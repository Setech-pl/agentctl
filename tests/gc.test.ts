import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { handleKey, initialBoardState, loadViewLines } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { applyGc, planGc, renderGc } from '../src/core/gc.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { archiveDir } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const DAY = 86_400_000;

interface World {
  config: ReturnType<typeof makeConfig>;
  root: string;
  repo: string;
  tmux: FakeTmux;
  runner: DiskRunner;
  ctx: Context;
  dirty: Set<string>;
  merged: Set<string>;
  branches: Set<string>;
  foreign: string[];
  wt(name: string): string;
  respond: NonNullable<ConstructorParameters<typeof DiskRunner>[0]>['respond'];
}

function world(name: string): World {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root);
  const tmux = new FakeTmux();
  const dirty = new Set<string>();
  const merged = new Set<string>();
  const branches = new Set<string>();
  const foreign: string[] = [];
  const wtDirs = new Map<string, string>();
  const wt = (n: string): string => {
    const dir = path.join(root, 'wt', n);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.txt'), 'x'.repeat(1000));
    }
    wtDirs.set(dir, `agent/${n}`);
    return dir;
  };
  const respond: World['respond'] = (cmd, args, opts) => {
      if (cmd !== 'git') return tmux.respond(cmd, args, opts);
      const dir = args[1] as string;
      const rest = args.slice(2).join(' ');
      if (rest === 'rev-parse --abbrev-ref HEAD') return { stdout: dir === repo ? 'main\n' : `${wtDirs.get(dir) ?? 'agent/x'}\n` };
      if (rest === 'status --porcelain') return { stdout: dirty.has(dir) ? ' M a.txt\n?? b.txt\n' : '' };
      if (rest === 'worktree list --porcelain') return { stdout: [`worktree ${repo}\nbranch refs/heads/main`, ...[...wtDirs].map(([d, b]) => `worktree ${d}\nbranch refs/heads/${b}`), ...foreign.map((f) => `worktree ${f}\nbranch refs/heads/other`)].join('\n\n') + '\n' };
      const verify = /^rev-parse --verify --quiet refs\/heads\/(.+)$/.exec(rest);
      if (verify) return { code: branches.has(verify[1] as string) ? 0 : 1 };
      const anc = /^merge-base --is-ancestor (\S+) (\S+)$/.exec(rest);
      if (anc) return { code: merged.has(anc[1] as string) ? 0 : 1 };
      return {};
  };
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond });
  return { config, root, repo, tmux, runner, ctx: new Context(runner, config, () => {}), dirty, merged, branches, foreign, wt, respond };
}

/** A task record with a worktree and a cache folder (report + extra files of a given age). */
function task(w: World, id: string, extra: Parameters<typeof seedTask>[2], files: Record<string, number> = {}): string {
  const worktree = w.wt(id.toLowerCase());
  const record = seedTask(w.config, id, { repos: [{ path: w.repo, worktree, base: 'main', branch: `agent/${id.toLowerCase()}` }], ...extra });
  w.branches.add(`agent/${id.toLowerCase()}`);
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, `# ${id}\n`);
  for (const [name, ageDays] of Object.entries(files)) {
    const file = path.join(path.dirname(record.report), name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'y'.repeat(500));
    const t = new Date(NOW - ageDays * DAY);
    fs.utimesSync(file, t, t);
  }
  return worktree;
}

describe('gc: what is a candidate', () => {
  it('finished tasks give worktrees, old files next to the report and archive moves; everything else is skipped with a reason', async () => {
    const w = world('plan');
    const wt1 = task(w, 'NC-1', { closed: true, closedAt: '2026-10-01T10:00:00.000Z' }, { 'shots.png': 20, 'fresh.log': 1 });
    const wt2 = task(w, 'NC-2', { cancelled: true }, { 'old.log': 30 });
    w.dirty.add(wt2);
    const wt3 = task(w, 'NC-3', {});
    w.tmux.add('nc-3', '❯ ');
    task(w, 'NC-4', { closed: true });
    // NC-4 shares the worktree of the running NC-3
    const rec4 = seedTask(w.config, 'NC-4', { closed: true, repos: [{ path: w.repo, worktree: wt3, base: 'main', branch: 'agent/nc-3' }] });
    void rec4;
    w.foreign.push(path.join(w.root, 'wt', 'someones-own'));
    const plan = await planGc(w.ctx, {});
    const items = plan.items.map((i) => `${i.kind}:${i.task}:${path.basename(i.target)}`);
    assert.deepEqual(items.sort(), ['archive:NC-1:nc-1', 'archive:NC-4:nc-4', 'cache:NC-1:shots.png', 'cache:NC-2:old.log', 'worktree:NC-1:nc-1']);
    const reasons = plan.skipped.map((s) => `${s.task}:${s.kind}:${s.reason.replace(/\s*\(.*\)/, '')}`);
    assert.ok(reasons.some((r) => r.startsWith('NC-2:worktree:uncommitted changes')), reasons.join('\n'));
    assert.ok(reasons.some((r) => r.startsWith('NC-1:cache:newer than 7d')), reasons.join('\n'));
    assert.ok(reasons.some((r) => r.startsWith('NC-4:worktree:also used by NC-3')), reasons.join('\n'));
    assert.ok(reasons.some((r) => r.startsWith('-:worktree-foreign:not a worktree of an agentctl task')), reasons.join('\n'));
    // NC-2 is cancelled: its old file is a candidate even though the worktree is not
    assert.ok(plan.items.some((i) => i.kind === 'cache' && i.task === 'NC-2' && i.target.endsWith('old.log')));
    // an active task is never touched; reports (*.md) are never candidates
    assert.ok(!plan.items.some((i) => i.task === 'NC-3'));
    assert.ok(!plan.items.some((i) => i.target.endsWith('.md')));
    assert.equal(plan.freeBytes, 1000 + 500 + 500 + 1000 * 0 + 0, 'sizes of the worktree of NC-1, shots.png and old.log');
    void wt1;
  });

  it('--older-than moves the line, --cohort restricts to a cohort', async () => {
    const w = world('older');
    task(w, 'NC-1', { closed: true, cohort: 'Sprint' }, { 'a.log': 4 });
    task(w, 'NC-2', { closed: true }, { 'b.log': 4 });
    const fourDays = await planGc(w.ctx, { olderThan: '3d' });
    assert.deepEqual(fourDays.items.filter((i) => i.kind === 'cache').map((i) => path.basename(i.target)).sort(), ['a.log', 'b.log']);
    assert.equal((await planGc(w.ctx, { olderThan: '5d' })).items.filter((i) => i.kind === 'cache').length, 0);
    fs.mkdirSync(path.join(path.dirname(w.config.path), 'cohorts'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(w.config.path), 'cohorts', 'sprint.json'), JSON.stringify({ name: 'Sprint', created: new Date(NOW).toISOString() }));
    const sprint = await planGc(w.ctx, { olderThan: '3d', cohort: 'sprint' });
    assert.deepEqual([...new Set(sprint.items.map((i) => i.task))], ['NC-1']);
    await assert.rejects(planGc(w.ctx, { olderThan: 'soon' }), /cannot read the age/);
  });

  it('a cache folder that belongs to no task of agentctl is not touched, and only counted', async () => {
    const w = world('unknown');
    task(w, 'NC-1', { closed: true });
    fs.mkdirSync(path.join(w.config.cache, 'somebody-elses-task'), { recursive: true });
    fs.writeFileSync(path.join(w.config.cache, 'somebody-elses-task', 'notes.txt'), 'keep');
    const plan = await planGc(w.ctx, {});
    assert.equal(plan.unknownCacheDirs, 1);
    assert.ok(!plan.items.some((i) => i.target.includes('somebody-elses-task')));
    assert.match(renderGc(plan).join('\n'), /1 folder in the cache belong to no task of agentctl/);
  });
});

describe('gc: branches', () => {
  it('only merged branches of finished tasks, never main/master, the current branch, or one that is checked out; git branch -d', async () => {
    const w = world('branches');
    task(w, 'NC-1', { closed: true });
    task(w, 'NC-2', { closed: true });
    task(w, 'NC-3', { closed: true });
    w.merged.add('agent/nc-1');
    w.merged.add('agent/nc-3');
    // NC-3's worktree has uncommitted changes, so it stays and its branch stays checked out there
    w.dirty.add(path.join(w.root, 'wt', 'nc-3'));
    const mainTask = seedTask(w.config, 'NC-5', { closed: true, repos: [{ path: w.repo, worktree: w.repo, base: 'main', branch: 'main' }] });
    void mainTask;
    w.branches.add('main');
    const plan = await planGc(w.ctx, { branches: true });
    const branchItems = plan.items.filter((i) => i.kind === 'branch').map((i) => i.branch);
    assert.deepEqual(branchItems, ['agent/nc-1']);
    const why = plan.skipped.filter((s) => s.kind === 'branch').map((s) => `${s.task}:${s.reason}`);
    assert.ok(why.some((r) => r.startsWith('NC-2:not merged into main')), why.join('\n'));
    assert.ok(why.some((r) => r.startsWith('NC-3:checked out in')), why.join('\n'));
    assert.ok(why.some((r) => r.startsWith('NC-5:main/master are never deleted')), why.join('\n'));
    assert.equal((await planGc(w.ctx, {})).items.filter((i) => i.kind === 'branch').length, 0, 'not without --branches');
  });
});

describe('gc: --apply', () => {
  it('removes worktrees with git worktree remove (never forced), deletes old files but not reports, archives the state, deletes merged branches with -d only', async () => {
    const w = world('apply');
    task(w, 'NC-1', { closed: true, closedAt: '2026-10-01T10:00:00.000Z' }, { 'shots/a.png': 20, 'run.log': 20 });
    w.merged.add('agent/nc-1');
    const plan = await planGc(w.ctx, { branches: true });
    const result = await applyGc(w.ctx, plan);
    assert.deepEqual(result.failed, []);
    const cmds = w.runner.commands.join('\n');
    assert.match(cmds, new RegExp(`git -C ${w.repo} worktree remove ${path.join(w.root, 'wt', 'nc-1')}`));
    assert.match(cmds, new RegExp(`git -C ${w.repo} branch -d agent/nc-1`));
    assert.ok(!/branch -D|--force| -f /.test(cmds), cmds);
    const reportDir = path.join(w.config.cache, 'nc-1');
    assert.deepEqual(fs.readdirSync(reportDir).sort(), ['NC-1.md']);
    assert.ok(fs.existsSync(path.join(archiveDir(w.config), 'nc-1', 'TASK.md')), 'the state is in the archive');
    assert.ok(result.freedBytes >= 1000 + 500 + 500);
    // history and the report stay: a second plan has nothing left but the removal of the (fake) worktree dir
    assert.match(renderGc(plan, { applied: result }).join('\n'), /Freed/);
  });

  it('a git failure is reported per item, the rest goes on', async () => {
    const w = world('apply-fail');
    task(w, 'NC-1', { closed: true }, { 'old.log': 20 });
    const failing = new DiskRunner({ dryRun: false, startTime: NOW, respond: (cmd, args, opts) => (cmd === 'git' && args.includes('remove') ? { code: 1, stderr: 'fatal: contains modified or untracked files\n' } : w.respond?.(cmd, args, opts)) });
    const plan = await planGc(w.ctx, {});
    const result = await applyGc(new Context(failing, w.config, () => {}), plan);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]?.reason ?? '', /untracked files/);
    assert.ok(!fs.existsSync(path.join(w.config.cache, 'nc-1', 'old.log')), 'the cache entry went anyway');
  });
});

describe('gc: CLI, board and MCP', () => {
  it('dry run by default; --apply asks y/N (no terminal: needs -y); --json', async () => {
    const w = world('cli');
    task(w, 'NC-1', { closed: true }, { 'old.log': 20 });
    const dry = await runCli(w.config, w.runner, ['gc']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /Would clean up \(a dry run/);
    assert.ok(fs.existsSync(path.join(w.config.cache, 'nc-1', 'old.log')));
    assert.equal(JSON.parse((await runCli(w.config, w.runner, ['gc', '--json', '--verbose'])).stdout).details.items.length > 0, true);
    const noTty = await runCli(w.config, w.runner, ['gc', '--apply']);
    assert.equal(noTty.code, 1);
    assert.match(noTty.stderr, /no terminal to ask on/);
    const no = await runCli(w.config, w.runner, ['gc', '--apply'], { confirm: async () => false });
    assert.match(no.stdout, /Aborted/);
    assert.ok(fs.existsSync(path.join(w.config.cache, 'nc-1', 'old.log')));
    const yes = await runCli(w.config, w.runner, ['gc', '--apply', '-y']);
    assert.equal(yes.code, 0, yes.stderr);
    assert.match(yes.stdout, /Cleaned up:/);
    assert.ok(!fs.existsSync(path.join(w.config.cache, 'nc-1', 'old.log')));
    fs.rmSync(path.join(w.root, 'wt', 'nc-1'), { recursive: true });
    assert.match((await runCli(w.config, w.runner, ['gc', '--apply', '-y'])).stdout, /Nothing to clean up/);
  });

  it('board G shows the preview in a view, and the MCP gc_preview reads the same plan (no tool cleans up)', async () => {
    const w = world('views');
    task(w, 'NC-1', { closed: true }, { 'old.log': 20 });
    const r = handleKey(initialBoardState(100, 30), 'G', {});
    assert.deepEqual(r.effects, [{ type: 'view', what: 'gc' }]);
    assert.equal(r.state.mode.kind, 'view');
    assert.match((await loadViewLines(w.ctx, 'gc')).join('\n'), /Would clean up/);
    const deps: McpDeps = { context: (out) => new Context(w.runner, loadGlobalConfig(path.dirname(w.config.path)), out), notify: async () => undefined };
    const tool = MCP_TOOLS.find((t) => t.name === 'gc_preview')!;
    assert.equal(tool.kind, 'read');
    const res = await tool.run(deps, z.object(tool.input).parse({}) as never);
    assert.match(res.text, /"preview":true/);
    assert.doesNotMatch(res.text, /old\.log/);
    const detailed = await tool.run(deps, { detail: true });
    assert.match(detailed.text, /old\.log/);
    assert.ok(fs.existsSync(path.join(w.config.cache, 'nc-1', 'old.log')), 'a preview deletes nothing');
    assert.equal(MCP_TOOLS.find((t) => t.name === 'gc')?.kind, 'write');
  });
});
