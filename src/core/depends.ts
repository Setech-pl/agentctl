import type { OutputVerdict } from './outputs.ts';
import type { Context } from './context.ts';
import type { QueueEntry } from './queue.ts';
import type { StatusRow } from './status.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import { BLOCKED_ICON } from './icons.ts';
import { Problems } from './util.ts';

/*
 * `after: <TASK>` in a spec: the task starts only when every task it names has a report. A task has one when it is `report-ready`,
 * or closed with a report file left behind (closing does not delete the report).
 */

/** The task has a report: `report-ready`, or closed with a report. */
export function hasReport(row: StatusRow | undefined): boolean {
  return row !== undefined && row.report === 'yes' && (row.state === 'report-ready' || row.closed);
}

/** The tasks of `after` that do not have a report yet (a task that does not exist yet, one in the queue, one still working). */
export const DEFAULT_AFTER_VERDICTS: OutputVerdict[] = ['PASS', 'PARTIAL'];

export function unmetAfter(after: readonly string[], rows: readonly StatusRow[], verdicts: Record<string, OutputVerdict[]> = {}): string[] {
  return after.filter(task => { const row = rows.find(r => r.task === task); return !hasReport(row) || (!row?.verdict || !(verdicts[task] ?? DEFAULT_AFTER_VERDICTS).includes(row.verdict)); });
}

/** "czeka na NC-4, NC-5": what a waiting task is waiting for; `failed` are the ones whose start failed in the queue, `cancelled` the ones that were cancelled. */
export function waitingText(unmet: readonly string[], failed: ReadonlySet<string> = new Set(), cancelled: ReadonlySet<string> = new Set()): string {
  return `czeka na ${unmet.map((t) => (cancelled.has(t) ? `${t} (anulowane)` : failed.has(t) ? `${t} (failed)` : t)).join(', ')}`;
}

/** The tasks that were cancelled (`agentctl cancel`). */
export function cancelledTasks(rows: readonly StatusRow[]): Set<string> {
  return new Set(rows.filter((r) => r.cancelled).map((r) => r.task));
}

/** The time of the watcher's look and `report.settle_s`: a report that changed within the settle time is still being written. */
export interface VerdictClock { nowMs: number; settleS: number }

/**
 * P94: a report without a readable first-line verdict is not a verdict yet while its author can still write one: the task is alive (its window
 * is up and it is neither closed nor cancelled) or the report changed within `report.settle_s`. Only then does a missing verdict block.
 */
export function verdictPending(row: StatusRow | undefined, clock?: VerdictClock): boolean {
  if (!row || row.verdict) return false;
  if (row.window === 'alive' && !row.closed && !row.cancelled) return true;
  return clock !== undefined && clock.settleS > 0 && row.reportMtime !== undefined && clock.nowMs - row.reportMtime < clock.settleS * 1000;
}

/** What keeps a queued task from ever starting: the cancelled tasks its `after` names, and the queued tasks that are blocked themselves. */
export interface Blockers {
  cancelled: string[];
  blocked: string[];
  verdicts?: Array<{ task: string; reason: string }>;
}

/**
 * The queued tasks that are blocked, with the cause. A task is blocked while its `after` names a cancelled task: it would wait for a report
 * that never comes, or a report whose first-line verdict is not accepted (FAIL, BLOCKED, NO-GO by default), or one without a verdict once its
 * author can no longer write it (closed, cancelled, window gone, report settled; P94). A missing verdict of a live author is waiting, not
 * blocked. A task that waits for a blocked task is blocked too. The way out is `agentctl unblock` or `agentctl cancel`.
 */
export function findBlocked(entries: readonly Pick<QueueEntry, 'task' | 'after' | 'status' | 'afterVerdicts'>[], rows: readonly StatusRow[], clock?: VerdictClock): Map<string, Blockers> {
  const cancelled = cancelledTasks(rows);
  const blocked = new Map<string, Blockers>();
  const waiting = entries.filter((e) => e.status === 'queued');
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of waiting) {
      const b: Blockers = { cancelled: e.after.filter((t) => cancelled.has(t)), blocked: e.after.filter((t) => blocked.has(t)) };
      const verdicts = e.after.flatMap(task => {
        const allowed = e.afterVerdicts?.[task] ?? DEFAULT_AFTER_VERDICTS;
        const row = rows.find(r => r.task === task);
        return hasReport(row) && !verdictPending(row, clock) && (!row?.verdict || !allowed.includes(row.verdict)) ? [{ task, reason: row?.verdict ? `verdict ${row.verdict}` : 'verdict missing/unparsable (brak werdyktu)' }] : [];
      });
      if (verdicts.length) b.verdicts = verdicts;
      if (b.cancelled.length + b.blocked.length + verdicts.length === 0) continue;
      const known = blocked.get(e.task);
      if (known && known.cancelled.length === b.cancelled.length && known.blocked.length === b.blocked.length && JSON.stringify(known.verdicts) === JSON.stringify(b.verdicts)) continue;
      blocked.set(e.task, b);
      grew = true;
    }
  }
  return blocked;
}

/** "⛓ zablokowane – NC-1 anulowane": the cause shown by `status`, `queue list` and the board. */
export function blockedText(b: Blockers): string {
  if (b.verdicts?.length && !b.cancelled.length && !b.blocked.length) return `waiting: ${b.verdicts.map(v => `${v.task} ${v.reason}`).join(', ')}`;
  return `${BLOCKED_ICON} zablokowane – ${[...b.cancelled.map((t) => `${t} anulowane`), ...b.blocked.map((t) => `${t} zablokowane`), ...(b.verdicts ?? []).map(v => `${v.task}: ${v.reason}`)].join(', ')}`;
}

/** Tasks that exist: started (also closed and archived ones) or waiting in the queue. */
function knownTasks(ctx: Context, entries: readonly QueueEntry[]): Set<string> {
  return new Set([...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)].map((r) => r.task).concat(entries.map((e) => e.task)));
}

/**
 * Check the `after` of tasks that are about to be added: every named task must exist (be started, be in the queue or be in the same
 * batch), and the tasks of the queue and the batch together must not wait for each other in a circle. Collects every problem.
 */
export function checkAfter(ctx: Context, batch: readonly { task: string; after: readonly string[] }[], entries: readonly QueueEntry[]): void {
  const p = new Problems();
  const known = knownTasks(ctx, entries);
  for (const b of batch) known.add(b.task);
  const cancelled = new Set([...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)].filter((r) => r.cancelled).map((r) => r.task));
  const revived = new Set([...batch.map((b) => b.task), ...entries.map((e) => e.task)]);
  // task -> the tasks it waits for, among those that have not started yet
  const edges = new Map<string, readonly string[]>(entries.map((e) => [e.task, e.after ?? []]));
  for (const b of batch) edges.set(b.task, b.after);
  for (const b of batch) {
    for (const dep of b.after) {
      if (dep === b.task) p.add(`${b.task}: after names the task itself`);
      else if (!known.has(dep)) p.add(`${b.task}: after ${dep}: there is no such task (not started, not in the queue, not in this file)`);
      else if (cancelled.has(dep) && !revived.has(dep)) p.add(`${b.task}: after ${dep}: ${dep} was cancelled, so it never gets a report`);
    }
  }
  for (const b of batch) {
    const path = findCycle(b.task, edges);
    if (path && path.length > 2) p.add(`${b.task}: after makes a circle: ${path.join(' -> ')}`);
  }
  p.throwIfAny('Cannot queue the tasks:', 'A task starts when every task in its "after" has a report; a circle would wait forever.');
}

/** A path from `start` back to `start` through the waiting edges, or undefined. */
function findCycle(start: string, edges: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visit = (node: string, trail: string[], seen: Set<string>): string[] | undefined => {
    for (const next of edges.get(node) ?? []) {
      if (next === start) return [...trail, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = visit(next, [...trail, next], seen);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(start, [start], new Set([start]));
  return found && found.length > 1 ? found : undefined;
}
