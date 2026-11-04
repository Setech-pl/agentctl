import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import {
  activeRows,
  applySnapshot,
  cancelledRows,
  cohortLabel,
  cohortOptions,
  groupTitle,
  handleKey,
  HELP_LINES,
  initialBoardState,
  KEY_HINTS,
  listItems,
  loadBoard,
  navTasks,
  ProgressCache,
  promptText,
  queueCells,
  runBoardEffect,
} from '../src/core/board.ts';
import type { BoardEffect, BoardRow, BoardState, KeyPress } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { liveWindows } from '../src/core/plan.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, readQueue } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Working\n  esc to interrupt\n';

function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: null, hint: null, question: null, pin: false,
    finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null,
    cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  };
}

const inCohort = (task: string, cohort: string | null, extra: Partial<BoardRow> = {}): BoardRow => row(task, { cohort, ...extra });
const press = (state: BoardState, input: string, key: KeyPress = {}) => handleKey(state, input, key);
const types = (e: BoardEffect[]): string[] => e.map((x) => x.type);
const boardOf = (rows: BoardRow[], extra: Partial<BoardState> = {}): BoardState => ({ ...initialBoardState(100, 30), rows, selected: rows.find((r) => !r.finished)?.task ?? null, refreshedAt: '09:00:00', ...extra });

/** Type a text key by key. */
function typeText(state: BoardState, text: string): BoardState {
  for (const ch of text) state = press(state, ch).state;
  return state;
}

describe('board: grouping by cohort', () => {
  const rows = [inCohort('B-1', 'Wave'), inCohort('A-1', 'alpha'), row('C-1'), inCohort('A-2', 'ALPHA', { state: 'report-ready', report: 'yes' }), inCohort('B-2', 'wave', { state: 'waiting' })];

  it('without any cohort the list is the flat one it always was', () => {
    const s = boardOf([row('A-1'), row('A-2')]);
    assert.deepEqual(listItems(s).map((i) => i.kind), ['row', 'row']);
  });

  it('cohorts by name, each under a header with the counts of its states, "bez kohorty" last', () => {
    const s = boardOf(rows);
    const items = listItems(s);
    assert.deepEqual(items.map((i) => (i.kind === 'group' ? `#${i.name}` : i.kind === 'row' ? i.row.task : i.kind)), ['#alpha', 'A-1', 'A-2', '#Wave', 'B-1', 'B-2', '#null', 'C-1']);
    const titles = items.flatMap((i) => (i.kind === 'group' ? [groupTitle(i)] : []));
    assert.deepEqual(titles, ['- alpha (2) 1⚙ 1✓', '- Wave (2) 1⚙ 1⏸', '- bez kohorty (1) 1⚙']);
    assert.deepEqual(navTasks(s), ['A-1', 'A-2', 'B-1', 'B-2', 'C-1']);
  });

  it('queued tasks of a cohort are counted in its header (⧗)', async () => {
    const root = scratch.sub('queuecount');
    const repo = scratch.sub('queuecount/app');
    const config = makeConfig(root);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    const spec = `---\ntask: Q-1\nagent: claude\ncohort: alpha\nrepos:\n  - {path: ${repo}, worktree: ${repo}-q-1}\n---\nP.\n`;
    await commitQueueAdd(ctx, (await planQueueAdd(ctx, splitSpecs(spec, 't'))).items);
    const queue = describeQueue(config, readQueue(config), await liveWindows(ctx), []);
    const s = applySnapshot(initialBoardState(100, 30), { rows: [inCohort('A-1', 'alpha')], queue, preview: null, refreshedAt: '09:00:00' });
    const group = listItems(s).find((i) => i.kind === 'group');
    assert.equal(group?.kind === 'group' ? groupTitle(group) : '', '- alpha (2) 1⚙ 1⧗');
    assert.match(queueCells(queue[0]!, false, { marker: 1, task: 10, who: 18, state: 14, time: 7, progress: 8, report: 7 }).map((c) => c.text).join('|'), /Q-1/);
  });

  it('g folds the group of the selected task (its rows leave the list and the cursor path), G opens every group', () => {
    let s = boardOf(rows, { selected: 'A-1' });
    let r = press(s, 'g');
    s = r.state;
    assert.deepEqual(s.folded, ['alpha']);
    assert.equal(s.selected, 'B-1', 'the cursor moves off the folded group');
    assert.deepEqual(navTasks(s), ['B-1', 'B-2', 'C-1']);
    const titles = listItems(s).flatMap((i) => (i.kind === 'group' ? [groupTitle(i)] : []));
    assert.equal(titles[0], '+ alpha (2) 1⚙ 1✓ – g opens, G opens all');
    assert.equal(listItems(s).filter((i) => i.kind === 'row').length, 3);
    s = press(s, 'g').state; // on B-1: folds Wave too
    assert.deepEqual(s.folded, ['alpha', 'wave']);
    assert.deepEqual(navTasks(s), ['C-1']);
    r = press(s, 'E');
    assert.deepEqual(r.state.folded, []);
    assert.deepEqual(navTasks(r.state), ['A-1', 'A-2', 'B-1', 'B-2', 'C-1']);
    assert.equal(press(boardOf([row('X-1')]), 'g').state.notice?.text, 'No cohorts: nothing to fold.');
  });
});

describe('board: k picks a cohort to show', () => {
  const rows = [inCohort('A-1', 'alpha'), inCohort('B-1', 'Wave'), row('C-1'), inCohort('B-2', 'Wave', { state: 'waiting' }), inCohort('A-9', 'alpha', { cancelled: true, state: 'cancelled', hidden: true, finished: true, window: 'gone' })];

  it('lists wszystkie, every cohort in use and bez kohorty; Enter picks, the lists follow, the header names it', () => {
    let s = boardOf(rows, { selected: 'A-1' });
    assert.deepEqual(cohortOptions(s).map((o) => [o.label, o.value]), [['wszystkie', null], ['alpha', 'alpha'], ['Wave', 'wave'], ['bez kohorty', '']]);
    s = press(s, 'k').state;
    assert.equal(s.mode.kind, 'cohort-pick');
    assert.match(promptText(s) ?? '', /\[1 wszystkie\]  2 alpha  3 Wave  4 bez kohorty/);
    s = press(s, '', { downArrow: true }).state;
    s = press(s, '', { downArrow: true }).state;
    assert.match(promptText(s) ?? '', /\[3 Wave\]/);
    const r = press(s, '', { return: true });
    s = r.state;
    assert.equal(s.mode.kind, 'list');
    assert.equal(s.cohortFilter, 'wave');
    assert.equal(cohortLabel(s), 'Wave');
    assert.deepEqual(navTasks(s), ['B-1', 'B-2']);
    assert.equal(s.selected, 'B-1', 'the selection goes to a task that is still listed');
    assert.deepEqual(types(r.effects), ['refresh']);
    assert.deepEqual(activeRows(s).map((x) => x.task), ['B-1', 'B-2']);
    // cancelled rows follow the filter too, under a
    assert.deepEqual(cancelledRows({ ...s, showHidden: true }).map((x) => x.task), []);
    assert.deepEqual(cancelledRows({ ...s, showHidden: true, cohortFilter: 'alpha' }).map((x) => x.task), ['A-9']);
  });

  it('a number picks at once; bez kohorty shows the tasks without a cohort; Esc leaves the filter as it was', () => {
    let s = boardOf(rows, { selected: 'A-1' });
    s = press(press(s, 'k').state, '4').state;
    assert.deepEqual([s.cohortFilter, navTasks(s)], ['', ['C-1']]);
    assert.equal(cohortLabel(s), 'bez kohorty');
    s = press(press(s, 'k').state, '1').state;
    assert.deepEqual([s.cohortFilter, navTasks(s).length], [null, 4]);
    const esc = press(press(s, 'k').state, '', { escape: true });
    assert.deepEqual([esc.state.mode.kind, esc.state.cohortFilter], ['list', null]);
  });

  it('with no cohort at all it says so instead of opening an empty list', () => {
    const s = press(boardOf([row('A-1')]), 'k').state;
    assert.equal(s.mode.kind, 'list');
    assert.match(s.notice?.text ?? '', /No cohorts yet/);
  });

  it('k is not "up" any more: the arrow moves up, j still moves down', () => {
    const s = boardOf([row('A-1'), row('A-2')], { selected: 'A-2' });
    assert.equal(press(s, '', { upArrow: true }).state.selected, 'A-1');
    assert.equal(press(boardOf([row('A-1'), row('A-2')]), 'j').state.selected, 'A-2');
  });
});

describe('board: X cancels', () => {
  const rows = [row('A-1'), row('A-2', { state: 'report-ready', report: 'yes', finished: true, window: 'gone', windowId: null }), row('A-3', { state: 'closed', closed: true, hidden: true, finished: true, window: 'gone' })];

  it('asks for a reason (optional), then y/N, and only then cancels; Esc stops at either step', () => {
    let s = boardOf(rows, { selected: 'A-1' });
    s = press(s, 'X').state;
    assert.equal(s.mode.kind, 'cancel-reason');
    assert.equal(promptText(s), 'Cancel A-1 – reason, optional (Enter goes on, Esc stops): ');
    s = typeText(s, 'wrong approach');
    assert.match(promptText(s) ?? '', /: wrong approach$/);
    s = press(s, '', { backspace: true }).state;
    s = press(s, 'h').state;
    let r = press(s, '', { return: true });
    assert.equal(r.state.mode.kind, 'confirm');
    assert.deepEqual(r.effects, []);
    assert.equal(promptText(r.state), 'Cancel A-1 – wrong approach? Interrupts the agent, closes the window; worktree and branch stay. [y/N]');
    const yes = press(r.state, 'y');
    assert.deepEqual(yes.effects, [{ type: 'cancel', task: 'A-1', reason: 'wrong approach' }]);
    assert.equal(yes.state.mode.kind, 'list');
    for (const no of ['n', '', 'x']) assert.deepEqual(press(r.state, no, no === '' ? { return: true } : {}).effects, [], `"${no}" does not cancel`);
    // Esc in the reason step
    const esc = press(press(boardOf(rows, { selected: 'A-1' }), 'X').state, '', { escape: true });
    assert.deepEqual([esc.state.mode.kind, esc.effects], ['list', []]);
    // no reason: Enter straight away
    r = press(press(boardOf(rows, { selected: 'A-1' }), 'X').state, '', { return: true });
    assert.equal(promptText(r.state), 'Cancel A-1? Interrupts the agent, closes the window; worktree and branch stay. [y/N]');
    assert.deepEqual(press(r.state, 'y').effects, [{ type: 'cancel', task: 'A-1' }]);
  });

  it('a finished task can be cancelled too (X in its menu); a closed or cancelled one cannot', () => {
    const open = press(boardOf(rows, { selected: 'A-2', showFinished: true }), '', { return: true }).state;
    assert.equal(open.mode.kind, 'finished');
    assert.match(promptText(open) ?? '', /x close · X cancel · h hide/);
    assert.equal(press(open, 'X').state.mode.kind, 'cancel-reason');
    const closed = press(boardOf(rows, { selected: 'A-3', showHidden: true }), 'X').state;
    assert.equal(closed.mode.kind, 'list');
    assert.match(closed.notice?.text ?? '', /A-3 is closed already; nothing to cancel\./);
  });

  it('a task from a move is cancelled with its other half; the question says so', () => {
    const s = boardOf([row('A-1', { state: 'superseded', supersededBy: 'A-1-2', finished: true }), row('A-1-2', { continues: 'A-1' })], { selected: 'A-1-2' });
    const confirm = press(press(s, 'X').state, '', { return: true }).state;
    assert.match(promptText(confirm) ?? '', /^Cancel A-1-2 and A-1 \(the other half of a move\)\?/);
  });

  it('a queued task is cancelled from the Queue section; the question says it leaves the queue', async () => {
    const root = scratch.sub('xqueue');
    const repo = scratch.sub('xqueue/app');
    const config = makeConfig(root);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    const spec = `---\ntask: Q-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-q-1}\n---\nP.\n`;
    await commitQueueAdd(ctx, (await planQueueAdd(ctx, splitSpecs(spec, 't'))).items);
    const queue = describeQueue(config, readQueue(config), await liveWindows(ctx), []);
    let s = applySnapshot(initialBoardState(100, 30), { rows: [row('A-1')], queue, preview: null, refreshedAt: '09:00:00' });
    s = press(s, '', { downArrow: true }).state;
    assert.equal(s.selected, 'Q-1');
    s = press(press(s, 'X').state, '', { return: true }).state;
    assert.equal(promptText(s), 'Cancel Q-1? It is taken out of the queue. [y/N]');
    assert.deepEqual(press(s, 'y').effects, [{ type: 'cancel', task: 'Q-1' }]);
  });

  it('the effect does what the command does: interrupt, window closed, cancelled with reason and source board; blocked tasks are named', async () => {
    const root = scratch.sub('xeffect');
    const repo = scratch.sub('xeffect/app');
    const config = makeConfig(root);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'A-1');
    tmux.add('a-1', WORKING);
    const spec = `---\ntask: B-2\nagent: claude\nafter: A-1\nrepos:\n  - {path: ${repo}, worktree: ${repo}-b-2}\n---\nP.\n`;
    await commitQueueAdd(ctx, (await planQueueAdd(ctx, splitSpecs(spec, 't'))).items);
    const notice = await runBoardEffect(runner, config, { type: 'cancel', task: 'A-1', reason: 'scrapped' }, { insideTmux: false });
    assert.deepEqual(notice, { level: 'info', text: 'A-1: cancelled; ⛓ blocked: B-2' });
    const record = readTaskRecord(config, 'a-1');
    assert.deepEqual([record?.cancelled, record?.cancelReason, record?.cancelSource], [true, 'scrapped', 'board']);
    assert.equal(tmux.windows.length, 0);
    assert.ok(runner.commands.some((c) => c.includes('send-keys') && c.endsWith('Escape')));
    const error = await runBoardEffect(runner, config, { type: 'cancel', task: 'A-1' }, { insideTmux: false });
    assert.deepEqual(error, { level: 'error', text: 'A-1 is already cancelled' });
  });

  it('cancelled tasks are in their own section under a, the queue shows blocked in yellow, the help names the keys', async () => {
    const s = boardOf([row('A-1'), inCohort('A-2', null, { cancelled: true, state: 'cancelled', hidden: true, hiddenBy: 'cancelled', finished: true, window: 'gone', cancelReason: 'x' })], { selected: 'A-1' });
    assert.deepEqual(listItems(s).map((i) => i.kind), ['row']);
    const all = listItems({ ...s, showHidden: true });
    assert.deepEqual(all.map((i) => i.kind), ['row', 'cancelled', 'row']);
    assert.equal(KEY_HINTS.includes('X cancel') && KEY_HINTS.includes('k cohort'), true);
    const help = HELP_LINES.join('\n');
    for (const needle of ['X ', 'k ', 'g / E', 'bez kohorty', 'Cancelled tasks are listed under "a"']) assert.ok(help.includes(needle), needle);
    // open the cancelled one with a: only c works on it
    const onCancelled = press({ ...s, showHidden: true, selected: 'A-2' }, 'x').state;
    assert.match(onCancelled.notice?.text ?? '', /A-2 is cancelled; only c \(copy the report\) works on it\./);
  });
});

describe('board: loadBoard and the Ink front with cohorts', () => {
  class Term extends EventEmitter {
    columns = 100;
    rows = 24;
    isTTY = true;
    frames: string[] = [];
    write(chunk: string, ...rest: unknown[]): boolean {
      this.frames.push(String(chunk));
      (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
      return true;
    }
    screen(): string {
      const last = [...this.frames].reverse().find((f) => f.includes('TASK'));
      return (last ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    }
  }
  class Keys extends PassThrough {
    isTTY = true;
    setRawMode(): this { return this; }
    ref(): this { return this; }
    unref(): this { return this; }
  }
  const until = async (check: () => boolean, term: Term): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the screen:\n${term.screen()}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('loadBoard brings the cohort of each task; the screen has the headers, k filters, X cancels for real', async () => {
    const root = scratch.sub('ink');
    const config = makeConfig(root);
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    for (const [id, cohort] of [['A-1', 'alpha'], ['B-1', 'Wave'], ['C-1', undefined]] as const) {
      seedTask(config, id, cohort ? { cohort } : {});
      tmux.add(id.toLowerCase(), WORKING);
    }
    const snap = await loadBoard(ctx, 'A-1', new ProgressCache());
    assert.deepEqual(snap.rows.map((r) => [r.task, r.cohort]), [['A-1', 'alpha'], ['B-1', 'Wave'], ['C-1', null]]);
    const term = new Term();
    const keys = new Keys();
    const done = runBoardApp(ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    try {
      await until(() => /- alpha \(1\) 1⚙/.test(term.screen()), term);
      let screen = term.screen();
      assert.match(screen, /- alpha \(1\) 1⚙\n.*A-1/);
      assert.match(screen, /- Wave \(1\) 1⚙\n.*B-1/);
      assert.match(screen, /- bez kohorty \(1\) 1⚙\n.*C-1/);
      keys.write('k');
      await until(() => term.frames.some((f) => f.includes('[1 wszystkie]')), term);
      keys.write('3');
      await until(() => term.screen().includes('cohort: Wave') && !term.screen().includes('C-1'), term);
      assert.doesNotMatch(term.screen(), /A-1/);
      // cancel B-1 with a reason
      keys.write('X');
      await until(() => term.frames.some((f) => f.includes('Cancel B-1 – reason')), term);
      for (const ch of 'not needed') keys.write(ch);
      await new Promise((r) => setTimeout(r, 60));
      keys.write('\r');
      await until(() => term.frames.some((f) => f.includes('Cancel B-1 – not needed?')), term);
      keys.write('y');
      await until(() => readTaskRecord(config, 'b-1')?.cancelled === true, term);
      assert.equal(readTaskRecord(config, 'b-1')?.cancelReason, 'not needed');
      assert.deepEqual(tmux.windows.map((w) => w.name).sort(), ['a-1', 'c-1']);
      keys.write('q');
      await done;
      for (const l of term.screen().split('\n')) assert.ok([...l].length <= 100, `too wide: ${l}`);
    } finally {
      keys.write('q');
      await done;
    }
  });
});

describe('P12: the k list stays short and scrolls; archived cohorts leave the choice', () => {
  // 14 finished cohorts (c01 oldest … c14 newest, no window) and one with a working task.
  const many = (): BoardRow[] => [
    ...Array.from({ length: 14 }, (_, i) => inCohort(`T${i + 1}`, `c${String(i + 1).padStart(2, '0')}`, { finished: true, closed: false, state: 'report-ready', report: 'yes', started: `2026-10-${String(i + 1).padStart(2, '0')} 08:00` })),
    inCohort('LIVE', 'c01', { started: '2026-10-01 08:00' }),
  ];
  const labels = (s: BoardState, expanded = false) => cohortOptions(s, expanded).map((o) => o.label);

  it('lists the cohorts_recent newest cohorts plus the ones with work, older quiet ones fold into "starsze…"', () => {
    const s = boardOf(many());
    const l = labels(s);
    assert.equal(l[0], 'wszystkie'); assert.ok(l.includes('c01'), 'a cohort with a working task always shows'); assert.ok(l.includes('c14') && l.includes('c06') && !l.includes('c02'));
    assert.match(l.at(-1)!, /^starsze… \(4\)$/); assert.equal(l.length, 1 + 10 + 1);
    assert.ok(labels(s, true).includes('c02')); assert.ok(!labels(s, true).some((x) => x.startsWith('starsze')));
    assert.equal(cohortOptions({ ...s, cohortsRecent: 3 }).length, 5, 'wszystkie + active c01 + 2 newest + starsze…: N counts the active cohort too');
  });
  it('"starsze…" expands the choice in place; PgUp/PgDn/arrows scroll and the prompt shows a window', () => {
    let s = press(boardOf(many()), 'k').state; assert.equal(s.mode.kind, 'cohort-pick');
    const m0 = s.mode as Extract<BoardState['mode'], { kind: 'cohort-pick' }>;
    s = press(s, '', { pageDown: true }).state; assert.equal((s.mode as typeof m0).index, 7);
    s = press(s, '', { pageDown: true }).state; assert.equal((s.mode as typeof m0).index, m0.options.length - 1, 'clamped at the last');
    s = press(s, '', { return: true }).state; const exp = s.mode as typeof m0; assert.equal(exp.expanded, true); assert.ok(exp.options.length > m0.options.length);
    s = press(s, '', { pageUp: true }).state; assert.ok(promptText(s)!.length < 200 && promptText(s)!.includes('›'), 'a window, not all 16 entries');
  });
  it('an archived cohort is not in the choice, its tasks are still listed', () => {
    const s = boardOf(many(), { archivedCohorts: ['c14', 'c13'] });
    assert.ok(!labels(s).includes('c14') && !labels(s).includes('c13') && labels(s).includes('c12'));
    assert.ok(activeRows(s).some((r) => r.task === 'LIVE'));
  });
});
