import { performance } from 'node:perf_hooks';
import { activeProviders } from './providers/registry.ts';
import type { Context } from './context.ts';
import { listTaskRecords } from './taskstore.ts';
import { planQueueAdd } from './queue.ts';
import { splitSpecs } from './spec.ts';
import path from 'node:path';

export interface ReadTiming { name: string; ms: number; thresholdMs: number; result: 'PASS' | 'WARN'; error?: string }
export const READ_TIMING_BUDGETS = { status: 1500, 'queue list': 500, events: 2000, 'queue preview': 2000 } as const;
export async function measureReadTimings(run: (name: keyof typeof READ_TIMING_BUDGETS) => Promise<void>, now = () => performance.now()): Promise<ReadTiming[]> {
  const result: ReadTiming[] = [];
  for (const [name, thresholdMs] of Object.entries(READ_TIMING_BUDGETS)) {
    const start = now();
    let error: string | undefined;
    try { await run(name as keyof typeof READ_TIMING_BUDGETS); }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    const ms = Math.max(0, now() - start);
    result.push({ name, ms, thresholdMs, result: !error && ms < thresholdMs ? 'PASS' : 'WARN', ...(error ? { error } : {}) });
  }
  return result;
}

/** The real queue planner, without registration, confirmation tokens or permission changes. */
export async function dryQueueTimingPreview(ctx: Context): Promise<void> {
  const repo = listTaskRecords(ctx.config).flatMap(r => r.repos)[0]?.path ?? process.cwd();
  const task = `DOCTOR-TIMING-${process.pid}`;
  const spec = `---\ntask: ${task}\nagent: ${activeProviders(ctx.config)[0]}\nrepos:\n - path: ${JSON.stringify(repo)}\n   worktree: ${JSON.stringify(path.join(ctx.config.cache, task, 'never-created-worktree'))}\n---\nDoctor read latency preview; never registered.\n`;
  await planQueueAdd(ctx, splitSpecs(spec, 'doctor --timings'));
}
export function renderReadTimings(rows: ReadTiming[]): string[] {
  return rows.map(r => `${r.result} ${r.name}: ${r.ms.toFixed(1)} ms (threshold < ${r.thresholdMs} ms)${r.error ? `; ${r.error}` : ''}`);
}
