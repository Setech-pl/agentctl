import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runIsolatedCanary } from '../src/core/canary.ts';
import { mirrorCanary } from '../src/core/canary-mirror.ts';
import { Context } from '../src/core/context.ts';
import { saveEntry, readQueue } from '../src/core/queue.ts';
import { watchSnapshotPath } from '../src/core/watch-snapshot.ts';
import { listTaskRecords, taskFile } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

test('shadow mirror preserves inventory and scheduling inputs while replacing contents and paths used by the runner', async () => {
  const root = scratch.sub('source');
  const source = makeConfig(root, 'env: {API_TOKEN: test_secret_value_only_in_source}\n');
  const repo = path.join(root, 'actual-repo'), worktree = '/Volumes/Crucial/actual-worktree';
  const record = seedTask(source, 'REAL-TASK', { repos: [{path: repo, worktree}], env: {API_TOKEN: 'test_secret_value_only_in_source'} });
  const runner = new DiskRunner({dryRun: false});
  const ctx = new Context(runner, source, () => {});
  const spec = `---\ntask: REAL-NEXT\nafter: REAL-TASK\nrepos: [{path: ${repo}, worktree: ${worktree}-next}]\nsetup: ['malicious source setup must never run']\nenv: {KEY: test_secret_value_only_in_source}\n---\nprivate prompt only in source\n`;
  await saveEntry(ctx, {task: 'REAL-NEXT', seq: 1, order: 1, status: 'queued', agent: 'codex', model: 'gpt-5.5',
    priority: 'high', effort: 'high', after: [record.task], queuedAt: '2026-11-23T12:34:00.000Z', spec});
  const snapshot = watchSnapshotPath(source);
  fs.writeFileSync(snapshot, JSON.stringify({version: 1, rows: [{task: record.task, window: 'alive', state: 'working'}]}));
  const state = fs.readFileSync(taskFile(source, record.window), 'utf8');
  await runIsolatedCanary(scratch.sub('dest'), () => {}, async world => {
    const counts = await mirrorCanary(world, source);
    assert.deepEqual(counts, {tasks: 1, queued: 1, worktreeDirs: 1, wall: 0});
    const [mirrored] = listTaskRecords(world.config);
    assert.equal(mirrored?.started, record.started);
    assert.equal(mirrored?.repos[0]?.worktreeMount, world.volume);
    assert.equal(mirrored?.env.API_TOKEN, undefined);
    assert.equal(world.runner.panes.get(mirrored!.window)?.screen, 'Working (esc to interrupt)');
    const [queued] = readQueue(world.config);
    assert.deepEqual(queued?.after, [mirrored?.task]);
    assert.equal(queued?.queuedAt, '2026-11-23T12:34:00.000Z');
    assert.doesNotMatch(queued!.spec, /private prompt|test_secret_value|malicious source setup|\/Volumes\/Crucial/);
    const manifest = fs.readFileSync(path.join(world.runner.root, 'mirror.json'), 'utf8');
    assert.match(manifest, /\/Volumes\/Crucial\/actual-worktree/);
    assert.doesNotMatch(manifest, /private prompt|test_secret_value/);
  });
  assert.equal(fs.readFileSync(taskFile(source, record.window), 'utf8'), state);
  assert.equal(readQueue(source)[0]?.spec, spec, 'source queue was not changed');
});
