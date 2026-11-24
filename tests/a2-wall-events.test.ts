import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { touchCohort } from '../src/core/cohort.ts';
import { recordJournal } from '../src/core/journal.ts';
import { postMessage, wallIdentity } from '../src/core/wall.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('FIELD0256-EVENTS: chat sees its tasks and cohorts, counts others, and can request all', async () => {
  const config = makeConfig(scratch.sub('quiet'));
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'OWN-1', {owner: 'chat:nc', cohort: 'Own'});
  seedTask(config, 'OTHER-1', {owner: 'chat:hems', cohort: 'Other'});
  await recordJournal(ctx, {kind: 'queue-start', task: 'OWN-1', text: 'own work'});
  await recordJournal(ctx, {kind: 'queue-start', task: 'OTHER-1', text: 'other work'});
  await recordJournal(ctx, {kind: 'cohort-done', cohort: 'Own', text: 'own cohort'});
  await recordJournal(ctx, {kind: 'cohort-done', cohort: 'Other', text: 'other cohort'});
  const deps = {context: () => ctx, notify: async () => {}};
  const events = MCP_TOOLS.find(tool => tool.name === 'events_since')!;
  const scoped = await events.run(deps, {as: 'chat:nc'});
  assert.match(scoped.text, /own work[\s\S]*own cohort[\s\S]*inne czaty: 2 zdarzeń/);
  assert.doesNotMatch(scoped.text, /other work|other cohort/);
  const all = await events.run(deps, {as: 'chat:nc', all: true});
  assert.match(all.text, /other work[\s\S]*other cohort/);
});
it('A2: shared WALL bypasses cohort; chat cursors survive sessions; open inbox ignores the cursor', async () => {
  const config = makeConfig(scratch.sub('a2'), 'wall:\n  channels:\n    shared:maps-3: {authors: ["*"]}\n  chats:\n    nc: {channels: [nc, agentctl, "shared:*"]}\n    hems: {channels: [hems, agentctl, "shared:*"]}\n');
  const runner = new DiskRunner({ dryRun: false, respond: new FakeTmux().respond });
  const ctx = new Context(runner, config, () => {});
  await touchCohort(ctx, '62'); await touchCohort(ctx, '63');
  const m = await postMessage(ctx, wallIdentity(config, {as: 'chat:hems'}), { channel: 'shared:maps-3', to: 'chat:nc', kind: 'question', subject: 'maps contract?', body: 'Check maps' });
  const tool = MCP_TOOLS.find(t => t.name === 'events_since')!;
  const deps = () => ({context: () => ctx, notify: async () => {}, clientId: 'claude-ai'});
  const first = await tool.run(deps(), {as: 'chat:nc', cohort: '62', format: 'json'});
  assert.ok(!first.isError, first.text);
  const data = JSON.parse(first.text);
  assert.ok(data.events.some((e: any) => e.wall?.id === m.id), first.text);
  const second = await tool.run(deps(), {as: 'chat:nc', cohort: '62'});
  assert.match(second.text, /WALL do Ciebie \(open\)/);
  assert.match(second.text, /maps contract/);
  assert.ok(!second.text.includes('  WALL  '), 'new MCP session uses the chat cursor');
  const anotherCohort = await tool.run(deps(), {as: 'chat:nc', cohort: '63', format: 'json'});
  assert.ok(!JSON.parse(anotherCohort.text).events.some((e: any) => e.kind === 'wall'), 'WALL cursor is shared across cohort filters of this chat');
  config.wall.subscriptions.nc = ['agentctl'];
  assert.match((await tool.run(deps(), {as: 'chat:nc', cohort: '62'})).text, /maps contract/, 'inbox covers readable channels even when event subscriptions are narrower');
  const other = await tool.run(deps(), {as: 'chat:hems', cohort: '62', format: 'json'});
  assert.ok(JSON.parse(other.text).events.some((e: any) => e.wall?.id === m.id), 'another chat has an independent cursor');
});

it('A2: known chat receives the open inbox even when task reads exhaust the response budget', async () => {
  const config = makeConfig(scratch.sub('budget'));
  let stalled = false, release!: () => void, expire: (() => void) | undefined;
  const held = new Promise<void>(yes => {release = yes;});
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const exec = runner.exec.bind(runner);
  runner.exec = async (...args) => {if (stalled) await held; return exec(...args);};
  const ctx = new Context(runner, config, () => {});
  const m = await postMessage(ctx, wallIdentity(config, {as: 'chat:nc'}), {channel: 'nc', kind: 'question', subject: 'Read me under load', body: 'data'});
  let time = 0;
  const deps = {context: () => ctx, notify: async () => {}, budgetClock: {now: () => time, schedule: (fn: () => void) => {expire = fn; return () => {};}}};
  stalled = true;
  const pending = MCP_TOOLS.find(t => t.name === 'events_since')!.run(deps, {as: 'chat:nc'});
  for (let i = 0; i < 50; i++) await new Promise(yes => setImmediate(yes));
  time = 8000; expire!();
  try { const result = await pending; assert.match(result.text, /WALL do Ciebie \(open\)/); assert.ok(result.text.includes(`${m.id}: Read me under load (0h)`), result.text); }
  finally {release();}
});
