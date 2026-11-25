import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { liveCacheRoot } from './live-cache.ts';
import { exerciseCanary, runIsolatedCanary, type CanaryMetrics } from '../src/core/canary.ts';

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const load = () => os.loadavg()[0] ?? 0;

async function main() {
  const work = liveCacheRoot(process.env.AGENTCTL_PRODSHAPE_WORK);
  const evidence = process.env.AGENTCTL_PRODSHAPE_EVIDENCE;
  if (!evidence) throw Error('prodshape requires an evidence path from the gate');
  liveCacheRoot(path.dirname(evidence));
  const cores = os.cpus().length;
  const target = 2 * cores;
  const stop = new AbortController();
  const abort = () => stop.abort();
  const workers: Worker[] = [];
  let workerError: Error | undefined;
  let current: CanaryMetrics | undefined;
  let attempt = 1;
  const save = (details: object) => fs.writeFileSync(evidence, JSON.stringify({cores, target, attempt, ...details, ...(current ? {metrics: current} : {})}, null, 2) + '\n');
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    for (let i = 0; i < 3 * cores; i++) {
      const worker = new Worker('for (;;) Math.imul(123, 456);', {eval: true, execArgv: []});
      workers.push(worker);
      worker.on('error', error => { workerError = error; stop.abort(); });
    }
    const warm = Date.now();
    while (load() < target && !stop.signal.aborted) {
      assert.ok(Date.now() - warm < 180_000, `CPU contention did not reach load1 ${target}, observed ${load()}`);
      await sleep(1000);
    }
    console.log(`prodshape CPU load1 ${load().toFixed(2)} / ${cores} cores, target ${target}`);
    const run = () => runIsolatedCanary(work, console.log, world => exerciseCanary(world, {
      scale: true, minTicks: 20, signal: stop.signal, load,
      sample: metrics => { current = {...metrics}; save({status: 'RUNNING'}); },
    }), 2);
    try { current = await run(); }
    catch (error) {
      if (!String(error).includes('MCP_LATENCY') || load() <= 3 * cores || stop.signal.aborted) throw error;
      console.log(`prodshape retry after MCP latency above 3 × cores: ${String(error)}`);
      save({status: 'RETRY', reason: String(error)});
      attempt++;
      current = await run();
    }
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
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
