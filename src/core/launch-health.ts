import { withCommandStage } from './command-stage.ts';
import type { Context } from './context.ts';
import type { SelfArgv } from './events.ts';
import { tryFileLock } from './file-lock.ts';
import { indexedJournalChange, journalChangeIds, recordJournalOnce } from './journal.ts';
import type { Notifier } from './notify.ts';
import { readQueue } from './queue.ts';
import { inspectReport } from './report-state.ts';
import { planResume, resumeTasks } from './resume.ts';
import { expectedStartClosure, inLaunchGrace, launchExitText, launchIdentity, legacyLaunch, readLaunchExit, storeLaunchExit } from './start-failure.ts';
import { pendingStarts } from './start-lock.ts';
import { readRecordFileAsync, readTaskRecord, setHeaderFields, TaskRecordIndex, taskFile } from './taskstore.ts';
import { expectedCloseFile } from './tmux-loss.ts';
import { errorMessage } from './util.ts';

export class LaunchHealthMemory {
  readonly records = new TaskRecordIndex();
  private readonly stop = new AbortController();
  private pending?: Promise<void>;

  start(action: (signal: AbortSignal) => Promise<void>, onError: (error: unknown) => void): boolean {
    if (this.pending || this.stop.signal.aborted) return false;
    this.pending = Promise.resolve().then(() => action(this.stop.signal)).catch(onError).finally(() => { this.pending = undefined; });
    return true;
  }

  async idle(): Promise<void> { await this.pending; }

  close(): void {
    this.stop.abort();
    this.records.close();
  }
}

/** Reap exited panes and schedule at most one early retry outside the watch tick. */
export async function checkLaunchHealth(ctx: Context, memory: LaunchHealthMemory, notifier: Notifier, self?: SelfArgv, signal?: AbortSignal): Promise<void> {
  if (ctx.runner.dryRun) return;
  const {config, runner} = ctx;
  const records = (await memory.records.current(config, runner.now())).filter(record => !record.closed && !record.cancelled && !record.supersededBy
    && (record.launchAt || legacyLaunch(record) || record.launchRetried));
  if (!records.length || signal?.aborted) return;
  const starting = new Set([...pendingStarts(config), ...readQueue(config).filter(entry => entry.status !== 'failed')].map(entry => entry.task));
  const windows = await withCommandStage(3000, signal, () => ctx.tmux.windows());
  const byName = new Map(windows.map(window => [window.plain, window]));
  const windowHosts = new Set(windows.map(window => window.host ?? ''));
  let ids: Awaited<ReturnType<typeof journalChangeIds>> | undefined;
  let marked = 0;
  let checkedLegacy: Set<string> | undefined;
  for (const record of records) {
    if (signal?.aborted) return;
    const pane = byName.get(record.window);
    if ((pane && pane.exitCode === undefined) || starting.has(record.task) || (record.host && ctx.hosts.connection(record.host).unreachable)) continue;
    const id = `${record.task}:${launchIdentity(record)}`;
    ids ??= await journalChangeIds(config);
    if (!pane && indexedJournalChange(ids, 'launch-failed', `launch-failed:${id}`)) continue;
    if (legacyLaunch(record) && !pane) {
      const changeId = `launch-legacy:${id}`;
      if (marked >= 20 || indexedJournalChange(ids, 'launch-legacy', changeId)) continue;
      const current = await readRecordFileAsync(taskFile(config, record.window));
      if (!current || launchIdentity(current) !== launchIdentity(record) || expectedStartClosure(config, current)) continue;
      // A separate observation prevents replay after a transient tmux inventory failure.
      checkedLegacy ??= new Set((await withCommandStage(3000, signal, () => ctx.tmux.windows())).map(window => window.plain));
      if (signal?.aborted || checkedLegacy.has(record.window)) continue;
      marked++;
      await recordJournalOnce(ctx, {kind: 'launch-legacy', task: record.task, changeId,
        text: `${record.task}: przerwany start ze starszej wersji. Wznów ręcznie poleceniem agentctl resume ${record.task}.`});
      continue;
    }
    let cause = readLaunchExit(config, record);
    const early = inLaunchGrace(config, record, runner.now());
    const missingDuringLaunch = early && windowHosts.has(record.host ?? '');
    if (expectedStartClosure(config, record) || (!cause && pane?.exitCode === undefined && !missingDuringLaunch)) continue;
    const release = tryFileLock(`${expectedCloseFile(config, record.window)}.launch.lock`);
    if (!release) continue;
    let transferred = false;
    try {
      const current = readTaskRecord(config, record.window);
      if (!current || current.closed || current.cancelled || launchIdentity(current) !== launchIdentity(record)) continue;
      const report = inspectReport(config, record, runner.now(), !record.attemptId);
      const tmux = record.host ? ctx.hosts.tmux(record.host) : ctx.localTmux;
      const capture = pane && !cause ? await withCommandStage(3000, signal, () => tmux.capture(record.window, 20, [pane], pane.id)) : undefined;
      if (!report.ready) {
        if (!pane && !cause) {
          const confirmed = await withCommandStage(3000, signal, () => tmux.windows());
          if (signal?.aborted || confirmed.some(window => window.plain === record.window || window.id === record.windowId)) continue;
        }
        cause ??= await storeLaunchExit(ctx, record, pane?.exitCode ?? null, capture?.stdout ?? '',
          pane ? 'proces agenta zakończył pracę' : 'okno zniknęło przed zapisaniem kodu wyjścia', early);
        await recordJournalOnce(ctx, {kind: 'dead', task: record.task, launch: cause,
          text: `${record.task}: okno zniknęło bez raportu – ${launchExitText(cause)}`, changeId: `exit:${record.task}:${cause.identity}`});
      }
      if (pane && (await withCommandStage(3000, signal, () => tmux.killWindow(record.window, pane.id))).code !== 0) continue;
      if (report.ready || !cause?.startup || legacyLaunch(record)) continue;
      const retryCause = cause;
      const fail = async (detail?: string) => {
        const text = `${record.task}: launch-failed – ${detail ? `${detail}; ` : ''}${launchExitText(cause!)}`;
        await recordJournalOnce(ctx, {kind: 'launch-failed', task: record.task, launch: cause, text, changeId: `launch-failed:${record.task}:${cause!.identity}`});
      };
      if (record.launchRetried) { await fail(); continue; }
      transferred = memory.start(async abort => {
        try {
          const plan = await withCommandStage(3000, abort, () => planResume(ctx, [record.task], {record}));
          if (!plan.items.length || !(await resumeTasks(ctx, plan, {self, signal: abort, launchRetry: true})).length) return;
          await recordJournalOnce(ctx, {kind: 'queue-retry', task: record.task,
            text: `${record.task}: ponowiono start w tym samym worktree; ${retryCause.logPath}`, changeId: `launch-retry:${record.task}:${retryCause.identity}`});
        } catch (error) {
          const current = readTaskRecord(config, record.window) ?? record;
          const detail = errorMessage(error).split('\n')[0]!;
          if (current.launchRetried) {
            cause = await storeLaunchExit(ctx, current, null, '', detail, true);
            await setHeaderFields(runner, taskFile(config, current.window), {prompt_delivery: 'needs-attention'});
          }
          await fail(detail);
          await notifier.notify('agentctl', `${record.task}: launch-failed – ${detail}`).catch(() => undefined);
        } finally { release(); }
      }, error => ctx.info(errorMessage(error)));
    } finally { if (!transferred) release(); }
  }
}
