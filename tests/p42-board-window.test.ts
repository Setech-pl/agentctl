import assert from 'node:assert/strict';
import { it } from 'node:test';
import { handleKey, initialBoardState, listItems, navTasks, queueViews } from '../src/core/board.ts';
import type { BoardRow, BoardState } from '../src/core/board.ts';
import type { QueueEntry, QueueView } from '../src/core/queue.ts';

/*
 * P42 (recurrence, production 0.18.2): a task waiting on a dialog in its window (trust, menu) showed twice on the
 * board — its task row and a queue row "… starting" — and Enter on the queue row did not open the window. A task
 * that has a window has no separate queue row; Enter on any row of a task opens its window.
 */
function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'needs-trust', window: 'alive', windowName: task.toLowerCase(), windowId: '@7', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '2m 10s', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: null,
    hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  };
}

function view(task: string, status: QueueEntry['status'], extra: Partial<QueueEntry> = {}): QueueView {
  return {
    position: status === 'queued' ? 1 : null,
    entry: { seq: 1, order: 1, task, status, queuedAt: '2026-11-01T08:00:00.000Z', agent: 'claude', model: 'opus', effort: 'high', priority: 'normal', after: [], spec: `---\ntask: ${task}\n---\nPrompt.\n`, ...extra },
    condition: { kind: status === 'starting' ? 'starting' : 'ready', text: status === 'starting' ? 'uruchamiane – setup w toku' : 'uruchamiane' },
    since: '2026-11-01T08:00:00.000Z',
  };
}

const stateWith = (rows: BoardRow[], queue: QueueView[], selected: string | null): BoardState => ({ ...initialBoardState(100, 30), rows, queue, queuePaused: false, selected });

it('P42 a task with a window has no separate queue row on the board', () => {
  const state = stateWith([row('NC-9')], [view('NC-9', 'starting'), view('Q-1', 'queued', { seq: 2, order: 2 })], 'NC-9');
  assert.deepEqual(queueViews(state).map((v) => v.entry.task), ['Q-1'], 'the windowed NC-9 leaves the queue section');
  assert.deepEqual(navTasks(state), ['NC-9', 'Q-1'], 'NC-9 is listed exactly once');
  const kinds = listItems(state).map((i) => (i.kind === 'row' ? `row:${i.row.task}` : i.kind === 'queue' ? `queue:${i.view.entry.task}` : i.kind));
  assert.deepEqual(kinds.filter((k) => k.includes('NC-9')), ['row:NC-9']);
});

it('P42 Enter on the task row opens its window (also while its start waits on a dialog)', () => {
  const state = stateWith([row('NC-9')], [view('NC-9', 'starting')], 'NC-9');
  const { effects } = handleKey(state, '', { return: true });
  assert.deepEqual(effects, [{ type: 'switch', task: 'NC-9', window: 'nc-9' }]);
});

it('P42 Enter on a stale queue row of a windowed task opens its window instead of an error', () => {
  // The selection can still stand on the queue entry (a refresh in flight): Enter goes to the window all the same.
  const state = stateWith([row('NC-9')], [view('NC-9', 'queued')], 'NC-9');
  const withQueueSelected: BoardState = { ...state, queue: [view('NC-9', 'queued')], rows: [row('NC-9')], selected: 'NC-9' };
  const { effects, state: after } = handleKey(withQueueSelected, '', { return: true });
  assert.deepEqual(effects, [{ type: 'switch', task: 'NC-9', window: 'nc-9' }]);
  assert.equal(after.notice, null);
});

it('P42 a queue row of a task without a window keeps the old answer', () => {
  const state = stateWith([], [view('Q-1', 'queued')], 'Q-1');
  const { effects, state: after } = handleKey(state, '', { return: true });
  assert.deepEqual(effects, []);
  assert.match(after.notice?.text ?? '', /has no window yet/);
});
