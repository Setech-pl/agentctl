import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { expectedCloseFile } from './tmux-loss.ts';
import { readTaskRecord, taskDir } from './taskstore.ts';
import { windowName } from './util.ts';

/** How much of the window a failed start keeps: the screen and its scrollback, last lines. */
export const START_FAILURE_LINES = 200;

/** The last screen of a start that did not reach the agent's input (P96): the evidence that outlives a closed window. */
export const startFailureScreenFile = (config: GlobalConfig, window: string): string => path.join(taskDir(config, window), 'start-failure-screen.txt');

/** `start_failure.keep_window` (default true): a start that failed leaves its window open, for diagnosis. */
export const keepFailedWindow = (config: Pick<GlobalConfig, 'startFailure'>): boolean => config.startFailure?.keepWindow !== false;

/** The saved capture of a failed start, if there is one. */
export function readStartFailureScreen(config: GlobalConfig, window: string): string | undefined {
  try { return fs.readFileSync(startFailureScreenFile(config, window), 'utf8'); } catch { return undefined; }
}

/** Save the last ≈200 lines of the window to the task folder. Returns the file; nothing when the window cannot be read (or on a dry run). */
export async function saveStartFailureScreen(ctx: Context, window: string, windowId?: string): Promise<string | undefined> {
  if (ctx.runner.dryRun) return undefined;
  const screen = await ctx.tmux.capture(window, START_FAILURE_LINES, undefined, windowId).catch(() => undefined);
  if (!screen || screen.code !== 0) return undefined;
  const lines = screen.stdout.split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  if (lines.length === 0) return undefined;
  const file = startFailureScreenFile(ctx.config, window);
  await ctx.runner.writeFile(file, `${lines.slice(-START_FAILURE_LINES).join('\n')}\n`);
  return file;
}

/**
 * Close the window of a start that never reached the agent's input: it is untrusted state nobody watches, and it holds a provider slot. The
 * capture is saved first and stays. Only a window whose prompt was never pasted qualifies (needs-attention or launching); a window waiting for a
 * human (folder trust: pending, a startup dialog: needs-input) is left alone, since a human may be answering it. Returns whether it was closed.
 */
export async function closeFailedStartWindow(ctx: Context, task: string): Promise<boolean> {
  const record = readTaskRecord(ctx.config, windowName(task));
  if (!record || (record.promptDelivery !== 'needs-attention' && record.promptDelivery !== 'launching') || record.deliveryStartedAt) return false;
  if (!(await ctx.tmux.windows()).some((w) => w.plain === record.window)) return false;
  await saveStartFailureScreen(ctx, record.window, record.windowId);
  // Record the intentional closure first: the missing window must not surface as a false tmux loss (tmux-loss.ts).
  if (!ctx.runner.dryRun) await ctx.runner.writeFile(expectedCloseFile(ctx.config, record.window), JSON.stringify({ identity: `${record.attemptId ?? record.started}:${record.windowId ?? ''}`, at: new Date(ctx.runner.now()).toISOString() }));
  return (await ctx.tmux.killWindow(record.window)).code === 0;
}
