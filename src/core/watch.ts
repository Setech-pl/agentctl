import path from 'node:path';
import type { Context } from './context.ts';
import { Alerts } from './alert.ts';
import type { Notifier } from './notify.ts';
import { limitText, reportReadyText } from './event-command.ts';
import type { SelfArgv } from './events.ts';
import { readVerdict } from './verdict.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import type { TaskState } from './state.ts';
import { decorateName } from './icons.ts';
import { ensureWindow } from './windows.ts';
import type { EnsureResult } from './windows.ts';

export const WATCH_WINDOW = 'watch';

interface Seen {
  state: TaskState;
  /** ms timestamp at which the task entered `state`. */
  since: number;
  /** The "waiting too long" notification was already sent for this stay in `waiting`. */
  waitingNotified: boolean;
}

export interface WatchEvent {
  task: string;
  from: TaskState | null;
  to: TaskState;
  /** Text of the notification; undefined when this transition is only logged. */
  notification?: string;
  reason: 'transition' | 'waiting-too-long' | 'baseline';
  /** The agent's own event announced this transition already: logged, not notified again. */
  duplicate?: boolean;
}

/** What the watcher remembers between ticks. */
export class WatchMemory {
  readonly tasks = new Map<string, Seen>();
  started = false;
  /** Windows that got a state icon from this watcher (plain name -> tmux window ID, if known): they get their plain names back. */
  readonly decorated = new Map<string, string>();
}

const NOTIFY_ON: Partial<Record<TaskState, (row: StatusRow) => string>> = {
  'report-ready': (r) => reportReadyText(r.task, undefined),
  'needs-trust': (r) => `${r.task} czeka na zaufanie folderu (trust)`,
  'needs-input': (r) => (r.question ? `${r.task}: ${r.question}` : `${r.task} zadaje pytanie i czeka na odpowiedź`),
  limited: (r) => limitText(r),
  dead: (r) => `${r.task}: okno zniknęło bez raportu`,
  orphan: (r) => `${r.task}: okno bez pliku stanu (orphan) – agentctl adopt ${r.task} --report <ścieżka>`,
};

/**
 * Compare the current rows with what was seen on the previous tick and return the events.
 * One event per transition: entering report-ready, needs-trust, needs-input, orphan or dead, and staying in `waiting`
 * for longer than `waitingAfterMs` (once per stay). The first tick only records the baseline.
 */
export function detectTransitions(memory: WatchMemory, rows: StatusRow[], nowMs: number, waitingAfterMs: number): WatchEvent[] {
  const events: WatchEvent[] = [];
  const baseline = !memory.started;
  memory.started = true;
  for (const row of rows) {
    const prev = memory.tasks.get(row.task);
    if (!prev || prev.state !== row.state) {
      memory.tasks.set(row.task, { state: row.state, since: nowMs, waitingNotified: false });
      const text = NOTIFY_ON[row.state]?.(row);
      if (baseline) events.push({ task: row.task, from: null, to: row.state, reason: 'baseline' });
      else events.push({ task: row.task, from: prev?.state ?? null, to: row.state, reason: 'transition', ...(text ? { notification: text } : {}) });
      continue;
    }
    if (row.state === 'waiting' && !prev.waitingNotified && nowMs - prev.since >= waitingAfterMs) {
      prev.waitingNotified = true;
      events.push({ task: row.task, from: 'waiting', to: 'waiting', reason: 'waiting-too-long', notification: `${row.task} czeka na Ciebie` });
    }
  }
  return events;
}

export function watchLogPath(ctx: Context): string {
  return path.join(ctx.config.cache, 'agentctl-watch.log');
}

const logLine = (nowMs: number, e: WatchEvent): string => {
  const what =
    e.reason === 'waiting-too-long' ? 'waiting too long' : e.reason === 'baseline' ? `baseline ${e.to}` : `${e.from ?? 'new'} -> ${e.to}`;
  return `${new Date(nowMs).toISOString()}  ${e.task}  ${what}${e.notification ? `  [${e.duplicate ? 'already announced by the agent\'s event' : 'notified'}: ${e.notification}]` : ''}\n`;
};

/**
 * Put the state icon of each live window in front of its name ("⚙ nc-42"). Only windows whose name is not already right are renamed.
 * Does nothing when `watch.window_icons` is off. Returns the tasks that were renamed.
 */
export async function decorateWindows(ctx: Context, memory: WatchMemory, rows: StatusRow[]): Promise<string[]> {
  const icons = ctx.config.watch.windowIcons;
  if (!icons) return [];
  const { tmux } = ctx;
  const infos = await tmux.windows();
  const renamed: string[] = [];
  for (const row of rows) {
    if (row.window !== 'alive') continue;
    const info = tmux.resolve(row.windowName, infos, row.windowId ?? undefined);
    if (!info) continue;
    const wanted = decorateName(row.windowName, icons[row.state]);
    if (info.name === wanted) continue;
    const r = await tmux.renameWindow(info.id !== '' ? info.id : tmux.target(info.name), wanted);
    if (r.code !== 0) continue;
    memory.decorated.set(row.windowName, info.id);
    renamed.push(row.task);
  }
  return renamed;
}

/** Give the windows this watcher decorated their plain names back. Returns how many were renamed. */
export async function restoreWindowNames(ctx: Context, memory: WatchMemory): Promise<number> {
  if (memory.decorated.size === 0) return 0;
  const { tmux } = ctx;
  const infos = await tmux.windows();
  let restored = 0;
  for (const [plain, id] of memory.decorated) {
    const info = tmux.resolve(plain, infos, id || undefined);
    if (!info || info.name === plain) continue;
    if ((await tmux.renameWindow(info.id !== '' ? info.id : tmux.target(info.name), plain)).code === 0) restored++;
  }
  memory.decorated.clear();
  return restored;
}

export interface TickOptions {
  /** This very agentctl as a command line: the click action of a notification runs `attach` with it. */
  self?: SelfArgv | undefined;
}

/**
 * One poll: collect states, detect transitions, notify and log. Returns the events. A transition that the agent's own event
 * announced a moment ago (see `agentctl event`) is logged but not notified again.
 */
export async function watchTick(ctx: Context, memory: WatchMemory, notifier: Notifier, options: TickOptions = {}): Promise<WatchEvent[]> {
  // A closed task is off the list: no transitions, no notifications (closing a task with no report is not a vanished window).
  const rows = (await collectStatus(ctx, { progress: false })).filter((r) => !r.closed);
  await decorateWindows(ctx, memory, rows);
  const now = ctx.runner.now();
  const events = detectTransitions(memory, rows, now, ctx.config.watch.waitingAfter * 1000);
  const alerts = new Alerts(ctx, notifier, { self: options.self });
  for (const e of events) {
    const row = rows.find((r) => r.task === e.task);
    if (e.notification && row) {
      if (e.to === 'report-ready' && e.reason === 'transition') e.notification = reportReadyText(e.task, readVerdict(row.reportPath, ctx.config.notify.verdictPattern));
      // The ledger key of a reminder differs from the state names, so it is never taken for the end-of-turn event.
      const key = e.reason === 'waiting-too-long' ? 'waiting-too-long' : e.to;
      if ((await alerts.send({ task: row.task, window: row.windowName }, key, e.notification, 'watch')) === 'duplicate') e.duplicate = true;
    }
    await ctx.runner.appendFile(watchLogPath(ctx), logLine(now, e));
    if (e.reason !== 'baseline') ctx.out(logLine(now, e).trimEnd());
  }
  return events;
}

export interface WatchOptions {
  /** Ctrl-C. */
  signal?: AbortSignal;
  /** Stop after this many ticks (tests). */
  maxTicks?: number;
  /** This very agentctl as a command line, for the click action of notifications. */
  self?: SelfArgv | undefined;
}

/** Foreground loop: tick every `watch.interval` seconds until aborted. */
export async function runWatch(ctx: Context, notifier: Notifier, opts: WatchOptions = {}): Promise<void> {
  const memory = new WatchMemory();
  const { interval, waitingAfter } = ctx.config.watch;
  ctx.out(`Watching every ${interval}s (waiting notice after ${waitingAfter}s), log: ${watchLogPath(ctx)}. Ctrl-C stops.`);
  try {
    for (let tick = 0; !opts.signal?.aborted && (opts.maxTicks === undefined || tick < opts.maxTicks); tick++) {
      if (tick > 0) await ctx.runner.sleep(interval * 1000, opts.signal);
      if (opts.signal?.aborted) break;
      await watchTick(ctx, memory, notifier, { self: opts.self });
    }
  } finally {
    const restored = await restoreWindowNames(ctx, memory);
    if (restored > 0) ctx.out(`Window names restored (${restored}).`);
  }
}

/**
 * `watch --tmux`: make sure window "watch" exists in the agentctl session, running `commandLine`.
 * Returns what happened; never starts a second watcher.
 */
export function ensureWatchWindow(ctx: Context, commandLine: string, cwd: string): Promise<EnsureResult> {
  return ensureWindow(ctx, WATCH_WINDOW, commandLine, cwd);
}
