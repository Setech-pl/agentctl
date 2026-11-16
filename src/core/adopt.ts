import path from 'node:path';
import { remotePath } from './host-task.ts';
import { remoteAttachHint } from './host-runtime.ts';
import fs from 'node:fs';
import type { Context } from './context.ts';
import type { AgentName, Effort } from './config.ts';
import { recordForAdopt, renderTaskMd, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError, TASK_ID, resolvePath, shellQuote, windowName } from './util.ts';

export interface AdoptOptions {
  host?: string;
  remoteReport?: string;
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
export async function adoptTask(ctx: Context, taskArg: string, opts: AdoptOptions, preview = false): Promise<ReturnType<typeof recordForAdopt>> {
  const { config, runner } = ctx;
  const task = taskArg.toUpperCase();
  if (!TASK_ID.test(task)) throw new AgentctlError(`"${taskArg}" is not a task ID`, 'Task IDs look like NC-42: letters, digits, "-" and "_".');
  const window = opts.window ?? windowName(task);
  const file = taskFile(config, windowName(task));
  if (fs.existsSync(file)) {
    throw new AgentctlError(`${task} already has a state file: ${file}`, 'Nothing to restore. Remove the file by hand first if you really want to rebuild it.');
  }
  const report = resolvePath(opts.report);
  if (opts.host && !config.hosts[opts.host]) throw new AgentctlError(`unknown host ${opts.host}`);
  let worktree = opts.worktree ? resolvePath(opts.worktree) : undefined;
  let remoteReport: string | undefined, remoteDir: string | undefined;
  if (opts.host) {
    const remote = ctx.hosts.forHost(opts.host);
    const home = (await remote.checked('sh', ['-c', 'printf "%s" "$HOME"'], {readOnly: true})).stdout.trim();
    if (!path.posix.isAbsolute(home)) throw new AgentctlError('Cannot resolve remote HOME');
    const root = remotePath(config.hosts[opts.host]!.workDir, home);
    worktree = opts.worktree ? remotePath(opts.worktree, home, root) : undefined;
    if (worktree && (await remote.exec('test', ['-d', worktree], {readOnly: true})).code !== 0) throw new AgentctlError('Remote worktree missing');
    remoteDir = path.posix.join(root, '.agentctl', windowName(task));
    remoteReport = opts.remoteReport ? remotePath(opts.remoteReport, home) : path.posix.join(root, 'reports', windowName(task), `${task}.md`);
  }
  if (!opts.host && worktree && !runner.dryRun && !fs.existsSync(worktree)) throw new AgentctlError(`worktree ${worktree} does not exist`);
  const input = { task, window, report, session: opts.host ? `agentctl-${opts.host}` : config.session, ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(worktree ? { worktree } : {}) };
  const record = recordForAdopt(input, runner.now());
  if (opts.host) Object.assign(record, {host: opts.host, remoteDir, remoteReport});
  const windows = await (opts.host ? ctx.hosts.tmux(opts.host) : ctx.tmux).windows();
  const found = windows.filter(w => w.plain === window || opts.host && w.role === windowName(task));
  if (opts.host && found.length !== 1) throw new AgentctlError('Cannot uniquely rediscover remote window by task ID');
  const windowId = found[0]?.id;
  if (windowId) record.windowId = windowId;
  if (preview) { delete record.adopted; return record; }
  const body = `Restored by "agentctl adopt" on ${record.adopted}: the original prompt of this task is lost.`;
  await runner.mkdir(taskDir(config, windowName(task)));
  await runner.writeFile(file, renderTaskMd(record, body));
  ctx.info(`${task}: state restored in ${file} (window ${config.session}:${window}, report ${report}${fs.existsSync(report) ? '' : ' – does not exist yet'})`);
  const unknown = [!opts.agent && 'agent', !opts.model && 'model', !opts.effort && 'effort'].filter(Boolean);
  if (unknown.length) ctx.info(`${task}: ${unknown.join(', ')} unknown; pass --agent/--model/--effort to record them`);
  ctx.info(`Check: agentctl status. Window contents: agentctl peek ${shellQuote(task)}, or tmux capture-pane -p -t ${shellQuote(`=${config.session}:${window}`)}`);
  if (opts.host) { await ctx.hosts.trackHost(opts.host); ctx.info(remoteAttachHint(config, record)!); }
  return record;
}
