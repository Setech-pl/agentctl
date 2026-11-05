import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

/** Process-wide scheduler shared by disk facts, capacity, previews and GC. No inventory-generation jobs. */
export const MEASUREMENT_TTL_MS = 5 * 60_000;
export interface PathMeasurement { target: string; identity: string; at: number; bytes: number; newest: number }
export interface MeasurementOptions { background?: boolean; now?: () => number; fresh?: boolean }
export interface MeasurementLease { promise: Promise<PathMeasurement>; startedAt: number; release(): void }
interface Job {
  key: string; target: string; identity: string; now: () => number; startedAt: number;
  promise: Promise<PathMeasurement>; resolve(value: PathMeasurement): void; reject(error: Error): void;
  foreground: number; worker?: Worker; timer?: NodeJS.Timeout; cancelled?: Error;
}
const cache = new Map<string, PathMeasurement>();
const jobs = new Map<string, Job>();
const pending: Job[] = [];
let active = 0, limit = 2, timeoutMs = 600_000, foreground = 0;
let keepAlive: NodeJS.Timeout | undefined;

export function configureMeasurements(settings: { workers: number; measurementTimeoutS: number }): void {
  limit = settings.workers;
  timeoutMs = settings.measurementTimeoutS * 1000;
  pump();
}

/** Only the root is inspected here: replacements/removals and direct directory changes invalidate a cached tree, not every file read. */
function identityOf(target: string): string {
  try { const st = fs.lstatSync(target); return `${st.dev}:${st.ino}:${st.birthtimeMs}:${st.mtimeMs}`; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'missing'; throw error; }
}
export function cachedMeasurement(target: string): PathMeasurement | undefined {
  target = path.resolve(target);
  const value = cache.get(target);
  if (value && value.identity !== identityOf(target)) { cache.delete(target); return undefined; }
  return value;
}
export function restoreMeasurements(values: unknown, now: number): void {
  if (!Array.isArray(values)) return;
  for (const item of values) {
    if (!item || typeof item.target !== 'string' || typeof item.identity !== 'string' || ![item.at, item.bytes, item.newest].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) continue;
    if (item.at > now || now - item.at >= MEASUREMENT_TTL_MS) continue;
    const target = path.resolve(item.target);
    if (!cache.has(target) && identityOf(target) === item.identity) remember({ ...item, target });
  }
}
function remember(value: PathMeasurement): void {
  cache.set(value.target, value);
  if (cache.size > 4096) cache.delete(cache.keys().next().value!);
}
function updateReferences(job: Job): void {
  // Adding message listeners references the port: ownership is applied only after all handlers are attached.
  if (job.foreground > 0) job.worker?.ref(); else job.worker?.unref();
  if (foreground > 0 && !keepAlive) keepAlive = setInterval(() => {}, 1000);
  if (foreground === 0 && keepAlive) { clearInterval(keepAlive); keepAlive = undefined; }
}

export function requestMeasurement(target: string, opts: MeasurementOptions = {}): MeasurementLease {
  target = path.resolve(target);
  const now = opts.now ?? Date.now;
  const identity = identityOf(target);
  const previous = cachedMeasurement(target);
  if (!opts.fresh && previous && now() >= previous.at && now() - previous.at < MEASUREMENT_TTL_MS) return { promise: Promise.resolve(previous), startedAt: Date.now(), release() {} };
  const key = `${target}\0${identity}`;
  let job = jobs.get(key);
  if (!job) {
    let resolve!: Job['resolve'], reject!: Job['reject'];
    const promise = new Promise<PathMeasurement>((yes, no) => { resolve = yes; reject = no; });
    // Budgeted readers may have returned when shutdown cancels a job. Every job owns a rejection observer.
    void promise.catch(() => undefined);
    job = { key, target, identity, now, startedAt: Date.now(), promise, resolve, reject, foreground: 0 };
    jobs.set(key, job); pending.push(job);
  }
  const current = job;
  let released = false;
  if (!opts.background) { current.foreground++; foreground++; }
  updateReferences(current);
  pump();
  return { promise: current.promise, startedAt: current.startedAt, release() {
    if (released) return; released = true;
    if (!opts.background) { current.foreground--; foreground--; }
    updateReferences(current);
  } };
}

const WALKER = `
const {parentPort, workerData} = require('node:worker_threads');
const fs = require('node:fs'); const path = require('node:path');
function walk(target) {
 let st; try { st=fs.lstatSync(target); } catch(e) { if(['ENOENT','ENOTDIR'].includes(e.code))return {bytes:0,newest:0}; throw e; }
 if(!st.isDirectory()) return {bytes:st.size,newest:st.mtimeMs};
 let names; try { names=fs.readdirSync(target); } catch(e) { if(['ENOENT','ENOTDIR'].includes(e.code))return {bytes:0,newest:0}; throw e; }
 let bytes=0,newest=names.length?0:st.mtimeMs;
 for(const name of names){const m=walk(path.join(target,name));bytes+=m.bytes;newest=Math.max(newest,m.newest);}
 return {bytes,newest};
}
try {parentPort.postMessage(walk(workerData.target));}catch(e){parentPort.postMessage({failure:String(e&&e.message||e)});}
`;

function pump(): void {
  while (active < limit && pending.length) {
    const job = pending.shift()!;
    if (job.cancelled) continue;
    active++;
    start(job);
  }
}
function finish(job: Job, value?: { bytes: number; newest: number }, error?: Error): void {
  clearTimeout(job.timer);
  jobs.delete(job.key);
  active--;
  try {
    if (job.cancelled || error) job.reject(job.cancelled ?? error!);
    else if (value) {
      const reading = { target: job.target, identity: job.identity, at: job.now(), ...value };
      // A replaced path must not inherit a result from an older root, even if its worker completes later.
      if (identityOf(job.target) === job.identity) remember(reading);
      job.resolve(reading);
    } else job.reject(new Error('measurement ended without a result'));
  } catch (e) { job.reject(e instanceof Error ? e : new Error(String(e))); }
  pump();
}
function start(job: Job): void {
  let value: { bytes: number; newest: number } | undefined, error: Error | undefined, unavailable = false;
  const duration = timeoutMs;
  job.timer = setTimeout(() => {
    job.cancelled = new Error(`measurement timed out after ${duration}ms: ${job.target}`);
    if (job.worker) void job.worker.terminate();
  }, duration);
  job.timer.unref();
  try {
    job.worker = new Worker(WALKER, { eval: true, workerData: { target: job.target } });
    job.worker.once('message', (m: { bytes: number; newest: number; failure?: string }) => {
      if (m.failure) error = new Error(m.failure); else value = { bytes: m.bytes, newest: m.newest };
    });
    job.worker.once('error', (e: Error) => { unavailable = true; error = e; });
    // A slot is released at exit, not message: live workers, including result/exit overlap, stay within the cap.
    job.worker.once('exit', () => {
      if (!job.cancelled && (unavailable || (!value && !error)) && job.foreground > 0) fallback(job);
      else if (!job.cancelled && !value && !error) finish(job, undefined, new Error('background measurement worker unavailable'));
      else finish(job, value, error);
    });
    updateReferences(job);
  } catch (error) {
    if (job.foreground > 0) fallback(job);
    else finish(job, undefined, error instanceof Error ? error : new Error(String(error)));
  }
}

/** Worker creation/crash fallback keeps the same scheduler slot; sequential asynchronous I/O has bounded memory. */
function fallback(job: Job): void {
  job.worker = undefined;
  const walk = async (target: string): Promise<{ bytes: number; newest: number }> => {
    if (job.cancelled) throw job.cancelled;
    let st: fs.Stats;
    try { st = await fs.promises.lstat(target); }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return { bytes: 0, newest: 0 }; throw e; }
    if (!st.isDirectory()) return { bytes: st.size, newest: st.mtimeMs };
    let names: string[];
    try { names = await fs.promises.readdir(target); }
    catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return { bytes: 0, newest: 0 }; throw e; }
    let bytes = 0, newest = names.length ? 0 : st.mtimeMs;
    for (const name of names) { const m = await walk(path.join(target, name)); bytes += m.bytes; newest = Math.max(newest, m.newest); }
    return { bytes, newest };
  };
  void walk(job.target).then(value => finish(job, value), error => finish(job, undefined, error));
}

function measurementValue(target: string, field: 'bytes' | 'newest', opts: MeasurementOptions): Promise<number> {
  const lease = requestMeasurement(target, opts);
  const result = lease.promise.then(value => value[field]).finally(() => lease.release());
  // Fire-and-forget background owners are allowed; awaiting the same promise still observes failures.
  if (opts.background) void result.catch(() => undefined);
  return result;
}
export function sizeOf(target: string, opts: MeasurementOptions = {}): Promise<number> {
  return measurementValue(target, 'bytes', opts);
}
export function newestMtime(target: string, opts: MeasurementOptions = {}): Promise<number> {
  return measurementValue(target, 'newest', opts);
}

/** MCP shutdown owns all measurements in its process. An idle CLI also cancels its remaining background-only work. */
export async function shutdownMeasurements(): Promise<void> {
  const stops: Promise<unknown>[] = [];
  for (const job of jobs.values()) {
    job.cancelled = new Error('measurement cancelled on shutdown');
    if (job.worker) stops.push(job.worker.terminate());
  }
  for (const job of pending.splice(0)) { jobs.delete(job.key); job.reject(job.cancelled!); }
  await Promise.allSettled(stops);
}
process.once('beforeExit', () => { void shutdownMeasurements(); });
