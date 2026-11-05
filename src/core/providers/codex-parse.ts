import type { SessionStats, Tokens, PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { num, str, touch, timeOf, addToBucket, windowKind } from '../usage-parse.ts';
import { isObject } from '../util.ts';
/** The plan of a `rate_limits` object (Codex), or null when it has no window: the `premium` limit has none. */
export function parseCodexRateLimits(v: unknown, at: number): PlanSnapshot | null {
  if (!isObject(v)) return null;
  const windows: PlanWindow[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = v[key];
    if (!isObject(w) || typeof w.used_percent !== 'number') continue;
    const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : null;
    windows.push({ kind: windowKind(minutes), minutes, usedPercent: w.used_percent, resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null });
  }
  if (windows.length === 0) return null;
  return { at, planType: typeof v.plan_type === 'string' ? v.plan_type : null, windows };
}

/** One line of a Codex session. */
export function feedCodexLine(stats: SessionStats, line: string): void {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(o) || !isObject(o.payload)) return;
  const ms = timeOf(o.timestamp);
  touch(stats, ms);
  const p = o.payload;
  if (o.type === 'session_meta') {
    stats.observed = { model: stats.observed?.model ?? 'unknown', effort: stats.observed?.effort ?? 'unknown', cliVersion: typeof p.cli_version === 'string' ? p.cli_version : 'unknown' };
    if (typeof p.id === 'string') stats.id = p.id;
    if (typeof p.cwd === 'string') stats.cwd = p.cwd;
    touch(stats, timeOf(p.timestamp));
    return;
  }
  if (o.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model !== '') stats.codex.model = p.model;
    stats.observed = { model: stats.codex.model ?? 'unknown', effort: typeof p.effort === 'string' ? p.effort : typeof p.reasoning_effort === 'string' ? p.reasoning_effort : 'unknown', cliVersion: stats.observed?.cliVersion ?? 'unknown' };
    return;
  }
  if (o.type !== 'event_msg' || p.type !== 'token_count') return;
  const snapshot = parseCodexRateLimits(p.rate_limits, ms ?? 0);
  if (snapshot && ms !== null && (stats.plan === null || stats.plan.at <= ms)) stats.plan = snapshot;
  const info = isObject(p.info) ? p.info : undefined;
  const raw = info && isObject(info.total_token_usage) ? info.total_token_usage : undefined;
  if (!raw) return;
  const cached = num(raw.cached_input_tokens);
  const total: Tokens = { input: Math.max(0, num(raw.input_tokens) - cached), output: num(raw.output_tokens), cacheRead: cached, cacheWrite: num(raw.cache_write_input_tokens), ...(typeof raw.reasoning_output_tokens === 'number' ? { reasoning_output_tokens: Math.min(num(raw.reasoning_output_tokens), num(raw.output_tokens)) } : {}) };
  const before = stats.codex.total;
  // The total only grows; a smaller one means a new count (a session continued from a compacted state): that count is new work.
  const shrank = before !== null && (total.input < before.input || total.output < before.output || total.cacheRead < before.cacheRead);
  const delta: Tokens = before === null || shrank
    ? total
    : { input: total.input - before.input, output: total.output - before.output, cacheRead: total.cacheRead - before.cacheRead, cacheWrite: Math.max(0, total.cacheWrite - before.cacheWrite), ...(total.reasoning_output_tokens !== undefined ? { reasoning_output_tokens: Math.max(0, total.reasoning_output_tokens - (before.reasoning_output_tokens ?? 0)) } : {}) };
  stats.codex.total = total;
  addToBucket(stats, ms, stats.codex.model ?? 'unknown', delta);
}
