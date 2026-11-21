import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { ConfigStore } from '../src/core/config-store.ts';
import { Context } from '../src/core/context.ts';
import { messageWithBody, readWall } from '../src/core/wall.ts';
import { reloadConfig } from '../src/core/watch.ts';
import { DiskRunner, fakeWatcher, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const reader = { id: 'owner', kind: 'owner' } as const;
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

test('FIELD0253-LIMITS: watch reports manual and chat changes exactly once with their sources', async () => {
  const config = makeConfig(scratch.sub('limits'), 'limits: {claude: 12, codex: 5}\nmcp: {allow: [set_limits]}\n');
  const runner = new DiskRunner({dryRun: false, startTime: Date.now()});
  const ctx = new Context(runner, config, () => {});
  const load = () => loadGlobalConfig(path.dirname(config.path));
  const store = new ConfigStore(load, config);
  const posts = () => readWall(ctx, reader, {channel: 'agentctl', kind: 'info'}).messages.map(m => messageWithBody(ctx.config, m).body);
  fs.writeFileSync(config.path, fs.readFileSync(config.path, 'utf8').replace('claude: 12, codex: 5', 'claude: 13, codex: 4'));
  await reloadConfig(ctx, store);
  await reloadConfig(ctx, store);
  assert.equal(posts().length, 1);
  assert.match(posts()[0]!, /claude 12 → 13/);
  assert.match(posts()[0]!, /codex 5 → 4/);
  assert.match(posts()[0]!, /config edit/);

  fakeWatcher(config);
  const deps = {context: () => new Context(runner, load(), () => {}), notify: async () => {}};
  const updated = await tool('set_limits').run(deps, {as: 'chat:agentctl', codex: 6, confirm: true});
  assert.ok(!updated.isError, updated.text);
  const reverted = await tool('set_limits').run(deps, {as: 'chat:agentctl', codex: 4, confirm: true});
  assert.ok(!reverted.isError, reverted.text);
  assert.equal(posts().length, 1, 'watch owns delivery with an active watcher');
  const restarted = new ConfigStore(load, load());
  await reloadConfig(ctx, restarted);
  await reloadConfig(ctx, restarted);
  assert.equal(posts().length, 3);
  assert.match(posts()[1]!, /chat:agentctl[\s\S]*codex 4 → 6/);
  assert.match(posts()[2]!, /chat:agentctl[\s\S]*codex 6 → 4/);
});
