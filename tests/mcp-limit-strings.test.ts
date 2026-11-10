import assert from 'node:assert/strict';
import { it } from 'node:test';
import { z } from 'zod';
import { MCP_TOOLS, providerToolInput } from '../src/core/mcp-tools.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import { readQueue, saveEntry } from '../src/core/queue.ts';
const scratch = useScratch();
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

it('P84/P79: MCP set_limits accepts integer strings for every provider', async () => {
  const config = makeConfig(scratch.sub('limits'), 'mcp: {allow: [set_limits]}\nproviders: [claude, codex, kimi]\n');
  const runner = new DiskRunner({ dryRun: false });
  const deps = { context: () => new Context(runner, config, () => {}), notify: async () => {} };
  const schema = z.object(providerToolInput(tool('set_limits'), config));
  for (const id of ['claude', 'codex', 'kimi']) {
    for (const value of ['2', 2, 'off', '0', '50']) assert.ok(schema.safeParse({ [id]: value }).success, `${id}=${value}`);
    for (const value of ['', ' ', '2.5', '-1', '51', '2x']) assert.equal(schema.safeParse({ [id]: value }).success, false, `${id}=${value}`);
  }
  const args = schema.parse({ claude: '2', codex: 'off', kimi: '3' });
  assert.equal((await tool('set_limits').run(deps, args)).isError, undefined);
  assert.equal((await tool('set_limits').run(deps, { ...args, confirm: true })).isError, undefined);
  const { loadGlobalConfig } = await import('../src/core/config.ts');
  const reloaded = loadGlobalConfig(config.path.slice(0, config.path.lastIndexOf('/')));
  assert.equal(reloaded.limits.claude, 2); assert.equal(reloaded.limits.codex, 'off'); assert.equal(reloaded.limits.kimi, 3);
});

