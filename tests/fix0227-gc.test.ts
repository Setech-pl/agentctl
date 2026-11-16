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

it('D2: cache defaults to keep; explicit inclusion lists sizes but protects report references', async () => {
  const f = fixture('protected');
  const dir = path.dirname(f.record.report);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['out', 'textures', 'refs-data', 'scratch']) {
    fs.mkdirSync(path.join(dir, name));
    const file = path.join(dir, name, 'only.png');
    fs.writeFileSync(file, 'only copy');
    fs.utimesSync(file, new Date(0), new Date(0));
    fs.utimesSync(path.dirname(file), new Date(0), new Date(0));
  }
  fs.writeFileSync(f.record.report, 'Verdict: PASS\n```agentctl-outputs\nversion: 1\nverdict: PASS\npersist: [out]\nartifacts: [{path: textures/only.png}]\nrefs: [refs-data/only.png]\n```\n');
  const defaults = await planGc(f.ctx, {});
  assert.equal(defaults.items.filter(i => i.kind === 'cache').length, 0);
  const included = await planGc(f.ctx, { cachedSizes: true, includeCache: true });
  assert.deepEqual(included.items.filter(i => i.kind === 'cache').map(i => path.basename(i.target)), ['scratch']);
  assert.equal(gcView(included).cache.items.find(i => i.target.endsWith('/scratch'))!.bytes, 9);
  for (const name of ['out', 'textures', 'refs-data']) assert.match(included.skipped.find(i => i.target === path.join(dir, name))!.reason, /referenced by report/);
  const result = await applyGc(f.ctx, included);
  assert.equal(result.failed.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'out/only.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'scratch')));
});

it('D2: keep_cache survives spec/record serialization and MCP/CLI overrides preserve cache', async () => {
  const { resolveSpec, splitSpecs } = await import('../src/core/spec.ts');
  const { readTaskRecord, recordFromSpec, renderTaskMd, parseTaskRecord } = await import('../src/core/taskstore.ts');
  const f = fixture('keep');
  const spec = resolveSpec(splitSpecs(`---\ntask: KEEP\nagent: claude\nkeep_cache: true\nrepos: [{path: '${f.repos[0]!.path}', worktree: '${f.repos[0]!.worktree}'}]\n---\nKeep data.`)[0]!, {config: f.config});
  assert.equal(parseTaskRecord(renderTaskMd(recordFromSpec(spec, f.config, 0), 'Keep data.'))!.keepCache, true);
  seedTask(f.config, 'TWO', { ...f.record, keepCache: true });
  const dir = path.dirname(f.record.report); fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'only-copy'); fs.writeFileSync(file, 'keep'); fs.utimesSync(file, new Date(0), new Date(0));
  assert.equal(readTaskRecord(f.config, 'two')!.keepCache, true);
  assert.equal((await planGc(f.ctx, {includeCache: true})).items.filter(i => i.kind === 'cache').length, 0);
  seedTask(f.config, 'TWO', { ...f.record, keepCache: false });
  const tool = MCP_TOOLS.find(t => t.name === 'gc_preview')!;
  const preview = await tool.run({context: () => f.ctx, notify: async () => {}}, {include_cache: true, keep_cache: ['TWO']});
  assert.match(preview.text, /keep_cache requested/);
  const cli = await runCli(f.config, f.runner, ['gc', '--include-cache', '--keep-cache', 'TWO', '--json']);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).categories.find((c: {category: string}) => c.category === 'cache').count, 0);
});

it('D2: newly referenced caches are protected again at apply, including prose and alias paths', async () => {
  const f = fixture('cache-race');
  const dir = path.dirname(f.record.report); fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'out'); fs.mkdirSync(file); fs.writeFileSync(path.join(file, 'only.png'), 'only');
  fs.utimesSync(path.join(file, 'only.png'), new Date(0), new Date(0)); fs.utimesSync(file, new Date(0), new Date(0));
  fs.writeFileSync(f.record.report, 'Verdict: PASS\n');
  const plan = await planGc(f.ctx, {includeCache: true});
  assert.ok(plan.items.some(i => i.target === file));
  const alias = path.join(dir, 'alias'); fs.symlinkSync(file, alias);
  fs.appendFileSync(f.record.report, `Artifact: [only image](${alias}/only.png)\n`);
  const applied = await applyGc(f.ctx, plan);
  assert.match(applied.failed.find(i => i.item.target === file)!.reason, /referenced by report/);
  assert.ok(fs.existsSync(path.join(file, 'only.png')));
});
