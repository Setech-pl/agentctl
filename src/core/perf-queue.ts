import { matchesGlob } from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { StatusRow } from './status.ts';
import { cohortKey } from './util.ts';

export interface PerfOrder {
  queuedAt: string;
  perf?: boolean;
  startAfter?: string;
  dailyAt?: string;
  onPass?: string;
  perfWaitSince?: string;
}

export function perfScheduleHold(order: PerfOrder, rows: readonly StatusRow[], now: number): string | undefined {
  if (!order.perf) return undefined;
  const earliest = Math.max(Date.parse(order.queuedAt), order.startAfter ? Date.parse(order.startAfter) : 0);
  const due = new Date(earliest);
  if (order.dailyAt) {
    const [hour, minute] = order.dailyAt.split(':').map(Number);
    due.setHours(hour!, minute!, 0, 0);
    if (due.getTime() < earliest) due.setDate(due.getDate() + 1);
  }
  if (now < due.getTime()) return `perf: start po ${due.toISOString()}`;
  if (order.onPass && !rows.some(row => row.integration && row.verdict === 'PASS' &&
    ((row.cohort && cohortKey(row.cohort) === cohortKey(order.onPass!)) || matchesGlob(row.task, order.onPass!)))) return `perf: czeka na integration PASS (${order.onPass})`;
  return undefined;
}

export function perfExpired(config: GlobalConfig, order: PerfOrder, now: number): boolean {
  return Boolean(order.perfWaitSince && now - Date.parse(order.perfWaitSince) >= config.perf.waitMaxMs);
}
