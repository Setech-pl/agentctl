import { withResponseBudget } from './response-budget.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { withFileLock, taskLock, FileLockTimeout } from './file-lock.ts';
import { readTaskRecordById, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import type { Context } from './context.ts';
import { readReportText } from './report-path.ts';
import { inspectReport } from './report-state.ts';

type Receipt = { task: string; signature: string; fields?: Record<string, string>; page?: { client: string; start: number; end: number; bytes: number } };
const receiptDir = (ctx: Context) => path.join(path.dirname(ctx.config.path), 'report-delivery-requests');
function enqueue(ctx: Context, receipt: Receipt): void {
  fs.mkdirSync(receiptDir(ctx), {recursive: true});
  fs.writeFileSync(path.join(receiptDir(ctx), `${randomUUID()}.json`), JSON.stringify(receipt), {mode: 0o600});
}
function unchanged(ctx: Context, record: TaskRecord, signature: string): boolean {
  return inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId).ready &&
    createHash('sha256').update(readReportText(ctx.config, record, record.report)).digest('hex') === signature;
}
async function fields(ctx: Context, record: TaskRecord, receipt: Receipt): Promise<void> {
  const file = taskFile(ctx.config, record.window);
  await withFileLock(taskLock(file), async () => {
    const current = readTaskRecordById(ctx.config, record.task);
    if (current && unchanged(ctx, current, receipt.signature)) await setHeaderFields(ctx.runner, file, receipt.fields!);
  }, 0);
}
export async function deliverReportFields(ctx: Context, record: TaskRecord, signature: string, values: Record<string, string>): Promise<void> {
  const receipt = {task: record.task, signature, fields: values};
  // Delivery never waits on an asynchronous state write either. A late writer may finish;
  // replay is idempotent and still verifies the content signature.
  await withResponseBudget(async () => {
    try { await fields(ctx, record, receipt); }
    catch (error) { if (!(error instanceof FileLockTimeout)) throw error; enqueue(ctx, receipt); }
  }, () => enqueue(ctx, receipt), undefined, 100);
}
async function page(ctx: Context, record: TaskRecord, receipt: Receipt): Promise<void> {
  const file = path.join(path.dirname(ctx.config.path), 'report-read-progress.json');
  await withFileLock(`${file}.lock`, async () => {
    if (!unchanged(ctx, record, receipt.signature)) return;
    let reads: Record<string, [number, number][]> = {};
    try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) reads[key] = [[0, value]];
      else if (Array.isArray(value)) reads[key] = value.filter(v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) as [number, number][];
    } } catch { /* first read */ }
    const p = receipt.page!;
    const key = `${p.client}:${record.task}:${record.attemptId ?? record.started}:${receipt.signature}`;
    const ranges = [...(reads[key] ?? []), [p.start, p.end] as [number, number]].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) { const last = merged.at(-1); if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
    reads[key] = merged;
    if (merged[0]?.[0] === 0 && merged[0][1] >= p.bytes) await deliverReportFields(ctx, record, receipt.signature, {pulled: new Date(Math.max(ctx.runner.now(), Math.ceil(fs.statSync(record.report).mtimeMs))).toISOString()});
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(reads).slice(-256))));
  }, 0);
}
export async function deferReportPage(ctx: Context, record: TaskRecord, signature: string, client: string, start: number, end: number, bytes: number): Promise<void> {
  const receipt = {task: record.task, signature, page: {client, start, end, bytes}};
  try { await page(ctx, record, receipt); }
  catch (error) { if (!(error instanceof FileLockTimeout)) throw error; enqueue(ctx, receipt); }
}
/** Watch retries contended acknowledgements; a changed report remains unread. */
export async function applyReportDeliveries(ctx: Context): Promise<void> {
  let files: string[];
  try { files = fs.readdirSync(receiptDir(ctx)).filter(f => f.endsWith('.json')).slice(0, 100); } catch { return; }
  for (const name of files) {
    const file = path.join(receiptDir(ctx), name);
    try {
      const receipt: Receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      const record = readTaskRecordById(ctx.config, receipt.task);
      if (record) { if (receipt.page) await page(ctx, record, receipt); else await fields(ctx, record, receipt); }
      fs.unlinkSync(file);
    } catch { /* retry on the next tick */ }
  }
}
