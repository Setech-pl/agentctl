import type { Context } from './context.ts';
import { collectStatus } from './status.ts';
import { listTaskRecords } from './taskstore.ts';
import type { StatusRow } from './status.ts';
import { cohortKey, AgentctlError } from './util.ts';

/** Only acknowledgements of the current report qualify; collectStatus invalidates stale pulls. */
export function pulledOpen(row: Pick<StatusRow, 'state' | 'pulled' | 'closed' | 'cancelled'>): boolean {
  return row.state === 'report-ready' && row.pulled !== null && !row.closed && !row.cancelled;
}

export function pulledSummary(rows: StatusRow[]): string[] {
  const pulled = rows.filter(pulledOpen);
  return pulled.length ? [`odebrane, niezamknięte: ${pulled.map(r => r.task).join(', ')}`] : [];
}

export async function pulledCohortTasks(ctx: Context, cohort: string): Promise<string[]> {
  const key = cohortKey(cohort);
  const current = listTaskRecords(ctx.config).filter(r => !r.closed && !r.cancelled && r.pulled && cohortKey(r.cohort ?? '') === key);
  if (!current.length) return [];
  // Validate current reports only inside the chosen cohort; unrelated reports and orphan windows are out of scope.
  const rows = await collectStatus(ctx, { progress: false, cachedOnly: true, orphans: false, records: { current, archived: [] } });
  return rows.filter(pulledOpen).map(r => r.task);
}

export function checkPulledClose(cohort: string | undefined, tasks: readonly string[] | undefined, remove: boolean | undefined): void {
  if (cohort === undefined || tasks?.length || remove) throw new AgentctlError('pulled requires cohort, without task IDs or worktree removal');
}
