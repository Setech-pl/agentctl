import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { collectDisk, diskLine } from '../src/core/disk.ts';
import type { DiskReport } from '../src/core/disk.ts';
import { sizeOf } from '../src/core/fs-measure.ts';
import { readJournal } from '../src/core/journal.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

/*
 * P69 (prod 08.11): after `gc --apply` the board and status kept showing the old disk reading ("agentctl worktrees
 * 349.6 GiB (measuring, last reading)", free 53 GiB) while the disk actually had 390 GiB free — the board caches a
 * reading for minutes and nothing re-measured or said anything. Now gc re-measures at once and records an event
 * "gc freed X GiB, free now Y", and a reading older than 10 minutes is shown with its age.
 */
const scratch = useScratch();
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const GIB = 1024 ** 3;

function world(name: string) {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root);
  const tmux = new FakeTmux();
  const respond = (cmd: string, args: string[], opts?: Parameters<FakeTmux['respond']>[2]) => {
    if (cmd !== 'git') return tmux.respond(cmd, args, opts);
    const rest = args.slice(2).join(' ');
    if (rest === 'rev-parse --abbrev-ref HEAD') return { stdout: 'agent/nc-1\n' };
    if (rest === 'status --porcelain') return { stdout: '' };
    if (rest === 'worktree list --porcelain') return { stdout: `worktree ${repo}\nbranch refs/heads/main\n` };
    if (rest.startsWith('worktree remove ')) fs.rmSync(rest.slice('worktree remove '.length), { recursive: true, force: true });
    return {};
  };
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond });
  return { config, root, repo, tmux, runner, ctx: new Context(runner, config, () => {}) };
}

it('P69: gc --apply re-measures at once and records "gc freed X GiB, free now Y"; the reading no longer counts the removed worktree', async () => {
  const w = world('remeasure');
  const worktree = path.join(w.root, 'wt', 'nc-1');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, 'file.txt'), 'x'.repeat(1000));
  seedTask(w.config, 'NC-1', { closed: true, closedAt: '2026-10-01T10:00:00.000Z', repos: [{ path: w.repo, worktree, base: 'main', branch: 'agent/nc-1' }] });
  await sizeOf(worktree, { now: () => w.runner.now() });
  const before = await collectDisk(w.ctx);
  assert.equal(before.worktreeBytes, 1000, 'the old reading counts the worktree');
  const r = await runCli(w.config, w.runner, ['gc', '--apply', '-y']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /gc freed \d+\.\d GiB, free now \d+\.\d GiB/);
  const events = readJournal(w.config).filter((e) => e.kind === 'gc-freed');
  assert.equal(events.length, 1, 'exactly one gc event');
  assert.match(events[0]!.text, /^gc freed \d+\.\d GiB, free now \d+\.\d GiB$/);
  const after = await collectDisk(w.ctx);
  assert.equal(after.worktreeBytes, 0, 'the reading was refreshed: the removed worktree is not in it');
  assert.ok(Date.parse(after.measuredAt) >= Date.parse(before.measuredAt));
});

it('P69: a reading older than 10 minutes shows its age next to the number; a fresh one does not', () => {
  const base: DiskReport = {
    volumes: [{ device: '1', paths: [], availableBytes: 53 * GIB, totalBytes: 926 * GIB, level: 'ok' }],
    worktreeBytes: 349.6 * GIB, measuredAt: new Date(NOW - 47 * 60_000).toISOString(), level: 'ok',
  };
  assert.match(diskLine(base, NOW), /349\.6 GiB \(last reading, 47 min old\)/);
  assert.match(diskLine({ ...base, measuring: true }, NOW), /\(measuring, last reading, 47 min old\)/);
  assert.match(diskLine({ ...base, measurementError: 'walk failed' }, NOW), /\(measurement failed, last reading, 47 min old\)/);
  assert.match(diskLine({ ...base, measuredAt: new Date(NOW - 3 * 3_600_000).toISOString() }, NOW), /3 h old\)/);
  assert.match(diskLine({ ...base, measuredAt: new Date(NOW - 5 * 60_000).toISOString() }, NOW), /old\)/);
  assert.match(diskLine({ ...base, measuredAt: new Date(NOW - 60_000).toISOString(), measuring: true }, NOW), /old\)/);
});
