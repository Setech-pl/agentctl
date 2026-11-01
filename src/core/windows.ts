import type { Context } from './context.ts';
import { AgentctlError } from './util.ts';

/** Name of the tmux window that runs `agentctl board` (like WATCH_WINDOW, it is not a task). */
export const BOARD_WINDOW = 'board';

export type EnsureResult = 'created' | 'session-created' | 'exists' | 'restarted';

/**
 * Make sure `window` exists in the agentctl session, running `commandLine` as the window's own process (the session is created if it is not
 * up yet). Never starts a second copy; a window whose process has ended (and that was kept with its error on screen) is started again.
 */
export async function ensureWindow(ctx: Context, window: string, commandLine: string, cwd: string): Promise<EnsureResult> {
  const { tmux } = ctx;
  const sessionUp = await tmux.hasSession();
  if (sessionUp && (await tmux.listWindows()).includes(window)) {
    if (!(await tmux.paneDead(window))) return 'exists';
    await tmux.respawn(window, cwd, commandLine);
    return 'restarted';
  }
  const r = await tmux.startWindow(window, cwd, commandLine, sessionUp);
  if (r.code !== 0) throw new AgentctlError(`tmux could not start window "${window}": ${r.stderr.trim() || `exit ${r.code}`}`);
  return sessionUp ? 'created' : 'session-created';
}
