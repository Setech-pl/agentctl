import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { liveCacheRoot } from './live-cache.ts';
import { exerciseCanary, runIsolatedCanary, type CanaryMetrics } from '../src/core/canary.ts';
import { profileWatch } from './watch-profile.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const load = () => os.loadavg()[0] ?? 0;

export function pressureWorkerArgs(platform = process.platform, extraNice = 19): string[] {
  // Competing application processes are outside the gate's Darwin background scheduling group.
  // Clear that inherited policy for the CPU-only load workers while retaining their low nice priority.
  const policy = platform === 'darwin' ? 'taskpolicy -B -p "$$" || exit\n' : '';
  return ['-n', String(extraNice), '/bin/sh', '-c', `${policy}while :; do :; done`];
}

export function additionalPressureWorkers(cores: number, workers: number, load1: number): number {
  return load1 < 2 * cores + 4 ? Math.max(0, Math.min(cores, 6 * cores - workers)) : 0;
}

function installStopHandlers() {
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  return {stop, close() { process.off('SIGINT', abort); process.off('SIGTERM', abort); }};
}

async function runFixture(work: string, evidence: string, signal: AbortSignal): Promise<void> {
  const cores = os.cpus().length, target = 2 * cores;
  let current: CanaryMetrics | undefined;
  const save = (details: object) => fs.writeFileSync(evidence, JSON.stringify({cores, target,
    ...(process.platform === 'darwin' ? {watchPolicy: 'application, inherited nice'} : {}),
    ...details, ...(current ? {metrics: current} : {})}, null, 2) + '\n');
  const profile = profileWatch(console.log);
  try {
    current = await runIsolatedCanary(work, console.log, world => exerciseCanary(world, {
      scale: true, minTicks: 20, signal, load, observeStep: profile.observe,
      sample: metrics => { current = {...metrics}; save({status: 'RUNNING'}); },
    }), 2, 5);
    assert.ok(current.ticks >= 20 && current.tasks >= 1500 && current.worktreeDirs >= 2000 && current.queued === 40 && current.wall >= 150);
    assert.ok(current.minLoad1 >= target, `CPU contention fell below ${target} during the watch`);
    save({status: 'PASS'});
    console.log(JSON.stringify(current));
  } catch (error) {
    save({status: 'FAIL', error: String(error)});
    throw error;
  } finally { profile.restore(); }
}

async function applicationFixture(work: string, evidence: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'darwin') return runFixture(work, evidence, signal);
  // The gate controller stays in Darwin background policy. A tmux watch on the real machine runs as an application.
  // Keep the gate's nice level and the same CPU workers and filesystem delays for the measured service process.
  console.log('prodshape watcher uses application scheduling (inherited nice and observed CPU contention)');
  const worker = spawn('/bin/sh', ['-c', 'taskpolicy -B -p "$$" && exec "$@"', 'prodshape-watch', process.execPath,
    '--experimental-strip-types', '--no-warnings', process.argv[1]!, '--watch-workload'], {stdio: 'inherit'});
  let escalation: NodeJS.Timeout | undefined;
  const stop = () => {
    worker.kill('SIGTERM');
    escalation ??= setTimeout(() => worker.kill('SIGKILL'), 5000);
  };
  signal.addEventListener('abort', stop, {once: true});
  if (signal.aborted) stop();
  try {
    const [code] = await once(worker, 'close');
    assert.equal(code, 0, 'prodshape watch workload failed');
  } finally {
    signal.removeEventListener('abort', stop);
    clearTimeout(escalation);
  }
}

async function main() {
  const work = liveCacheRoot(process.env.AGENTCTL_PRODSHAPE_WORK);
  const evidence = process.env.AGENTCTL_PRODSHAPE_EVIDENCE;
  if (!evidence) throw Error('prodshape requires an evidence path from the gate');
  liveCacheRoot(path.dirname(evidence));
  const {stop, close} = installStopHandlers();
  if (process.argv[2] === '--watch-workload') {
    try { return await runFixture(work, evidence, stop.signal); }
    finally { close(); }
  }
  const cores = os.cpus().length, target = 2 * cores;
  const workers: { process: ChildProcess; closed: Promise<unknown> }[] = [];
  let closing = false;
  let workerError: Error | undefined;
  let addedAt = 0;
  const addWorkers = (count: number, extraNice: number) => {
    for (let i = 0; i < count; i++) {
      const child = spawn('nice', pressureWorkerArgs(process.platform, extraNice), {stdio: 'ignore'});
      const closed = once(child, 'close').catch(error => { workerError = error; stop.abort(); });
      workers.push({process: child, closed});
      child.once('exit', () => { if (!closing && !stop.signal.aborted) { workerError = Error('CPU pressure loop exited early'); stop.abort(); } });
    }
  };
  const keepPressure = () => {
    if (stop.signal.aborted || Date.now() - addedAt < 30_000) return;
    const additional = additionalPressureWorkers(cores, workers.length, load());
    if (!additional) return;
    addedAt = Date.now();
    addWorkers(additional, 0);
    console.log(`prodshape pressure increased to ${workers.length} CPU workers at load1 ${load().toFixed(2)}`);
  };
  let pressureTimer: NodeJS.Timeout | undefined;
  try {
    addWorkers(2 * cores + 8, 19);
    const warm = Date.now();
    addedAt = warm;
    while (load() < target + 4 && !stop.signal.aborted) {
      assert.ok(Date.now() - warm < 180_000, `CPU contention did not reach load1 ${target}, observed ${load()}`);
      keepPressure();
      await sleep(1000);
    }
    pressureTimer = setInterval(keepPressure, 5000);
    console.log(`prodshape CPU load1 ${load().toFixed(2)} / ${cores} cores, target ${target}`);
    await applicationFixture(work, evidence, stop.signal);
    if (workerError) throw workerError;
  } catch (error) {
    const failure = workerError ?? error;
    let saved: Record<string, unknown> = {};
    try { saved = JSON.parse(fs.readFileSync(evidence, 'utf8')); } catch { /* startup or interrupted write */ }
    if (saved.status !== 'FAIL' || workerError) fs.writeFileSync(evidence, JSON.stringify({cores, target, ...saved, status: 'FAIL', error: String(failure)}, null, 2) + '\n');
    throw failure;
  } finally {
    clearInterval(pressureTimer);
    close();
    closing = true;
    for (const worker of workers) worker.process.kill('SIGTERM');
    const escalate = setTimeout(() => { for (const worker of workers) if (worker.process.exitCode === null) worker.process.kill('SIGKILL'); }, 2000);
    try { await Promise.allSettled(workers.map(worker => worker.closed)); }
    finally { clearTimeout(escalate); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
