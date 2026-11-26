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

export function pressureWorkerArgs(platform = process.platform): string[] {
  // Competing application processes are outside the gate's Darwin background scheduling group.
  // Clear that inherited policy for the CPU-only load workers while retaining their low nice priority.
  const policy = platform === 'darwin' ? 'taskpolicy -B -p "$$" || exit\n' : '';
  return ['-n', '19', '/bin/sh', '-c', `${policy}while :; do :; done`];
}

async function main() {
  const work = liveCacheRoot(process.env.AGENTCTL_PRODSHAPE_WORK);
  const evidence = process.env.AGENTCTL_PRODSHAPE_EVIDENCE;
  if (!evidence) throw Error('prodshape requires an evidence path from the gate');
  liveCacheRoot(path.dirname(evidence));
  const cores = os.cpus().length;
  const target = 2 * cores;
  const stop = new AbortController();
  const abort = () => stop.abort();
  const workers: { process: ChildProcess; closed: Promise<unknown> }[] = [];
  let closing = false;
  let workerError: Error | undefined;
  let current: CanaryMetrics | undefined;
  const save = (details: object) => fs.writeFileSync(evidence, JSON.stringify({cores, target, ...details, ...(current ? {metrics: current} : {})}, null, 2) + '\n');
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    for (let i = 0; i < 2 * cores + 8; i++) {
      const child = spawn('nice', pressureWorkerArgs(), {stdio: 'ignore'});
      const closed = once(child, 'close').catch(error => { workerError = error; stop.abort(); });
      workers.push({process: child, closed});
      child.once('exit', () => { if (!closing && !stop.signal.aborted) { workerError = Error('CPU pressure loop exited early'); stop.abort(); } });
    }
    const warm = Date.now();
    while (load() < target && !stop.signal.aborted) {
      assert.ok(Date.now() - warm < 180_000, `CPU contention did not reach load1 ${target}, observed ${load()}`);
      await sleep(1000);
    }
    console.log(`prodshape CPU load1 ${load().toFixed(2)} / ${cores} cores, target ${target}`);
    const profile = profileWatch(console.log);
    try {
      current = await runIsolatedCanary(work, console.log, world => exerciseCanary(world, {
        scale: true, minTicks: 20, signal: stop.signal, load, observeStep: profile.observe,
        sample: metrics => {
          current = {...metrics};
          save({status: 'RUNNING'});
        },
      }), 2, 5);
    } finally { profile.restore(); }
    if (workerError) throw workerError;
    assert.ok(current.ticks >= 20 && current.tasks >= 1500 && current.worktreeDirs >= 2000 && current.queued === 40 && current.wall >= 150);
    assert.ok(current.minLoad1 >= target, `CPU contention fell below ${target} during the watch`);
    save({status: 'PASS'});
    console.log(JSON.stringify(current));
  } catch (error) {
    save({status: 'FAIL', error: String(workerError ?? error)});
    throw workerError ?? error;
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
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
