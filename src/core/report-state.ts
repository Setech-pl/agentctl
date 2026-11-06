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
  return { attempt: (record.attempt ?? 0) + 1, outputsProtocol: 1, attemptId: randomUUID(), attemptStarted: new Date(now).toISOString(), attemptReportBaseline: reportFingerprint(record.report) };
}
export interface ReportState { ready: boolean; exists: boolean; mtime?: number; signature?: string; reason: string; /** The report ends with the explicit report-end directive of this attempt (not only a settled turn). */ sentinel?: boolean }

/** What the body of a report says, once read: its hash and the directives the readiness rule looks at. */
interface ReportDigest {
  signature: string;
  lastDirective: string;
  declaredAttempts: Set<string>;
}

/** Digests per report path, valid while lstat (dev, ino, mtime, size) is unchanged: the body is not read or hashed again. */
const reportDigests = new Map<string, { dev: number; ino: number; mtimeMs: number; size: number; digest: ReportDigest }>();

function digestReport(config: Pick<GlobalConfig, 'reportSettleS'> & Partial<Pick<GlobalConfig, 'cache'>>, record: TaskRecord, file: string, st: fs.Stats): ReportDigest {
  const hit = reportDigests.get(file);
  if (hit && hit.dev === st.dev && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.digest;
  const text = config.cache ? readReportText({ cache: config.cache }, record, file) : fs.readFileSync(file, 'utf8');
  let fence: string | null = null, lastDirective = '';
  const declaredAttempts = new Set<string>();
  for (const line of text.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; if (line.trim()) lastDirective = ''; continue; }
    if (line.trim()) lastDirective = fence ? '' : line.trim();
    if (!fence) { const attempt = /^<!-- agentctl:attempt ([^>]+) -->$/.exec(line.trim())?.[1]; if (attempt) declaredAttempts.add(attempt); }
  }
  const digest: ReportDigest = { signature: createHash('sha256').update(text).digest('hex'), lastDirective, declaredAttempts };
  if (reportDigests.size > 5000) reportDigests.delete(reportDigests.keys().next().value!);
  reportDigests.set(file, { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, digest });
  return digest;
}

/** Single report readiness rule for status, hooks, history, cohorts and dependency consumers. */
export function inspectReport(config: Pick<GlobalConfig, 'reportSettleS'> & Partial<Pick<GlobalConfig, 'cache'>>, record: TaskRecord, now: number, turnEnded: boolean, file = record.report): ReportState {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { ready: false, exists: true, reason: 'not a regular report' };
    const start = Date.parse(record.attemptStarted ?? record.started);
    if (Number.isFinite(start) && st.mtimeMs < start) return { ready: false, exists: true, mtime: st.mtimeMs, reason: 'before current attempt' };
    const { signature, lastDirective, declaredAttempts } = digestReport(config, record, file, st);
    if (record.deliveryStartedAt && signature === record.deliveryReportBaseline && (record.promptDelivery !== 'sent' || record.promptKind === 'followup')) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'unchanged before prompt delivery' };
    if (record.attemptReportBaseline && signature === record.attemptReportBaseline) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'unchanged from previous attempt' };
    // In-place revisions can retain an older directive after the current one.
    // A previous-attempt-only report remains ineligible, regardless of mtime.
    if (declaredAttempts.size && (!record.attemptId || !declaredAttempts.has(record.attemptId))) return { ready: false, exists: true, mtime: st.mtimeMs, signature, reason: 'different report attempt' };
    const sentinel = lastDirective === REPORT_END;
    const copiedComplete = file === record.report && signature === record.reportCompleteHash;
    const ended = turnEnded || (!!record.turnEndedAt && Date.parse(record.turnEndedAt) >= (Number.isFinite(start) ? start : 0) && (config.reportSettleS === 0 || Date.parse(record.turnEndedAt) >= Math.floor(st.mtimeMs)));
    const ready = sentinel || copiedComplete || (ended && (config.reportSettleS === 0 || now - st.mtimeMs >= config.reportSettleS * 1000));
    return { ready, exists: true, mtime: st.mtimeMs, signature, sentinel, reason: ready ? sentinel ? 'report-end marker' : 'settled after turn end' : 'incomplete: awaiting report-end or settled turn end' };
  } catch (error) { return { ready: false, exists: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'no report' : error instanceof Error ? error.message : 'no report' }; }
}
