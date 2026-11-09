import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { it } from 'node:test';
import { collectDisk, refreshDiskAfterGc } from '../src/core/disk.ts';
import { shutdownMeasurements } from '../src/core/fs-measure.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { z } from 'zod';
import { DiskRunner, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();

it('P83: reads and post-GC publication never start a measurement or discover worktree files', async () => {
  const config = makeConfig(scratch.sub('reads'), 'mcp: {allow: [queue, new, close]}\n');
  const repo = scratch.sub('reads/repo'), wt = scratch.sub('reads/wt');
  const record = seedTask(config, 'READ-1', { repos: [{ path: repo, worktree: wt }] });
  const runner = new DiskRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1 } : { code: 0, stdout: '' } });
  const ctx = new Context(runner, config, () => {});
  const deps = { context: () => ctx, notify: async () => {} };
  const NativeWorker = threads.Worker, readdir = fs.readdirSync;
  let workers = 0, walks = 0;
  threads.Worker = class extends NativeWorker {
    constructor(...args: ConstructorParameters<typeof NativeWorker>) { workers++; super(...args); }
  } as typeof NativeWorker;
  fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === wt || String(target).startsWith(`${wt}/`)) walks++;
    return (readdir as Function)(target, ...args);
  }) as typeof fs.readdirSync;
  syncBuiltinESMExports();
  try {
    await collectDisk(ctx);
    assert.equal((await runCli(config, runner, ['status'])).code, 0);
    assert.equal((await runCli(config, runner, ['queue', 'list'])).code, 0);
    for (const [name, input] of [['status', { detail: true }], ['queue_list', {}], ['events_since', { keep: true }], ['close', { task: 'READ-1' }], ['queue', { spec: `---\ntask: READ-Q\nagent: claude\nrepos:\n - path: ${repo}\n   worktree: ${wt}-q\n---\nPreview.` }], ['new', { spec: `---\ntask: READ-N\nagent: claude\nrepos:\n - path: ${repo}\n   worktree: ${wt}-n\n---\nPreview.` }]] as const) {
      const tool = MCP_TOOLS.find(t => t.name === name)!;
      const result = await tool.run(deps, z.object(tool.input).parse(input));
      assert.equal(result.isError, undefined, `${name}: ${result.text}`);
    }
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, 'Verdict: PASS\nReady.\n');
    const report = MCP_TOOLS.find(t => t.name === 'get_report')!;
    assert.equal((await report.run(deps, z.object(report.input).parse({ task: record.task }))).isError, undefined);
    assert.equal((await runCli(config, runner, ['events', '--keep'])).code, 0);
    await refreshDiskAfterGc(ctx, 123);
    assert.equal(workers, 0, 'only watch or explicit GC may schedule size measurements');
    assert.equal(walks, 0, 'read paths must not discover files in worktrees');
    assert.ok(!runner.commands.some(c => /(^|\s)du(\s|$)|status --porcelain/.test(c)), 'no du or git status walk');
    assert.ok(!fs.existsSync(path.join(path.dirname(config.path), 'disk-sizes.json')) || workers === 0);
  } finally {
    threads.Worker = NativeWorker; fs.readdirSync = readdir; syncBuiltinESMExports(); await shutdownMeasurements();
  }
});

it('P83: watch samples one stale worktree per rate interval; readers reload old and updated persisted samples', async () => {
  const { refreshDiskMeasurements } = await import('../src/core/disk.ts');
  const config = makeConfig(scratch.sub('watch'));
  const a = scratch.sub('watch/a'), b = scratch.sub('watch/b');
  fs.writeFileSync(path.join(a, 'data'), 'aaa'); fs.writeFileSync(path.join(b, 'data'), 'bbbb');
  seedTask(config, 'SAMPLE-A', { repos: [{ path: a, worktree: a }] });
  seedTask(config, 'SAMPLE-B', { repos: [{ path: b, worktree: b }] });
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal((await collectDisk(ctx)).worktreeBytes, null);
    await refreshDiskMeasurements(ctx);
    assert.equal((await collectDisk(ctx)).largestWorktrees!.length, 1);
    await refreshDiskMeasurements(ctx);
    assert.equal((await collectDisk(ctx)).largestWorktrees!.length, 1, 'rate limited');
    await runner.sleep(5000); await refreshDiskMeasurements(ctx);
    assert.equal((await collectDisk(ctx)).worktreeBytes, 7);
    const cacheFile = path.join(path.dirname(config.path), 'disk-sizes.json');
    const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    stored.entries = stored.entries.map((e: Record<string, unknown>) => ({ ...e, bytes: 20, at: runner.now() + 1 }));
    await runner.sleep(1); fs.writeFileSync(cacheFile, JSON.stringify(stored));
    assert.equal((await collectDisk(ctx)).worktreeBytes, 40, 'a running MCP reader sees new watch samples');
    await runner.sleep(3600_000);
    assert.equal((await collectDisk(ctx)).worktreeBytes, 40, 'TTL expiry never deletes a last reading or walks');
  } finally { clearInterval(keepAlive); await shutdownMeasurements(); }
});

for (const archived of [false, true]) it(`P83: queue listing never opens unrelated records (archived author: ${archived})`, async () => {
  const { queueViews, saveEntry } = await import('../src/core/queue.ts');
  const { archiveDir } = await import('../src/core/taskstore.ts');
  const config = makeConfig(scratch.sub(`dependencies-${archived}`));
  const unrelated = seedTask(config, 'UNRELATED');
  const author = seedTask(config, 'DEPENDENCY', { closed: archived });
  if (archived) {
    fs.mkdirSync(archiveDir(config), { recursive: true });
    fs.renameSync(path.join(config.stateDir, author.window), path.join(archiveDir(config), author.window));
    fs.mkdirSync(path.dirname(author.report), { recursive: true });
    fs.writeFileSync(author.report, 'Verdict: PASS\n<!-- agentctl:report-end -->\n');
  }
  const runner = new DiskRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1 } : {} });
  const ctx = new Context(runner, config, () => {});
  await saveEntry(ctx, { seq: 1, order: 1, task: 'WAIT', priority: 'normal', status: 'queued', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: ['DEPENDENCY'], ...(archived ? { autoReview: { author: 'DEPENDENCY', hash: 'hash', heads: {} } } : {}), spec: '---\ntask: WAIT\n---\nWait.' });
  const read = fs.readFileSync;
  let unrelatedReads = 0;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === unrelated.report || String(file).endsWith('/unrelated/TASK.md')) unrelatedReads++;
    return (read as Function)(file, ...args);
  }) as typeof fs.readFileSync;
  try { assert.equal((await queueViews(ctx)).length, 1); assert.equal(unrelatedReads, 0); }
  finally { fs.readFileSync = read; }
});

it('P83: shared record parsing isolates mutable callers and observes header edits', async () => {
  const { readTaskRecord, renderTaskMd } = await import('../src/core/taskstore.ts');
  const config = makeConfig(scratch.sub('record-cache'));
  const record = seedTask(config, 'CACHE');
  const first = readTaskRecord(config, record.window)!;
  first.report = '/mutated'; first.env.TOKEN = 'mutable';
  const second = readTaskRecord(config, record.window)!;
  assert.equal(second.report, record.report); assert.equal(second.env.TOKEN, undefined);
  fs.writeFileSync(path.join(config.stateDir, record.window, 'TASK.md'), renderTaskMd({ ...record, model: 'changed' }, 'New prompt'));
  assert.equal(readTaskRecord(config, record.window)!.model, 'changed');
});
