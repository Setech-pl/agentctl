import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Context } from './context.ts';
import { canaryCacheDir, canaryRead, MCP_HEALTH_READS, renderCanaryHeader, runIsolatedCanary } from './canary.ts';
import { queueTick, queueViews, QueueMemory, saveEntry } from './queue.ts';
import { packageVersion } from './version.ts';
import { readWatchProgress, watchSnapshotPath } from './watch-snapshot.ts';
import { type DiskReport } from './disk.ts';

async function admittedNoop(root: string) {
  return runIsolatedCanary(root, () => {}, async world => {
    const task = 'UPGRADE-NOOP';
    await saveEntry(world.ctx, {task, seq: 1, order: 1, status: 'queued', agent: 'claude', model: 'opus',
      priority: 'normal', effort: 'high', after: [], spec: world.order(task, 'claude'),
      queuedAt: new Date(world.runner.now()).toISOString()});
    const reasons = await queueViews(world.ctx);
    assert.equal(reasons[0]?.condition.kind, 'ready', reasons[0]?.condition.text ?? 'missing queue reason');
    const memory = new QueueMemory();
    await queueTick(world.ctx, memory, {notify: async () => {}});
    await memory.idle();
    assert.ok(world.runner.launches.has(task.toLowerCase()), 'Fake provider failed to admit the no-op task');
  });
}

export async function verifyUpgrade(ctx: Context, expect: string, since: number) {
  const actual = packageVersion();
  assert.equal(actual, expect, 'installed candidate version mismatch');
  const deadline = since + 180_000;
  let snapshot: {at: number; degraded?: string; rows: unknown[]; capacity: {disk: DiskReport}} | undefined;
  let tick = 0;
  let reason = 'watch has not published progress';
  while (ctx.runner.now() < deadline) {
    const progress = readWatchProgress(ctx.config);
    try {
      assert.ok(progress && progress.version === expect && progress.startedAt >= since && progress.tick >= 2, 'candidate watch has not completed two ticks');
      process.kill(progress.pid, 0);
      const sample = JSON.parse(fs.readFileSync(watchSnapshotPath(ctx.config), 'utf8'));
      assert.ok(sample.version === 1 && Array.isArray(sample.rows) && sample.capacity?.disk && !sample.degraded,
        `no complete snapshot: ${sample.degraded ?? 'missing data'}`);
      assert.ok(sample.at >= progress.startedAt && ctx.runner.now() - sample.at < 60_000, 'watch snapshot is stale');
      snapshot = sample;
      tick = progress.tick;
      break;
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    await ctx.runner.sleep(1000);
  }
  assert.ok(snapshot, `Watch health check did not pass in 3 minutes: ${reason}`);
  const deps = {context: () => ctx, notify: async () => {}};
  const mcp: Record<string, number> = {};
  for (const [tool, args] of MCP_HEALTH_READS) {
    const data = await canaryRead(deps, tool, tool === 'status' ? {...args, limit: 10} : args);
    mcp[tool] = Math.round(data.ms);
    if (tool === 'queue_list') {
      const queue = JSON.parse(data.text);
      assert.ok(Array.isArray(queue) && queue.every(row => typeof row.task === 'string' && typeof row.startCondition === 'string'
        && row.startCondition.trim() && !/opóźnienie watch|response budget/i.test(row.startCondition)), 'queue_list contains invalid admission reasons');
    }
  }
  await renderCanaryHeader(ctx.config, snapshot.capacity.disk);
  await admittedNoop(canaryCacheDir([ctx.config.stateDir, ctx.config.cache]));
  assert.ok(ctx.runner.now() < deadline, 'Upgrade health check exceeded 3 minutes');
  return {version: actual, watchTick: tick, tasks: snapshot.rows.length, mcpMs: mcp, admission: 'PASS', board: 'PASS'};
}
