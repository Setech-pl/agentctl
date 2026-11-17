import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { collectStatus } from '../src/core/status.ts';
import { collectEvents, renderEvents } from '../src/core/chat-events.ts';
import { limitedTick } from '../src/core/limited.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const now = Date.parse('2026-11-17T12:00:00Z');
const quota = 'API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-21 03:12:28';
function fixture(name: string) {
  const config = makeConfig(scratch.sub(name), 'providers: [claude, codex, glm]');
  const tmux = new FakeTmux(); tmux.add('hems-2-fdm-7', `${quota}\n❯ `);
  seedTask(config, 'HEMS-2-FDM-7', {agent: 'glm', cohort: 'HEMS', started: new Date(now - 1000).toISOString()});
  const runner = new DiskRunner({dryRun: false, startTime: now, respond: tmux.respond});
  return {ctx: new Context(runner, config, () => {}), config, tmux, runner};
}
it('F5: quota pane stays limited with reset, original usage_hint and events attention', async () => {
  const f = fixture('quota');
  const rows = await collectStatus(f.ctx, {progress: false});
  assert.equal(rows[0]!.state, 'limited');
  assert.equal(rows[0]!.usage_hint, quota);
  assert.equal(rows[0]!.usage_reset_at, new Date('2026-11-21T03:12:28').toISOString());
  const result = await MCP_TOOLS.find(t => t.name === 'status')!.run({context: () => f.ctx, notify: async () => {}}, {format: 'json'});
  assert.equal(JSON.parse(result.text).tasks[0].usage_hint, quota);
  const events = renderEvents(await collectEvents(f.ctx, {client: 'mcp:field', keep: true})).join('\n');
  assert.match(events, /czeka na Ciebie:.*HEMS-2-FDM-7 \(limited\)/);
  assert.match(events, /reset/);
});
it('F5: wrapped quota reset is retained and ordinary user mentions do not limit a task', async () => {
  const f = fixture('wrapped');
  f.tmux.windows[0]!.screen = 'API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted.\nYour limit will reset at 2026-11-21 03:12:28\n❯ ';
  assert.match((await collectStatus(f.ctx))[0]!.usage_hint!, /Your limit will reset/);
  f.tmux.windows[0]!.screen = '❯ Explain quota limits';
  assert.notEqual((await collectStatus(f.ctx))[0]!.state, 'limited');
});

it('F6: GLM holds are global across cohorts/chats and name the detecting task', async () => {
  const {collectLimits, renderLimits} = await import('../src/core/limits.ts');
  const {saveEntry, queueViews, queueTick, QueueMemory} = await import('../src/core/queue.ts');
  const {providerHoldLines} = await import('../src/core/provider-hold.ts');
  const f = fixture('shared');
  await limitedTick(f.ctx, await collectStatus(f.ctx), {notify: async () => {}});
  await saveEntry(f.ctx, {seq: 1, order: 1, task: 'NC-NEXT', cohort: 'NC', status: 'queued', priority: 'normal', queuedAt: new Date(now).toISOString(), agent: 'glm', model: 'default', effort: 'high', after: [], spec: '---\ntask: NC-NEXT\nagent: glm\n---\nFake.'});
  const otherChat = new Context(f.runner, f.config, () => {});
  assert.match((await queueViews(otherChat))[0]!.condition.text, /glm: wstrzymane do .*wykryte w HEMS-2-FDM-7.*globalnie/);
  assert.deepEqual(await queueTick(otherChat, new QueueMemory(), {notify: async () => {}}), []);
  const limits = collectLimits(f.config, [], now);
  const hold = limits.providers.find(p => p.agent === 'glm')!.providerHold!;
  assert.equal(hold.scope, 'global');
  assert.equal(hold.detectedIn, 'HEMS-2-FDM-7');
  assert.match(renderLimits(limits).join('\n'), /HEMS-2-FDM-7/);
  assert.match(providerHoldLines(f.config, now).join('\n'), /wszystkie kohorty/);
  const result = await MCP_TOOLS.find(t => t.name === 'status')!.run({context: () => otherChat, notify: async () => {}}, {cohort: 'HEMS'});
  assert.match(result.text, /globalnie/);
});
