import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { AgentName } from './config.ts';
import type { PlanState } from './usage.ts';
import { withFileLock } from './file-lock.ts';
import { liveWindows } from './plan.ts';
import { recordJournal } from './journal.ts';

/** Staleness is worth an event only while this provider actually has a task window. */
export async function recordStaleCapacity(ctx: Context, plans: Record<AgentName, PlanState>): Promise<void> {
  if (ctx.runner.dryRun) return;
  const live = await liveWindows(ctx);
  const file = path.join(path.dirname(ctx.config.path), 'capacity-stale.json');
  await withFileLock(`${file}.lock`, async () => {
    let state: Partial<Record<AgentName, string>> = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof state; } catch { /* first look */ }
    for (const provider of ['claude', 'codex'] as const) {
      const plan = plans[provider];
      const active = live.some((w) => w.agent === provider && w.kind === undefined);
      const stale = active && plan.readAt !== null && ctx.runner.now() - plan.readAt > ctx.config.capacity.staleMinutes * 60_000;
      const key = String(plan.readAt);
      if (stale && state[provider] !== key) {
        await recordJournal(ctx, { kind: 'usage', text: `${provider}: plan reading stale with active tasks (>${ctx.config.capacity.staleMinutes} min, age ${plan.readAt === null ? 'n/d' : Math.floor((ctx.runner.now() - plan.readAt) / 1000)} s)` });
        state[provider] = key;
      }
      if (!stale) delete state[provider];
    }
    await ctx.runner.writeFile(file, JSON.stringify(state));
  });
}
