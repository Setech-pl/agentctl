// ACTL-0267 spike: headless one-shot driver (classes review/report/simple/gate).
// `claude -p --output-format stream-json --verbose` and `codex exec --json` → normalized driver events → task outcome.
// Fixture streams are schema-derived (no inference was allowed to record real ones); the reducer is tolerant of unknown event types.
import fs from 'node:fs';

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; costUsd?: number }
export type FailureClass = 'limited' | 'overloaded' | 'auth' | 'max-turns' | 'budget' | 'error';
export type DriverEvent =
  | { kind: 'session'; id: string; model?: string; version?: string }
  | { kind: 'turn-start' }
  | { kind: 'activity'; what: string }
  | { kind: 'message'; text: string }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'turn-done'; result: string; isError: boolean; subtype?: string; denials: number }
  | { kind: 'failure'; cls: FailureClass; text: string }
  | { kind: 'retry'; text: string };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const LIMIT = /usage limit|hit your limit|rate.?limit|quota|billing/i;
const OVERLOAD = /\b529\b|overloaded/i;
const AUTH = /invalid api key|please run \/login|not logged in|unauthorized|401\b/i;
export function classify(text: string): FailureClass { return LIMIT.test(text) ? 'limited' : OVERLOAD.test(text) ? 'overloaded' : AUTH.test(text) ? 'auth' : 'error'; }

/** One line of `claude -p --output-format stream-json --verbose` (Agent SDK message union). */
export function normalizeClaude(line: string): DriverEvent[] {
  let m: Record<string, unknown>; try { m = obj(JSON.parse(line)); } catch { return []; }
  if (m.type === 'system' && m.subtype === 'init') return [{ kind: 'session', id: String(m.session_id), model: m.model as string, version: m.claude_code_version as string }, { kind: 'turn-start' }];
  if (m.type === 'system' && m.subtype === 'api_retry') return [{ kind: 'retry', text: `${m.error_status ?? ''} ${m.error ?? ''} attempt ${m.attempt}/${m.max_retries}` }];
  if (m.type === 'assistant') {
    const out: DriverEvent[] = [];
    for (const c of Array.isArray(obj(m.message).content) ? (obj(m.message).content as unknown[]) : []) {
      const b = obj(c);
      if (b.type === 'text' && b.text) out.push({ kind: 'message', text: String(b.text) });
      if (b.type === 'tool_use') out.push({ kind: 'activity', what: String(b.name) });
    }
    return out;
  }
  if (m.type === 'result') {
    const u = obj(m.usage);
    const usage: Usage = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), reasoning: 0, costUsd: num(m.total_cost_usd) };
    const result = String(m.result ?? (Array.isArray(m.errors) ? m.errors.join('; ') : ''));
    const subtype = String(m.subtype);
    const out: DriverEvent[] = [{ kind: 'usage', usage }, { kind: 'turn-done', result, isError: m.is_error === true || subtype !== 'success', subtype, denials: Array.isArray(m.permission_denials) ? m.permission_denials.length : 0 }];
    if (subtype === 'error_max_turns') out.push({ kind: 'failure', cls: 'max-turns', text: result });
    else if (subtype === 'error_max_budget_usd') out.push({ kind: 'failure', cls: 'budget', text: result });
    else if (m.is_error === true || subtype !== 'success') out.push({ kind: 'failure', cls: classify(result), text: result });
    return out;
  }
  return [];
}

/** One line of `codex exec --json` (exec ThreadEvent: thread.started, turn.*, item.*, error). */
export function normalizeCodex(line: string): DriverEvent[] {
  let m: Record<string, unknown>; try { m = obj(JSON.parse(line)); } catch { return []; }
  const item = obj(m.item);
  switch (m.type) {
    case 'thread.started': return [{ kind: 'session', id: String(m.thread_id) }];
    case 'turn.started': return [{ kind: 'turn-start' }];
    case 'item.started': return item.type && item.type !== 'agent_message' ? [{ kind: 'activity', what: String(item.type) }] : [];
    case 'item.completed': return item.type === 'agent_message' ? [{ kind: 'message', text: String(item.text ?? '') }] : item.type === 'error' ? [{ kind: 'retry', text: String(item.message ?? '') }] : [];
    case 'turn.completed': { const u = obj(m.usage); return [{ kind: 'usage', usage: { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cached_input_tokens), cacheWrite: 0, reasoning: num(u.reasoning_output_tokens) } }, { kind: 'turn-done', result: '', isError: false, denials: 0 }]; }
    case 'turn.failed': { const t = String(obj(m.error).message ?? ''); return [{ kind: 'turn-done', result: t, isError: true, denials: 0 }, { kind: 'failure', cls: classify(t), text: t }]; }
    case 'error': { const t = String(m.message ?? ''); return /reconnecting|retry/i.test(t) ? [{ kind: 'retry', text: t }] : [{ kind: 'failure', cls: classify(t), text: t }]; }
    default: return [];
  }
}

export type HeadlessState = 'report-ready' | 'turn-done' | 'limited' | 'overloaded' | 'needs-attention' | 'dead';
export interface Outcome { state: HeadlessState; sessionId?: string; verdict?: string; reportSource?: 'file' | 'stream'; lastMessage?: string; usage: Usage; failure?: { cls: FailureClass; text: string }; retries: number; denials: number; events: number }
export interface ReportCheck { path: string; attempt?: string }

const VERDICT = /^(?:Werdykt|Verdict):\s*(PASS with findings|PASS|PARTIAL|FAIL|BLOCKED)\b/;
/** The canonical report wins over the stream: first line verdict, attempt marker, report-end marker (agentctl's existing protocol). */
export function readReport(check: ReportCheck, read: (p: string) => string | undefined = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return undefined; } }): { verdict?: string; complete: boolean } {
  const text = read(check.path);
  if (text === undefined) return { complete: false };
  const lines = text.trimEnd().split('\n');
  const verdict = VERDICT.exec(lines[0] ?? '')?.[1];
  const attemptOk = !check.attempt || text.includes(`<!-- agentctl:attempt ${check.attempt} -->`);
  return { verdict, complete: !!verdict && attemptOk && lines.at(-1)?.trim() === '<!-- agentctl:report-end -->' };
}

/** Reduce a finished stream (+ process exit code) to the task outcome. */
export function reduce(events: DriverEvent[], exitCode: number | null, report?: ReportCheck, read?: (p: string) => string | undefined): Outcome {
  const o: Outcome = { state: 'dead', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, retries: 0, denials: 0, events: events.length };
  let done = false; let isError = false;
  for (const e of events) {
    if (e.kind === 'session') o.sessionId = e.id;
    else if (e.kind === 'message') o.lastMessage = e.text;
    else if (e.kind === 'retry') o.retries++;
    else if (e.kind === 'usage') { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) o.usage[k] += e.usage[k]; if (e.usage.costUsd) o.usage.costUsd = (o.usage.costUsd ?? 0) + e.usage.costUsd; }
    else if (e.kind === 'turn-done') { done = true; isError = e.isError; o.denials += e.denials; if (e.result && !e.isError) o.lastMessage = e.result; }
    else if (e.kind === 'failure') o.failure = { cls: e.cls, text: e.text };
  }
  const r = report ? readReport(report, read) : { complete: false };
  if (r.complete) return { ...o, state: 'report-ready', verdict: r.verdict, reportSource: 'file' };
  if (o.failure?.cls === 'limited') return { ...o, state: 'limited' };
  if (o.failure?.cls === 'overloaded') return { ...o, state: 'overloaded' };
  if (!done) return { ...o, state: 'dead' }; // crash, kill, OOM, or stream cut: no terminal event
  if (isError || exitCode !== 0 || o.denials > 0) return { ...o, state: 'needs-attention' };
  const v = VERDICT.exec(o.lastMessage ?? '')?.[1];
  return v ? { ...o, state: 'report-ready', verdict: v, reportSource: 'stream' } : { ...o, state: 'turn-done' };
}

export interface HeadlessOrder { provider: 'claude' | 'codex'; worktree: string; settingsFile?: string; sessionId?: string; model?: string; lastMessageFile?: string; maxBudgetUsd?: number }
/** argv only (the prompt goes on stdin, never argv: size limits and ps leakage). Not executed by the spike. */
export function headlessArgv(o: HeadlessOrder): { cmd: string; args: string[] } {
  if (o.provider === 'claude') return { cmd: 'claude', args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', ...(o.settingsFile ? ['--settings', o.settingsFile] : []), ...(o.sessionId ? ['--session-id', o.sessionId] : []), ...(o.model ? ['--model', o.model] : []), ...(o.maxBudgetUsd ? ['--max-budget-usd', String(o.maxBudgetUsd)] : [])] };
  return { cmd: 'codex', args: ['exec', '--json', '-C', o.worktree, ...(o.model ? ['-m', o.model] : []), ...(o.lastMessageFile ? ['-o', o.lastMessageFile] : []), '-'] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [provider, file, exit = '0', reportPath, attempt] = process.argv.slice(2);
  if (!file || (provider !== 'claude' && provider !== 'codex')) { console.error('usage: runner.ts claude|codex <stream.jsonl> [exit] [report] [attempt]'); process.exit(2); }
  const norm = provider === 'claude' ? normalizeClaude : normalizeCodex;
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(norm);
  console.log(JSON.stringify(reduce(events, Number(exit), reportPath ? { path: reportPath, attempt } : undefined), null, 1));
}
