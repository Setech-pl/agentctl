import path from 'node:path';
import { DEFAULT_AGENT_SETTINGS } from '../config.ts';

import { CLAUDE_KINDS, parseClaudeEvent, parseCodexEvent, planEventWiring } from '../events.ts';
import type { ClaudeKind } from '../events.ts';
import { sessionOfStatusLine } from '../usage-tap.ts';
import { readPlans } from '../usage.ts';
import { agentHomes } from '../usage-sources.ts';
import { feedClaudeLine, feedCodexLine } from '../usage-parse.ts';
import { refreshCodexCapacity } from '../capacity.ts';
import { defaultEquivalents, formatModelEffort } from '../equivalents.ts';
import { modelLabel } from './model-label.ts';
import { splitFlag } from './safety.ts';
import { sessionAgent } from '../limits.ts';
import { sessionQuestion } from '../codex-question.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter } from './types.ts';

/** Initially delegates to the 0.17.4 implementation; subsequent steps move each responsibility here. */
export const claude: ProviderAdapter = {
  id: 'claude', displayName: 'Claude', boardLabel: 'cl', letter: 'C', command: 'claude',
  installHint: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code (npm i -g @anthropic-ai/claude-code).',
  capabilities: { remoteControl: true, statusLineTap: true, mcpInstall: true, busyPrompt: true },
  defaultSettings: () => structuredClone(DEFAULT_AGENT_SETTINGS.claude),
  async detect(runner) {
    const version = await runner.exec('claude', ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec('claude', ['--help'], { readOnly: true }) : { stdout: '' };
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.trim().split('\n')[0] ?? '', features: { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt-file\b/.test(help.stdout) } };
  },
  doctor(d) { return [{ name: 'claude', level: d.found ? 'ok' : 'warn', text: d.found ? d.raw : `not found (only needed for agent: claude). ${this.installHint}` }]; },
  argv(spec, settings, extra) {
  const hasModel = spec.model !== 'default';
  const effortArgs = settings.effortArgs.map((a) => a.replaceAll('{effort}', spec.effort));
    if (spec.remoteControl && !spec.task) throw new Error('remote control needs the task ID as the name of the session');
    return ['claude', ...(hasModel ? ['--model', spec.model] : []), ...effortArgs, ...settings.flags, ...(spec.remoteControl ? ['--remote-control', spec.task as string] : []), ...extra];
  },
  launchEnv: () => ({}),
  resumeArgv(order, settings, extra, sessionId) { return [...this.argv(order, settings, extra), ...(sessionId ? ['--resume', sessionId] : ['--continue'])]; },
  resumeLabel: (sessionId) => sessionId ? `--resume ${sessionId}` : '--continue',
  effort: { accepted: ['low', 'medium', 'high', 'xhigh', 'max'], mode: 'flag', args: (effort, settings) => settings.effortArgs.map(a => a.replaceAll('{effort}', effort)) },
  screen: { echoMarker: '❯' },
  events: {
    emits: { turnEnd: true, needsInput: true, limit: true, overload: true, promptSubmit: true },
    get kinds() { return CLAUDE_KINDS; }, payloadFrom: 'stdin',
    plan: input => planEventWiring({ ...input, agent: 'claude' }),
    parse: e => parseClaudeEvent(e.kind as ClaudeKind, e.payload),
    session(e) { return sessionOfStatusLine(isObject(e.payload) ? e.payload : {}); },
    acknowledgesPrompt: e => e.kind === 'user-prompt-submit',
  },
  usage: {
    home: (config, env) => agentHomes(config, env).claude, homeEnv: 'CLAUDE_CONFIG_DIR',
    sessions(reader, home, record, worktrees, known, now) {
      const out = worktrees.flatMap(w => reader.claudeSessions(home, w).flatMap(file => { const meta = reader.meta(file, 'claude'); return meta?.cwd && (meta.cwd === w || meta.cwd.startsWith(`${w}/`)) ? [{ file, firstAt: meta.firstAt, explicit: false }] : []; }));
      for (const session of known) if (session.transcript) out.push({ file: session.transcript, firstAt: reader.meta(session.transcript, 'claude')?.firstAt ?? null, explicit: true });
      return out;
    },
    related: (reader, file) => reader.claudeSubagents(file),
    feedLine: feedClaudeLine,
    readPlan: (config, reader, now) => readPlans(config, reader, now).claude,
    
    planSources: ['claude-statusline'],
  },
  models: { get equivalents() { const rows = defaultEquivalents().map(row => formatModelEffort(row.claude)); return { light: rows.slice(0, 2), medium: rows.slice(2, 4), strong: rows.slice(4) }; }, label: modelLabel },
  safety: { forbiddenFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'], check(args) {
      const [arg, next] = args; if (!arg) return undefined;
      const [flag, inlineValue] = splitFlag(arg); const value = inlineValue ?? next;
      if (flag === '--permission-mode' && value !== undefined && ['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk'].includes(value)) return `${flag} ${value}`;
      return undefined;
    } },
  isExternalSession: tokens => sessionAgent(tokens.join(' ')) === 'claude',
};
