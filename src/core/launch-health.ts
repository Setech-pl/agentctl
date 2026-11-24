import type { Context } from './context.ts';
import type { SelfArgv } from './events.ts';
import { tryFileLock } from './file-lock.ts';
import { readJournal, recordJournalOnce } from './journal.ts';
import type { Notifier } from './notify.ts';
import { readQueue } from './queue.ts';
import { inspectReport } from './report-state.ts';
import { planResume, resumeTasks } from './resume.ts';
import { expectedStartClosure, inLaunchGrace, launchExitText, launchIdentity, readLaunchExit, storeLaunchExit } from './start-failure.ts';
import { listTaskRecords, readTaskRecord } from './taskstore.ts';
import { expectedCloseFile } from './tmux-loss.ts';
import { errorMessage } from './util.ts';

/** Reap exited panes, retain the cause and retry an early exit once under the original task ID. */
export async function checkLaunchHealth(ctx: Context, notifier: Notifier, self?: SelfArgv, signal?: AbortSignal): Promise<void> {
  if (ctx.runner.dryRun) return;
  const {config, runner} = ctx;
  const records = listTaskRecords(config).filter(record => !record.closed && !record.cancelled && !record.supersededBy
    && (record.launchAt || (record.promptDelivery === 'launching' && record.started && record.windowId) || record.launchRetried));
  if (!records.length) return;
  const starting = new Set(readQueue(config).filter(entry => entry.status === 'starting' || entry.status === 'accepted' || entry.status === 'queued').map(entry => entry.task));
  const windows = await ctx.tmux.windows();
  const byName = new Map(windows.map(window => [window.plain, window]));
  let terminal: Set<string | undefined> | undefined;
  for (const record of records) {
    if (signal?.aborted) return;
    const pane = byName.get(record.window);
    if ((pane && pane.exitCode === undefined) || starting.has(record.task) || (record.host && ctx.hosts.connection(record.host).unreachable)) continue;
    let cause = readLaunchExit(config, record);
    const early = inLaunchGrace(config, record, runner.now());
    if (!cause && pane?.exitCode === undefined && (!early || expectedStartClosure(config, record))) continue;
    terminal ??= new Set(readJournal(config).filter(event => event.kind === 'launch-failed').map(event => event.changeId));
    if (!pane && terminal.has(`launch-failed:${record.task}:${launchIdentity(record)}`)) continue;
    const release = tryFileLock(`${expectedCloseFile(config, record.window)}.launch.lock`);
    if (!release) continue;
    try {
      const current = readTaskRecord(config, record.window);
      if (!current || current.closed || current.cancelled || launchIdentity(current) !== launchIdentity(record)) continue;
      const report = inspectReport(config, record, runner.now(), !record.attemptId);
      const tmux = record.host ? ctx.hosts.tmux(record.host) : ctx.localTmux;
      const capture = pane && !cause ? await tmux.capture(record.window, 20, [pane], pane.id) : undefined;
      if (!report.ready) {
        cause ??= await storeLaunchExit(ctx, record, pane?.exitCode ?? null, capture?.stdout ?? '',
          pane ? 'proces agenta zakończył pracę' : 'okno zniknęło przed zapisaniem kodu wyjścia', early);
        const text = `${record.task}: okno zniknęło bez raportu – ${launchExitText(cause)}`;
        await recordJournalOnce(ctx, {kind: 'dead', task: record.task, launch: cause, text, changeId: `exit:${record.task}:${cause.identity}`});
      }
      if (pane && (await tmux.killWindow(record.window, pane.id)).code !== 0) continue;
      if (report.ready || !cause?.startup) continue;
      const fail = async (detail?: string) => {
        const text = `${record.task}: launch-failed – ${detail ? `${detail}; ` : ''}${launchExitText(cause!)}`;
        await recordJournalOnce(ctx, {kind: 'launch-failed', task: record.task, launch: cause, text, changeId: `launch-failed:${record.task}:${cause!.identity}`});
      };
      if (record.launchRetried) { await fail(); continue; }
      try {
        const plan = await planResume(ctx, [record.task]);
        if (!plan.items.length) continue; // The same worktree waits for an available slot.
        if (!(await resumeTasks(ctx, plan, {self, launchRetry: true})).length) continue;
        await recordJournalOnce(ctx, {kind: 'queue-retry', task: record.task, text: `${record.task}: ponowiono start w tym samym worktree; ${cause.logPath}`, changeId: `launch-retry:${record.task}:${cause.identity}`});
      } catch (error) {
        const current = readTaskRecord(config, record.window) ?? record;
        const detail = errorMessage(error);
        if (current.launchRetried) cause = await storeLaunchExit(ctx, current, null, '', detail.split('\n')[0]!, true);
        await fail(detail);
        await notifier.notify('agentctl', `${record.task}: launch-failed – ${detail.split('\n')[0]}`).catch(() => undefined);
      }
    } finally { release(); }
  }
}
