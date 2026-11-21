import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { applyAcceptedWrites } from '../src/core/queue.ts';
import { fakeWatcher } from './helpers.ts';
import { gcFixture } from './field0253-gc-fixture.ts';

const notifier = { notify: async () => {} };
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;
const requestId = (text: string) => /request_id: ([a-f0-9-]{36})/.exec(text)?.[1];

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
