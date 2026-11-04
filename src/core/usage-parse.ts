import { provider as adapter } from './providers/registry.ts';
export { feedClaudeLine } from './providers/claude-parse.ts';
export { feedCodexLine, parseCodexRateLimits } from './providers/codex-parse.ts';
import type { AgentName } from './config.ts';
import { isObject } from './util.ts';

/*
 * Readers of the agents' own logs: how many tokens a session used, and (Codex) the state of the plan.
 *
 * Claude Code 2.1.309 writes every message of a session to `<claude home>/projects/<cwd with non-alphanumerics as "-">/<session id>.jsonl`;
 * an `assistant` line carries `message.usage` (input, output, cache read, cache creation) and `message.model`. One API message is written
 * once per content block (same `message.id`, same usage), so it is counted once. Subagents write `<session id>/subagents/agent-*.jsonl`.
 * Codex 0.166.0 writes `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`: `session_meta` (id, cwd), `turn_context` (model, effort)
 * and `event_msg` `token_count` with the cumulative `total_token_usage` of the session and the plan's `rate_limits`.
 */

/** Tokens normalised over both providers. Codex's `input_tokens` contains the cached part; here `input` is only the fresh part. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of output, never added to fresh tokens. */
  reasoning_output_tokens?: number;
}

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, ...((a.reasoning_output_tokens !== undefined || b.reasoning_output_tokens !== undefined) ? { reasoning_output_tokens: (a.reasoning_output_tokens ?? 0) + (b.reasoning_output_tokens ?? 0) } : {}) };
}

/**
 * The number shown as "tokens": what was processed anew (input, output, and what was written to the cache). Cache reads are left out:
 * a long session re-reads its context on every turn, and they would drown the rest. They are kept apart in `cacheRead`.
 */
export const freshTokens = (t: Tokens): number => t.input + t.output + t.cacheWrite;

export const isZero = (t: Tokens): boolean => t.input === 0 && t.output === 0 && t.cacheRead === 0 && t.cacheWrite === 0;

/** "1.2M", "340k", "950": three significant digits at most. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

/** Local calendar day, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** What was seen of one plan window. `resetsAt` is epoch seconds. */
export interface PlanWindow {
  /** `session`: the 5-hour window; `week`: the weekly one; `other`: a window of another length (`minutes` says which). */
  kind: 'session' | 'week' | 'other';
  minutes: number | null;
  usedPercent: number;
  resetsAt: number | null;
}

/** The plan as one log line said it, at the time of that line. */
export interface PlanSnapshot {
  /** ms */
  at: number;
  planType: string | null;
  windows: PlanWindow[];
}

export function windowKind(minutes: number | null): PlanWindow['kind'] {
  if (minutes === null) return 'other';
  if (minutes >= 300 - 30 && minutes <= 360) return 'session';
  if (minutes >= 10_000 && minutes <= 10_200) return 'week';
  return 'other';
}

/** Everything one session file adds up to; `seen`, `codex` and the like are the parser's memory, kept so a file can be read on from an offset. */
export interface SessionStats {
  provider: AgentName;
  observed?: { model: string; effort: string; cliVersion: string };
  id: string | null;
  cwd: string | null;
  /** ms of the first and the last line that has a time. */
  firstAt: number | null;
  lastAt: number | null;
  /** `<local day>|<model>` -> tokens. */
  buckets: Record<string, Tokens>;
  /** Claude: messages counted lately (id -> the usage counted), so that the next block of the same message adds only what grew. */
  seen: Record<string, Tokens>;
  seenOrder: string[];
  /** Codex: the cumulative total of the last `token_count`, the model of the current turn. */
  codex: { total: Tokens | null; model: string | null };
  /** Codex: the newest `rate_limits` of the file. */
  plan: PlanSnapshot | null;
}

export function emptyStats(provider: AgentName): SessionStats {
  return { provider, id: null, cwd: null, firstAt: null, lastAt: null, buckets: {}, seen: {}, seenOrder: [], codex: { total: null, model: null }, plan: null };
}

/** The blocks of one message are written one after another: a few ids are enough to tell them from the next message. */
const SEEN_MAX = 16;

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function touch(stats: SessionStats, ms: number | null): void {
  if (ms === null) return;
  stats.firstAt = stats.firstAt === null ? ms : Math.min(stats.firstAt, ms);
  stats.lastAt = stats.lastAt === null ? ms : Math.max(stats.lastAt, ms);
}

export function timeOf(v: unknown): number | null {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

export function addToBucket(stats: SessionStats, ms: number | null, model: string, t: Tokens): void {
  if (isZero(t)) return;
  const key = `${localDay(ms ?? stats.lastAt ?? Date.now())}|${model || 'unknown'}`;
  stats.buckets[key] = addTokens(stats.buckets[key] ?? zeroTokens(), t);
}

export function feedLine(stats: SessionStats, line: string): void {
  adapter(stats.provider).usage.feedLine(stats, line);
}

/** Feed every complete line of `text`; returns how many bytes were consumed (a last line without "\n" is left for the next read). */
export function feedText(stats: SessionStats, text: string): number {
  const end = text.lastIndexOf('\n');
  if (end < 0) return 0;
  for (const line of text.slice(0, end).split('\n')) if (line !== '') feedLine(stats, line);
  return Buffer.byteLength(text.slice(0, end + 1));
}

/** Tokens of the buckets of a session: all of them, or only those from `sinceDay` on (`YYYY-MM-DD`), optionally one model. */
export function sumBuckets(buckets: Record<string, Tokens>, filter: { sinceDay?: string | undefined; model?: string | undefined } = {}): Tokens {
  let sum = zeroTokens();
  for (const [key, t] of Object.entries(buckets)) {
    const [day = '', model = ''] = key.split('|');
    if (filter.sinceDay !== undefined && day < filter.sinceDay) continue;
    if (filter.model !== undefined && model !== filter.model) continue;
    sum = addTokens(sum, t);
  }
  return sum;
}
