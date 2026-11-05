import { within } from './usage-shared.ts';
import path from 'node:path';
import { defaultSettings } from './settings.ts';

import { parseCodexEvent, planCodexEvents } from './codex-events.ts';
import type { ClaudeKind } from '../events.ts';
import { sessionOfStatusLine } from '../usage-tap.ts';
import { readCodexPlan, codexHome } from './codex-usage.ts';
import { agentHomes } from '../usage-sources.ts';
import { feedCodexLine } from './codex-parse.ts';
import { refreshCodexCapacity } from './codex-usage.ts';
import { DEFAULT_EQUIVALENTS } from './equivalents.ts';
import { modelLabel } from './model-label.ts';
import { legacySafety } from './safety.ts';
import { interactiveTokens } from './process.ts';
import { sessionQuestion } from './codex-question.ts';
import { isObject } from '../util.ts';
import type { ProviderAdapter, DoctorLine } from './types.ts';

/** Initially delegates to the 0.17.4 implementation; subsequent steps move each responsibility here. */
export const codex: ProviderAdapter = {
  id: 'codex', displayName: 'Codex', boardLabel: 'cx', letter: 'X', command: 'codex',
  processCommands: { args: /(?:^|[\s/])codex(?:\s|$)/, pane: /^codex(?:\s|$)/ },
  installHint: 'Install Codex CLI: npm i -g @openai/codex (https://github.com/openai/codex).',
  capabilities: { remoteControl: false, statusLineTap: false, mcpInstall: false, busyPrompt: true },
  defaultSettings: () => defaultSettings('codex'),
  async detect(runner) {
    const version = await runner.exec('codex', ['--version'], { readOnly: true });
    const help = version.code === 0 ? await runner.exec('codex', ['--help'], { readOnly: true }) : { stdout: '' };
    return { found: version.code === 0, version: /\d+\.\d+\.\d+/.exec(version.stdout)?.[0] ?? null, raw: version.stdout.split('\n').map(line => line.trim()).find(Boolean) ?? '', features: { effortFlag: /--effort\b/.test(help.stdout), config: /-c, --config/.test(help.stdout), remoteControl: /--remote-control\b/.test(help.stdout), appendSystemPromptFile: /--append-system-prompt(?:-file\b|\[-file\])/.test(help.stdout) } };
  },
  doctor(d, env) {
    if (!d.found) return [{ name: 'codex', level: 'warn', text: `not found (only needed for agent: codex). ${this.installHint}` }];
    const lines: DoctorLine[] = [];
    const add = (name: string, level: DoctorLine['level'], text: string) => lines.push({ name, level, text });
    const effort = d.features.config
      ? 'effort: via -c model_reasoning_effort=<effort>'
      : 'effort: no -c/--config flag in this version; set agents.codex.effort_args: [] (the prompt header still carries the effort)';
    add('codex', 'ok', `${d.raw}; ${effort}`);
    return lines;
  },
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
    home: codexHome, homeEnv: 'CODEX_HOME',
    sessions(reader, home, record, worktrees, known, now) {
      const start = Date.parse(record.started);
      const ids = new Set(known.map(s => s.id));
      return reader.codexSessions(home, Number.isNaN(start) ? now : start - 86_400_000, now).flatMap(file => {
        const meta = reader.meta(file, 'codex'); if (!meta) return [];
        const explicit = meta.id !== null && ids.has(meta.id);
        return explicit || (meta.cwd && worktrees.some(w => within(meta.cwd!, w))) ? [{ file, firstAt: meta.firstAt, explicit }] : [];
      });
    },

    feedLine: feedCodexLine,
    readPlan: readCodexPlan,
    refreshPlan: refreshCodexCapacity,
    planSources: ['codex-session-log', 'codex-app-server:account/rateLimits/read'],
  },
  models: { get equivalents() { const rows = DEFAULT_EQUIVALENTS.map(row => row.codex); return { light: rows.slice(0, 2), medium: rows.slice(2, 4), strong: rows.slice(4) }; }, label: modelLabel },
  safety: legacySafety,
  isExternalSession(tokens) { const first = path.basename(tokens[0] ?? ''); return (first === 'codex' || (/^node(js)?$/.test(first) && /@openai\/codex\/\S*\.js$/.test(tokens[1] ?? ''))) && interactiveTokens(tokens); },
};
