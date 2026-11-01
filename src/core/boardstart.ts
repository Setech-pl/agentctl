import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import { AgentctlError } from './util.ts';

/** `<config dir>/board.log` or `watch.log`: how the board and the watcher started and why they stopped (the window may be gone by then). */
export function startLogPath(config: Pick<GlobalConfig, 'path'>, name: 'board' | 'watch'): string {
  return path.join(path.dirname(config.path), `${name}.log`);
}

/** One line with a time stamp; a log that cannot be written never stops the program. */
export function appendStartLog(file: string, text: string, now: number = Date.now()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date(now).toISOString()}  ${text}\n`);
  } catch {
    // no log is better than a crash on start
  }
}

export interface SizeSource {
  columns?: number | undefined;
  rows?: number | undefined;
}

export interface SizeWait {
  columns: number;
  rows: number;
  /** How long the size was 0 or missing. */
  waitedMs: number;
}

export interface SizeWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * A window created without a client attached may report a size of 0 until a terminal is attached (and a pty can be 0x0 for a moment
 * at start). The board waits for a real size instead of drawing into nothing or exiting.
 */
export async function waitForSize(stream: SizeSource, opts: SizeWaitOptions = {}): Promise<SizeWait> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 200;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const started = now();
  for (;;) {
    const columns = stream.columns ?? 0;
    const rows = stream.rows ?? 0;
    if (columns > 0 && rows > 0) return { columns, rows, waitedMs: now() - started };
    if (now() - started >= timeoutMs) {
      throw new AgentctlError(`the terminal reported no size (${columns}x${rows}) for ${Math.round(timeoutMs / 1000)} s`, 'Attach a terminal to the window (tmux attach) and start the board again, or run "agentctl board" in a terminal.');
    }
    await sleep(intervalMs);
  }
}

/** What the log says about the terminal the board starts in: enough to see why it would not draw. */
export function describeTerminal(env: NodeJS.ProcessEnv, stdout: SizeSource & { isTTY?: boolean | undefined }, stdin: { isTTY?: boolean | undefined }): string {
  const parts = [`stdin.isTTY=${Boolean(stdin.isTTY)}`, `stdout.isTTY=${Boolean(stdout.isTTY)}`, `size=${stdout.columns ?? 0}x${stdout.rows ?? 0}`, `TERM=${env.TERM ?? ''}`];
  if (env.CI) parts.push(`CI=${env.CI} (Ink would draw nothing unless forced interactive)`);
  if (env.TMUX) parts.push('inside tmux');
  return parts.join(' ');
}

/** A board that ends sooner than this after its start did not get a real chance: it is reported as a failure. */
export const MIN_BOARD_LIFETIME_MS = 1500;

/**
 * Run `body` as the board or the watcher of a tmux window: log the start and the end, and turn an end that nobody asked for
 * (an exception, or an exit within MIN_BOARD_LIFETIME_MS) into a message that stays on the window's screen.
 * Returns the message to print, or undefined when all is well.
 */
export async function loggedRun(file: string, name: string, body: () => Promise<void>, opts: { minLifetimeMs?: number; now?: () => number; startNote?: string } = {}): Promise<string | undefined> {
  const now = opts.now ?? Date.now;
  const started = now();
  appendStartLog(file, `${name} start pid=${process.pid}${opts.startNote ? ` ${opts.startNote}` : ''}`, started);
  try {
    await body();
  } catch (e) {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    appendStartLog(file, `${name} failed after ${now() - started} ms: ${detail}`, now());
    throw e;
  }
  const lived = now() - started;
  appendStartLog(file, `${name} ended after ${lived} ms`, now());
  const min = opts.minLifetimeMs ?? MIN_BOARD_LIFETIME_MS;
  return lived < min ? `${name} ended after ${lived} ms without an error (see ${file}); it needs a terminal that stays open` : undefined;
}
