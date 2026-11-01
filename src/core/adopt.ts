import fs from 'node:fs';
import type { Context } from './context.ts';
import type { AgentName, Effort } from './config.ts';
import { recordForAdopt, renderTaskMd, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError, TASK_ID, resolvePath, shellQuote, windowName } from './util.ts';

export interface AdoptOptions {
  report: string;
  window?: string;
  worktree?: string;
  agent?: AgentName;
  model?: string;
  effort?: Effort;
}

/**
 * `adopt`: write a new state file (TASK.md in the state directory) for a task whose own was lost.
 * Only what is given is known; the rest stays "unknown". The original prompt cannot be restored.
 */
export async function adoptTask(ctx: Context, taskArg: string, opts: AdoptOptions): Promise<void> {
  const { config, runner } = ctx;
  const task = taskArg.toUpperCase();
  if (!TASK_ID.test(task)) throw new AgentctlError(`"${taskArg}" is not a task ID`, 'Task IDs look like NC-42: letters, digits, "-" and "_".');
  const window = opts.window ?? windowName(task);
  const file = taskFile(config, windowName(task));
  if (fs.existsSync(file)) {
    throw new AgentctlError(`${task} already has a state file: ${file}`, 'Nothing to restore. Remove the file by hand first if you really want to rebuild it.');
  }
  const report = resolvePath(opts.report);
  const worktree = opts.worktree ? resolvePath(opts.worktree) : undefined;
  if (worktree && !runner.dryRun && !fs.existsSync(worktree)) throw new AgentctlError(`worktree ${worktree} does not exist`);
  const input = { task, window, report, session: config.session, ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(worktree ? { worktree } : {}) };
  const record = recordForAdopt(input, runner.now());
  const windowId = (await ctx.tmux.windows()).find((w) => w.plain === window)?.id;
  if (windowId) record.windowId = windowId;
  const body = `Restored by "agentctl adopt" on ${record.adopted}: the original prompt of this task is lost.`;
  await runner.mkdir(taskDir(config, windowName(task)));
  await runner.writeFile(file, renderTaskMd(record, body));
  ctx.info(`${task}: state restored in ${file} (window ${config.session}:${window}, report ${report}${fs.existsSync(report) ? '' : ' – does not exist yet'})`);
  const unknown = [!opts.agent && 'agent', !opts.model && 'model', !opts.effort && 'effort'].filter(Boolean);
  if (unknown.length) ctx.info(`${task}: ${unknown.join(', ')} unknown; pass --agent/--model/--effort to record them`);
  ctx.info(`Check: agentctl status. Window contents: agentctl peek ${shellQuote(task)}, or tmux capture-pane -p -t ${shellQuote(`=${config.session}:${window}`)}`);
}
