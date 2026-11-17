import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { pulledTitle, bulkCloseLines, initialBoardState, handleKey } from '../src/core/board.ts';
import { collectStatus } from '../src/core/status.ts';
import { autoClosePulled } from '../src/core/pulled-auto-close.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { readJournal } from '../src/core/journal.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { world } from './ux0228-fixture.ts';
it('UX0228: auto-close is opt-in, uses pull age, keeps worktrees and journals once', async () => {
  const w = world('auto'); w.add('OLD', 4); w.add('RECENT', 1); w.add('UNREAD', null);
  let rows = await collectStatus(w.ctx, { progress: false });
  assert.equal(w.config.board.pulledAutoCloseAfter, null);
  assert.equal(await autoClosePulled(w.ctx, rows), false);
  w.config.board.pulledAutoCloseAfter = 2;
  assert.equal(await autoClosePulled(w.ctx, rows), true);
  assert.equal(readTaskRecord(w.config, 'old')?.closed, true);
  assert.equal(readTaskRecord(w.config, 'recent')?.closed, undefined);
  assert.equal(readTaskRecord(w.config, 'unread')?.closed, undefined);
  assert.ok(fs.existsSync(readTaskRecord(w.config, 'old')!.report));
  assert.equal(readJournal(w.config).filter(e => e.kind === 'pulled-auto-close').length, 1);
  rows = await collectStatus(w.ctx, { progress: false });
  assert.equal(await autoClosePulled(w.ctx, rows), false);
});
it('UX0228: config validates collapse minutes and optional auto-close hours', () => {
  const w = world('config', 'board: {pulled_collapse_after: 10, pulled_auto_close_after: 2}\n');
  assert.equal(w.config.board.pulledCollapseAfter, 10);
  assert.equal(w.config.board.pulledAutoCloseAfter, 2);
  assert.equal(world('off', 'board: {pulled_auto_close_after: false}\n').config.board.pulledAutoCloseAfter, null);
  for (const value of ['-1', '"2"', '.inf']) assert.throws(() => world(`bad-${value}`, `board: {pulled_collapse_after: ${value}}\n`));
});

it('UX0228: watch applies opted-in auto-close before publishing its task state', async () => {
  const w = world('watch', 'board: {pulled_auto_close_after: 2}\n');
  w.add('OLD', 4); w.add('NEW', null);
  await watchTick(w.ctx, new WatchMemory(), { clickable: false, notify: async () => {} });
  assert.equal(readTaskRecord(w.config, 'old')?.closed, true);
  assert.equal(readTaskRecord(w.config, 'new')?.closed, undefined);
  const snapshot = JSON.parse(fs.readFileSync(path.join(w.config.stateDir, 'mcp-state-snapshot.json'), 'utf8'));
  assert.equal(snapshot.rows.find((r: {task: string}) => r.task === 'OLD').closed, true);
});

it('UX0228: render collapsed and expanded cohort labels', () => {
  assert.equal(pulledTitle({kind: 'pulled', key: 'wave', count: 3, expanded: false}), '+ wave · odebrane, do zamknięcia (3) · Enter / B');
  assert.equal(pulledTitle({kind: 'pulled', key: '', count: 1, expanded: true}), '- bez kohorty · odebrane, do zamknięcia (1) · Enter / B');
});

it('UX0228: bulk confirmation pages the complete list in small terminals', () => {
  const tasks = Array.from({length: 30}, (_, i) => `READ-${i + 1}`);
  const state = { ...initialBoardState(80, 10), mode: {kind: 'confirm' as const, action: 'close-pulled' as const, task: 'wave', tasks} };
  assert.deepEqual(bulkCloseLines(state).slice(1), tasks.slice(0, 5));
  let paged = handleKey(state, '', {pageDown: true}).state;
  assert.deepEqual(bulkCloseLines(paged).slice(1), tasks.slice(5, 10));
  for (let i = 0; i < 10; i++) paged = handleKey(paged, '', {pageDown: true}).state;
  assert.deepEqual(bulkCloseLines(paged).slice(1), tasks.slice(-5));
  assert.deepEqual(handleKey(paged, '', {escape: true}).effects, []);
});
