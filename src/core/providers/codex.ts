import path from 'node:path';
import { defaultSettings } from './settings.ts';

import { parseCodexEvent, planCodexEvents } from './codex-events.ts';
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
import { sessionQuestion } from './codex-question.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter } from './types.ts';

/** Initially delegates to the 0.17.4 implementation; subsequent steps move each responsibility here. */
export const codex: ProviderAdapter = {
  id: 'codex', displayName: 'Codex', boardLabel: 'cx', letter: 'X', command: 'codex',
  installHint: 'Install Codex CLI: npm i -g @openai/codex (https://github.com/openai/codex).',
  capabilities: { remoteControl: false, statusLineTap: false, mcpInstall: false, busyPrompt: true },
  defaultSettings: () => defaultSettings('codex'),
  async detect(runner) {
    const version = await runner.exec('codex', ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec('codex', ['--help'], { readOnly: true }) : { stdout: '' };
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.trim().split('\n')[0] ?? '', features: { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt-file\b/.test(help.stdout) } };
  },
  doctor(d) { return [{ name: 'codex', level: d.found ? 'ok' : 'warn', text: d.found ? d.raw : `not found (only needed for agent: codex). ${this.installHint}` }]; },
  argv(spec, settings, extra) {
  const hasModel = spec.model !== 'default';
  const effortArgs = settings.effortArgs.map((a) => a.replaceAll('{effort}', spec.effort));
  return ['codex', '--sandbox', 'danger-full-access', ...(hasModel ? ['-m', spec.model] : []), ...effortArgs, ...settings.flags, ...extra];
  },
  launchEnv: () => ({}),
  resumeArgv(order, settings, extra, sessionId) { const [cmd, ...rest] = this.argv(order, settings, extra) as [string, ...string[]]; return [cmd, 'resume', ...(sessionId ? [sessionId] : ['--last']), ...rest]; },
  resumeLabel: (sessionId) => sessionId ? `resume ${sessionId}` : 'resume --last',
  effort: { accepted: ['low', 'medium', 'high', 'xhigh'], mode: 'config', args: (effort, settings) => settings.effortArgs.map(a => a.replaceAll('{effort}', effort)) },
  screen: { echoMarker: '›', sessionQuestion },
  events: {
    emits: { turnEnd: true, needsInput: false, limit: false, overload: false, promptSubmit: false },
    kinds: [], payloadFrom: 'argv',
    plan: planCodexEvents,
    parse: e => parseCodexEvent(e.payload),
    session(e) { const data = isObject(e.payload) ? e.payload : {}; return typeof data['thread-id'] === 'string' && data['thread-id'] !== '' ? { id: data['thread-id'] } : undefined; },
    acknowledgesPrompt(e) {
      const normalize = (s: string) => s.replace(/\r\n?/g, '\n').trim();
      const data = isObject(e.payload) ? e.payload : {};
      return Array.isArray(data['input-messages']) && data['input-messages'].some(text => typeof text === 'string' && normalize(text) === normalize(e.prompt ?? ''));
    },
    
  },
  usage: {
    home: (config, env) => agentHomes(config, env).codex, homeEnv: 'CODEX_HOME',
    sessions(reader, home, record, worktrees, known, now) {
      const start = Date.parse(record.started);
      const ids = new Set(known.map(s => s.id));
      return reader.codexSessions(home, Number.isNaN(start) ? now : start - 86_400_000, now).flatMap(file => {
        const meta = reader.meta(file, 'codex'); if (!meta) return [];
        const explicit = meta.id !== null && ids.has(meta.id);
        return explicit || (meta.cwd && worktrees.some(w => meta.cwd === w || meta.cwd!.startsWith(`${w}/`))) ? [{ file, firstAt: meta.firstAt, explicit }] : [];
      });
    },
    
    feedLine: feedCodexLine,
    readPlan: (config, reader, now) => readPlans(config, reader, now).codex,
    refreshPlan: refreshCodexCapacity,
    planSources: ['codex-session-log', 'codex-app-server:account/rateLimits/read'],
  },
  models: { get equivalents() { const rows = defaultEquivalents().map(row => formatModelEffort(row.codex)); return { light: rows.slice(0, 2), medium: rows.slice(2, 4), strong: rows.slice(4) }; }, label: modelLabel },
  safety: { forbiddenFlags: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto', '--approve-for-me'], check(args) {
      const [arg, next] = args; if (!arg) return undefined;
      const [flag, inlineValue] = splitFlag(arg); const value = inlineValue ?? next;
      if ((flag === '-a' || flag === '--ask-for-approval') && value === 'never') return `${flag} ${value}`;
      if ((flag === '-c' || flag === '--config') && value !== undefined && /^approval_policy\s*=\s*["']?never/.test(value)) return `${flag} ${value}`;
      return undefined;
    } },
  isExternalSession: tokens => sessionAgent(tokens.join(' ')) === 'codex',
};
