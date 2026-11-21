import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { initialBoardState, loadBoard, applySnapshot, ProgressCache } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { diskLine } from '../src/core/disk.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

test('FIELD0253-DISK: a stale partial worktree reading cannot colour healthy free space yellow', async (t) => {
  const config = makeConfig(scratch.sub('disk'), 'disk: {worktree_share_percent: 10, warn_gb: 30, critical_gb: 10}\n');
  const wt = scratch.sub('disk/wt');
  const missing = scratch.sub('disk/unmeasured');
  seedTask(config, 'DISK', {closed: true, repos: [{path: wt, worktree: wt}, {path: missing, worktree: missing}]});
  const runner = new DiskRunner({dryRun: false});
  fs.writeFileSync(path.join(path.dirname(config.path), 'disk-sizes.json'), JSON.stringify({version: 2, entries: [{target: wt, at: runner.now() - 21 * 3600_000, identity: "fixture", newest: 0, bytes: 100 * 1024 ** 3}]}));
  t.mock.method(fs.promises, 'statfs', async () => ({bsize: 1024 ** 2, bavail: 185242, blocks: 300 * 1024}));
  const ctx = new Context(runner, config, () => {});
  const board = applySnapshot(initialBoardState(120, 35), await loadBoard(ctx, null, new ProgressCache()));
  assert.match(diskLine(board.disk!, runner.now()), /180\.9 GiB.*n\/d.*21 h old/);
  assert.equal(board.disk?.level, 'ok');
});
