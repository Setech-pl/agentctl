import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { expectedCloseFile } from './tmux-loss.ts';
import { readTaskRecord, setHeaderFields, taskDir, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { secretRedactor } from './secret-redaction.ts';
import type { Tmux } from './tmux.ts';
import { windowName } from './util.ts';

/** How much of the window a failed start keeps: the screen and its scrollback, last lines. */
export const START_FAILURE_LINES = 200;

export interface LaunchExit {
  identity: string;
  exitCode: number | null;
  logPath: string;
  lines: string[];
  startup: boolean;
  detail: string;
}

export const launchIdentity = (record: TaskRecord): string => `${record.attemptId ?? record.started}:${record.launchAt ?? ''}:${record.windowId ?? ''}`;
export const legacyLaunch = (record: TaskRecord): boolean =>
  record.promptDelivery === 'launching' && Boolean(record.started && record.windowId) && !record.launchAt;
const launchExitPath = (config: GlobalConfig, window: string): string => path.join(taskDir(config, window), 'launch-exit.json');
const launchTailPath = (config: GlobalConfig, window: string): string => path.join(taskDir(config, window), 'launch-screen.txt');

export function inLaunchGrace(config: GlobalConfig, record: TaskRecord, now: number): boolean {
  if (record.promptDelivery && record.promptDelivery !== 'sent' && record.promptKind !== 'followup') return true;
  const launchAt = Date.parse(record.launchAt ?? record.attemptStarted ?? record.started);
  return now - launchAt <= config.launch.graceS * 1000;
}

export function expectedStartClosure(config: GlobalConfig, record: TaskRecord): boolean {
  try {
    const {identity} = JSON.parse(fs.readFileSync(expectedCloseFile(config, record.window), 'utf8'));
    return identity === `${record.attemptId ?? record.started}:${record.windowId ?? ''}`;
  } catch { return false; }
}

export async function expectWindowClosure(ctx: Context, record: TaskRecord): Promise<void> {
  if (ctx.runner.dryRun) return;
  await ctx.runner.writeFile(expectedCloseFile(ctx.config, record.window), JSON.stringify({ identity: `${record.attemptId ?? record.started}:${record.windowId ?? ''}`, at: new Date(ctx.runner.now()).toISOString() }));
}

export function readLaunchExit(config: GlobalConfig, record: TaskRecord): LaunchExit | undefined {
  try {
    const result = JSON.parse(fs.readFileSync(launchExitPath(config, record.window), 'utf8')) as LaunchExit;
    if (result.identity === launchIdentity(record)) return result;
  } catch { /* no persisted exit for this attempt */ }
  return undefined;
}

export const launchExitText = (cause: LaunchExit): string =>
  `${cause.detail}; kod wyjścia ${cause.exitCode ?? 'n/d'}; log: ${cause.logPath}${cause.lines.length ? `\n${cause.lines.join('\n')}` : ''}`;

export async function trackLaunch(ctx: Context, tmux: Tmux, record: TaskRecord, windowId?: string, retried = false): Promise<void> {
  if (!windowId) return;
  await tmux.runner.exec('tmux', ['set-option', '-w', '-t', windowId, 'remain-on-exit', 'on']);
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { window_id: windowId, launch_at: new Date(ctx.runner.now()).toISOString(), launch_retried: retried || null });
}

function launchLines(ctx: Context, record: TaskRecord, screen: string): string[] {
  const safe = secretRedactor([ctx.config, process.env, record], new Set([record.task]))(screen);
  return safe.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd().split('\n').filter(line => line.trim()).slice(-20).map(line => line.slice(0, 300));
}

/** A rolling screen for a window killed before tmux could preserve its pane. */
export async function saveLaunchTail(ctx: Context, record: TaskRecord, screen: string): Promise<void> {
  if (!record.launchAt || !screen || ctx.runner.dryRun) return;
  const file = launchTailPath(ctx.config, record.window);
  const next = JSON.stringify({identity: launchIdentity(record), lines: launchLines(ctx, record, screen)});
  try { if (fs.readFileSync(file, 'utf8') === next) return; } catch { /* first screen */ }
  await ctx.runner.writeFile(file, next);
}

export async function storeLaunchExit(ctx: Context, record: TaskRecord, exitCode: number | null, screen: string, detail: string, startup: boolean): Promise<LaunchExit> {
  const identity = launchIdentity(record);
  let lines = launchLines(ctx, record, screen);
  if (!lines.length) {
    try {
      const tail = JSON.parse(fs.readFileSync(launchTailPath(ctx.config, record.window), 'utf8')) as Pick<LaunchExit, 'identity' | 'lines'>;
      if (tail.identity === identity) lines = tail.lines;
    } catch { /* nothing was captured before the window disappeared */ }
  }
  const suffix = (record.attemptId ?? record.launchAt ?? record.started).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 45);
  const logPath = path.join(taskDir(ctx.config, record.window), `launch-${suffix || 'legacy'}.log`);
  const result = {identity, exitCode, logPath, lines, startup, detail};
  await ctx.runner.writeFile(logPath, `${detail}; exit ${exitCode ?? 'unknown'}\n${lines.join('\n')}\n`);
  await ctx.runner.writeFile(launchExitPath(ctx.config, record.window), JSON.stringify(result));
  return result;
}

export class LaunchExited extends Error {}

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
  if (!record || record.host || (record.promptDelivery !== 'needs-attention' && record.promptDelivery !== 'launching') || record.deliveryStartedAt) return false;
  if (!(await ctx.tmux.windows()).some((w) => w.plain === record.window)) return false;
  await saveStartFailureScreen(ctx, record.window, record.windowId);
  // Record the intentional closure first: the missing window must not surface as a false tmux loss (tmux-loss.ts).
  await expectWindowClosure(ctx, record);
  return (await ctx.tmux.killWindow(record.window)).code === 0;
}
