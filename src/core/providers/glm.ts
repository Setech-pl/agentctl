import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { claude } from './claude.ts';
import { defaultSettings } from './settings.ts';
import { parseClaudeEvent } from './claude-events.ts';
import type { ClaudeKind } from '../events.ts';
import { hookPromptMatches } from '../paste-wrapper.ts';
import { claudeSessions, claudeSubagents, glmPlanFile, readSnapshotFile } from './claude-usage.ts';
import { planState } from '../usage.ts';
import type { PlanState } from '../usage.ts';
import { feedClaudeLine } from './claude-parse.ts';
import { deriveTierModels } from '../matrix.ts';
import { modelLabel } from './model-label.ts';
import { legacySafety } from './safety.ts';
import { interactiveTokens } from './process.ts';
import { within } from './usage-shared.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter, DoctorLine } from './types.ts';
import type { GlobalConfig } from '../config.ts';
import type { UsageReader } from '../usage-sources.ts';
import type { Runner } from '../runner.ts';

/*
 * GLM (Z.ai GLM Coding Plan) is Claude Code pointed at the Z.ai Anthropic-compatible endpoint by the owner's
 * `claude-glm` wrapper (~/.local/bin/claude-glm), which sets ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN (from the
 * macOS Keychain item "neon-city-zai") itself. agentctl therefore reuses the whole Claude adapter - hooks, skills,
 * subagents, prompt delivery, report contract, folder-trust handling - and changes only the launch command, the
 * validated model list and the usage bookkeeping. Hard isolation rule: agentctl never sets ANTHROPIC_BASE_URL /
 * ANTHROPIC_AUTH_TOKEN anywhere (see launchEnvironment in safety.ts and the glm strip in spec.ts); a glm task gets
 * only what the wrapper does, and a claude task's environment stays untouched.
 */

/** The models the GLM Coding Plan documents (docs.z.ai/devpack/faq); anything else is a spec error. */
export const GLM_MODELS = ['glm-5.3', 'glm-5.3-flash'] as const;

/** The Keychain service the wrapper reads the Z.ai token from (existence is checked, never the value). */
export const GLM_KEYCHAIN_SERVICE = 'neon-city-zai';

/** The launch command: `providers_config.glm.command`, else the default wrapper. */
export const glmCommand = (config?: Pick<GlobalConfig, 'providersConfig'>): string => config?.providersConfig?.glm?.command ?? 'claude-glm';

/** The Claude config directory glm sessions land in: `usage.glm_dir`, else $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function glmHome(config: Pick<GlobalConfig, 'usage'>, env: Record<string, string | undefined> = process.env): string {
  return config.usage.glmDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}

const WRAPPER_MAX_BYTES = 64 * 1024;

/** The file the wrapper command is: an absolute or relative path as given, else the first match on PATH. */
function wrapperFile(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates = command.includes('/') ? [command] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  return candidates.find(file => { try { return fs.statSync(file).isFile(); } catch { return false; } });
}

/** `$HOME`, `${HOME}` and a leading `~` of a path the wrapper script writes; anything else that is still variable is not determinable (undefined). */
function expandHome(value: string, home: string): string | undefined {
  const expanded = value.replace(/^~(?=\/|$)/, home).replaceAll('${HOME}', home).replaceAll('$HOME', home);
  return expanded.includes('$') || expanded.includes('`') || !path.isAbsolute(expanded) ? undefined : path.normalize(expanded);
}

/**
 * The Claude config directory the claude-glm wrapper runs Claude Code in: `usage.glm_dir` when configured, else what the wrapper script itself
 * sets (`CLAUDE_CONFIG_DIR=…`, the last assignment), else the variable the wrapper inherits. `undefined`: not determinable (n/d).
 */
export function glmConfigDir(config: Pick<GlobalConfig, 'usage' | 'providersConfig'>, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (config.usage.glmDir) return config.usage.glmDir;
  const home = env.HOME ?? os.homedir();
  const file = wrapperFile(glmCommand(config), env);
  if (!file) return undefined;
  let text: string;
  try {
    if (fs.statSync(file).size > WRAPPER_MAX_BYTES) return undefined;
    text = fs.readFileSync(file, 'utf8');
  } catch { return undefined; }
  if (text.includes('\0')) return undefined; // a binary, not a script
  let found: string | undefined;
  for (const m of text.matchAll(/(?:^|[\s;])CLAUDE_CONFIG_DIR=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;"'\n]+))/g)) found = m[1] ?? m[2] ?? m[3];
  if (found !== undefined) return expandHome(found, home);
  return env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR, home) : undefined;
}

/** Has Claude Code finished its first-run onboarding in this config dir? It records `hasCompletedOnboarding` in `<dir>/.claude.json` (the default dir also in ~/.claude.json). */
export function glmOnboardingDone(dir: string, home: string): { done: boolean; checked: string[] } {
  const files = [path.join(dir, '.claude.json'), ...(path.resolve(dir) === path.join(home, '.claude') ? [path.join(home, '.claude.json')] : [])];
  for (const file of files) {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isObject(data) && data.hasCompletedOnboarding === true) return { done: true, checked: files };
    } catch { /* absent or unreadable: not done */ }
  }
  return { done: false, checked: files };
}

/** The glm plan: only the glm statusLine tap writes glm-plan.json. Z.ai documents no quota endpoint, so in practice this stays n/d. */
export function readGlmPlan(config: GlobalConfig, reader: UsageReader, now: number): PlanState {
  const plan = planState('glm', readSnapshotFile(glmPlanFile(config)), now, 'no reading yet: Z.ai exposes no documented quota endpoint or CLI quota output for the 5-hour and weekly windows, so the GLM plan stays n/d (see README "Providers")');
  plan.source = 'glm-statusline';
  return plan;
}

export const glm: ProviderAdapter = {
  id: 'glm', displayName: 'GLM', boardLabel: 'gl', letter: 'G', command: 'claude-glm',
  processCommands: { args: /(?:^|[\s/])claude-glm(?:\s|$)/, pane: /^claude-glm(?:\s|$)/ },
  installHint: 'Install the claude-glm wrapper (Z.ai GLM Coding Plan): a small script that exports ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic and ANTHROPIC_AUTH_TOKEN from the macOS Keychain item "neon-city-zai", then runs claude.',
  // Remote Control needs a claude.ai login, which the Z.ai token is not; the MCP install is shared with claude through ~/.claude.
  capabilities: { remoteControl: false, statusLineTap: true, mcpInstall: false, busyPrompt: true },
  defaultSettings: () => defaultSettings('glm'),
  async detect(runner: Runner, config?: GlobalConfig) {
    const command = glmCommand(config);
    const version = await runner.exec(command, ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec(command, ['--help'], { readOnly: true }) : { stdout: '' };
    const features: Record<string, boolean> = { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt(?:-file\b|\[-file\])/.test(help.stdout) };
    // Keychain existence only (macOS): the command prints metadata, never the secret, and agentctl never asks for the value.
    if (process.platform === 'darwin') features.keychain = (await runner.exec('security', ['find-generic-password', '-s', GLM_KEYCHAIN_SERVICE], { readOnly: true })).code === 0;
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '', features };
  },
  doctor(d, env, config) {
    const command = glmCommand(config);
    const lines: DoctorLine[] = [];
    if (!d.found) lines.push({ name: 'glm', level: 'warn', text: `${command} not found or not executable (only needed for agent: glm). ${this.installHint}` });
    else lines.push({ name: 'glm', level: 'ok', text: `${d.raw} via ${command}` });
    if (config?.providersConfig?.glm?.command) lines.push({ name: 'glm command', level: 'ok', text: `providers_config.glm.command: ${command}` });
    if (process.platform === 'darwin') {
      lines.push(d.features.keychain
        ? { name: 'glm keychain', level: 'ok', text: `Keychain item "${GLM_KEYCHAIN_SERVICE}" exists (existence only; the secret is never read or printed)` }
        : { name: 'glm keychain', level: 'warn', text: `no Keychain item "${GLM_KEYCHAIN_SERVICE}": the wrapper cannot set ANTHROPIC_AUTH_TOKEN; add it with "security add-generic-password -s ${GLM_KEYCHAIN_SERVICE} -a $USER -w" (the value is never shown by agentctl)` });
    } else lines.push({ name: 'glm keychain', level: 'warn', text: `macOS Keychain item "${GLM_KEYCHAIN_SERVICE}" not checked (not macOS)` });
    // P95: a wrapper that uses its own Claude config dir shows the first-run onboarding (theme, security notes) before anything else; the first glm task would wait at it.
    const home = env.HOME ?? os.homedir();
    const dir = config ? glmConfigDir(config, env) : undefined;
    if (!dir) lines.push({ name: 'glm onboarding', level: 'ok', text: `n/d: the Claude config dir of ${command} is not determinable (no usage.glm_dir, no CLAUDE_CONFIG_DIR in the wrapper script); if the first glm task stops at "Choose the text style", run ${command} once in a terminal` });
    else {
      const onboarding = glmOnboardingDone(dir, home);
      lines.push(onboarding.done
        ? { name: 'glm onboarding', level: 'ok', text: `first-run onboarding completed in ${dir}` }
        : { name: 'glm onboarding', level: 'warn', text: `the glm Claude config dir ${dir} has not completed onboarding (no hasCompletedOnboarding in ${onboarding.checked.join(' or ')}): the first glm task would wait at the theme picker; fix: run ${command} once in a terminal and finish it (theme, security notes, folder trust)` });
    }
    // Z.ai quota: no documented endpoint or CLI output, so glm usage is n/d and usage.queue_hold never holds glm.
    lines.push({ name: 'glm usage', level: 'ok', text: 'plan n/d: Z.ai documents no quota endpoint; usage.queue_hold does not hold glm (token accounting still works from the session logs)' });
    return lines;
  },
  argv: claude.argv,
  // The wrapper sets ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN itself; agentctl adds nothing (hard isolation rule).
  launchEnv: () => ({}),
  resumeArgv: claude.resumeArgv,
  resumeLabel: claude.resumeLabel,
  effort: claude.effort,
  screen: claude.screen,
  events: {
    ...claude.events,
    parse: e => e.kind ? parseClaudeEvent(e.kind as ClaudeKind, e.payload, 'glm') : undefined,
    acknowledgesPrompt(e) {
      const data = isObject(e.payload) ? e.payload : {};
      return e.kind === 'user-prompt-submit' && typeof data.prompt === 'string' && hookPromptMatches(data.prompt, e.prompt ?? '', 'glm');
    },
  },
  usage: {
    ...claude.usage,
    home: glmHome,
    sessions(reader, home, record, worktrees, known, now) {
      const out = worktrees.flatMap(w => claudeSessions(reader, home, w).flatMap(file => { const meta = reader.meta(file, 'glm'); return meta?.cwd && within(meta.cwd, w) ? [{ file, firstAt: meta.firstAt, explicit: false }] : []; }));
      for (const session of known) if (session.transcript && fs.existsSync(session.transcript)) out.push({ file: session.transcript, firstAt: reader.meta(session.transcript, 'glm')?.firstAt ?? null, explicit: true });
      return out;
    },
    related: (reader, file) => claudeSubagents(reader, file),
    feedLine: feedClaudeLine,
    readPlan: readGlmPlan,
    refreshPlan: undefined, // no documented Z.ai quota probe (see readGlmPlan)
    planSources: ['glm-statusline'],
  },
  models: { get equivalents() { return deriveTierModels('glm'); }, label: modelLabel },
  safety: {
    ...legacySafety,
    validate(order, _settings, _env) {
      if (order.model !== 'default' && !(GLM_MODELS as readonly string[]).includes(order.model)) return `unknown GLM model "${order.model}": the GLM Coding Plan documents ${GLM_MODELS.join(' and ')} (docs.z.ai/devpack/faq)`;
      return undefined;
    },
  },
  isExternalSession(tokens) { const first = path.basename(tokens[0] ?? ''); return first === 'claude-glm' && interactiveTokens(tokens); },
};
