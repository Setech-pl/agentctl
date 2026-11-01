import type { Context } from './context.ts';
import { describeTargets, listTargets, resolveRunningTask } from './resolve.ts';
import type { TaskTarget } from './resolve.ts';
import { AgentctlError } from './util.ts';

/** Printed before the terminal is handed to tmux: the safe way out. */
export const ATTACH_HINT = 'Ctrl-b d – wyjście bez przerywania agenta; nie wciskaj Esc ani Ctrl-c';

export interface AttachOptions {
  /** `$TMUX` is set: switch the current client instead of attaching a new one. */
  insideTmux: boolean;
  /** Pick one of several tasks; absent when there is no terminal to ask on. */
  choose?: (targets: TaskTarget[]) => Promise<TaskTarget | undefined>;
}

/** The task `attach` goes to: the named one, the only running one, or one picked from a list. */
async function pickTask(ctx: Context, taskArg: string | undefined, opts: AttachOptions): Promise<TaskTarget> {
  if (taskArg !== undefined) return resolveRunningTask(ctx, taskArg);
  const running = (await listTargets(ctx)).filter((t) => t.alive);
  if (running.length === 0) {
    throw new AgentctlError(`no running tasks in session "${ctx.config.session}"`, 'Start one with "agentctl new <spec>"; "agentctl status" lists the known tasks.');
  }
  if (running.length === 1) return running[0] as TaskTarget;
  if (!opts.choose) {
    throw new AgentctlError(`more than one running task, name one:\n${describeTargets(running).join('\n')}`, 'Example: "agentctl attach ' + (running[0] as TaskTarget).task + '" (a unique prefix is enough).');
  }
  const chosen = await opts.choose(running);
  if (!chosen) throw new AgentctlError('no task chosen');
  return chosen;
}

/** Make the task's window the current one, in this terminal: switch-client inside tmux, attach-session outside. */
export async function showWindow(ctx: Context, window: string, insideTmux: boolean): Promise<void> {
  const { tmux, config } = ctx;
  if (!(await tmux.hasSession())) {
    throw new AgentctlError(`tmux session "${config.session}" is not running`, 'Start a task with "agentctl new <spec>".');
  }
  const select = await tmux.selectWindow(window);
  if (select.code !== 0) throw new AgentctlError(`cannot select window "${window}": ${select.stderr.trim() || `tmux exit ${select.code}`}`);
  const r = await (insideTmux ? tmux.switchClient() : tmux.attachSession());
  if (r.code !== 0) throw new AgentctlError(`tmux ${insideTmux ? 'switch-client' : 'attach-session'} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
}

/** `agentctl attach [TASK]` */
export async function attachTask(ctx: Context, taskArg: string | undefined, opts: AttachOptions): Promise<TaskTarget> {
  const target = await pickTask(ctx, taskArg, opts);
  ctx.out(ATTACH_HINT);
  await showWindow(ctx, target.window, opts.insideTmux);
  return target;
}

/**
 * `agentctl attach TASK --switch-client`: what a click on a notification runs. No terminal is involved: the task's window is
 * selected and the most recently active client attached to the agentctl session is switched to it.
 */
export async function switchAttachedClient(ctx: Context, taskArg: string): Promise<TaskTarget> {
  const { tmux, config } = ctx;
  const target = await resolveRunningTask(ctx, taskArg);
  const clients = await tmux.clients();
  if (clients.length === 0) {
    throw new AgentctlError(`no tmux client is attached to session "${config.session}"`, `Attach one: tmux attach -t ${config.session}, or run "agentctl attach ${target.task}" in a terminal.`);
  }
  const select = await tmux.selectWindow(target.window);
  if (select.code !== 0) throw new AgentctlError(`cannot select window "${target.window}": ${select.stderr.trim() || `tmux exit ${select.code}`}`);
  const r = await tmux.switchClientTo(clients[0] as string);
  if (r.code !== 0) throw new AgentctlError(`tmux switch-client failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return target;
}
