import { attentionTick } from './attention.ts';
import { tmuxLoss } from './tmux-loss.ts';
import { maintainWall, OWNER_IDENTITY, postMessage } from './wall.ts';
import { watchIntegrationGc } from './integration-gc.ts';
import { autoClosePulled } from './pulled-auto-close.ts';
import { applyAcceptedWrites } from './queue.ts';
import { consultTick } from './consult.ts';
import { applyInstanceLabel } from './instance.ts';
import { beginTitle } from './title.ts';
import { packageVersion } from './version.ts';
import { recordMachineLoad } from './machine.ts';
import { checkLaunchHealth, LaunchHealthMemory } from './launch-health.ts';
import { limitedTick } from './limited.ts';
import { drainPromptQueue, queueFile, readPromptQueue } from './prompt-queue.ts';
import { mcpWriteNotice } from './mcp-notify.ts';
import { reviewTick } from './review.ts';
import { journalOutputs } from './outputs.ts';
import { deliverPendingPrompt } from './prompt-delivery.ts';
import { overloadTick } from './overload.ts';
import { collectDisk, diskTick } from './disk.ts';
import { WatchSteps } from './watch-steps.ts';
import { watchSnapshotPath, watchProgressPath } from './watch-snapshot.ts';
import { atomicWriteFile, readStateWriteFailure, stateWriteFailure } from './atomic-file.ts';
import { taskLock, withFileLock } from './file-lock.ts';
import { fenceLegacyLimits } from './config-compat.ts';
import type { BudgetClock } from './response-budget.ts';
import { withoutResponseBudget } from './response-budget.ts';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore, configStatePath, noteConfigState } from './config-store.ts';
import type { ConfigRefresh } from './config-store.ts';
import { loadGlobalConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import { announceLimitConfigChange, holdDiffText, limitEditLock } from './limits.ts';
import { maintainLimitRequests } from './limit-requests.ts';
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
import { findRecordAnywhere, readTaskRecord, setHeaderField, snapshotRecords, taskFile } from './taskstore.ts';
import { syncReport } from './report-detect.ts';
import { recordEvent } from './history.ts';
import { errorMessage, formatDuration } from './util.ts';
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
  readonly steps = new WatchSteps();
  statusSweep?: { config: GlobalConfig; rows: StatusRow[] } | undefined;
  lastTickAt?: number;
  /** Windows that got a state icon from this watcher (plain name -> tmux window ID, if known): they get their plain names back. */
  readonly decorated = new Map<string, string>();
  /** Queued tasks this watcher is in the middle of starting. */
  readonly queue = new QueueMemory();
  readonly launchHealth = new LaunchHealthMemory();
  /** The pairs of colliding tasks already announced, and when git was last asked. */
  readonly collisions = new CollisionMemory();
  readonly recoveredWrites = new Set<string>();
}

/** Revalidate the last complete task state under its normal lock. Watch then derives fresh updates from the current task. */
async function recoverTaskWrites(ctx: Context, memory: WatchMemory, signal: AbortSignal): Promise<void> {
  if (ctx.runner.dryRun) return;
  const retryable = async (file: string) => /^(ENOSPC:|write error: Partial result: response budget exhausted)/.test((await readStateWriteFailure(file))?.reason ?? '');
  const records = await memory.launchHealth.records.current(ctx.config, ctx.runner.now());
  const recover = async (record: typeof records[number]) => {
    if (signal.aborted) return;
    const file = taskFile(ctx.config, record.window);
    if (!await retryable(file) || signal.aborted) return;
    await withFileLock(taskLock(file), async () => {
      if (signal.aborted || !await retryable(file)) return;
      atomicWriteFile(file, fs.readFileSync(file));
      memory.recoveredWrites.add(record.task);
    }, 100).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') ctx.out(`state recovery ${record.task}: ${errorMessage(error)}`);
    });
  };
  for (let i = 0; i < records.length && !signal.aborted; i += 25) {
    await Promise.all(records.slice(i, i + 25).map(recover));
  }
}

/** P55: the one desktop notification of a trust wait points at the board, where the row is on top and Enter opens the dialog. */
export const NOTIFY_ON_TRUST = (r: StatusRow): string => `${r.task} czeka na zaufanie folderu (trust) – board: wiersz na górze, Enter otwiera dialog`;

const NOTIFY_ON: Partial<Record<TaskState, (row: StatusRow) => string>> = {
  'host-unreachable': r => `${r.task}: host ${r.host} niedostępny – watch ponawia połączenie; okno pozostaje na hoście`,
  'needs-attention': r => `${r.task}: ${r.hint ?? 'prompt delivery needs attention'}`,
  'report-ready': (r) => reportReadyText(r.task, undefined),
  'needs-trust': NOTIFY_ON_TRUST,
  'needs-input': (r) => (r.question ? `${r.task}: ${r.question}` : `${r.task} zadaje pytanie i czeka na odpowiedź`),
  overloaded: r => `${r.task}: dostawca przeciążony (overloaded)`,
  // Limited notifications use a durable provider episode. Hooks only record evidence and hold admission.
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
  const record = findRecordAnywhere(ctx.config, task);
  if (record) { await recordEvent(ctx, record, 'report'); await journalOutputs(ctx, record); }
}

const JOURNALED: Partial<Record<TaskState, JournalKind>> = { 'host-unreachable': 'host-unreachable', 'needs-attention': 'needs-attention', overloaded: 'overloaded', 'report-ready': 'report-ready', 'needs-trust': 'needs-trust', 'needs-input': 'needs-input', limited: 'limited', dead: 'dead', orphan: 'orphan' };

/** The transition goes to the journal that `events` reads (the notification only reaches the desktop). */
async function journalTransition(ctx: Context, row: StatusRow, e: WatchEvent): Promise<void> {
  const kind = e.from === 'host-unreachable' && e.to !== 'host-unreachable' ? 'host-recovered' : JOURNALED[e.to];
  if (!kind || row.tmuxLost || (kind === 'dead' && row.launchExit)) return;
  const verdict = kind === 'report-ready' ? readVerdict(row.reportPath, ctx.config.notify.verdictPattern, row.reviewOf != null) : undefined;
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
    if (row.window !== 'alive' || row.state === 'host-unreachable') continue;
    const info = tmux.resolve(row.windowName, infos, row.windowId ?? undefined);
    if (!info) continue;
    const wanted = decorateName(row.windowName, icons[row.state]);
    if (info.name === wanted) continue;
    const r = await (row.host ? ctx.hosts.tmux(row.host) : tmux).renameWindow(info.id !== '' ? info.id : tmux.target(info.name), wanted);
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
    if ((await (readTaskRecord(ctx.config, plain)?.host ? ctx.hosts.tmux(readTaskRecord(ctx.config, plain)!.host!) : tmux).renameWindow(info.id !== '' ? info.id : tmux.target(info.name), plain)).code === 0) restored++;
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
    if (!record || record.host) continue;
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
  stepClock?: BudgetClock;
}

/**
 * One poll: collect states, detect transitions, notify and log. Returns the events. A transition that the agent's own event
 * announced a moment ago (see `agentctl event`) is logged but not notified again.
 */
export async function watchTick(ctx: Context, memory: WatchMemory, notifier: Notifier, options: TickOptions = {}): Promise<WatchEvent[]> {
  const stages = new Map<string, { run: (signal: AbortSignal) => Promise<unknown>; needs: string[] }>();
  const done = new Set<string>();
  const stage = (name: string, run: (signal: AbortSignal) => Promise<unknown>, ...needs: string[]) => { stages.set(name, {run, needs}); };
  const execute = async (name: string): Promise<void> => {
    const item = stages.get(name);
    if (!item || done.has(name) || options.signal?.aborted) return;
    for (const dependency of item.needs) await execute(dependency);
    done.add(name);
    await withoutResponseBudget(() => memory.steps.run(ctx, watchLogPath(ctx), name, item.run, options.stepClock));
  };
  let observed: StatusRow[] | undefined, processed: StatusRow[] | undefined;
  const allRows = () => processed ?? observed;
  const activeRows = () => allRows()?.filter(r => !r.closed && !r.cancelled);
  const collect = async () => collectStatus(ctx, {progress: false, archived: true, verifyWatchLoss: true, records: await snapshotRecords(ctx.config, true)});
  const startLog = async (text: string): Promise<void> => {
    await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  ${text}\n`);
    ctx.out(text);
  };
  stage('state write recovery', signal => recoverTaskWrites(ctx, memory, signal));
  stage('accepted MCP writes', () => applyAcceptedWrites(ctx, notifier, { ...options, log: startLog }));
  stage('launch health', signal => checkLaunchHealth(ctx, memory.launchHealth, notifier, options.self, signal));
  // Admission observes slots and named dependencies. Full status and report processing are optional for it.
  stage('queue', () => queueTick(ctx, memory.queue, notifier, { self: options.self, signal: options.signal, log: startLog }), 'accepted MCP writes');
  stage('WALL maintenance', () => maintainWall(ctx));
  stage('limit requests', () => maintainLimitRequests(ctx));
  const tickAt = ctx.runner.now();
  if (memory.lastTickAt === undefined) {
    try {
      const previous = JSON.parse(fs.readFileSync(watchSnapshotPath(ctx.config), 'utf8'));
      if (previous.version === 1 && typeof previous.at === 'number') {
        memory.lastTickAt = previous.at;
        if (tickAt - previous.at > Math.max(300_000, 10 * ctx.config.watch.interval * 1000)) {
          for (const row of (previous.rows ?? []) as StatusRow[]) memory.tasks.set(row.task, {state: row.state, since: previous.at, waitingNotified: false});
          memory.started = true;
        }
      }
    } catch { /* first watch, no durable baseline */ }
  }
  const gap = memory.lastTickAt === undefined ? 0 : tickAt - memory.lastTickAt;
  memory.lastTickAt = tickAt;
  // A closed or cancelled task is off the list: no transitions, no notifications (closing a task with no report is not a vanished window).
  stage('status collection', async signal => {
    const config = ctx.config;
    if (memory.statusSweep?.config === config) {
      observed = memory.statusSweep.rows;
      memory.statusSweep = undefined;
      return;
    }
    // A slow sweep may finish between ticks. Keep its result for the next tick instead of
    // discarding it and repeatedly starting the same work. WatchSteps keeps one sweep in flight.
    const rows = await collect();
    if (ctx.config !== config || options.signal?.aborted) throw new Error('watch configuration or run changed during status collection');
    if (signal.aborted) memory.statusSweep = { config, rows };
    else observed = rows;
  });
  stage('task delivery and reports', async signal => {
    if (!observed) throw Error('status collection incomplete');
    let allRows = observed;
    if (await autoClosePulled(ctx, allRows)) allRows = await collect();
    const inventory = await memory.launchHealth.records.current(ctx.config, ctx.runner.now());
    const records = new Map(inventory.map(record => [record.window, record]));
    let changed = false;
    for (const row of allRows) {
      if (signal.aborted) break;
      const record = !row.closed && !row.cancelled && !row.archived ? records.get(row.windowName) : undefined;
      if (row.tmuxLost || row.launchExit || row.state === 'host-unreachable') continue;
      let delivery = record?.promptDelivery;
      if (record?.host && delivery === 'launching' && row.window === 'alive') {
        await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'prompt_delivery', 'pending');
        delivery = 'pending';
      }
      if (record && ['pending', 'sending', 'confirming', 'needs-attention', 'needs-input'].includes(delivery ?? '')) {
        if (delivery === 'pending' && row.window !== 'alive') continue;
        const result = await deliverPendingPrompt(ctx, row.windowName);
        // The baseline tick has no transition notifier yet; later deadlines use NOTIFY_ON below.
        if (result === 'needs-attention' && delivery !== 'needs-attention' && !memory.started) {
          const updated = readTaskRecord(ctx.config, row.windowName);
          const text = `${row.task}: ${updated?.promptError}`;
          await new Alerts(ctx, notifier, { self: options.self }).send({ task: row.task, window: row.windowName }, 'needs-attention', text, 'watch');
          await journalTransition(ctx, row, { task: row.task, from: row.state, to: 'needs-attention', reason: 'transition', notification: text });
        }
        if (result !== 'pending') changed = true;
      }
    }
    if (signal.aborted) return;
    if (changed) allRows = await collect();
    const byWindow = new Map(allRows.map(row => [row.windowName, row.state]));
    const current = changed ? await memory.launchHealth.records.current(ctx.config, ctx.runner.now()) : inventory;
    for (const record of current) {
      if (signal.aborted) break;
      if (record.closed || record.cancelled || record.host && ctx.hosts.connection(record.host).unreachable) continue;
      // Avoid opening the shared start lock for inactive FIFOs. Drain revalidates under the lock.
      const pending = record.pendingPrompt && record.promptDelivery !== 'sent';
      if (pending || fs.existsSync(queueFile(ctx, record.window)) && readPromptQueue(ctx, record.window).length) {
        await drainPromptQueue(ctx, record.window, byWindow.get(record.window));
      }
    }
    // A waiting agent may have written its report somewhere else than the spec says: record a candidate without changing the execution state.
    if (!signal.aborted && await syncWaitingReports(ctx, allRows)) allRows = await collect();
    const ready = new Set(allRows.filter(row => row.state === 'report-ready').map(row => row.task));
    for (const record of current) if (!signal.aborted && (ready.has(record.task) || record.closed || record.cancelled)) await journalOutputs(ctx, record);
    if (!signal.aborted) processed = allRows;
  }, 'status collection');
  for (const [name, run] of [
    ['limited recovery', (rows: StatusRow[]) => limitedTick(ctx, rows, notifier)],
    ['overload recovery', (rows: StatusRow[]) => overloadTick(ctx, rows, notifier)],
    ['window decorations', (rows: StatusRow[]) => decorateWindows(ctx, memory, rows)],
  ] as const) stage(name, async () => { const rows = activeRows(); if (rows) await run(rows); }, 'task delivery and reports');
  stage('away', async () => {
    const awayChange = await awayTick(ctx);
    if (awayChange) await startLog(`away ${awayChange} (away.auto_idle)`);
  });
  stage('reviews', () => reviewTick(ctx));
  stage('consultations', () => consultTick(ctx));
  stage('blocked queue', () => processed ? announceBlocked(ctx, notifier, processed, {self: options.self, log: startLog}) : Promise.resolve(), 'task delivery and reports');
  stage('cohorts', () => processed ? cohortTick(ctx, notifier, processed, startLog) : Promise.resolve(), 'task delivery and reports');
  stage('collisions', () => collisionTick(ctx, memory.collisions, notifier, startLog));
  stage('machine load', () => recordMachineLoad(ctx));
  stage('disk alerts', () => diskTick(ctx, notifier, startLog));
  stage('MCP notices', () => mcpWriteNotice(ctx, async text => { await notifier.notify('agentctl', text); }));
  stage('usage', () => usageTick(ctx, notifier, startLog));
  stage('phone', async () => { for (const line of await phoneTick(ctx)) await startLog(line); });
  stage('attention', async () => { const rows = allRows(); if (rows) await attentionTick(ctx, rows, notifier); }, 'task delivery and reports');
  const events: WatchEvent[] = [];
  stage('transitions', async signal => {
    const rows = activeRows();
    if (!rows) return;
    const now = ctx.runner.now();
    for (const row of rows) {
      if (signal.aborted) return;
      if (!row.tmuxLost) continue;
      const record = readTaskRecord(ctx.config, row.windowName);
      if (!record || await ctx.localTmux.paneExists(record.window, record.windowId)) continue;
      await tmuxLoss(ctx, record, false, false, row.hint?.includes('serwer/sesja tmux działa'));
    }
    events.push(...detectTransitions(memory, rows, now, ctx.config.watch.waitingAfter * 1000));
    const alerts = new Alerts(ctx, notifier, { self: options.self });
    const byTask = new Map(rows.map(row => [row.task, row]));
    const baseline = [];
    for (const e of events) {
      if (signal.aborted) break;
      if (e.reason === 'baseline') { baseline.push(logLine(now, e)); continue; }
      const row = byTask.get(e.task);
      if (e.notification && row) {
        if (e.to === 'report-ready' && e.reason === 'transition') e.notification = reportReadyText(e.task, readVerdict(row.reportPath, ctx.config.notify.verdictPattern, row.reviewOf != null));
        if (e.to === 'report-ready' && e.reason === 'transition') await recordReport(ctx, row.task);
        // The ledger key of a reminder differs from the state names, so it is never taken for the end-of-turn event.
        const key = e.reason === 'waiting-too-long' ? 'waiting-too-long' : e.to;
        if ((await alerts.send({ task: row.task, window: row.windowName }, key, e.notification, 'watch')) === 'duplicate') e.duplicate = true;
        else if (e.reason === 'transition') await journalTransition(ctx, row, e);
      }
      if (!e.notification && e.from === 'host-unreachable' && e.reason === 'transition' && row) await journalTransition(ctx, row, e);
      await ctx.runner.appendFile(watchLogPath(ctx), logLine(now, e));
      ctx.out(logLine(now, e).trimEnd());
    }
    if (baseline.length) await ctx.runner.appendFile(watchLogPath(ctx), baseline.join(''));
    if (!signal.aborted && gap > Math.max(300_000, 10 * ctx.config.watch.interval * 1000)) {
      const changes = events.filter(e => e.reason === 'transition').map(e => `${e.task}: ${e.from ?? 'new'} → ${e.to}`);
      await recordJournal(ctx, {kind: 'watch-resumed', text: `WATCH WZNOWIONY po przerwie ${formatDuration(gap)}; ${changes.join('; ') || 'bez zmian stanu zadań'}`});
    }
  }, 'task delivery and reports');
  if (!ctx.runner.dryRun) {
    const {publishMcpSnapshot, publishDegradedMcpSnapshot} = await import('./mcp-tools.ts');
    const snapshot = watchSnapshotPath(ctx.config);
    const snapshotFailed = stateWriteFailure(snapshot)?.reason.startsWith('ENOSPC:');
    let published = false;
    stage('snapshot preparation', async signal => {
      const rows = allRows();
      if (!rows) throw Error('status collection incomplete');
      await publishMcpSnapshot(ctx, rows, undefined, signal);
      published = !signal.aborted;
    }, 'task delivery and reports');
    stage('degraded snapshot', async signal => {
      if (published || stateWriteFailure(snapshot)) return;
      const disk = await collectDisk(ctx);
      if (!signal.aborted) publishDegradedMcpSnapshot(ctx, disk, allRows() ? 'snapshot preparation' : 'status collection');
    }, 'snapshot preparation');
    stage('state write recovery event', async () => {
      if (published && snapshotFailed) memory.recoveredWrites.add('snapshot watch');
      if (!published || !memory.recoveredWrites.size) return;
      await recordJournal(ctx, { kind: 'state-write-recovered', text: `zapis stanu wznowiony: ${[...memory.recoveredWrites].join(', ')}` });
      memory.recoveredWrites.clear();
    }, 'snapshot preparation');
  }
  stage('integration GC proposals', () => watchIntegrationGc(ctx, options.signal));
  const priority = memory.steps.priority(stages);
  if (priority) await execute(priority);
  for (const name of stages.keys()) await execute(name);
  return events;
}

export interface WatchOptions {
  titleOutput?: { write(text: string): unknown };
  insideTmux?: boolean;
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
  /** A supervisor relaunches the watch process after a stuck stage. */
  onStall?: () => never;
  onTick?: (tick: number, memory: WatchMemory) => Promise<void> | void;
}

export const WATCH_RESTART_CODE = 75;
export class WatchRestart extends Error {}

/**
 * Read config.yaml again if its text changed. A file that loads comes into force at once (the next tick sees it: a raised limit starts the
 * waiting tasks, a new `mcp.allow` is known to the server on its next call); a file that does not load leaves the previous settings in force
 * and is reported once in the log, and `status` and `doctor` say so.
 */
export async function reloadConfig(ctx: Context, store: ConfigStore, by = 'watch', guardLegacyLimits = false): Promise<ConfigRefresh> {
  const before = ctx.config;
  const log = async (text: string): Promise<void> => {
    await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  ${text}\n`);
    ctx.out(text);
  };
  const refresh = async () => {
    const outcome = store.refresh(ctx.runner.now());
    if (outcome.config !== before) ctx.setConfig(outcome.config);
    if (guardLegacyLimits && !outcome.config.reloadWarning) await fenceLegacyLimits(ctx);
    await announceLimitConfigChange(ctx, before, outcome.config).catch(error => log(`config: ${errorMessage(error)}`));
    return outcome;
  };
  const r = ctx.runner.dryRun ? await refresh() : await withFileLock(limitEditLock(before.path), refresh);
  if (r.error) await log(`config: ${r.error}`);
  else if (r.changed) {
    await log(`config: reloaded (${r.keys.join(', ')})`);
    // QH: a changed usage.queue_hold (set_limits, limits set or a hand edit) is in force from this tick and said once.
    const hold = holdDiffText(before.usage.queueHold, r.config.usage.queueHold);
    if (hold) await recordJournalOnce(ctx, { kind: 'limits-changed', text: hold });
  }
  if (r.error || r.changed || before.reloadWarning) noteConfigState(configStatePath(r.config), by, ctx.runner.now(), r.error ?? r.config.reloadWarning);
  return r;
}

/** One notification "N zadań do wznowienia" when the watcher starts and tasks can be resumed (`agentctl resume`). Returns how many. */
export async function announceResumable(ctx: Context, notifier: Notifier): Promise<number> {
  const n = (await findResumable(ctx)).filter(candidate => !candidate.explicitOnly).length;
  if (n === 0) return 0;
  const text = resumeText(n);
  await ctx.runner.appendFile(watchLogPath(ctx), `${new Date(ctx.runner.now()).toISOString()}  resume: ${text}\n`);
  ctx.out(`resume: ${text}`);
  await notifier.notify('agentctl', text).catch(() => undefined);
  return n;
}

/** Foreground loop: tick every `watch.interval` seconds until aborted. */
export async function runWatch(ctx: Context, notifier: Notifier, opts: WatchOptions = {}): Promise<void> {
  const insideTmux = opts.insideTmux ?? Boolean(process.env.TMUX);
  if (insideTmux) await applyInstanceLabel(ctx).catch(() => undefined);
  const titleOut = opts.titleOutput ?? (process.stdout.isTTY && !ctx.runner.dryRun ? process.stdout : undefined);
  const restoreTitle = titleOut ? await beginTitle(ctx, titleOut, packageVersion(), 'watch', insideTmux) : undefined;
  try { await watchLoop(ctx, notifier, opts); }
  finally { await restoreTitle?.(); }
}

async function watchLoop(ctx: Context, notifier: Notifier, opts: WatchOptions): Promise<void> {
  let memory = new WatchMemory();
  const startedAt = ctx.runner.now(), version = packageVersion();
  const store = opts.configStore ?? new ConfigStore(() => loadGlobalConfig(path.dirname(ctx.config.path)), ctx.config);
  let current = notifier;
  const { interval, waitingAfter } = ctx.config.watch;
  ctx.out(`Watching every ${interval}s (waiting notice after ${waitingAfter}s), log: ${watchLogPath(ctx)}. Ctrl-C stops.`);
  // A change of the file is seen at once (and logged); the check at every tick is the safety net for a watcher that missed it.
  const reload = () => memory.steps.run(ctx, watchLogPath(ctx), 'config reload', applyReload);
  let fileWatcher: fs.FSWatcher | undefined;
  try {
    fileWatcher = fs.watch(path.dirname(ctx.config.path), (_event, name) => {
      if (name === path.basename(ctx.config.path)) void reload();
    });
    fileWatcher.on('error', () => undefined);
  } catch {
    // no file watching here: the tick checks
  }
  const applyReload = async (): Promise<void> => {
    const before = ctx.config.notify;
    const r = await reloadConfig(ctx, store, 'watch', true);
    if (r.changed && JSON.stringify(before) !== JSON.stringify(ctx.config.notify) && opts.remakeNotifier) current = await opts.remakeNotifier();
  };
  // After a restart of the Mac the tasks that were at work have a worktree and no window: say so once, when the watcher starts.
  await memory.steps.run(ctx, watchLogPath(ctx), 'startup inventory', () => announceResumable(ctx, current));
  try {
    for (let tick = 0; !opts.signal?.aborted && (opts.maxTicks === undefined || tick < opts.maxTicks); tick++) {
      if (tick > 0) await ctx.runner.sleep(ctx.config.watch.interval * 1000, opts.signal);
      if (opts.signal?.aborted) break;
      await reload();
      await watchTick(ctx, memory, current, { self: opts.self, signal: opts.signal });
      if (!ctx.runner.dryRun && !opts.signal?.aborted) {
        try {
          atomicWriteFile(watchProgressPath(ctx.config), JSON.stringify({version, pid: process.pid, tick: tick + 1, startedAt, at: ctx.runner.now()}));
        } catch (error) { ctx.out(`watch progress: ${errorMessage(error)}`); }
      }
      await opts.onTick?.(tick + 1, memory);
      const stalled = memory.steps.stalled(ctx.runner.now());
      if (stalled.length) {
        const text = `Watch wznawia pętlę po 10 min bez ukończenia etapów: ${stalled.join(', ')}`;
        ctx.out(text);
        await recordJournal(ctx, {kind: 'watch-stage-restarted', owner: 'owner', text});
        await postMessage(ctx, OWNER_IDENTITY, {kind: 'info', channel: 'agentctl', to: 'owner', subject: 'Watch wznowił pętlę etapów', body: text}).catch(error => ctx.out(errorMessage(error)));
        if (opts.onStall) opts.onStall();
        await memory.queue.idle();
        memory.launchHealth.close();
        await memory.launchHealth.idle();
        memory = new WatchMemory();
      }
    }
  } finally {
    fileWatcher?.close();
    memory.launchHealth.close();
    // A start in progress is not abandoned half way: the window and the prompt are its result.
    if (!(memory.steps.stalled(ctx.runner.now()).length && opts.onStall)) {
      await memory.queue.idle();
      const restored = await restoreWindowNames(ctx, memory);
      if (restored > 0) ctx.out(`Window names restored (${restored}).`);
    }
  }
}

/**
 * `watch --tmux`: make sure window "watch" exists in the agentctl session, running `commandLine`.
 * Returns what happened; never starts a second watcher.
 */
export function ensureWatchWindow(ctx: Context, commandLine: string, cwd: string): Promise<EnsureResult> {
  return ensureWindow(ctx, WATCH_WINDOW, commandLine, cwd);
}
