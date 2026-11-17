import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { planGc, applyGc, renderGc } from '../src/core/gc.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
function fixture(name: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [gc]}');
  const wt = scratch.sub(`${name}/wt`);
  seedTask(config, 'DIRTY', {closed: true, repos: [{path: scratch.sub(`${name}/repo`), worktree: wt, base: 'main'}]});
  const tmux = new FakeTmux();
  const runner = new DiskRunner({dryRun: false, respond: (cmd, args, opts) => cmd !== 'git' ? tmux.respond(cmd, args, opts) : args.includes('status') ? {stdout: '?? a\n?? b'} : args.includes('rev-list') ? {stdout: '0'} : args.includes('@{upstream}') ? {code: 1} : args.includes('--abbrev-ref') ? {stdout: 'agent/dirty'} : {}});
  return {ctx: new Context(runner, config, () => {}), wt, runner};
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

it('F2: persistent pin and per-run keep survive dirty overrides and are rechecked at apply', async () => {
  const {setPinned} = await import('../src/core/hide.ts');
  const {readTaskRecordById} = await import('../src/core/taskstore.ts');
  const {runCli} = await import('./helpers.ts');
  const f = fixture('f2');
  const before = await planGc(f.ctx, {forceDirty: true});
  await setPinned(f.ctx, ['DIRTY'], true);
  assert.equal(readTaskRecordById(f.ctx.config, 'DIRTY')!.pin, true);
  const pinned = await planGc(f.ctx, {forceDirty: true, includeCache: true});
  assert.equal(pinned.items.length, 0);
  assert.match(renderGc(pinned).join('\n'), /Skipped \(pinned\).*\n.*DIRTY/);
  const applied = await applyGc(f.ctx, before);
  assert.equal(applied.done.length, 0);
  assert.ok(applied.failed.every(f => /pinned/.test(f.reason)));
  const cli = await runCli(f.ctx.config, f.ctx.runner, ['unpin', 'DIRTY']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(readTaskRecordById(f.ctx.config, 'DIRTY')!.pin, undefined);
  assert.equal((await planGc(f.ctx, {keep: ['DIRTY'], forceDirty: true, includeCache: true})).items.length, 0);
  for (const name of ['pin', 'unpin']) assert.ok(MCP_TOOLS.find(t => t.name === name));
});

it('F2: pin added during GC risk queries is rechecked at the deletion boundary', async () => {
  const {setPinned} = await import('../src/core/hide.ts');
  const f = fixture('pin-race');
  const plan = await planGc(f.ctx, {forceDirty: true});
  const original = f.runner.exec.bind(f.runner);
  let pinned = false;
  f.runner.exec = async (cmd, args, options) => {
    const result = await original(cmd, args, options);
    if (!pinned && cmd === 'git' && args.includes('status')) {pinned = true; await setPinned(f.ctx, ['DIRTY'], true);}
    return result;
  };
  const result = await applyGc(f.ctx, plan);
  assert.equal(result.done.length, 0);
  assert.ok(result.failed.some(f => /pinned/.test(f.reason)));
});
