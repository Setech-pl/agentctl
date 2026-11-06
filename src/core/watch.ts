import { limitedTick } from './limited.ts';
import { drainPromptQueue } from './prompt-queue.ts';
import { mcpWriteNotice } from './mcp-notify.ts';
import { reviewTick } from './review.ts';
import { journalOutputs } from './outputs.ts';
import { deliverPendingPrompt } from './prompt-delivery.ts';
import { overloadTick } from './overload.ts';
import { diskTick } from './disk.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore, configStatePath, noteConfigState } from './config-store.ts';
import type { ConfigRefresh } from './config-store.ts';
import { loadGlobalConfig } from './config.ts';
import { limitsDiffText } from './limits.ts';
import { findResumable, resumeText } from './resume.ts';
import { recordJournal, recordJournalOnce } from './journal.ts';
import type { JournalKind } from './journal.ts';
import type { Context } from './context.ts';
import { Alerts } from './alert.ts';
import { awayTick } from './away.ts';
import { phoneTick } from './phone-send.ts';
import type { Notifier } from './notify.ts';
import { reportReadyText } from './event-command.ts';
import type { SelfArgv } from './events.ts';
import { readVerdict } from './verdict.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import type { TaskState } from './state.ts';
import { decorateName } from './icons.ts';
import { CollisionMemory, collisionTick } from './collisions.ts';
import { cohortTick } from './cohort.ts';
import { announceBlocked, QueueMemory, queueTick } from './queue.ts';
import { usageTick } from './usage-limits.ts';
import { listTaskRecords, readTaskRecord } from './taskstore.ts';
import { syncReport } from './report-detect.ts';
import { recordEvent } from './history.ts';
import { errorMessage } from './util.ts';
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
  /** Queued tasks this watcher is in the middle of starting. */
  readonly queue = new QueueMemory();
  /** The pairs of colliding tasks already announced, and when git was last asked. */
  readonly collisions = new CollisionMemory();
}

const NOTIFY_ON: Partial<Record<TaskState, (row: StatusRow) => string>> = {
  'needs-attention': r => `${r.task}: ${r.hint ?? 'prompt delivery needs attention'}`,
  'report-ready': (r) => reportReadyText(r.task, undefined),
  'needs-trust': (r) => `${r.task} czeka na zaufanie folderu (trust)`,
  'needs-input': (r) => (r.question ? `${r.task}: ${r.question}` : `${r.task} zadaje pytanie i czeka na odpowiedź`),
  overloaded: r => `${r.task}: dostawca przeciążony (overloaded)`,
  // Limited notifications use a durable provider episode, shared with hooks.
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

/** The history gets a record when a report is ready (`history.jsonl`); the same report is recorded once. */
async function recordReport(ctx: Context, task: string): Promise<void> {
  const record = listTaskRecords(ctx.config).find((r) => r.task === task);
  if (record) { await recordEvent(ctx, record, 'report'); await journalOutputs(ctx, record); }
}

const JOURNALED: Partial<Record<TaskState, JournalKind>> = { 'needs-attention': 'needs-attention', overloaded: 'overloaded', 'report-ready': 'report-ready', 'needs-trust': 'needs-trust', 'needs-input': 'needs-input', limited: 'limited', dead: 'dead', orphan: 'orphan' };

/** The transition goes to the journal that `events` reads (the notification only reaches the desktop). */
async function journalTransition(ctx: Context, row: StatusRow, e: WatchEvent): Promise<void> {
  const kind = JOURNALED[e.to];
  if (!kind) return;
  const verdict = kind === 'report-ready' ? readVerdict(row.reportPath, ctx.config.notify.verdictPattern) : undefined;
  await recordJournal(ctx, { kind, task: row.task, text: e.notification ?? e.to, ...(verdict ? { verdict } : {}) });
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

/** Discover configured candidates for open tasks without overriding their screen/event state. */
async function syncWaitingReports(ctx: Context, rows: StatusRow[]): Promise<boolean> {
  let copied = false;
  for (const row of rows) {
    if (row.report === 'yes' || row.closed || row.cancelled || row.archived) continue;
    const record = readTaskRecord(ctx.config, row.windowName);
    if (!record) continue;
    const candidateBefore = record.reportCandidate;
    const r = await syncReport(ctx, record).catch(() => undefined);
    if (r && (r.action === 'copied' || r.action === 'updated' || record.reportCandidate !== candidateBefore)) copied = true;
  }
  return copied;
}

export interface TickOptions {
  /** This very agentctl as a command line: the click action of a notification runs `attach` with it. */
  self?: SelfArgv | undefined;
  /** Ctrl-C: ends the waits of the queued tasks that are being started. */
  signal?: AbortSignal | undefined;
}

/**
 * One poll: collect states, detect transitions, notify and log. Returns the events. A transition that the agent's own event
 * announced a moment ago (see `agentctl event`) is logged but not notified again.
 */
export async function watchTick(ctx: Context, memory: WatchMemory, notifier: Notifier, options: TickOptions = {}): Promise<WatchEvent[]> {
  // A closed or cancelled task is off the list: no transitions, no notifications (closing a task with no report is not a vanished window).
  let allRows = await collectStatus(ctx, { progress: false, archived: true });
  for (const row of allRows) {
    const record = !row.closed && !row.cancelled ? readTaskRecord(ctx.config, row.windowName) : undefined;
    if (record && ['pending', 'sending', 'confirming', 'needs-attention'].includes(record.promptDelivery ?? '')) {
      if (record.promptDelivery === 'pending' && row.window !== 'alive') continue;
      const result = await deliverPendingPrompt(ctx, row.windowName);
      // The baseline tick has no transition notifier yet; later deadlines use NOTIFY_ON below.
      if (result === 'needs-attention' && record.promptDelivery !== 'needs-attention' && !memory.started) {
        const updated = readTaskRecord(ctx.config, row.windowName);
        const text = `${row.task}: ${updated?.promptError}`;
        await new Alerts(ctx, notifier, { self: options.self }).send({ task: row.task, window: row.windowName }, 'needs-attention', text, 'watch');
        await journalTransition(ctx, row, { task: row.task, from: row.state, to: 'needs-attention', reason: 'transition', notification: text });
      }
      if (result !== 'pending') allRows = await collectStatus(ctx, { progress: false, archived: true });
    }
  }
  for (const record of listTaskRecords(ctx.config)) if (!record.closed && !record.cancelled) await drainPromptQueue(ctx, record.window);
  // A waiting agent may have written its report somewhere else than the spec says: record a candidate without changing the execution state.
  if (await syncWaitingReports(ctx, allRows)) allRows = await collectStatus(ctx, { progress: false, archived: true });
  for (const record of listTaskRecords(ctx.config)) await journalOutputs(ctx, record);
  const rows = allRows.filter((r) => !r.closed && !r.cancelled);
  await limitedTick(ctx, rows, notifier).catch(e => ctx.out(`limited recovery: ${errorMessage(e)}`));
  await overloadTick(ctx, rows, notifier).catch(e => ctx.out(`overload recovery: ${errorMessage(e)}`));
  await decorateWindows(ctx, memory, rows);
  const now = ctx.runner.now();
  // away.auto_idle: the Mac idle for long enough counts as away; before the events of this tick, so they reach the phone.
  const awayChange = await awayTick(ctx).catch(() => undefined);
  if (awayChange) await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(now).toISOString()}  away ${awayChange} (away.auto_idle)\n`);
  // Queued tasks whose provider has a free window start now, in the background: a start can wait for a human (folder trust) for minutes.
  const startLog = async (text: string): Promise<void> => {
    await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  ${text}\n`);
    ctx.out(text);
  };
  await reviewTick(ctx).catch((e: unknown) => startLog(`review: ${errorMessage(e)}`));
  await queueTick(ctx, memory.queue, notifier, { self: options.self, signal: options.signal, rows: allRows, log: startLog });
  await announceBlocked(ctx, notifier, allRows, { self: options.self, log: startLog }).catch((e: unknown) => startLog(`queue: ${errorMessage(e)}`));
  await cohortTick(ctx, notifier, allRows, startLog).catch((e: unknown) => startLog(`cohort: ${errorMessage(e)}`));
  await collisionTick(ctx, memory.collisions, notifier, startLog).catch((e: unknown) => startLog(`collisions: ${errorMessage(e)}`));
  await diskTick(ctx, notifier).catch((e: unknown) => startLog(`disk: ${errorMessage(e)}`));
  await mcpWriteNotice(ctx, async text => { await notifier.notify('agentctl', text); }).catch((e: unknown) => startLog(`mcp notices: ${errorMessage(e)}`));
  await usageTick(ctx, notifier, startLog).catch((e: unknown) => startLog(`usage: ${errorMessage(e)}`));
  // The phone: requests that failed before are tried again (a network error never stops the watcher).
  for (const l of await phoneTick(ctx).catch((e: unknown) => [`phone: ${errorMessage(e)}`])) await startLog(l);
  const events = detectTransitions(memory, rows, now, ctx.config.watch.waitingAfter * 1000);
  const alerts = new Alerts(ctx, notifier, { self: options.self });
  for (const e of events) {
    const row = rows.find((r) => r.task === e.task);
    if (e.notification && row) {
      if (e.to === 'report-ready' && e.reason === 'transition') e.notification = reportReadyText(e.task, readVerdict(row.reportPath, ctx.config.notify.verdictPattern));
      if (e.to === 'report-ready' && e.reason === 'transition') await recordReport(ctx, row.task);
      // The ledger key of a reminder differs from the state names, so it is never taken for the end-of-turn event.
      const key = e.reason === 'waiting-too-long' ? 'waiting-too-long' : e.to;
      if ((await alerts.send({ task: row.task, window: row.windowName }, key, e.notification, 'watch')) === 'duplicate') e.duplicate = true;
      else if (e.reason === 'transition') await journalTransition(ctx, row, e);
    }
    await ctx.runner.appendFile(watchLogPath(ctx), logLine(now, e));
    if (e.reason !== 'baseline') ctx.out(logLine(now, e).trimEnd());
  }
  return events;
}

export interface WatchOptions {
  /** Where the configuration is read again from; default: config.yaml next to the one this run started with. */
  configStore?: ConfigStore;
  /** Makes the notifier again when the `notify` section changed. */
  remakeNotifier?: () => Promise<Notifier>;
  /** Ctrl-C. */
  signal?: AbortSignal;
  /** Stop after this many ticks (tests). */
  maxTicks?: number;
  /** This very agentctl as a command line, for the click action of notifications. */
  self?: SelfArgv | undefined;
}

/**
 * Read config.yaml again if its text changed. A file that loads comes into force at once (the next tick sees it: a raised limit starts the
 * waiting tasks, a new `mcp.allow` is known to the server on its next call); a file that does not load leaves the previous settings in force
 * and is reported once in the log, and `status` and `doctor` say so.
 */
export async function reloadConfig(ctx: Context, store: ConfigStore, by = 'watch'): Promise<ConfigRefresh> {
  const before = ctx.config;
  const r = store.refresh();
  if (r.config !== before) ctx.setConfig(r.config);
  const log = async (text: string): Promise<void> => {
    await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  ${text}\n`);
    ctx.out(text);
  };
  if (r.error) await log(`config: ${r.error}`);
  else if (r.changed) {
    await log(`config: reloaded (${r.keys.join(', ')})`);
    const text = limitsDiffText(before.limits, r.config.limits);
    if (text) await recordJournalOnce(ctx, { kind: 'limits-changed', text });
  }
  if (r.error || r.changed || before.reloadWarning) noteConfigState(configStatePath(r.config), by, ctx.runner.now(), r.error ?? r.config.reloadWarning);
  return r;
}

/** One notification "N zadań do wznowienia" when the watcher starts and tasks can be resumed (`agentctl resume`). Returns how many. */
export async function announceResumable(ctx: Context, notifier: Notifier): Promise<number> {
  const n = (await findResumable(ctx)).length;
  if (n === 0) return 0;
  const text = resumeText(n);
  await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  resume: ${text}\n`);
  ctx.out(`resume: ${text}`);
  await notifier.notify('agentctl', text).catch(() => undefined);
  return n;
}

/** Foreground loop: tick every `watch.interval` seconds until aborted. */
export async function runWatch(ctx: Context, notifier: Notifier, opts: WatchOptions = {}): Promise<void> {
  const memory = new WatchMemory();
  const store = opts.configStore ?? new ConfigStore(() => loadGlobalConfig(path.dirname(ctx.config.path)), ctx.config);
  let current = notifier;
  const { interval, waitingAfter } = ctx.config.watch;
  ctx.out(`Watching every ${interval}s (waiting notice after ${waitingAfter}s), log: ${watchLogPath(ctx)}. Ctrl-C stops.`);
  // A change of the file is seen at once (and logged); the check at every tick is the safety net for a watcher that missed it.
  let fileWatcher: fs.FSWatcher | undefined;
  try {
    fileWatcher = fs.watch(path.dirname(ctx.config.path), (_event, name) => {
      if (name === path.basename(ctx.config.path)) void applyReload().catch(() => undefined);
    });
    fileWatcher.on('error', () => undefined);
  } catch {
    // no file watching here: the tick checks
  }
  const applyReload = async (): Promise<void> => {
    const before = ctx.config.notify;
    const r = await reloadConfig(ctx, store);
    if (r.changed && JSON.stringify(before) !== JSON.stringify(ctx.config.notify) && opts.remakeNotifier) current = await opts.remakeNotifier();
  };
  // After a restart of the Mac the tasks that were at work have a worktree and no window: say so once, when the watcher starts.
  await announceResumable(ctx, current).catch(() => undefined);
  try {
    for (let tick = 0; !opts.signal?.aborted && (opts.maxTicks === undefined || tick < opts.maxTicks); tick++) {
      if (tick > 0) await ctx.runner.sleep(ctx.config.watch.interval * 1000, opts.signal);
      if (opts.signal?.aborted) break;
      await applyReload();
      await watchTick(ctx, memory, current, { self: opts.self, signal: opts.signal });
    }
  } finally {
    fileWatcher?.close();
    // A start in progress is not abandoned half way: the window and the prompt are its result.
    await memory.queue.idle();
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
