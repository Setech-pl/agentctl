import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { collectDisk } from '../src/core/disk.ts';
import { planGc } from '../src/core/gc.ts';
import { RealRunner } from '../src/core/runner.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P19 (0.17.5): nothing the chat reads waits for a long operation. The MCP server answered a "status" only after the size of every worktree
 * (node_modules included) was added up by a synchronous walk, and its queries to tmux and git were synchronous child processes.
 */

const scratch = useScratch();

describe('P19: nothing the chat reads waits for a long operation', () => {
  it('RealRunner: a child process of a query does not block the event loop', async () => {
    const dir = scratch.sub('loop');
    const slow = path.join(dir, 'slow-tool');
    fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.6\necho done\n', { mode: 0o755 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const r = await new RealRunner().exec(slow, [], { readOnly: true });
    clearInterval(timer);
    assert.equal(r.stdout.trim(), 'done');
    assert.ok(ticks >= 6, `the loop turned ${ticks} times in 600 ms`);
  });

  it('the size walks (disk facts, gc plan) give the loop back; a worktree with a big node_modules does not freeze a read', async () => {
    const root = scratch.sub('walk');
    const config = makeConfig(root);
    const wt = path.join(root, 'wt');
    for (let d = 0; d < 400; d++) {
      const dir = path.join(wt, 'node_modules', `pkg${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), 'x');
    }
    seedTask(config, 'BIG-1', { repos: [{ path: root, worktree: wt }], closed: true });
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() });
    const ctx = new Context(runner, config, () => {});
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const disk = await collectDisk(ctx);
    const afterDisk = ticks;
    await planGc(ctx);
    clearInterval(timer);
    assert.equal(disk.worktreeBytes, 40_000);
    assert.ok(afterDisk >= 3, `the loop turned ${afterDisk} times during the disk measurement of 40 000 files`);
  });

  it('collectDisk with a budget answers in time with the last reading while the measurement continues; a new task does not blank it', async () => {
    const root = scratch.sub('budget');
    const config = makeConfig(root);
    const first = path.join(root, 'wt-first');
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, 'a'), '12345');
    seedTask(config, 'B-1', { repos: [{ path: root, worktree: first }] });
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() });
    const ctx = new Context(runner, config, () => {});
    assert.equal((await collectDisk(ctx, undefined, { budgetMs: 2000 })).worktreeBytes, 5);
    // a second task = a new set of worktrees = a new cache key; its tree is big
    const second = path.join(root, 'wt-second');
    for (let d = 0; d < 400; d++) {
      const dir = path.join(second, 'node_modules', `pkg${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), 'x');
    }
    seedTask(config, 'B-2', { repos: [{ path: root, worktree: second }] });
    const t0 = Date.now();
    const quick = await collectDisk(ctx, undefined, { budgetMs: 1 });
    assert.ok(Date.now() - t0 < 500);
    assert.deepEqual([quick.measuring, quick.worktreeBytes], [true, 5], 'the last reading, flagged as still measuring');
    const full = await collectDisk(ctx);
    assert.equal(full.worktreeBytes, 40_005);
    assert.equal(full.measuring, undefined);
  });
});
