import type { Context } from './context.ts';
import { describeTargets, matchTask } from './resolve.ts';
import type { TaskTarget } from './resolve.ts';
import { listTaskRecords, setHeaderField, taskFile } from './taskstore.ts';
import { AgentctlError } from './util.ts';

export interface HideResult {
  task: string;
  /** The window of the task is still there: hiding it takes a live agent off the board and `status`. */
  windowAlive: boolean;
  /** Nothing changed: the flag already had this value. */
  unchanged: boolean;
}

/**
 * `hide` / `unhide`: set `hidden` in the TASK.md of each task. Hiding takes the task off the board and `status` (they show it
 * again with `--all` / the `a` key); the task, its window and its worktree are not touched. `unhide` writes `hidden: false`, so the
 * automatic hiding of pulled finished tasks (`board.auto_hide_pulled_dead`) leaves a task you brought back alone.
 * All names are resolved first: one that does not match stops everything before anything is written.
 */
export async function setHidden(ctx: Context, taskArgs: string[], hidden: boolean): Promise<HideResult[]> {
  const live = new Set(await ctx.tmux.listWindows());
  const records = listTaskRecords(ctx.config);
  const targets: TaskTarget[] = records.map((r) => ({ task: r.task, window: r.window, alive: live.has(r.window) }));
  const chosen: typeof records = [];
  for (const arg of taskArgs) {
    const match = matchTask(arg, targets);
    if (match.kind === 'many') throw new AgentctlError(`"${arg}" fits more than one task:\n${describeTargets(match.matches).join('\n')}`, 'Type more of the task ID.');
    if (match.kind === 'none') throw new AgentctlError(`no task "${arg}" with a state file`, 'See "agentctl status --all". A window without a state file (orphan) cannot be hidden: restore it with "agentctl adopt".');
    const record = records.find((r) => r.window === match.target.window);
    if (record && !chosen.includes(record)) chosen.push(record);
  }
  const results: HideResult[] = [];
  for (const record of chosen) {
    const unchanged = record.hidden === hidden;
    if (!unchanged) await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'hidden', hidden);
    results.push({ task: record.task, windowAlive: live.has(record.window), unchanged });
  }
  return results;
}
