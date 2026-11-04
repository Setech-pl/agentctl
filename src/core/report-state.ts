import { readReportText } from './report-path.ts';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import type { GlobalConfig } from './config.ts';
import type { TaskRecord } from './taskstore.ts';

export const REPORT_END = '<!-- agentctl:report-end -->';
export function reportFingerprint(file: string): string {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
export function attemptFields(record: Pick<TaskRecord, 'report' | 'attempt'>, now: number) {
  return { attempt: (record.attempt ?? 0) + 1, attemptId: randomUUID(), attemptStarted: new Date(now).toISOString(), attemptReportBaseline: reportFingerprint(record.report) };
}
export interface ReportState { ready: boolean; exists: boolean; mtime?: number; signature?: string; reason: string }
/** Single report readiness rule for status, hooks, history, cohorts and dependency consumers. */
export function inspectReport(config: Pick<GlobalConfig, 'reportSettleS'> & Partial<Pick<GlobalConfig, 'cache'>>, record: TaskRecord, now: number, turnEnded: boolean, file = record.report): ReportState {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { ready: false, exists: true, reason: 'not a regular report' };
    const start = Date.parse(record.attemptStarted ?? record.started);
    if (Number.isFinite(start) && st.mtimeMs < start) return { ready: false, exists: true, mtime: st.mtimeMs, reason: 'before current attempt' };
    const text = config.cache ? readReportText({ cache: config.cache }, record, file) : fs.readFileSync(file, 'utf8');
    const signature = createHash('sha256').update(text).digest('hex');
    if (record.deliveryStartedAt && signature === record.deliveryReportBaseline && (record.promptDelivery !== 'sent' || record.promptKind === 'followup')) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'unchanged before prompt delivery' };
    if (record.attemptReportBaseline && signature === record.attemptReportBaseline) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'unchanged from previous attempt' };
    let fence: string | null = null, declaredAttempt: string | undefined, lastDirective = '';
    for (const line of text.split('\n')) {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; if (line.trim()) lastDirective = ''; continue; }
      if (line.trim()) lastDirective = fence ? '' : line.trim();
      if (!fence) declaredAttempt = /^<!-- agentctl:attempt ([^>]+) -->$/.exec(line.trim())?.[1] ?? declaredAttempt;
    }
    if (declaredAttempt && declaredAttempt !== record.attemptId) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'different report attempt' };
    const sentinel = lastDirective === REPORT_END;
    const copiedComplete = file === record.report && signature === record.reportCompleteHash;
    const ended = turnEnded || (!!record.turnEndedAt && Date.parse(record.turnEndedAt) >= (Number.isFinite(start) ? start : 0) && (config.reportSettleS === 0 || Date.parse(record.turnEndedAt) >= Math.floor(st.mtimeMs)));
    const ready = sentinel || copiedComplete || (ended && (config.reportSettleS === 0 || now - st.mtimeMs >= config.reportSettleS * 1000));
    return { ready, exists: true, mtime: st.mtimeMs, signature, reason: ready ? sentinel ? 'report-end marker' : 'settled after turn end' : 'incomplete: awaiting report-end or settled turn end' };
  } catch (error) { return { ready: false, exists: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no report' : error instanceof Error ? error.message : 'no report' }; }
}
