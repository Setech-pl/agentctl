import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { planGc, renderGc } from '../src/core/gc.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
function fixture(name: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [gc]}');
  const wt = scratch.sub(`${name}/wt`);
  seedTask(config, 'DIRTY', {closed: true, repos: [{path: scratch.sub(`${name}/repo`), worktree: wt, base: 'main'}]});
  const tmux = new FakeTmux();
  const runner = new DiskRunner({dryRun: false, respond: (cmd, args, opts) => cmd !== 'git' ? tmux.respond(cmd, args, opts) : args.includes('status') ? {stdout: '?? a\n?? b'} : args.includes('rev-list') ? {stdout: '0'} : args.includes('@{upstream}') ? {code: 1} : args.includes('--abbrev-ref') ? {stdout: 'agent/dirty'} : {}});
  return {ctx: new Context(runner, config, () => {}), wt};
}
it('F1: CLI and MCP keep dirty worktrees out of Would remove and include skipped sizes', async () => {
  const f = fixture('f1');
  const plan = await planGc(f.ctx);
  const text = renderGc(plan).join('\n');
  assert.match(text, /Would remove:/);
  assert.ok(!text.split('Skipped (uncommitted changes)')[0]!.includes(f.wt));
  assert.match(text, /uncommitted changes \(2 files\)/);
  assert.equal(typeof plan.skipped.find(s => s.target === f.wt)!.bytes, 'number');
  const result = await MCP_TOOLS.find(t => t.name === 'gc_preview')!.run({context: () => f.ctx, notify: async () => {}}, {});
  assert.match(JSON.parse(result.text).text, /Skipped \(uncommitted changes\)/);
});
