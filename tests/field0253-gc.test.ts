import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { applyGc, planGc } from '../src/core/gc.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { applyAcceptedWrites } from '../src/core/queue.ts';
import { readJournal } from '../src/core/journal.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { fakeWatcher, runCli, seedTask } from './helpers.ts';
import { gcFixture } from './field0253-gc-fixture.ts';

const notifier = { notify: async () => {} };
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;
const requestId = (text: string) => /request_id: ([a-f0-9-]{36})/.exec(text)?.[1];

test('FIELD0256-GC-KEEP: CLI keeps variadic and comma-delimited tasks despite force-dirty', async () => {
  const { config, runner } = gcFixture('cli-gc-keep', 4, true);
  const result = await runCli(config, runner, ['gc', '--keep', 'gc-0, GC-1', 'GC-2', '--force-dirty', 'GC-0,GC-1,GC-2,GC-3']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Skipped \(pinned\): 3,/);
  for (const id of ['GC-0', 'GC-1', 'GC-2']) assert.match(result.stdout, new RegExp(`worktree ${id} .*keep requested`));
  assert.match(result.stdout, /worktree GC-3 .*closed task/);
});

test('FIELD0256-DEAD-GC: a clean task dead at launch is a worktree-only safe candidate', async () => {
  const { config, ctx } = gcFixture('dead-gc', 1, false);
  const existing = readTaskRecord(config, 'gc-0')!;
  seedTask(config, 'GC-0', {...existing, started: '', closed: false, promptDelivery: 'launching'});
  const preview = await tool('gc_preview').run({context: () => ctx, notify: async () => {}}, {});
  assert.match(preview.text, /dead without commits/);
  const view = JSON.parse(preview.text);
  assert.equal(view.sections.remove.count, 1);
  assert.equal(view.sections.remove.items[0].kind, 'worktree');
});

test('FIELD0256-GC-EVENT: deferred cohort GC publishes one summary', async () => {
  const { config, ctx } = gcFixture('gc-event', 2, false, undefined, 'Tidy');
  fakeWatcher(config);
  const deps = {context: () => ctx, notify: async () => {}};
  const gc = tool('gc');
  const pending = await gc.run(deps, {cohort: 'Tidy'});
  const id = requestId(pending.text);
  assert.ok(id, pending.text);
  await applyAcceptedWrites(ctx, notifier, {});
  const prepared = await gc.run(deps, {request_id: id});
  const token = /preview_token: (\S+)/.exec(prepared.text)?.[1];
  assert.ok(token, prepared.text);
  assert.match((await gc.run(deps, {confirm: true, preview_token: token})).text, /^Accepted/);
  await applyAcceptedWrites(ctx, notifier, {});
  const summaries = readJournal(config).filter(e => e.kind === 'mcp-applied' && /^gc\b(?!_)/.test(e.text));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!.text, /^gc cohort Tidy: 2 worktree usunięto, 2 zarchiwizowano, \d+\.\d+ GiB$/);
});

test('FIELD0253-GC: the watcher plans 301 worktrees before issuing a bound GC token', async () => {
  let now = 0;
  let whilePlanning: (() => void) | undefined;
  const {config, ctx, gitCalls} = gcFixture('large-gc', 301, false, () => { now += 8001; whilePlanning?.(); });
  fakeWatcher(config);
  const deps = {context: () => ctx, notify: async () => {}, budgetClock: {now: () => now, schedule: () => () => {}}};
  const gc = tool('gc');
  const pending = await gc.run(deps, {});
  const id = requestId(pending.text);
  assert.ok(id, pending.text);
  assert.equal(gitCalls.length, 0);
  assert.equal(requestId((await gc.run(deps, {})).text), id);
  let concurrent: Promise<void> | undefined;
  whilePlanning = () => {
    whilePlanning = undefined;
    concurrent = applyAcceptedWrites(ctx, notifier, {});
  };
  await applyAcceptedWrites(ctx, notifier, {});
  await concurrent;
  assert.equal(readMcpRequests(config).find(r => r.id === id)?.status, 'done');
  const prepared = await gc.run(deps, {request_id: id});
  const token = /preview_token: (\S+)/.exec(prepared.text)?.[1];
  assert.ok(token, prepared.text);
  assert.ok(gitCalls.filter(args => args[2] === 'status').length >= 301);
  const count = gitCalls.length;
  const changed = await gc.run(deps, {confirm: true, preview_token: token, branches: true});
  assert.equal(changed.isError, true);
  const confirmed = await gc.run(deps, {confirm: true, preview_token: token});
  assert.match(confirmed.text, /^Accepted/);
  assert.equal(gitCalls.length, count);
  const queued = readMcpRequests(config).find(r => r.token === token);
  assert.equal(queued?.status, 'pending');
  assert.equal(JSON.parse(queued!.scope!).filter((i: {kind: string}) => i.kind === 'worktree').length, 301);
  await applyAcceptedWrites(ctx, notifier, {});
  assert.equal(readMcpRequests(config).find(r => r.token === token)?.status, 'done');
  assert.equal(gitCalls.filter(args => args[2] === 'worktree' && args[3] === 'remove').length, 301);
});

test('REL0272-GC-APPLY-IO: removal revalidates task record versions without synchronous header reads', async t => {
  const {ctx} = gcFixture('apply-io', 2, false);
  const plan = await planGc(ctx, {cachedSizes: true});
  const opened = t.mock.method(fs, 'openSync');
  const result = await applyGc(ctx, plan);
  assert.equal(result.done.filter(item => item.kind === 'worktree').length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(opened.mock.calls.filter(call => String(call.arguments[0]).endsWith('/TASK.md')).length, 0);
});
