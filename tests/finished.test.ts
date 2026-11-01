import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { activeRows, applySnapshot, displayRows, finishedRows, handleKey, initialBoardState, listItems, loadBoard, promptText, ProgressCache, rowCells, runBoardEffect, visibleItems } from '../src/core/board.ts';
import type { BoardEffect, BoardRow, BoardState, KeyPress } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { setHidden } from '../src/core/hide.ts';
import { collectStatus, shownRows } from '../src/core/status.ts';
import { tmuxLine } from '../src/core/statusline.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: null, hint: null, question: null, pin: false,
    finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, worktrees: [], ...extra,
  };
}
const dead = (task: string, extra: Partial<BoardRow> = {}): BoardRow => row(task, { state: 'dead', window: 'gone', windowId: null, finished: true, ...extra });
const tasks = (rows: BoardRow[]): string[] => rows.map((r) => r.task);

function boardOf(rows: BoardRow[], extra: Partial<BoardState> = {}): BoardState {
  return { ...initialBoardState(100, 30), rows, selected: rows.find((r) => !r.finished)?.task ?? null, refreshedAt: '09:00:00', ...extra };
}
const press = (s: BoardState, input: string, key: KeyPress = {}) => handleKey(s, input, key);
const types = (e: BoardEffect[]): string[] => e.map((x) => x.type);

describe('board: active tasks and the closed "Finished" section', () => {
  const rows = [row('A-1'), dead('A-2'), row('A-3', { state: 'waiting' }), dead('A-4', { state: 'report-ready', report: 'yes' }), row('A-5', { state: 'superseded', finished: true })];

  it('finished tasks (no window, or moved to the other provider) are not among the active ones; the section is closed by default', () => {
    const s = boardOf(rows);
    assert.deepEqual(tasks(activeRows(s)), ['A-1', 'A-3']);
    assert.deepEqual(tasks(finishedRows(s)), ['A-2', 'A-4', 'A-5']);
    assert.deepEqual(tasks(displayRows(s)), ['A-1', 'A-3']);
    assert.deepEqual(listItems(s).map((i) => i.kind), ['row', 'row', 'finished']);
    const title = listItems(s).at(-1);
    assert.deepEqual(title, { kind: 'finished', count: 3, expanded: false });
  });

  it('z opens it: the finished rows follow the title and the cursor can reach them; z again closes it and the cursor comes back', () => {
    let s = press(boardOf(rows), 'z').state;
    assert.equal(s.showFinished, true);
    assert.deepEqual(listItems(s).map((i) => (i.kind === 'row' ? i.row.task : i.kind)), ['A-1', 'A-3', 'finished', 'A-2', 'A-4', 'A-5']);
    s = press(press(s, 'j').state, 'j').state;
    assert.equal(s.selected, 'A-2');
    const closed = press(s, 'z');
    assert.equal(closed.state.showFinished, false);
    assert.equal(closed.state.selected, 'A-1', 'the selected task is hidden by the closing: the first active one is selected');
    assert.deepEqual(types(closed.effects), ['refresh']);
  });

  it('with only finished tasks the list is the title alone; the cursor has nothing to stand on until z', () => {
    const s = boardOf([dead('A-2')]);
    assert.equal(s.selected, null);
    assert.deepEqual(listItems(s).map((i) => i.kind), ['finished']);
    assert.deepEqual(press(s, 'j').effects, []);
  });

  it('a refresh keeps the selection when its row is still listed, otherwise takes the first listed one', () => {
    const open = boardOf(rows, { showFinished: true, selected: 'A-4' });
    assert.equal(applySnapshot(open, { rows, preview: null, refreshedAt: 'x' }).selected, 'A-4');
    const closed = boardOf(rows, { selected: 'A-4' });
    assert.equal(applySnapshot(closed, { rows, preview: null, refreshedAt: 'x' }).selected, 'A-1');
  });

  it('a long list scrolls with the titles in it', () => {
    const many = [...Array.from({ length: 6 }, (_, i) => row(`A-${i}`)), ...Array.from({ length: 6 }, (_, i) => dead(`D-${i}`))];
    const s = boardOf(many, { showFinished: true, selected: 'D-5' });
    const v = visibleItems(s, 5);
    assert.equal(v.items.length, 5);
    assert.deepEqual(v.items.at(-1), { kind: 'row', row: many[11] });
  });

  it('finished rows are dimmed; the state colour goes grey', () => {
    const cells = rowCells(dead('A-2'), false, { marker: 1, task: 10, who: 18, state: 14, time: 7, progress: 8, report: 7 });
    assert.ok(cells.filter((c) => c.key !== 'marker').every((c) => c.dim === true));
    assert.ok(!rowCells(row('A-1'), false, { marker: 1, task: 10, who: 18, state: 14, time: 7, progress: 8, report: 7 }).some((c) => c.dim && c.key === 'task'));
  });
});

describe('board: Enter on a finished task opens a menu instead of switching', () => {
  const rows = [row('A-1'), dead('A-2', { worktrees: ['/wt/a2'], state: 'report-ready', report: 'yes' }), dead('A-3')];
  const open = (task: string) => press(boardOf(rows, { showFinished: true, selected: task }), '', { return: true });

  it('Enter on a finished task: no switch, a menu with the prompt', () => {
    const r = open('A-2');
    assert.deepEqual(r.effects, []);
    assert.deepEqual(r.state.mode, { kind: 'finished', task: 'A-2' });
    assert.equal(promptText(r.state), 'A-2 is finished (no window): c copy report · x close · h hide · Esc');
    assert.equal(r.state.notice, null, 'no "has no tmux window" complaint');
  });

  it('Enter on a running task still switches', () => {
    assert.deepEqual(press(boardOf(rows), '', { return: true }).effects, [{ type: 'switch', task: 'A-1', window: 'a-1' }]);
  });

  it('c copies the report and leaves the menu', () => {
    const r = press(open('A-2').state, 'c');
    assert.deepEqual(r.effects, [{ type: 'pull', task: 'A-2' }]);
    assert.equal(r.state.mode.kind, 'list');
  });

  it('x asks, then asks about the worktree when there is one; answering n only closes', () => {
    let r = press(open('A-2').state, 'x');
    assert.equal(promptText(r.state), 'Close A-2? It has no window; it is marked closed and leaves the list. [y/N]');
    r = press(r.state, 'y');
    assert.deepEqual(r.state.mode, { kind: 'confirm', action: 'close-worktree', task: 'A-2' });
    assert.match(promptText(r.state) ?? '', /remove the git worktree of A-2/);
    assert.deepEqual(press(r.state, 'n').effects, [{ type: 'close', task: 'A-2', rmWorktree: false }]);
    assert.deepEqual(press(r.state, 'y').effects, [{ type: 'close', task: 'A-2', rmWorktree: true }]);
    assert.deepEqual(press(r.state, '', { escape: true }).effects, []);
    const noWorktree = press(press(open('A-3').state, 'x').state, 'y');
    assert.deepEqual(noWorktree.effects, [{ type: 'close', task: 'A-3', rmWorktree: false }]);
    assert.deepEqual(press(press(open('A-3').state, 'x').state, 'n').effects, []);
  });

  it('h hides; Esc leaves; a key that is not in the menu changes nothing; m, i do not work on a finished task', () => {
    assert.deepEqual(press(open('A-2').state, 'h').effects, [{ type: 'hide', task: 'A-2', hidden: true }]);
    const esc = press(open('A-2').state, '', { escape: true });
    assert.deepEqual([esc.state.mode.kind, esc.effects], ['list', []]);
    const other = press(open('A-2').state, 'q');
    assert.deepEqual([other.state.mode.kind, other.effects], ['finished', []]);
    const m = press(boardOf(rows, { showFinished: true, selected: 'A-2' }), 'm');
    assert.match(m.state.notice?.text ?? '', /A-2 has no tmux window/);
  });

  it('a moved task whose old window is still open is finished too, and its menu can open the window', () => {
    const superseded = row('A-5', { state: 'superseded', finished: true });
    const r = press(boardOf([row('A-1'), superseded], { showFinished: true, selected: 'A-5' }), '', { return: true });
    assert.match(promptText(r.state) ?? '', /o open window/);
    assert.deepEqual(press(r.state, 'o').effects, [{ type: 'switch', task: 'A-5', window: 'a-5' }]);
    assert.deepEqual(press(open('A-3').state, 'o').effects, [], 'no window, nothing to open');
  });
});

function setup(name: string, yaml = '') {
  const config = makeConfig(scratch.sub(name), yaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  return { config, tmux, runner, ctx };
}

function writeReport(report: string): void {
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, '# report\n');
}

describe('hide and unhide', () => {
  it('hide sets hidden in TASK.md and nothing else: no window, worktree or branch is touched', async () => {
    const { config, runner, ctx } = setup('h1');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    const results = await setHidden(ctx, ['nc-1', 'NC-2'], true);
    assert.deepEqual(results.map((r) => [r.task, r.unchanged]), [['NC-1', false], ['NC-2', false]]);
    assert.equal(readTaskRecord(config, 'nc-1')?.hidden, true);
    assert.deepEqual(runner.commands.filter((c) => !c.startsWith('write ')), []);
    assert.deepEqual((await setHidden(ctx, ['NC-1'], true)).map((r) => r.unchanged), [true]);
    await setHidden(ctx, ['NC-1'], false);
    assert.equal(readTaskRecord(config, 'nc-1')?.hidden, false);
  });

  it('takes a unique prefix; an unknown or ambiguous name stops everything before anything is written', async () => {
    const { config, ctx } = setup('h2');
    seedTask(config, 'AUDIO-1');
    seedTask(config, 'AUDIO-2');
    seedTask(config, 'ZOMBIE-1');
    await assert.rejects(setHidden(ctx, ['ZOMBIE-1', 'AUDIO'], true), /"AUDIO" fits more than one task/);
    await assert.rejects(setHidden(ctx, ['ZOMBIE-1', 'NOPE'], true), /no task "NOPE" with a state file/);
    assert.equal(readTaskRecord(config, 'zombie-1')?.hidden, undefined);
    await setHidden(ctx, ['zom'], true);
    assert.equal(readTaskRecord(config, 'zombie-1')?.hidden, true);
  });

  it('a hidden task is off status, the tmux line and the board; --all, the a key and unhide bring it back', async () => {
    const { config, tmux, runner, ctx } = setup('h3');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol' });
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    assert.equal((await runCli(config, runner, ['hide', 'nc-2'])).stdout, "NC-2: hidden (its window is still running; \"agentctl status --all\" lists it)\n");
    const rows = await collectStatus(ctx, { progress: false });
    assert.equal(tmuxLine(shownRows(rows, false), null), '1⚙');
    assert.equal(tmuxLine(shownRows(rows, true), null), '2⚙');
    const status = (await runCli(config, runner, ['status'])).stdout;
    assert.doesNotMatch(status.split('\n').slice(0, -2).join('\n'), /NC-2/);
    assert.match(status, /1 hidden task not shown: agentctl status --all/);
    assert.match((await runCli(config, runner, ['status', '--all'])).stdout, /NC-2 \(hidden\)/);
    const json = JSON.parse((await runCli(config, runner, ['status', '--json'])).stdout) as { task: string }[];
    assert.deepEqual(json.map((r) => r.task), ['NC-1']);
    let board = applySnapshot(initialBoardState(100, 30), await loadBoard(ctx, null, new ProgressCache()));
    assert.deepEqual(tasks(displayRows(board)), ['NC-1']);
    board = press(board, 'a').state;
    assert.deepEqual(tasks(displayRows(board)), ['NC-1', 'NC-2']);
    assert.equal(rowCells(displayRows(board)[1]!, false, { marker: 1, task: 10, who: 18, state: 14, time: 7, progress: 8, report: 7 })[0]?.text, '·');
    assert.equal((await runCli(config, runner, ['unhide', 'NC-2'])).stdout, 'NC-2: shown again\n');
    assert.match((await runCli(config, runner, ['status'])).stdout, /NC-2/);
  });

  it('the h key hides the selected task, or shows a hidden one; the effect runs the same code as the command', async () => {
    const { config, runner } = setup('h4');
    seedTask(config, 'NC-1');
    const s = boardOf([row('NC-1')]);
    const r = press(s, 'h');
    assert.deepEqual(r.effects, [{ type: 'hide', task: 'NC-1', hidden: true }]);
    const notice = await runBoardEffect(runner, config, r.effects[0]!, { insideTmux: false });
    assert.match(notice.text, /NC-1: hidden/);
    assert.equal(readTaskRecord(config, 'nc-1')?.hidden, true);
    const hidden = boardOf([row('NC-1', { hidden: true, hiddenBy: 'user' })], { showHidden: true });
    assert.deepEqual(press(hidden, 'h').effects, [{ type: 'hide', task: 'NC-1', hidden: false }]);
    await runBoardEffect(runner, config, { type: 'hide', task: 'NC-1', hidden: false }, { insideTmux: false });
    assert.equal(readTaskRecord(config, 'nc-1')?.hidden, false);
  });
});

describe('board.auto_hide_pulled_dead', () => {
  it('a task without a window whose report was pulled hides itself; without a report it stays under Finished', async () => {
    const { config, ctx } = setup('ah1');
    const pulled = seedTask(config, 'NC-1');
    const unpulled = seedTask(config, 'NC-2');
    seedTask(config, 'NC-3'); // dead: no report
    writeReport(pulled.report);
    writeReport(unpulled.report);
    const { setHeaderField } = await import('../src/core/taskstore.ts');
    await setHeaderField(ctx.runner, path.join(config.stateDir, 'nc-1', 'TASK.md'), 'pulled', new Date(ctx.runner.now() + 60_000).toISOString());
    const rows = await collectStatus(ctx, { progress: false });
    const by = (t: string) => rows.find((r) => r.task === t)!;
    assert.deepEqual([by('NC-1').state, by('NC-1').hidden, by('NC-1').hiddenBy], ['report-ready', true, 'auto']);
    assert.deepEqual([by('NC-2').hidden, by('NC-2').finished], [false, true]);
    assert.deepEqual([by('NC-3').state, by('NC-3').hidden, by('NC-3').finished], ['dead', false, true]);
    assert.deepEqual(shownRows(rows, false).map((r) => r.task), ['NC-2', 'NC-3']);
  });

  it('copying the report from the board (c) counts as pulled, so a finished task goes away by itself', async () => {
    const { config, runner, ctx } = setup('ah2');
    const record = seedTask(config, 'NC-1');
    writeReport(record.report);
    assert.equal((await collectStatus(ctx, { progress: false }))[0]?.hidden, false);
    await runner.sleep(5000); // the fake clock started before the report was written; a real pull always comes later
    const notice = await runBoardEffect(runner, config, { type: 'pull', task: 'NC-1' }, { insideTmux: false });
    assert.match(notice.text, /Copied/);
    const [after] = await collectStatus(ctx, { progress: false });
    assert.deepEqual([after?.hidden, after?.hiddenBy], [true, 'auto']);
  });

  it('a task whose window is alive is never hidden by itself, and a new report makes a pulled task visible again', async () => {
    const { config, tmux, ctx } = setup('ah3');
    const record = seedTask(config, 'NC-1', { pulled: '2026-11-01T12:30:00.000Z' });
    writeReport(record.report);
    fs.utimesSync(record.report, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
    assert.equal((await collectStatus(ctx, { progress: false }))[0]?.hiddenBy, 'auto');
    fs.utimesSync(record.report, new Date('2026-11-01T13:00:00Z'), new Date('2026-11-01T13:00:00Z'));
    assert.equal((await collectStatus(ctx, { progress: false }))[0]?.hidden, false, 'the report is newer than the pull');
    fs.utimesSync(record.report, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
    tmux.add('nc-1', WORKING);
    assert.equal((await collectStatus(ctx, { progress: false }))[0]?.hidden, false, 'its window is there');
  });

  it('can be switched off; unhide keeps a pulled task visible for good; nothing is closed or removed', async () => {
    const off = setup('ah4', 'board: {auto_hide_pulled_dead: false}\n');
    const r1 = seedTask(off.config, 'NC-1', { pulled: '2026-11-01T12:30:00.000Z' });
    writeReport(r1.report);
    fs.utimesSync(r1.report, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
    assert.equal((await collectStatus(off.ctx, { progress: false }))[0]?.hidden, false);

    const on = setup('ah5');
    const r2 = seedTask(on.config, 'NC-1', { pulled: '2026-11-01T12:30:00.000Z' });
    writeReport(r2.report);
    fs.utimesSync(r2.report, new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
    assert.equal((await collectStatus(on.ctx, { progress: false }))[0]?.hiddenBy, 'auto');
    await setHidden(on.ctx, ['NC-1'], false);
    const [after] = await collectStatus(on.ctx, { progress: false });
    assert.deepEqual([after?.hidden, after?.hiddenBy], [false, null]);
    assert.deepEqual(on.runner.commands.filter((c) => !c.startsWith('write ') && !c.startsWith('mkdir')), [], 'no tmux kill, no git worktree remove');
    assert.throws(() => makeConfig(scratch.sub('ah6'), 'board: {auto_hide_pulled_dead: 1}\n'), /auto_hide_pulled_dead must be true or false/);
  });
});
