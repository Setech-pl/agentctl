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
