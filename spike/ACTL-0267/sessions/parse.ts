// ACTL-0267 spike: agent state from native session files (no screen). Formats observed 2026-11-28 on Claude Code 2.1.326/2.1.323
// (~/.claude/projects/<cwd>/<session>.jsonl, ~/.claude/sessions/<pid>.json) and codex-cli 0.167.0 (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl).
// Only keys/record types were surveyed on the real files; the fixtures are synthetic.
import fs from 'node:fs';
import path from 'node:path';

export type Phase = 'starting' | 'working' | 'needs-input' | 'turn-done' | 'interrupted' | 'unknown';
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
export interface SessionState {
  provider: 'claude' | 'codex';
  sessionId?: string;
  version?: string;
  phase: Phase;
  turnId?: string;
  turnStartedAt?: number;
  turnEndedAt?: number;
  turnDurationMs?: number;
  waiting?: { kind: 'question' | 'approval'; text: string };
  lastAssistant?: string;
  turnUsage: Usage;
  totalUsage?: Usage;
  contextWindow?: number;
  /** Records the tail did not cover (the turn started before the tail): usage is then a lower bound. */
  truncated: boolean;
}

const zero = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const time = (v: unknown): number | undefined => { const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : NaN; return Number.isFinite(t) ? t : undefined; };

/** The last `maxBytes` of a file as complete lines (the first partial line is dropped). Session files reach hundreds of MB: never read them whole. */
export function tailLines(file: string, maxBytes = 256 * 1024): { lines: string[]; truncated: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines: lines.filter(Boolean), truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

function records(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of lines) { try { out.push(obj(JSON.parse(l))); } catch { /* torn last line while the agent writes */ } }
  return out;
}

const textOf = (content: unknown): string => Array.isArray(content) ? content.map(c => (obj(c).type === 'text' ? String(obj(c).text ?? '') : '')).filter(Boolean).join('\n') : typeof content === 'string' ? content : '';

/** Claude Code transcript. Turn start = a `user` record with `promptSource` (typed|queued|system); turn end = `system/turn_duration`. */
export function parseClaude(lines: string[], truncated = false): SessionState {
  const st: SessionState = { provider: 'claude', phase: 'unknown', turnUsage: zero(), truncated };
  const seen = new Set<string>(); // one API message is split into several records that repeat its usage
  const pending = new Map<string, { name: string; text: string }>();
  let sawStart = false;
  for (const r of records(lines)) {
    st.sessionId ??= typeof r.sessionId === 'string' ? r.sessionId : undefined;
    if (typeof r.version === 'string') st.version = r.version;
    const at = time(r.timestamp);
    if (r.type === 'user' && typeof r.promptSource === 'string') {
      sawStart = true;
      st.phase = 'working'; st.turnStartedAt = at; st.turnEndedAt = undefined; st.turnDurationMs = undefined; st.waiting = undefined;
      st.turnUsage = zero(); seen.clear(); pending.clear();
      st.turnId = typeof r.promptId === 'string' ? r.promptId : undefined;
      continue;
    }
    if (r.type === 'user') { // tool results
      for (const c of Array.isArray(obj(r.message).content) ? (obj(r.message).content as unknown[]) : []) if (obj(c).type === 'tool_result') pending.delete(String(obj(c).tool_use_id));
      if (st.phase === 'needs-input' && pending.size === 0) { st.phase = 'working'; st.waiting = undefined; }
      continue;
    }
    if (r.type === 'assistant') {
      const m = obj(r.message);
      const id = String(m.id ?? r.requestId ?? r.uuid);
      if (!seen.has(id)) {
        seen.add(id);
        const u = obj(m.usage);
        st.turnUsage.input += num(u.input_tokens); st.turnUsage.output += num(u.output_tokens);
        st.turnUsage.cacheRead += num(u.cache_read_input_tokens); st.turnUsage.cacheWrite += num(u.cache_creation_input_tokens);
      }
      const text = textOf(m.content);
      if (text) st.lastAssistant = text;
      for (const c of Array.isArray(m.content) ? (m.content as unknown[]) : []) {
        const b = obj(c);
        if (b.type === 'tool_use') pending.set(String(b.id), { name: String(b.name), text: String(obj(obj(b.input).questions instanceof Array ? (obj(b.input).questions as unknown[])[0] : {}).question ?? '') });
      }
      const ask = [...pending.values()].find(p => p.name === 'AskUserQuestion');
      if (ask) { st.phase = 'needs-input'; st.waiting = { kind: 'question', text: ask.text }; }
      else if (st.phase !== 'turn-done') st.phase = 'working';
      continue;
    }
    if (r.type === 'system' && r.subtype === 'turn_duration') {
      st.phase = 'turn-done'; st.turnEndedAt = at; st.turnDurationMs = num(r.durationMs);
      if (st.turnStartedAt === undefined && at !== undefined) st.turnStartedAt = at - num(r.durationMs);
    }
  }
  if (!sawStart && st.phase === 'unknown' && !truncated) st.phase = 'starting';
  return st;
}

/** Codex rollout. task_started / task_complete / turn_aborted bracket a turn; token_count carries last+total usage; an unanswered request_user_input call is a question. */
export function parseCodex(lines: string[], truncated = false): SessionState {
  const st: SessionState = { provider: 'codex', phase: truncated ? 'unknown' : 'starting', turnUsage: zero(), truncated };
  const asks = new Map<string, string>();
  const toUsage = (v: unknown): Usage => { const u = obj(v); return { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cached_input_tokens), cacheWrite: num(u.cache_write_input_tokens), reasoning: num(u.reasoning_output_tokens) }; };
  let turnBase: Usage | undefined;
  for (const r of records(lines)) {
    const p = obj(r.payload);
    if (r.type === 'session_meta') { st.sessionId = String(p.id ?? p.session_id ?? ''); st.version = typeof p.cli_version === 'string' ? p.cli_version : undefined; continue; }
    if (r.type === 'response_item') {
      if (p.type === 'function_call' && /^request_user_input/.test(String(p.name))) {
        let q = ''; try { q = String(obj((obj(JSON.parse(String(p.arguments ?? '{}'))).questions as unknown[] | undefined)?.[0]).question ?? ''); } catch {}
        asks.set(String(p.call_id), q); st.phase = 'needs-input'; st.waiting = { kind: 'question', text: q };
      } else if (p.type === 'function_call_output' && asks.delete(String(p.call_id)) && asks.size === 0 && st.phase === 'needs-input') { st.phase = 'working'; st.waiting = undefined; }
      else if (p.type === 'message' && p.role === 'assistant') { const t = Array.isArray(p.content) ? (p.content as unknown[]).map(c => String(obj(c).text ?? '')).join('') : ''; if (t) st.lastAssistant = t; }
      continue;
    }
    if (r.type !== 'event_msg') continue;
    if (p.type === 'task_started') { st.phase = 'working'; st.turnId = String(p.turn_id); st.turnStartedAt = time(p.started_at) ?? time(r.timestamp); st.turnEndedAt = undefined; st.waiting = undefined; asks.clear(); turnBase = st.totalUsage; st.contextWindow = num(p.model_context_window) || st.contextWindow; }
    else if (p.type === 'task_complete') { st.phase = 'turn-done'; st.turnEndedAt = time(p.completed_at) ?? time(r.timestamp); st.turnDurationMs = num(p.duration_ms); if (typeof p.last_agent_message === 'string') st.lastAssistant = p.last_agent_message; }
    else if (p.type === 'turn_aborted') { st.phase = 'interrupted'; st.turnEndedAt = time(r.timestamp); }
    else if (p.type === 'token_count' && Object.keys(obj(p.info)).length) {
      const info = obj(p.info);
      st.totalUsage = toUsage(info.total_token_usage); st.contextWindow = num(info.model_context_window) || st.contextWindow;
      const b = turnBase ?? zero();
      st.turnUsage = { input: st.totalUsage.input - b.input, output: st.totalUsage.output - b.output, cacheRead: st.totalUsage.cacheRead - b.cacheRead, cacheWrite: st.totalUsage.cacheWrite - b.cacheWrite, reasoning: st.totalUsage.reasoning - b.reasoning };
    }
  }
  return st;
}

export interface ClaudeLive { pid: number; sessionId: string; status: string; statusUpdatedAt: number; tmuxPane?: string; version?: string }
/** ~/.claude/sessions/<pid>.json: one file per live Claude process (interactive too). Observed status values: idle, busy, shell. Keyed by tmux pane id ("%1955"). */
export function readClaudeRegistry(dir: string): Map<string, ClaudeLive> {
  const out = new Map<string, ClaudeLive>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter(n => /^\d+\.json$/.test(n)); } catch { return out; }
  for (const n of names) {
    let d: Record<string, unknown>;
    try { d = obj(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { continue; }
    const pane = typeof d.tmux === 'string' ? d.tmux.split('.').pop() : undefined; // "session:@window.%pane"
    const live: ClaudeLive = { pid: num(d.pid), sessionId: String(d.sessionId ?? ''), status: String(d.status ?? 'unknown'), statusUpdatedAt: num(d.statusUpdatedAt), tmuxPane: pane, version: typeof d.version === 'string' ? d.version : undefined };
    out.set(pane ?? `pid:${live.pid}`, live);
  }
  return out;
}

/** Merge: the registry says busy/idle right now (it is rewritten on change); the transcript says why (question, done, usage). A stale registry entry (pid gone) is ignored. */
export function claudeState(transcript: SessionState, live: ClaudeLive | undefined, pidAlive: (pid: number) => boolean): SessionState & { live?: string } {
  if (!live || !pidAlive(live.pid)) return { ...transcript, live: live ? 'stale' : undefined };
  if (live.status === 'idle' && transcript.phase === 'working') return { ...transcript, phase: 'turn-done', live: live.status }; // Stop arrives before turn_duration is flushed
  if ((live.status === 'busy' || live.status === 'shell') && transcript.phase === 'turn-done') return { ...transcript, phase: 'working', live: live.status };
  return { ...transcript, live: live.status };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, file] = process.argv.slice(2);
  if (!file || (kind !== 'claude' && kind !== 'codex')) { console.error('usage: parse.ts claude|codex <file.jsonl>'); process.exit(2); }
  const { lines, truncated } = tailLines(file);
  console.log(JSON.stringify(kind === 'claude' ? parseClaude(lines, truncated) : parseCodex(lines, truncated), null, 1));
}
