import type { Context } from './context.ts';
import { readTaskRecord } from './taskstore.ts';
import { AgentctlError, windowName } from './util.ts';

export interface InterruptResult {
  task: string;
  window: string;
  key: string;
}

/**
 * Interrupt the agent's current turn by sending the agent's interrupt key (default: a single Escape).
 * The window stays open and nothing is typed. Send it once: in Codex 0.166.0 a double Escape at an idle
 * prompt opens "edit previous message".
 */
export async function interruptTask(ctx: Context, taskArg: string): Promise<InterruptResult> {
  const { config, runner, tmux } = ctx;
  const window = windowName(taskArg);
  const record = readTaskRecord(config, window);
  if (!record) {
    throw new AgentctlError(
      `unknown task ${taskArg}: no TASK.md in ${config.stateDir}/${window}, so the agent (and its interrupt key) is unknown`,
      'List known tasks with "agentctl status".',
    );
  }
  if (!runner.dryRun) {
    const windows = await tmux.listWindows();
    if (!windows.includes(window)) {
      throw new AgentctlError(`no tmux window "${window}" in session "${config.session}"`, 'The task is dead; see "agentctl status". Nothing to interrupt.');
    }
  }
  const key = config.agents[record.agent === 'unknown' ? 'claude' : record.agent].interruptKey;
  await tmux.sendKey(window, key);
  ctx.info(`${record.task}: sent ${key} to ${config.session}:${window}; the window stays open`);
  return { task: record.task, window, key };
}
