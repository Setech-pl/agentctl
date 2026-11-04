import path from 'node:path';
import { DEFAULT_AGENT_SETTINGS } from '../config.ts';
import { buildAgentArgv, buildResumeArgv, INSTALL_HINTS } from '../agents.ts';
import { CLAUDE_KINDS, parseClaudeEvent, parseCodexEvent, planEventWiring } from '../events.ts';
import type { ClaudeKind } from '../events.ts';
import { sessionOfStatusLine } from '../usage-tap.ts';
import { readPlans } from '../usage.ts';
import { agentHomes } from '../usage-sources.ts';
import { feedClaudeLine, feedCodexLine } from '../usage-parse.ts';
import { refreshCodexCapacity } from '../capacity.ts';
import { defaultEquivalents, formatModelEffort } from '../equivalents.ts';
import { modelLabel } from '../model-label.ts';
import { findAutoAcceptFlag } from '../safety.ts';
import { sessionAgent } from '../limits.ts';
import { sessionQuestion } from '../codex-question.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter } from './types.ts';

/** Initially delegates to the 0.17.4 implementation; subsequent steps move each responsibility here. */
export const claude: ProviderAdapter = {
  id: 'claude', displayName: 'Claude', boardLabel: 'cl', letter: 'C', command: 'claude',
  get installHint() { return INSTALL_HINTS.claude!; },
  capabilities: { remoteControl: true, statusLineTap: true, mcpInstall: true, busyPrompt: true },
  defaultSettings: () => structuredClone(DEFAULT_AGENT_SETTINGS.claude),
  async detect(runner) {
    const version = await runner.exec('claude', ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec('claude', ['--help'], { readOnly: true }) : { stdout: '' };
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.trim().split('\n')[0] ?? '', features: { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt-file\b/.test(help.stdout) } };
  },
  doctor(d) { return [{ name: 'claude', level: d.found ? 'ok' : 'warn', text: d.found ? d.raw : `not found (only needed for agent: claude). ${this.installHint}` }]; },
  argv: (order, settings, extra) => buildAgentArgv({ ...order, agent: 'claude' }, settings, extra),
  launchEnv: () => ({}),
  resumeArgv: (order, settings, extra, sessionId) => buildResumeArgv({ ...order, agent: 'claude' }, settings, extra, sessionId),
  resumeLabel: (sessionId) => sessionId ? `--resume ${sessionId}` : '--continue',
  effort: { accepted: ['low', 'medium', 'high', 'xhigh', 'max'], mode: 'flag', args: (effort, settings) => settings.effortArgs.map(a => a.replaceAll('{effort}', effort)) },
  screen: { echoMarker: '❯' },
  events: {
    emits: { turnEnd: true, needsInput: true, limit: true, overload: true, promptSubmit: true },
    kinds: CLAUDE_KINDS, payloadFrom: 'stdin',
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
  safety: { forbiddenFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions'], check: findAutoAcceptFlag },
  isExternalSession: tokens => sessionAgent(tokens.join(' ')) === 'claude',
};
