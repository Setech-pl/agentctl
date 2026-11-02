import type { Context } from './context.ts';
import type { QueueEntry } from './queue.ts';
import type { StatusRow } from './status.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
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
export function unmetAfter(after: readonly string[], rows: readonly StatusRow[]): string[] {
  return after.filter((task) => !hasReport(rows.find((r) => r.task === task)));
}

/** "czeka na NC-4, NC-5": what a waiting task is waiting for; `queued` are the ones that still wait in the queue themselves. */
export function waitingText(unmet: readonly string[], failed: ReadonlySet<string> = new Set()): string {
  return `czeka na ${unmet.map((t) => (failed.has(t) ? `${t} (failed)` : t)).join(', ')}`;
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
  // task -> the tasks it waits for, among those that have not started yet
  const edges = new Map<string, readonly string[]>(entries.map((e) => [e.task, e.after ?? []]));
  for (const b of batch) edges.set(b.task, b.after);
  for (const b of batch) {
    for (const dep of b.after) {
      if (dep === b.task) p.add(`${b.task}: after names the task itself`);
      else if (!known.has(dep)) p.add(`${b.task}: after ${dep}: there is no such task (not started, not in the queue, not in this file)`);
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
