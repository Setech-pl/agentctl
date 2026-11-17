import assert from 'node:assert/strict';
import { it } from 'node:test';
import { initialBoardState, listItems, navTasks, handleKey, promptText, rowCells, boardColumns } from '../src/core/board.ts';
import type { BoardRow, BoardState } from '../src/core/board.ts';
import { collectStatus } from '../src/core/status.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
const scratch = useScratch();
const now = Date.parse('2026-11-17T12:00:00Z');
const pulled = new Date(now - 3600_000).toISOString();
function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return { task, agent: 'claude', model: 'opus', effort: 'high', requested: '', effective: '', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '', startedLocal: '', duration: '', report: 'missing', reportPath: '', pulled: null, lastLine: '', progress: null, hint: null, question: null, pin: false,
    finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null, cohort: 'wave', supersededBy: null, continues: null, worktrees: [], collide: [], ...extra };
}
it('UX0228: pulled reports collapse per cohort after active rows; Enter expands and unpulled reports lead and highlight', () => {
  const state = { ...initialBoardState(100, 30), now, rows: [row('WORK'), row('READ', { state: 'report-ready', report: 'yes', pulled }), row('NEW', { state: 'report-ready', report: 'yes', finished: true })] };
  const items = listItems(state);
  assert.deepEqual(items.filter(i => i.kind === 'row').map(i => i.row.task), ['NEW', 'WORK']);
  assert.deepEqual(items.at(-1), { kind: 'pulled', key: 'wave', count: 1, expanded: false });
  assert.deepEqual(navTasks(state), ['NEW', 'WORK', '@pulled:wave']);
  const expanded = handleKey({ ...state, selected: '@pulled:wave' }, '', { return: true }).state;
  assert.equal(listItems(expanded).at(-1)?.kind, 'row');
  assert.deepEqual(navTasks(expanded), ['NEW', 'WORK', '@pulled:wave', 'READ']);
  assert.ok(rowCells(state.rows[2]!, false, boardColumns(100)).find(c => c.key === 'task')?.bold);
  const grace = { ...state, pulledCollapseAfter: 61 };
  assert.ok(listItems(grace).some(i => i.kind === 'row' && i.row.task === 'READ'));
  assert.ok(!listItems(grace).some(i => i.kind === 'pulled'));
});
it('UX0228: bulk close lists scope, cancels by default, confirms without worktree removal and refuses changed scope', () => {
  const state = { ...initialBoardState(100, 30), now, selected: '@pulled:wave', rows: [row('READ', { state: 'report-ready', pulled }), row('NEW', { state: 'report-ready' }), row('OTHER', { cohort: 'other', state: 'report-ready', pulled })] };
  const preview = handleKey(state, 'B', {}).state;
  assert.match(promptText(preview)!, /READ/);
  assert.doesNotMatch(promptText(preview)!, /NEW|OTHER/);
  assert.deepEqual(handleKey(preview, '', { return: true }).effects, []);
  assert.deepEqual(handleKey(preview, 'y', {}).effects, [{ type: 'close-pulled', cohort: 'wave', tasks: ['READ'] }]);
  assert.deepEqual(handleKey({ ...preview, rows: [...preview.rows, row('LATER', { state: 'report-ready', pulled })] }, 'y', {}).effects, []);
});
it('UX0228: pulled dead report stays visible and a rewritten report is unpulled', async () => {
  const config = makeConfig(scratch.sub('visibility'));
  const tmux = new FakeTmux();
  const ctx = new Context(new DiskRunner({ dryRun: false, startTime: now, respond: tmux.respond }), config, () => {});
  const record = seedTask(config, 'READ', { pulled, turnEndedAt: new Date(now - 7200_000).toISOString() });
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  fs.utimesSync(record.report, (now - 7200_000) / 1000, (now - 7200_000) / 1000);
  const rows = await collectStatus(ctx, { progress: false });
  assert.equal(rows[0]!.state, 'report-ready');
  assert.equal(rows[0]!.hidden, false);
  fs.utimesSync(record.report, now / 1000, now / 1000);
  assert.equal((await collectStatus(ctx, { progress: false }))[0]!.pulled, null);
});

it('UX0228: queued selection closes its cohort and manager selection has no implicit cohort', () => {
  const state = { ...initialBoardState(100, 30), now, selected: 'QUEUED', rows: [row('WAVE', { state: 'report-ready', pulled }), row('UNGROUPED', { cohort: null, state: 'report-ready', pulled })], queue: [{entry: {task: 'QUEUED', cohort: 'wave'}}] as BoardState['queue'] };
  const preview = handleKey(state, 'B', {}).state;
  assert.deepEqual(preview.mode, {kind: 'confirm', action: 'close-pulled', task: 'wave', tasks: ['WAVE']});
  const manager = handleKey({...state, selected: '@manager'}, 'B', {});
  assert.equal(manager.state.mode.kind, 'list');
  assert.deepEqual(manager.effects, []);
  const ungrouped = handleKey({...state, selected: 'UNGROUPED', pulledExpanded: ['']}, 'B', {}).state;
  assert.deepEqual(ungrouped.mode, {kind: 'confirm', action: 'close-pulled', task: '', tasks: ['UNGROUPED']});
});
