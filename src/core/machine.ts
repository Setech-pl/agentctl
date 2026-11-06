import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';

export function collectMachine(config: GlobalConfig, host: Pick<typeof os, 'loadavg' | 'freemem' | 'cpus'> = os) {
  const cpuCount = Math.max(1, host.cpus().length);
  const loadAverage = host.loadavg();
  const threshold = config.capacity.loadThreshold ?? 3 * cpuCount;
  return { loadAverage, freeMemoryBytes: host.freemem(), cpuCount, threshold, overloaded: loadAverage[0]! > threshold };
}
export function machineLine(sample: ReturnType<typeof collectMachine>): string {
  return `Machine: load (1/5/15 min) ${sample.loadAverage.map(n => n.toFixed(2)).join(' / ')}; free memory ${sample.freeMemoryBytes} bytes; load threshold ${sample.threshold}`;
}
/** The watcher observes crossings; status reads never change the event baseline. */
export async function recordMachineLoad(ctx: Context, sample = collectMachine(ctx.config)): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = path.join(path.dirname(ctx.config.path), 'machine-load.json');
  await withFileLock(`${file}.lock`, async () => {
    let previous = false;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')).overloaded === true; } catch { /* first observation */ }
    if (previous !== sample.overloaded) await recordJournal(ctx, { kind: sample.overloaded ? 'machine-load-high' : 'machine-load-recovered', text: `${sample.overloaded ? 'Machine load crossed threshold' : 'Machine load fell back'}: ${machineLine(sample)}` });
    await ctx.runner.writeFile(file, JSON.stringify({ overloaded: sample.overloaded }));
  });
}
