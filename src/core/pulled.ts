import type { Context } from './context.ts';
import { collectStatus } from './status.ts';
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
  return (await collectStatus(ctx, { progress: false })).filter(r => pulledOpen(r) && cohortKey(r.cohort ?? '') === cohortKey(cohort)).map(r => r.task);
}

export function checkPulledClose(cohort: string | undefined, tasks: readonly string[] | undefined, remove: boolean | undefined): void {
  if (cohort === undefined || tasks?.length || remove) throw new AgentctlError('pulled requires cohort, without task IDs or worktree removal');
}
