import { usagePanel } from '../src/core/board.ts';
import { openReader, readPlans } from '../src/core/usage.ts';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { collectLimits } from '../src/core/limits.ts';
import { queueTick, QueueMemory, queueViews, saveEntry } from '../src/core/queue.ts';
import { collectCapacity, capacitySnapshot, snapshotLines } from '../src/core/capacity.ts';
import { readJournal } from '../src/core/journal.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
it('G1a: manual holds block every provider including direct starts, expose capacity, expire once, and clear with off', async () => {
  const config = makeConfig(scratch.sub('hold'), 'providers: [claude, codex, glm, kimi]\nmcp: {allow: [set_limits]}\ncapacity: {snapshot: false, codex_refresh: false}\n');
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  const tool = MCP_TOOLS.find(t => t.name === 'set_limits')!;
  const hold = {glm: '3h', claude: '3h', codex: '3h', kimi: '3h'};
  const preview = await tool.run(deps, {hold}); assert.ok(!preview.isError, preview.text);
  assert.match(preview.text, /hold.glm/);
  const confirmed = await tool.run(deps, {confirm: true, preview_token: /preview_token: (\S+)/.exec(preview.text)![1]});
  assert.ok(!confirmed.isError, confirmed.text);
  for (const [i, agent] of (['glm', 'claude', 'codex', 'kimi'] as const).entries()) {
    await saveEntry(ctx, {seq: i + 1, order: i + 1, task: `HOLD-${agent}`, direct: true, status: 'queued', priority: 'normal', queuedAt: new Date(runner.now()).toISOString(), agent, model: 'default', effort: 'high', after: [], spec: '---\ntask: UNUSED\n---\nWait.'});
  }
  const limits = collectLimits(config, [], runner.now());
  assert.ok(limits.providers.every(p => p.free === 0 && p.providerHold?.source === 'manual'));
  const reader = openReader(config); const plans = readPlans(config, reader, runner.now()); reader.save();
  const holds = Object.fromEntries(limits.providers.map(p => [p.agent, p.providerHold!]));
  const panel = usagePanel(plans, config.usage, runner.now(), holds);
  assert.ok(panel.every(line => /wstrzymane: .* \(ręcznie\)/.test(line.text.slice(0, 80))), 'timed hold stays visible in the first 80 columns, before long n/d notes');
  const views = await queueViews(ctx); assert.ok(views.every(v => /wstrzymane: .* \(ręcznie\)/.test(v.condition.text)));
  const memory = new QueueMemory(), notifier = {notify: async () => {}};
  assert.deepEqual(await queueTick(ctx, memory, notifier), []); await memory.idle();
  const capacity = await collectCapacity(ctx, {cachedOnly: true});
  assert.match(snapshotLines(capacitySnapshot(capacity)).join('\n'), /wstrzymane: glm/);
  await runner.sleep(3 * 3600000);
  config.queue.enabled = false;
  await queueTick(ctx, memory, notifier); await queueTick(ctx, memory, notifier);
  assert.equal(readJournal(config).filter(e => /wstrzymanie wygasło/.test(e.text)).length, 4);
  for (const value of ['21:50', new Date(runner.now() + 60000).toISOString(), 'off']) {
    const p = await tool.run(deps, {hold: {glm: value}}); assert.ok(!p.isError, p.text);
    const c = await tool.run(deps, {confirm: true, preview_token: /preview_token: (\S+)/.exec(p.text)![1]}); assert.ok(!c.isError, c.text);
  }
  assert.equal(collectLimits(config, [], runner.now()).providers.find(p => p.agent === 'glm')!.providerHold, undefined);
});
