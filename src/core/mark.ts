import type { Context } from './context.ts';
import { allRecords } from './usage.ts';
import { findCohort } from './cohort.ts';
import { markTask } from './history.ts';
import type { Result } from './history.ts';
import { matchTask } from './resolve.ts';
import { AgentctlError, cohortKey } from './util.ts';

export interface MarkSelection { task?: string; tasks?: string[]; cohort?: string }
/** Fully resolve before writing any mark. The same explicit IDs feed preview and execution. */
export function planMark(ctx: Context, selection: MarkSelection): string[] {
  const { task, tasks, cohort } = selection;
  if ([Boolean(task), Boolean(tasks?.length), Boolean(cohort)].filter(Boolean).length !== 1) throw new AgentctlError('give exactly one of task, tasks or cohort');
  const records = allRecords(ctx.config);
  if (cohort) {
    const name = findCohort(ctx.config, cohort).name;
    const ids = records.filter(r => r.cohort && cohortKey(r.cohort) === cohortKey(name)).map(r => r.task);
    if (!ids.length) throw new AgentctlError(`cohort ${name} has no tasks with state files`);
    return [...new Set(ids)];
  }
  return [...new Set((tasks ?? [task!]).map(id => {
    const match = matchTask(id, records.map(r => ({ task: r.task, window: r.window, alive: false })));
    if (match.kind !== 'one') throw new AgentctlError(match.kind === 'none' ? `no task "${id}" with a state file` : `ambiguous task "${id}"`);
    return match.target.task;
  }))];
}
export async function markTasks(ctx: Context, tasks: string[], result: Result, note?: string) {
  // Revalidate the entire selected range before the first history append.
  const selected = planMark(ctx, { tasks });
  const results = [];
  for (const task of selected) results.push(await markTask(ctx, task, result, note));
  return results;
}
