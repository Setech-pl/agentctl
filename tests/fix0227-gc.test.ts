import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { planGc, applyGc, gcView } from '../src/core/gc.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch, runCli } from './helpers.ts';

const scratch = useScratch();
function fixture(name: string) {
  const root = scratch.sub(name), config = makeConfig(root, 'mcp: {allow: [gc]}');
  const repos = ['frontend', 'backend'].map(n => ({ path: scratch.sub(`${name}/${n}`), worktree: scratch.sub(`${name}/${n}-wt`), base: 'main' }));
  const record = seedTask(config, 'TWO', { closed: true, repos });
  const dirt = new Map<string, string>([[repos[1]!.worktree, '?? only-copy.png\n?? textures/\n']]);
  const ahead = new Map<string, number>();
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    if (cmd !== 'git') return tmux.respond(cmd, args, opts);
    if (args.includes('status')) return { stdout: dirt.get(args[1]!) ?? '' };
    if (args.includes('rev-list')) return { stdout: String(ahead.get(args[1]!) ?? 0) };
    if (args.includes('@{upstream}')) return { code: 1 };
    if (args.includes('--abbrev-ref')) return { stdout: 'agent/two' };
    return {};
  } });
  return { config, repos, record, dirt, ahead, runner, ctx: new Context(runner, config, () => {}) };
}

it('D1: cached MCP preview checks every repo including untracked files in the second', async () => {
  const f = fixture('second');
  const result = await MCP_TOOLS.find(t => t.name === 'gc_preview')!.run({ context: () => f.ctx, notify: async () => {} }, {});
  assert.equal(result.isError, undefined, result.text);
  const view = JSON.parse(result.text);
  assert.match(result.text, /2 dirty files/);
  assert.equal(view.worktrees.items.find((w: { repo: string }) => w.repo === f.repos[1]!.path).dirtyFiles, 2);
  for (const repo of f.repos) assert.ok(f.runner.queries.includes(`git -C ${repo.worktree} status --porcelain --untracked-files=normal`));
  const plan = await planGc(f.ctx, { cachedSizes: true });
  assert.ok(!plan.items.some(i => i.kind === 'worktree' && i.target === f.repos[1]!.worktree));
  assert.equal(gcView(plan).worktrees.total, 2);
  const forced = await planGc(f.ctx, { cachedSizes: true, forceDirty: ['TWO'] });
  assert.equal(forced.items.filter(i => i.kind === 'worktree').length, 2);
  await applyGc(f.ctx, forced);
  assert.ok(f.runner.commands.some(c => c.includes('worktree remove --force')));
});

it('D1: unpushed commits and dirt created after preview are refused at apply', async () => {
  const f = fixture('race');
  f.dirt.clear();
  const plan = await planGc(f.ctx, { cachedSizes: true });
  assert.equal(plan.items.filter(i => i.kind === 'worktree').length, 2);
  f.ahead.set(f.repos[0]!.worktree, 3);
  f.dirt.set(f.repos[1]!.worktree, '?? late.png');
  const applied = await applyGc(f.ctx, plan);
  assert.equal(applied.failed.filter(i => i.item.kind === 'worktree').length, 2);
  assert.ok(!f.runner.commands.some(c => c.includes('worktree remove')));
  const after = await planGc(f.ctx, {});
  assert.match(after.skipped.find(i => i.target === f.repos[0]!.worktree)!.reason, /3 unpushed commits vs main/);
  const cli = await runCli(f.config, f.runner, ['gc', '--force-dirty', '--json']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).categories.find((c: { category: string }) => c.category === 'worktree').count, 2);
});

it('D1: failed git risk checks fail closed even with a dirty override', async () => {
  const f = fixture('error');
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => cmd === 'git' && args.includes('status') ? { code: 1, stderr: 'unreadable' } : {} });
  const plan = await planGc(new Context(runner, f.config, () => {}), { forceDirty: true });
  assert.equal(plan.items.filter(i => i.kind === 'worktree').length, 0);
  assert.ok(plan.skipped.some(i => /status failed/.test(i.reason)));
});
