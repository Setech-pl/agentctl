import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { applySnapshot, boardColumns, handleKey, headerCells, initialBoardState, loadBoard, loadLogLines, ProgressCache, promptText, rowCells, runBoardEffect, usageBar, usagePanel } from '../src/core/board.ts';
import type { BoardRow } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { statusTmuxLine, tmuxLine } from '../src/core/statusline.ts';
import { planState } from '../src/core/usage.ts';
import { makeConfig } from './helpers.ts';
import { DiskRunner, FakeTmux, runCli, useScratch } from './helpers.ts';
import { makeWorld } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const sec = (ms: number): number => Math.floor(ms / 1000);
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function plans(claude: number | null, codex: number | null) {
  const state = (p: 'claude' | 'codex', pct: number | null) =>
    planState(p, pct === null ? undefined : { at: NOW - 60_000, planType: null, windows: [{ kind: 'session', minutes: 300, usedPercent: pct, resetsAt: sec(NOW + 3600_000) }, { kind: 'week', minutes: 10080, usedPercent: 10, resetsAt: sec(NOW + 4 * 86_400_000) }] }, NOW, 'no reading');
  return { claude: state('claude', claude), codex: state('codex', codex) };
}

describe('board usage panel', () => {
  const config = makeConfig(scratch.sub('panel'));

  it('a bar in tenths', () => {
    assert.deepEqual([0, 4, 62, 100, 130].map(usageBar), ['░░░░░░░░░░', '░░░░░░░░░░', '▓▓▓▓▓▓░░░░', '▓▓▓▓▓▓▓▓▓▓', '▓▓▓▓▓▓▓▓▓▓']);
  });

  it('one line per provider: windows with bar, percentage and reset; n/d with the reason when nothing is known', () => {
    const lines = usagePanel(plans(62, null), config.usage, NOW);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!.text, /^claude\s+5h ▓▓▓▓▓▓░░░░ 62% ↻\d\d:\d\d\s+week ▓░░░░░░░░░ 10% ↻\w{3} \d\d:\d\d$/);
    assert.match(lines[1]!.text, /^codex\s+n\/d – no reading$/);
    assert.equal(lines[1]!.color, undefined);
  });

  it('green below warn, yellow from usage.warn, red from usage.critical (per provider)', () => {
    const color = (pct: number, cfg = config): string | undefined => usagePanel(plans(pct, null), cfg.usage, NOW)[0]?.color;
    assert.deepEqual([50, 80, 96].map((p) => color(p)), ['green', 'yellow', 'red']);
    const custom = makeConfig(scratch.sub('panel2'), 'usage:\n  warn: {claude: 50}\n  critical: {claude: 60}\n');
    assert.deepEqual([40, 55, 65].map((p) => color(p, custom)), ['green', 'yellow', 'red']);
  });

  it('no plans yet (before the first refresh): no panel', () => {
    assert.deepEqual(usagePanel(null, config.usage, NOW), []);
  });

  it('applySnapshot keeps the plans of the snapshot', () => {
    const state = applySnapshot(initialBoardState(100, 30), { rows: [], plans: plans(10, 20), preview: null, refreshedAt: '09:00:00' });
    assert.equal(state.plans?.codex.maxPercent, 20);
  });
});

describe('board TOKENS column', () => {
  const row = (extra: Partial<BoardRow>): BoardRow => ({
    task: 'NC-1', agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: 'nc-1', windowId: '@1', started: '', startedLocal: '', duration: '12m 04s', report: 'missing', reportPath: '', pulled: null,
    lastLine: '', progress: null, hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false,
    cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  });

  it('the list has it from 69 columns on and still fits (the list beside the preview is 71)', () => {
    for (const width of [71, 80, 100]) {
      const cols = boardColumns(width);
      assert.equal(cols.tokens, 7);
      const total = (cells: { width: number }[]): number => cells.reduce((n, c) => n + c.width + 1, -1);
      assert.ok(total(headerCells(cols)) <= width, `header ${total(headerCells(cols))} > ${width}`);
    }
    assert.equal(boardColumns(60).tokens, undefined);
    assert.equal(headerCells(boardColumns(60)).some((c) => c.key === 'tokens'), false);
  });

  it('shows 1.2M for a task with tokens, n/d for one without', () => {
    const cols = boardColumns(80);
    const text = (r: BoardRow): string => rowCells(r, false, cols).find((c) => c.key === 'tokens')?.text ?? '';
    const tokens = { fresh: 1_234_567, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, sessions: 1 };
    assert.equal(text(row({ tokens })), '1.2M');
    assert.equal(text(row({ tokens: null })), 'n/d');
    assert.equal(text(row({})), 'n/d');
  });
});

describe('loadBoard with usage', () => {
  it('rows carry tokens, the snapshot the plans of both providers', async () => {
    const w = makeWorld(scratch, 'load');
    const wt = w.worktree('nc-1');
    w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z' });
    w.claudeSession(wt, 's1', '2026-11-01T10:00:00.000Z');
    const tmux = new FakeTmux();
    tmux.add('nc-1', WORKING);
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
    const ctx = new Context(runner, w.config, () => {});
    const snap = await loadBoard(ctx, null, new ProgressCache());
    assert.equal(snap.rows[0]?.tokens?.fresh, 5 + 326 + 17200 + 5 + 400);
    assert.equal(snap.plans?.claude.available, false);
    assert.equal(snap.plans?.codex.available, false);
  });
});

describe('tmux status line', () => {
  it('tasks, then the plans after a bar; the plans alone when there is no task', () => {
    assert.equal(tmuxLine([], null, 0, 'C 62% · X 18%'), 'C 62% · X 18%');
    assert.equal(tmuxLine([], null, 3, 'C 62%'), '3⧗ │ C 62%');
    assert.equal(tmuxLine([], null, 0, ''), '');
  });

  it('statusTmuxLine shows the plans that have a reading, and usage.status_line: false turns them off', async () => {
    const w = makeWorld(scratch, 'line');
    const file = w.codexSession(w.worktree('x'), 'live', new Date(NOW - 3600_000).toISOString());
    const future = sec(NOW) + 3600;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('1793700000', String(future)).replaceAll('1794300000', String(future + 86_400 * 3)));
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: new FakeTmux().respond });
    const ctx = new Context(runner, w.config, () => {});
    assert.equal(await statusTmuxLine(ctx), 'X 12%');
    const r = await runCli(w.config, runner, ['status', '--tmux-line']);
    assert.equal(r.stdout.trim(), 'X 12%');
    const off = makeWorld(scratch, 'line-off', '  status_line: false\n');
    assert.equal(await statusTmuxLine(new Context(runner, off.config, () => {})), '');
  });
});

describe('board: log view and result keys', () => {
  const row = (task: string, extra: Partial<BoardRow> = {}): BoardRow => ({
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '', startedLocal: '', duration: '1m', report: 'missing', reportPath: '', pulled: null,
    lastLine: '', progress: null, hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false,
    cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  });
  const board = (rows: BoardRow[], selected: string) => ({ ...initialBoardState(100, 30), rows, selected, showFinished: true, showHidden: true });

  it('l opens the log view and asks for the history; arrows scroll within it; Esc, q and l leave', () => {
    const open = handleKey(board([row('A-1')], 'A-1'), 'l', {});
    assert.deepEqual(open.effects, [{ type: 'log' }]);
    assert.equal(open.state.mode.kind, 'log');
    const loaded = { ...open.state, mode: { kind: 'log' as const, lines: ['h', 'a', 'b', 'c'], offset: 0 } };
    assert.equal((handleKey(loaded, '', { downArrow: true }).state.mode as { offset: number }).offset, 1);
    assert.equal((handleKey(loaded, '', { upArrow: true }).state.mode as { offset: number }).offset, 0);
    const bottom = { ...loaded, mode: { ...loaded.mode, offset: 3 } };
    assert.equal((handleKey(bottom, '', { downArrow: true }).state.mode as { offset: number }).offset, 3, 'not past the last line');
    for (const [input, key] of [['', { escape: true }], ['q', {}], ['l', {}]] as const) assert.equal(handleKey(loaded, input, key).state.mode.kind, 'list');
  });

  it('o / p / f mark a finished, closed, cancelled or report-ready task', () => {
    for (const r of [row('A-1', { finished: true, window: 'gone' }), row('A-1', { closed: true, window: 'gone' }), row('A-1', { cancelled: true, window: 'gone' }), row('A-1', { state: 'report-ready', report: 'yes' })]) {
      assert.deepEqual(handleKey(board([r], 'A-1'), 'o', {}).effects, [{ type: 'mark', task: 'A-1', result: 'ok' }]);
      assert.deepEqual(handleKey(board([r], 'A-1'), 'p', {}).effects, [{ type: 'mark', task: 'A-1', result: 'partial' }]);
      assert.deepEqual(handleKey(board([r], 'A-1'), 'f', {}).effects, [{ type: 'mark', task: 'A-1', result: 'fail' }]);
    }
  });

  it('on a task that is still working o and f say so, and p is still the queue pause', () => {
    const working = board([row('A-1')], 'A-1');
    for (const input of ['o', 'f']) {
      const r = handleKey(working, input, {});
      assert.deepEqual(r.effects, []);
      assert.equal(r.state.notice?.level, 'error');
      assert.match(r.state.notice?.text ?? '', /mark the result of a finished task/);
    }
    assert.deepEqual(handleKey(working, 'p', {}).effects, [{ type: 'queue-pause', paused: true }]);
  });

  it('the menu of a finished task marks too: o only when the window is gone (else it opens the window)', () => {
    const dead = { ...board([row('A-1', { finished: true, window: 'gone' })], 'A-1'), mode: { kind: 'finished' as const, task: 'A-1' } };
    assert.deepEqual(handleKey(dead, 'o', {}).effects, [{ type: 'mark', task: 'A-1', result: 'ok' }]);
    assert.deepEqual(handleKey(dead, 'f', {}).effects, [{ type: 'mark', task: 'A-1', result: 'fail' }]);
    const closed = { ...board([row('A-1', { closed: true, window: 'gone' })], 'A-1'), mode: { kind: 'finished' as const, task: 'A-1' } };
    assert.deepEqual(handleKey(closed, 'p', {}).effects, [{ type: 'mark', task: 'A-1', result: 'partial' }], 'a closed task can be marked, too');
  });

  it('the Enter menu of a finished task names the marks; o opens the window of a task that was moved', () => {
    const menu = handleKey(board([row('A-1', { finished: true, window: 'gone', state: 'dead' })], 'A-1'), '', { return: true }).state;
    assert.equal(menu.mode.kind, 'finished');
    assert.match(promptText(menu) ?? '', /o ok · p partial · f fail/);
    const moved = handleKey(board([row('A-2', { finished: true, state: 'superseded' })], 'A-2'), '', { return: true }).state;
    assert.deepEqual(handleKey(moved, 'o', {}).effects.map((e) => e.type), ['switch']);
  });

  it('the effect writes the mark to the history and the footer says what was marked; the log lists it', async () => {
    const w = makeWorld(scratch, 'board-mark');
    w.task('NC-1', w.worktree('nc-1'), { started: '2026-11-01T09:00:00.000Z' });
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
    const notice = await runBoardEffect(runner, w.config, { type: 'mark', task: 'NC-1', result: 'partial' }, { insideTmux: false });
    assert.deepEqual(notice, { level: 'info', text: 'NC-1: marked partial' });
    const again = await runBoardEffect(runner, w.config, { type: 'mark', task: 'NC-1', result: 'ok' }, { insideTmux: false });
    assert.equal(again.text, 'NC-1: marked ok (was partial)');
    const lines = loadLogLines(new Context(runner, w.config, () => {}));
    assert.match(lines.join('\n'), /NC-1\s+claude\/opus\/high\s+open\s+.*\bok\b/);
    assert.equal((await runBoardEffect(runner, w.config, { type: 'mark', task: 'NC-9', result: 'ok' }, { insideTmux: false })).level, 'error');
  });
});
