import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { it } from 'node:test';
import { shutdownMeasurements } from '../src/core/fs-measure.ts';
import { measureWritePreviews, writePreviewFixture } from './write-preview-fixture.ts';
import { useScratch } from './helpers.ts';
const scratch = useScratch();
it('P83: all write previews and metadata confirms use headers/cached facts, never workers, du or worktree walks', async () => {
  const f = await writePreviewFixture(scratch.sub('contracts'), 400, 1);
  const Worker = threads.Worker, read = fs.readFileSync, readdir = fs.readdirSync;
  let workers = 0, walks = 0, fullInventories = 0;
  threads.Worker = class extends Worker { constructor(...args: ConstructorParameters<typeof Worker>) { workers++; super(...args); } } as typeof Worker;
  fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === f.wt || String(target).startsWith(`${f.wt}/`)) walks++;
    return (readdir as Function)(target, ...args);
  }) as typeof readdir;
  // Only selected mutations may read the body to preserve it. Unrelated prompt bodies are forbidden.
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (/\/other-\d+\/TASK.md$/.test(String(file))) fullInventories++;
    return (read as Function)(file, ...args);
  }) as typeof read;
  syncBuiltinESMExports();
  try {
    const results = await measureWritePreviews(f);
    assert.deepEqual(results.filter(r => r.error), []);
    assert.equal(workers, 0, 'previews/confirms never schedule recursive measurements');
    assert.equal(walks, 0, 'no discovery or cache cleanup in worktrees');
    assert.equal(fullInventories, 0, 'inventory never loads full TASK.md bodies');
    assert.ok(fs.existsSync(path.join(f.wt, '.cache/keep-until-watch')), 'close leaves cleanup to watch');
    assert.equal(f.gitWalks(), 0, 'history and retry registration never run git status');
    assert.ok(!f.ctx.runner.dryRun, 'confirms actually mutate isolated metadata');
  } finally { threads.Worker = Worker; fs.readdirSync = readdir; fs.readFileSync = read; syncBuiltinESMExports(); await shutdownMeasurements(); }
});

it('P83: cached retry registration defers checkout scanning, worker rechecks dirty tracked files', async () => {
  const { checkRetryWorktrees } = await import('../src/core/git.ts');
  const { withResponseBudget } = await import('../src/core/response-budget.ts');
  const { DiskRunner } = await import('./helpers.ts');
  const wt = scratch.sub('retry-wt'), repo = scratch.sub('retry-repo');
  let scans = 0;
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => {
    if (args.includes('worktree')) return { stdout: `worktree ${wt}\n` };
    if (args.includes('--show-toplevel')) return { stdout: wt };
    if (args.includes('--git-path')) return { stdout: path.join(wt, '.git/index.lock') };
    if (args.includes('--verify')) return { stdout: 'abc' };
    if (args.includes('symbolic-ref')) return { stdout: 'fixture' };
    if (args.includes('status')) { scans++; return { stdout: ' M changed.txt' }; }
    return { stdout: '' };
  } });
  const repos = [{ path: repo, worktree: wt, branch: 'fixture' }];
  await withResponseBudget(() => checkRetryWorktrees(runner, repos), () => { throw new Error('expired'); });
  assert.equal(scans, 0);
  await assert.rejects(checkRetryWorktrees(runner, repos), /tracked checkout is incomplete\/modified/);
  assert.equal(scans, 1, 'worker must reject dirty residue before starting inference');
});

it('P83: cached GC preview/confirm do not measure or scan; dirty deletion is refused by git', async () => {
  const { planGc, applyGc } = await import('../src/core/gc.ts');
  const { DiskRunner, makeConfig, seedTask } = await import('./helpers.ts');
  const root = scratch.sub('gc'), repo = scratch.sub('gc/repo'), wt = scratch.sub('gc/wt');
  const config = makeConfig(root);
  const record = seedTask(config, 'FINISHED', { closed: true, repos: [{ path: repo, worktree: wt }] });
  fs.mkdirSync(path.join(config.cache, 'finished/old-dir'), { recursive: true });
  fs.writeFileSync(path.join(config.cache, 'finished/old-dir/keep'), 'new child of old directory');
  let statuses = 0, removals = 0;
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd === 'tmux') return { code: 1 };
    if (args.includes('status')) { statuses++; throw new Error('unexpected git walk'); }
    if (args.includes('--abbrev-ref')) return { stdout: 'task-branch' };
    if (args.includes('remove')) { removals++; return { code: 1, stderr: 'contains modified or untracked files' }; }
    return { stdout: '' };
  } });
  const ctx = new (await import('../src/core/context.ts')).Context(runner, config, () => {});
  const plan = await planGc(ctx, { cachedSizes: true });
  assert.equal(statuses, 0);
  assert.ok(plan.items.some(i => i.kind === 'worktree'));
  assert.ok(plan.skipped.some(i => i.target.endsWith('old-dir') && /directory age/.test(i.reason)));
  const result = await applyGc(ctx, plan);
  assert.equal(removals, 1);
  assert.match(result.failed[0]!.reason, /modified or untracked/);
  assert.ok(fs.existsSync(wt));
  assert.ok(fs.existsSync(path.join(path.dirname(record.report), 'old-dir/keep')));
});

it('P83: cohort close/cancel preview and confirm never inspect unrelated reports or discover worktree files', async () => {
  const { setHeaderField, taskFile } = await import('../src/core/taskstore.ts');
  const { MCP_TOOLS } = await import('../src/core/mcp-tools.ts');
  const f = await writePreviewFixture(scratch.sub('cohort-contracts'), 400, 1);
  await setHeaderField(f.ctx.runner, taskFile(f.config, 'close'), 'cohort', 'CLOSE-GROUP');
  await setHeaderField(f.ctx.runner, taskFile(f.config, 'cancel'), 'cohort', 'CANCEL-GROUP');
  const read = fs.readFileSync, readdir = fs.readdirSync;
  let reportReads = 0, walks = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (/\/other-\d+\/OTHER-\d+\.md$/.test(String(file))) reportReads++;
    return (read as Function)(file, ...args);
  }) as typeof read;
  fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === f.wt || String(target).startsWith(`${f.wt}/`)) walks++;
    return (readdir as Function)(target, ...args);
  }) as typeof readdir;
  try {
    for (const name of ['close', 'cancel']) {
      const tool = MCP_TOOLS.find(t => t.name === name)!;
      const p = await tool.run(f.deps, { cohort: `${name.toUpperCase()}-GROUP` });
      assert.equal(p.isError, undefined, p.text);
      const token = /preview_token: (\S+)/.exec(p.text)?.[1]; assert.ok(token);
      const done = await tool.run(f.deps, { confirm: true, preview_token: token });
      assert.equal(done.isError, undefined, done.text);
    }
    assert.equal(walks, 0);
    assert.equal(reportReads, 0);
  } finally { fs.readFileSync = read; fs.readdirSync = readdir; }
});
