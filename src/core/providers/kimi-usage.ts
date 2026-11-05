import fs from 'node:fs';
import path from 'node:path';
import type { UsageSupport, UsageCandidate, SessionRef } from './types.ts';
import type { GlobalConfig } from '../config.ts';
import type { UsageReader } from '../usage-sources.ts';
import type { TaskRecord } from '../taskstore.ts';
import type { SessionStats, PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { num, str, timeOf, touch, addToBucket } from '../usage-parse.ts';
import { planState } from '../usage.ts';
import { homeDir } from '../usage-sources.ts';
import { kimiHome } from './kimi-config.ts';
import { isObject } from '../util.ts';
import { within } from './usage-shared.ts';
import { refreshKimiPlan } from './kimi-probe.ts';

export const kimiPlanFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(homeDir(config), 'usage', 'kimi-plan.json');
export function readKimiSnapshot(config: Pick<GlobalConfig, 'path'>): PlanSnapshot | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(kimiPlanFile(config), 'utf8'));
    if (!isObject(value) || typeof value.at !== 'number' || !Array.isArray(value.windows)) return undefined;
    const windows = value.windows.filter((w): w is PlanWindow => isObject(w) && ['session', 'week', 'other'].includes(String(w.kind)) && typeof w.usedPercent === 'number' && w.usedPercent >= 0 && w.usedPercent <= 100 && (w.resetsAt === null || typeof w.resetsAt === 'number'));
    return windows.length ? { at: value.at, planType: typeof value.planType === 'string' ? value.planType : null, windows } : undefined;
  } catch { return undefined; }
}

/** [hypothesis] Session layout from the design; only under sessions/, never credentials. */
export function kimiSessions(reader: UsageReader, home: string, record: TaskRecord, worktrees: string[], known: SessionRef[]): UsageCandidate[] {
  const root = path.join(home, 'sessions'), candidates: string[] = [];
  for (const workspace of reader.list(root)) {
    const dir = path.join(root, workspace);
    for (const session of reader.list(dir)) {
      const base = path.join(dir, session);
      const file = path.join(base, 'agents', 'main', 'wire.jsonl');
      candidates.push(file);
    }
  }
  const ids = new Set(known.map(s => s.id));
  return candidates.flatMap(file => {
    const meta = reader.meta(file, 'kimi');
    if (!meta) return [];
    const explicit = meta.id !== null && ids.has(meta.id);
    return explicit || (meta.cwd && worktrees.some(w => within(meta.cwd!, w))) ? [{ file, firstAt: meta.firstAt, explicit }] : [];
  });
}

export function wireObject(line: string): Record<string, unknown> | undefined {
  try { const o: unknown = JSON.parse(line); return isObject(o) ? o : undefined; } catch { return undefined; }
}
export function wirePayload(o: Record<string, unknown>): Record<string, unknown> {
  return isObject(o.event) ? o.event : o;
}
export function wireProtocol(o: Record<string, unknown>): string | undefined {
  const meta = isObject(o.metadata) ? o.metadata : o;
  return typeof meta.protocol_version === 'string' ? meta.protocol_version : undefined;
}
/** Protocol gate precedes every event. Unknown versions never contribute tokens. */
export function feedKimiLine(stats: SessionStats, line: string): void {
  const o = wireObject(line);
  if (!o) return;
  const protocol = wireProtocol(o);
  if (protocol !== undefined) stats.kimi = { protocol };
  const event = wirePayload(o), data = isObject(event.data) ? event.data : event;
  const ms = timeOf(o.timestamp ?? event.timestamp);
  const metadata = isObject(o.metadata) ? o.metadata : o;
  if (typeof metadata.session_id === 'string') stats.id = metadata.session_id;
  if (typeof metadata.cwd === 'string') stats.cwd = metadata.cwd;
  touch(stats, ms);
  if (stats.kimi?.protocol !== '1.5') return;
  const type = str(event.type);
  if (type === 'llm.request') stats.observed = { model: str(data.model) || stats.observed?.model || 'unknown', effort: str(data.effort) || stats.observed?.effort || 'unknown', cliVersion: str(data.cli_version) || stats.observed?.cliVersion || 'unknown' };
  if (type !== 'usage.record') return; // token_counting.* describes context, not billable usage
  const u = isObject(data.usage) ? data.usage : data;
  const id = str(event.id ?? data.id);
  if (id && stats.seen[id]) return;
  const tokens = { input: num(u.inputOther), output: num(u.output), cacheRead: num(u.inputCacheRead), cacheWrite: num(u.inputCacheCreation) };
  addToBucket(stats, ms, str(data.model) || stats.observed?.model || 'unknown', tokens);
  if (id) { stats.seen[id] = tokens; stats.seenOrder.push(id); while (stats.seenOrder.length > 256) delete stats.seen[stats.seenOrder.shift()!]; }
}
export const kimiUsage: UsageSupport = {
  home: (config, env = process.env) => config.usage.kimiDir ?? kimiHome(env), homeEnv: 'KIMI_CODE_HOME',
  sessions: (reader, home, record, worktrees, known) => kimiSessions(reader, home, record, worktrees, known),
  feedLine: feedKimiLine,
  readPlan(config, _reader, now) {
    const plan = planState('kimi', readKimiSnapshot(config), now, config.capacity.kimiUsageProbe ? 'no Kimi /usage probe reading yet; neutral folder needs manual trust' : 'capacity.kimi_usage_probe is off; plan limits n/d');
    plan.source = 'kimi-usage-probe';
    for (const w of plan.windows) if (w.minutes === 43200) w.label = 'month';
    return plan;
  },
  refreshPlan: refreshKimiPlan, planSources: ['kimi-usage-probe'],
};
