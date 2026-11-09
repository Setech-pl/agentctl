import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { MCP_TOOLS, providerToolInput } from '../src/core/mcp-tools.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import { readQueue, saveEntry } from '../src/core/queue.ts';
const scratch = useScratch();
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

it('P77: every preview_token tool schema accepts token-only confirmation', async () => {
  for (const t of MCP_TOOLS.filter(t => t.input.preview_token)) {
    assert.ok(z.object(t.input).safeParse({ confirm: true, preview_token: 'a-token' }).success, t.name);
  }
});

it('P77: queue_rm token-only confirmation executes stored task; missing preview arguments still fail', async () => {
  const config = makeConfig(scratch.sub('confirm'), 'mcp: {allow: [queue_rm, close, cancel]}\n');
  const runner = new DiskRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1 } : {} });
  const deps = { context: () => new Context(runner, config, () => {}), notify: async () => {} };
  await saveEntry(deps.context(), { seq: 1, order: 1, task: 'TOKEN-Q', priority: 'normal', status: 'queued', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: [], spec: '---\ntask: TOKEN-Q\n---\nUnused.' });
  for (const [name, task] of [['queue_rm', 'TOKEN-Q'], ['close', 'TOKEN-C'], ['cancel', 'TOKEN-X']]) {
    if (name !== 'queue_rm') seedTask(config, task);
    const t = tool(name), schema = z.object(t.input);
    const preview = await t.run(deps, schema.parse({ task }));
    assert.equal(preview.isError, undefined, preview.text);
    const token = /preview_token: (\S+)/.exec(preview.text)![1];
    const done = await t.run(deps, schema.parse({ confirm: true, preview_token: token }));
    assert.equal(done.isError, undefined, done.text);
    assert.match(done.text, new RegExp(task));
  }
  assert.equal(readQueue(config).length, 0);
  const missing = await tool('queue_rm').run(deps, {});
  assert.equal(missing.isError, true, 'relaxing confirm schemas must not relax preview validation');
});
