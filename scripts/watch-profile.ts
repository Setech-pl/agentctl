import { AsyncLocalStorage } from 'node:async_hooks';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import type { WatchStepObserver } from '../src/core/watch-steps.ts';

interface Counter { calls: number; ms: number }
interface StageSample {
  stage: string;
  elapsedMs: number;
  sync: Record<string, Counter>;
  taskScans: number;
  taskHeaders: number;
  journalReads: number;
}

/** Only the prodshape process instruments its own calls. Timings include scheduler wait. */
export function profileWatch(out: (text: string) => void): { observe: WatchStepObserver; restore: () => void } {
  const context = new AsyncLocalStorage<StageSample>();
  const restores: Array<() => void> = [];
  const wrap = (target: object, property: string, count?: (stage: StageSample, arg: unknown) => void, sync = true) => {
    const original: (...args: unknown[]) => unknown = Reflect.get(target, property);
    Reflect.set(target, property, function (this: unknown, ...args: unknown[]) {
      const sample = context.getStore();
      if (!sample) return Reflect.apply(original, this, args);
      count?.(sample, args[0]);
      const start = performance.now();
      try { return Reflect.apply(original, this, args); }
      finally {
        if (sync) {
          const counter = sample.sync[property] ??= {calls: 0, ms: 0};
          counter.calls++;
          counter.ms += performance.now() - start;
        }
      }
    });
    restores.push(() => { Reflect.set(target, property, original); });
  };
  const header = (stage: StageSample, file: unknown) => { if (typeof file === 'string' && path.basename(file) === 'TASK.md') stage.taskHeaders++; };
  const journal = (stage: StageSample, file: unknown) => { if (typeof file === 'string' && path.basename(file) === 'journal.jsonl') stage.journalReads++; };
  const scan = (stage: StageSample, dir: unknown) => { if (typeof dir === 'string' && ['tasks', 'archive'].includes(path.basename(dir))) stage.taskScans++; };
  wrap(fs, 'openSync', header);
  wrap(fs, 'readFileSync', journal);
  wrap(fs, 'readdirSync', scan);
  for (const method of ['statSync', 'lstatSync', 'statfsSync', 'existsSync', 'realpathSync', 'fsyncSync', 'writeFileSync', 'readSync']) wrap(fs, method);
  wrap(fs.promises, 'open', header, false);
  wrap(fs.promises, 'readdir', scan, false);
  wrap(childProcess, 'spawnSync');
  wrap(childProcess, 'execFileSync');
  wrap(childProcess, 'execSync');
  syncBuiltinESMExports();
  const observe: WatchStepObserver = async (stage, work) => {
    const sample: StageSample = {stage, elapsedMs: 0, sync: {}, taskScans: 0, taskHeaders: 0, journalReads: 0};
    const started = performance.now();
    try { return await context.run(sample, work); }
    finally {
      sample.elapsedMs = performance.now() - started;
      out(`WATCH_PROFILE ${JSON.stringify(sample)}`);
    }
  };
  return {observe, restore() { for (const restore of restores.reverse()) restore(); syncBuiltinESMExports(); }};
}
