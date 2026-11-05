import { blockingEnv } from './claude-rc.ts';
import path from 'node:path';
import fs from 'node:fs';
import { within } from './usage-shared.ts';
import { defaultSettings } from './settings.ts';

import { CLAUDE_KINDS, parseClaudeEvent, planClaudeEvents } from './claude-events.ts';
import type { ClaudeKind } from '../events.ts';
import { hookPromptMatches } from '../paste-wrapper.ts';
import { sessionOfStatusLine } from '../usage-tap.ts';
import { readClaudePlan, claudeHome } from './claude-usage.ts';
import { agentHomes } from '../usage-sources.ts';
import { feedClaudeLine } from './claude-parse.ts';
import { refreshCodexCapacity } from '../capacity.ts';
import { DEFAULT_EQUIVALENTS } from './equivalents.ts';
import { modelLabel } from './model-label.ts';
import { legacySafety } from './safety.ts';
import { interactiveTokens } from './process.ts';
import { sessionQuestion } from '../codex-question.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter, DoctorLine } from './types.ts';

/** Initially delegates to the 0.17.4 implementation; subsequent steps move each responsibility here. */
export const claude: ProviderAdapter = {
  id: 'claude', displayName: 'Claude', boardLabel: 'cl', letter: 'C', command: 'claude',
  processCommands: { args: /(?:^|[\s/])claude(?:\s|$)/, pane: /^claude(?:\s|$)/ },
  installHint: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code (npm i -g @anthropic-ai/claude-code).',
  capabilities: { remoteControl: true, statusLineTap: true, mcpInstall: true, busyPrompt: true },
  defaultSettings: () => defaultSettings('claude'),
  async detect(runner) {
    const version = await runner.exec('claude', ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec('claude', ['--help'], { readOnly: true }) : { stdout: '' };
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '', features: { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt(?:-file\b|\[-file\])/.test(help.stdout) } };
  },
  doctor(d, env) {
    if (!d.found) return [{ name: 'claude', level: 'warn', text: `not found (only needed for agent: claude). ${this.installHint}` }];
    const lines: DoctorLine[] = [];
    const add = (name: string, level: DoctorLine['level'], text: string) => lines.push({ name, level, text });
    const effort = d.features.effortFlag
      ? 'effort: native --effort flag'
      : 'effort: no --effort flag in this version; set agents.claude.effort_args: [] (the prompt header still carries the effort)';
    add('claude', 'ok', `${d.raw}; ${effort}`);
    // Remote Control (the manager, and remote_control: true in a spec) needs these two flags and a claude.ai login without an API key or a gateway.
    const support = { remoteControl: d.features.remoteControl, roleFile: d.features.appendSystemPromptFile };
    const blocking = blockingEnv(env);
    if (!support.remoteControl) add('claude remote control', 'warn', 'this Claude Code has no --remote-control flag in its help: agentctl manager and remote_control: true need it (claude update)');
    else if (!support.roleFile) add('claude remote control', 'warn', 'has --remote-control, but no --append-system-prompt-file: agentctl manager cannot give the manager its role (claude update)');
    else if (blocking.length > 0) add('claude remote control', 'warn', `has --remote-control, but ${blocking.join(', ')} ${blocking.length === 1 ? 'is' : 'are'} set here: Claude Code then refuses Remote Control (it needs a claude.ai login, not an API key or a gateway). A tmux server started from this shell has them too`);
    else add('claude remote control', 'ok', 'has --remote-control and --append-system-prompt-file (the login is not checked: claude auth status)');
    return lines;
  },
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
    plan: planClaudeEvents,
    parse: e => e.kind ? parseClaudeEvent(e.kind as ClaudeKind, e.payload) : undefined,
    session(e) { return sessionOfStatusLine(isObject(e.payload) ? e.payload : {}); },
    acknowledgesPrompt(e) {
      const data = isObject(e.payload) ? e.payload : {};
      return e.kind === 'user-prompt-submit' && typeof data.prompt === 'string' && hookPromptMatches(data.prompt, e.prompt ?? '', 'claude');
    },
  },
  usage: {
    home: claudeHome, homeEnv: 'CLAUDE_CONFIG_DIR',
    sessions(reader, home, record, worktrees, known, now) {
      const out = worktrees.flatMap(w => reader.claudeSessions(home, w).flatMap(file => { const meta = reader.meta(file, 'claude'); return meta?.cwd && within(meta.cwd, w) ? [{ file, firstAt: meta.firstAt, explicit: false }] : []; }));
      for (const session of known) if (session.transcript && fs.existsSync(session.transcript)) out.push({ file: session.transcript, firstAt: reader.meta(session.transcript, 'claude')?.firstAt ?? null, explicit: true });
      return out;
    },
    related: (reader, file) => reader.claudeSubagents(file),
    feedLine: feedClaudeLine,
    readPlan: readClaudePlan,

    planSources: ['claude-statusline'],
  },
  models: { get equivalents() { const rows = DEFAULT_EQUIVALENTS.map(row => row.claude); return { light: rows.slice(0, 2), medium: rows.slice(2, 4), strong: rows.slice(4) }; }, label: modelLabel },
  safety: legacySafety,
  isExternalSession(tokens) { const first = path.basename(tokens[0] ?? ''); return (first === 'claude' || (/^node(js)?$/.test(first) && /claude-code\/\S*\.js$/.test(tokens[1] ?? ''))) && interactiveTokens(tokens); },
};
