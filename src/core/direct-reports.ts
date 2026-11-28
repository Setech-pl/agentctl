import { inspectReport } from './report-state.ts';
import { listTaskRecords, listArchivedRecords, type TaskRecord } from './taskstore.ts';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';

/** Report facts belong to TASK.md and its file, never to tmux or a watch snapshot. */
/** `loaded` reuses headers a caller already read (events keeps its indexed snapshot instead of reopening TASK.md). */
export function directReportRows(ctx: Context, archived = false, loaded?: readonly TaskRecord[]): StatusRow[] {
  const records = loaded ? [...loaded] : [...listTaskRecords(ctx.config), ...(archived ? listArchivedRecords(ctx.config) : [])];
  const seen = new Set<string>();
  return records.flatMap(record => {
    if (seen.has(record.task)) return [];
    seen.add(record.task);
    const report = inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId);
    if (!report.ready) return [];
    const pulled = record.pulled && Date.parse(record.pulled) >= Math.floor(report.mtime ?? Infinity) ? record.pulled : null;
    const closed = record.closed === true, cancelled = record.cancelled === true;
    return [{
      task: record.task, agent: record.agent, model: record.model, effort: record.effort,
      requested: '', effective: '', switchedBy: null, state: cancelled ? 'cancelled' : closed ? 'closed' : record.supersededBy ? 'superseded' : 'report-ready',
      window: 'gone', windowName: record.window, windowId: record.windowId ?? null,
      started: record.started, startedLocal: '', duration: '-', report: 'yes', reportPath: record.report,
      reportSignature: report.signature, reportMtime: report.mtime, reportSource: record.reportSource,
      pulled, lastLine: '', progress: null, collide: [], hint: null, question: null, pin: record.pin === true,
      finished: true, hidden: closed || cancelled || record.hidden === true,
      hiddenBy: cancelled ? 'cancelled' : closed ? 'closed' : record.hidden ? 'user' : null,
      closed, closedAt: record.closedAt ?? null, archived: false, cancelled, cancelledAt: record.cancelledAt ?? null, cancelReason: record.cancelReason ?? null,
      cohort: record.cohort ?? null, supersededBy: record.supersededBy ?? null, continues: record.continues ?? null,
      attemptId: record.attemptId, attempt: record.attempt, reviewOf: record.reviewOf,
    } satisfies StatusRow];
  });
}
