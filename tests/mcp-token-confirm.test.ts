import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { MCP_TOOLS, providerToolInput } from '../src/core/mcp-tools.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
import { readQueue, saveEntry } from '../src/core/queue.ts';
const scratch = useScratch();
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

it('P77: every preview_token tool schema accepts token-only confirmation', async () => {
  const phased = MCP_TOOLS.filter(t => t.input.preview_token);
  const config = makeConfig(scratch.sub('schema-parity'), `mcp: {allow: [${phased.map(t => t.name).join(', ')}]}\n`);
  const deps = { context: () => new Context(new DiskRunner({ dryRun: false }), config, () => {}), notify: async () => {} };
  for (const t of phased) {
    const refused = await t.run(deps, { confirm: true, preview_token: 'missing-token' });
    assert.match(refused.text, /Confirmation refused: missing preview/, t.name);
    assert.ok(z.object(t.input).safeParse({ confirm: true, preview_token: 'a-token' }).success, t.name);
  }
});

it('P77: queue_rm token-only confirmation executes stored task; missing preview arguments still fail', async () => {
  const config = makeConfig(scratch.sub('confirm'), 'mcp: {allow: [queue_rm, close, cancel, interrupt, mark]}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const deps = { context: () => new Context(runner, config, () => {}), notify: async () => {} };
  await saveEntry(deps.context(), { seq: 1, order: 1, task: 'TOKEN-Q', priority: 'normal', status: 'queued', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: [], spec: '---\ntask: TOKEN-Q\n---\nUnused.' });
  for (const [name, task] of [['queue_rm', 'TOKEN-Q'], ['close', 'TOKEN-C'], ['cancel', 'TOKEN-X'], ['interrupt', 'TOKEN-I']]) {
    if (name !== 'queue_rm') { const record = seedTask(config, task); if (name === 'interrupt') tmux.add(record.window, '● Working\n  esc to interrupt\n'); }
    const t = tool(name), schema = z.object(t.input);
    const preview = await t.run(deps, schema.parse({ task }));
    assert.equal(preview.isError, undefined, preview.text);
    const token = /preview_token: (\S+)/.exec(preview.text)![1];
    const done = await t.run(deps, schema.parse({ confirm: true, preview_token: token }));
    assert.equal(done.isError, undefined, done.text);
    assert.match(done.text, new RegExp(task));
  }
  seedTask(config, 'TOKEN-M1'); seedTask(config, 'TOKEN-M2');
  const mark = tool('mark');
  const preview = await mark.run(deps, { tasks: ['TOKEN-M1', 'TOKEN-M2'], result: 'ok' });
  assert.equal(preview.isError, undefined, preview.text);
  const token = /preview_token: (\S+)/.exec(preview.text)![1];
  const done = await mark.run(deps, { confirm: true, preview_token: token });
  assert.equal(done.isError, undefined, done.text);
  assert.equal(readQueue(config).length, 0);
  const missing = await tool('queue_rm').run(deps, {});
  assert.equal(missing.isError, true, 'relaxing confirm schemas must not relax preview validation');
});
