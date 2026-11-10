import type { GlobalConfig } from './config.ts';
import type { QueueEntry } from './queue.ts';
import { splitSpecs } from './spec.ts';
import { readTaskRecord } from './taskstore.ts';

export function isHeavy(entry: Pick<QueueEntry, 'spec'>): boolean {
  try { return splitSpecs(entry.spec, 'heavy admission')[0]?.header.weight === 'heavy'; }
  catch { return false; } // malformed specs fail normal start validation
}
/** Count task identities once: a starting entry and its new window can overlap. */
export function heavyBudget(config: GlobalConfig, entries: QueueEntry[], live: {window?: string}[]): Set<string> {
  const windows = new Set(live.map(w => w.window));
  return new Set([
    ...[...windows].flatMap(window => { const r = window ? readTaskRecord(config, window) : undefined; return r?.weight === 'heavy' ? [r.task] : []; }),
    ...entries.filter(e => e.status === 'starting' && isHeavy(e)).map(e => e.task),
  ]);
}
export function heavyWait(config: GlobalConfig, heavy: boolean, used: number): string | undefined {
  const limit = config.limits.heavy ?? 1;
  return heavy && used >= limit ? `czeka na heavy slot: heavy ${used}/${limit} (across providers)` : undefined;
}

export function heavyPreviewUsed(config: GlobalConfig, entries: QueueEntry[], live: {window?: string}[]): number {
  const active = heavyBudget(config, entries, live).size;
  return Math.max(active, Math.min(config.limits.heavy ?? 1, active + entries.filter(e => e.status === 'queued' && isHeavy(e)).length));
}
