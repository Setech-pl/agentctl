import type { Context } from './context.ts';

/** Name of the tmux window that runs `agentctl board` (like WATCH_WINDOW, it is not a task). */
export const BOARD_WINDOW = 'board';

/**
 * Make sure `window` exists in the agentctl session, running `commandLine` (the session is created if it is not up yet).
 * Never starts a second copy.
 */
export async function ensureWindow(ctx: Context, window: string, commandLine: string, cwd: string): Promise<'created' | 'session-created' | 'exists'> {
  const { tmux } = ctx;
  const sessionUp = await tmux.hasSession();
  if (sessionUp && (await tmux.listWindows()).includes(window)) return 'exists';
  if (sessionUp) await tmux.newWindow(window, cwd, {});
  else await tmux.newSession(window, cwd, {});
  await tmux.typeCommand(window, commandLine);
  return sessionUp ? 'created' : 'session-created';
}
