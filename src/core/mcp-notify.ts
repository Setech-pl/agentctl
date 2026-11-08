import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';

/** Notification aggregation is independent of the full per-write audit and journal. */
export async function mcpWriteNotice(ctx: Context, notify: (text: string) => Promise<void>, announce?: string): Promise<void> {
  if (ctx.runner.dryRun) return;
  const settings = ctx.config.notify;
  const mode = settings.mcpWrites ?? 'summary';
  if (mode === 'all') { if (announce) await notify(`czat zlecił: ${announce}`).catch(() => undefined); return; }
  if (mode === 'off') return;
  const file = path.join(path.dirname(ctx.config.path), 'mcp-write-notices.json');
  await withFileLock(`${file}.lock`, async () => {
    let state: { lastAt?: number; count: number; samples: string[] } = { count: 0, samples: [] };
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first notice */ }
    if (announce) { state.count++; if (state.samples.length < 5) state.samples.push(announce); }
    if (state.count && (state.lastAt === undefined || ctx.runner.now() - state.lastAt >= (settings.mcpWritesIntervalS ?? 60) * 1000)) {
      const text = `czat zlecił: ${state.samples.join('; ')}${state.count > state.samples.length ? `; +${state.count - state.samples.length}` : ''}${state.count > 1 ? ` (${state.count} operacji)` : ''}`;
      state = { count: 0, samples: [], lastAt: ctx.runner.now() };
      await ctx.runner.writeFile(file, JSON.stringify(state));
      await notify(text).catch(() => undefined);
    } else await ctx.runner.writeFile(file, JSON.stringify(state));
  });
}
