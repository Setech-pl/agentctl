import type { SessionStats, Tokens, PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { num, str, touch, timeOf, addToBucket, windowKind } from '../usage-parse.ts';
import { isObject } from '../util.ts';
const SEEN_MAX = 16;
/** One line of a Claude transcript. Lines that are not JSON, or not about tokens, only move the clock. */
export function feedClaudeLine(stats: SessionStats, line: string): void {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (!isObject(o)) return;
  const ms = timeOf(o.timestamp);
  touch(stats, ms);
  if (stats.id === null && typeof o.sessionId === 'string') stats.id = o.sessionId;
  if (stats.cwd === null && typeof o.cwd === 'string') stats.cwd = o.cwd;
  if (typeof o.version === 'string') stats.observed = { model: stats.observed?.model ?? 'unknown', effort: stats.observed?.effort ?? 'unknown', cliVersion: o.version };
  if (o.type !== 'assistant' || !isObject(o.message) || !isObject(o.message.usage)) return;
  const model = str(o.message.model);
  if (model === '' || model.startsWith('<')) return; // "<synthetic>": a message the client made up (an API error), not a request
  stats.observed = { model, effort: typeof o.message.effort === 'string' ? o.message.effort : stats.observed?.effort ?? 'unknown', cliVersion: stats.observed?.cliVersion ?? 'unknown' };
  const u = o.message.usage;
  const now: Tokens = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
  const id = str(o.message.id) || str(o.requestId) || str(o.uuid);
  const prev = id !== '' ? stats.seen[id] : undefined;
  // Another block of a message already counted: what grew since (the output of a streamed message), never more.
  const grown: Tokens = prev
    ? { input: Math.max(0, now.input - prev.input), output: Math.max(0, now.output - prev.output), cacheRead: Math.max(0, now.cacheRead - prev.cacheRead), cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite) }
    : now;
  addToBucket(stats, ms, model, grown);
  if (id !== '') {
    stats.seen[id] = prev ? { input: Math.max(prev.input, now.input), output: Math.max(prev.output, now.output), cacheRead: Math.max(prev.cacheRead, now.cacheRead), cacheWrite: Math.max(prev.cacheWrite, now.cacheWrite) } : now;
    if (!prev) stats.seenOrder.push(id);
    while (stats.seenOrder.length > SEEN_MAX) delete stats.seen[stats.seenOrder.shift() as string];
  }
}

