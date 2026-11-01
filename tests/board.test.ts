import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import {
  applySnapshot,
  boardColumns,
  boardLayout,
  handleKey,
  HELP_LINES,
  headerCells,
  initialBoardState,
  KEY_HINTS,
  LIST_WIDTH,
  loadBoard,
  PREVIEW_LINES,
  PREVIEW_MIN_WIDTH,
  ProgressCache,
  PROGRESS_TTL_MS,
  promptText,
  reportLabel,
  rowCells,
  runBoardEffect,
  selectedRow,
  visibleRows,
} from '../src/core/board.ts';
import type { BoardEffect, BoardRow, BoardState, KeyPress } from '../src/core/board.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { StatusRow } from '../src/core/status.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m 04s', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: { commits: 2, files: 7, text: '2c 7f', repos: [] },
    hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, worktrees: [], ...extra,
  };
}

/** The "Finished" section is open here, so the older tests keep seeing every row; the closed default is tested on its own. */
function boardOf(rows: BoardRow[], selected: string | null = rows[0]?.task ?? null, width = 100, height = 30): BoardState {
  return { ...initialBoardState(width, height), rows, selected, refreshedAt: '09:00:00', showFinished: true };
}

const press = (state: BoardState, input: string, key: KeyPress = {}) => handleKey(state, input, key);
const types = (effects: BoardEffect[]): string[] => effects.map((e) => e.type);

/** Press keys one after another; returns the final state and all effects. */
function run(state: BoardState, keys: [string, KeyPress?][]): { state: BoardState; effects: BoardEffect[] } {
  const effects: BoardEffect[] = [];
  for (const [input, key] of keys) {
    const r = press(state, input, key ?? {});
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

describe('board: selection and snapshots', () => {
  const rows = [row('NC-1'), row('NC-2'), row('NC-3')];

  it('arrows and j/k move the selection, clamped, and ask for a fresh preview', () => {
    let s = boardOf(rows);
    let r = press(s, '', { downArrow: true });
    assert.equal(r.state.selected, 'NC-2');
    assert.deepEqual(types(r.effects), ['refresh']);
    r = press(r.state, 'j');
    assert.equal(r.state.selected, 'NC-3');
    r = press(r.state, '', { downArrow: true });
    assert.equal(r.state.selected, 'NC-3', 'no wrap at the end');
    assert.deepEqual(r.effects, []);
    s = press(r.state, 'k').state;
    assert.equal(s.selected, 'NC-2');
    s = press(boardOf(rows), '', { upArrow: true }).state;
    assert.equal(s.selected, 'NC-1', 'no wrap at the top');
  });

  it('an empty board has nothing to select and does not crash', () => {
    const s = boardOf([], null);
    assert.deepEqual(press(s, '', { downArrow: true }).effects, []);
    const r = press(s, '', { return: true });
    assert.deepEqual(r.effects, []);
    assert.equal(r.state.notice?.level, 'error');
  });

  it('a refresh keeps the selected task while it exists, otherwise the first row', () => {
    const s = boardOf(rows, 'NC-2');
    const reordered = [row('NC-3'), row('NC-2'), row('NC-1')];
    assert.equal(applySnapshot(s, { rows: reordered, preview: null, refreshedAt: '09:00:02' }).selected, 'NC-2');
    const gone = applySnapshot(s, { rows: [row('NC-1')], preview: null, refreshedAt: '09:00:02' });
    assert.equal(gone.selected, 'NC-1');
    assert.equal(applySnapshot(boardOf([], null), { rows, preview: null, refreshedAt: 'x' }).selected, 'NC-1');
  });

  it('a preview that belongs to another task than the selected one is dropped', () => {
    const s = boardOf(rows, 'NC-2');
    const late = applySnapshot(s, { rows, preview: { task: 'NC-1', lines: ['old'] }, refreshedAt: 'x' });
    assert.equal(late.preview, null);
    const fine = applySnapshot(s, { rows, preview: { task: 'NC-2', lines: ['now'] }, refreshedAt: 'x' });
    assert.deepEqual(fine.preview?.lines, ['now']);
  });
});

describe('board: actions', () => {
  const rows = [row('NC-1'), row('NC-2', { window: 'gone', windowId: null, state: 'report-ready', report: 'yes' })];

  it('Enter switches to the window of the selected task', () => {
    const r = press(boardOf(rows), '', { return: true });
    assert.deepEqual(r.effects, [{ type: 'switch', task: 'NC-1', window: 'nc-1' }]);
  });

  it('Enter, m and i on a task without a window say so and do nothing', () => {
    const s = boardOf(rows, 'NC-2');
    for (const [input, key] of [['', { return: true }], ['m', {}], ['i', {}]] as [string, KeyPress][]) {
      const r = press(s, input, key);
      assert.deepEqual(r.effects, [], input);
      assert.match(r.state.notice?.text ?? '', /NC-2 has no tmux window/);
      assert.equal(r.state.mode.kind, 'list');
    }
  });

  it('m opens a one-line field; Enter sends it, Esc drops it', () => {
    let r = run(boardOf(rows), [['m'], ['h'], ['e'], ['l'], ['l'], ['o'], ['', { backspace: true }], ['o']]);
    assert.deepEqual(r.state.mode, { kind: 'input', task: 'NC-1', text: 'hello' });
    assert.match(promptText(r.state) ?? '', /^Message to NC-1 \(Enter sends, Esc cancels\): hello$/);
    const sent = press(r.state, '', { return: true });
    assert.deepEqual(sent.effects, [{ type: 'send', task: 'NC-1', window: 'nc-1', text: 'hello' }]);
    assert.equal(sent.state.mode.kind, 'list');
    const dropped = press(r.state, '', { escape: true });
    assert.deepEqual(dropped.effects, []);
    assert.equal(dropped.state.mode.kind, 'list');
  });

  it('typing keeps keys like q, x and i for the text; pasted line breaks become spaces; Ctrl-U clears', () => {
    const r = run(boardOf(rows), [['m'], ['q'], ['x'], ['i'], ['ab\ncd']]);
    assert.deepEqual(r.effects, []);
    assert.equal((r.state.mode as { text: string }).text, 'qxiab cd');
    const cleared = press(r.state, 'u', { ctrl: true }).state;
    assert.equal((cleared.mode as { text: string }).text, '');
    assert.deepEqual(press(cleared, '', { return: true }).effects, [], 'an empty message is not sent');
  });

  it('i asks first: only y interrupts', () => {
    const asked = press(boardOf(rows), 'i');
    assert.deepEqual(asked.effects, []);
    assert.match(promptText(asked.state) ?? '', /^Interrupt NC-1\?.*\[y\/N\]$/);
    assert.deepEqual(press(asked.state, 'y').effects, [{ type: 'interrupt', task: 'NC-1' }]);
    for (const [input, key] of [['n', {}], ['', { return: true }], ['', { escape: true }], ['x', {}]] as [string, KeyPress][]) {
      const r = press(asked.state, input, key);
      assert.deepEqual(r.effects, [], `${input}${JSON.stringify(key)}`);
      assert.equal(r.state.mode.kind, 'list');
    }
  });

  it('x asks, then asks about the worktree when there is one, and closes with or without removing it', () => {
    const withTree = [row('NC-1', { worktrees: ['/wt/nc-1'] })];
    const asked = press(boardOf(withTree), 'x');
    assert.deepEqual(asked.effects, []);
    const second = press(asked.state, 'y');
    assert.deepEqual(second.effects, [], 'the window is not closed yet');
    assert.match(promptText(second.state) ?? '', /remove the git worktree of NC-1/);
    assert.deepEqual(press(second.state, 'y').effects, [{ type: 'close', task: 'NC-1', rmWorktree: true }]);
    assert.deepEqual(press(second.state, 'n').effects, [{ type: 'close', task: 'NC-1', rmWorktree: false }]);
    assert.deepEqual(press(second.state, '', { return: true }).effects, [{ type: 'close', task: 'NC-1', rmWorktree: false }]);
    const cancelled = press(second.state, '', { escape: true });
    assert.deepEqual(cancelled.effects, []);
    assert.equal(cancelled.state.mode.kind, 'list');
    assert.deepEqual(press(asked.state, 'n').effects, []);
  });

  it('x without a worktree closes right after the first y; a missing report is a warning in the question', () => {
    const asked = press(boardOf([row('NC-1')]), 'x');
    assert.match(promptText(asked.state) ?? '', /WARNING: no report yet/);
    assert.deepEqual(press(asked.state, 'y').effects, [{ type: 'close', task: 'NC-1', rmWorktree: false }]);
    const ready = press(boardOf([row('NC-1', { report: 'yes' })]), 'x');
    assert.doesNotMatch(promptText(ready.state) ?? '', /WARNING/);
  });

  it('x works on a task whose window is already gone (to remove its worktree)', () => {
    const r = press(boardOf(rows, 'NC-2'), 'x');
    assert.equal(r.state.mode.kind, 'confirm');
  });

  it('c pulls the selected task, r pulls everything new, q and Ctrl-C leave', () => {
    assert.deepEqual(press(boardOf(rows, 'NC-2'), 'c').effects, [{ type: 'pull', task: 'NC-2' }]);
    assert.deepEqual(press(boardOf(rows), 'r').effects, [{ type: 'pull-ready' }]);
    assert.deepEqual(press(boardOf(rows), 'q').effects, [{ type: 'quit' }]);
    assert.deepEqual(press(boardOf(rows), 'c', { ctrl: true }).effects, [{ type: 'quit' }]);
    assert.equal(press(boardOf(rows), 'q').state.quit, true);
  });

  it('? shows the help and any key goes back', () => {
    const help = press(boardOf(rows), '?');
    assert.equal(help.state.mode.kind, 'help');
    const back = press(help.state, 'q');
    assert.equal(back.state.mode.kind, 'list');
    assert.deepEqual(back.effects, [], 'the key that closes the help does nothing else');
  });

  it('no single key in the list runs anything destructive', () => {
    const s = boardOf([row('NC-1', { worktrees: ['/wt'] })]);
    const keys = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789?'.split('');
    for (const k of keys) {
      for (const effect of press(s, k).effects) assert.ok(!['close', 'interrupt', 'send'].includes(effect.type), `${k} -> ${effect.type}`);
    }
    for (const key of [{ return: true }, { escape: true }, { tab: true }, { backspace: true }, { delete: true }] as KeyPress[]) {
      for (const effect of press(s, '', key).effects) assert.ok(!['close', 'interrupt', 'send'].includes(effect.type));
    }
  });
});

describe('board: layout and cells', () => {
  it('the preview shows from 110 columns on; the list alone fits 80', () => {
    assert.equal(boardLayout(80).showPreview, false);
    assert.equal(boardLayout(PREVIEW_MIN_WIDTH - 1).showPreview, false);
    assert.deepEqual(boardLayout(PREVIEW_MIN_WIDTH), { showPreview: true, listWidth: LIST_WIDTH, previewWidth: PREVIEW_MIN_WIDTH - LIST_WIDTH });
    assert.deepEqual(boardLayout(80), { showPreview: false, listWidth: 80, previewWidth: 0 });
    const wide = boardLayout(200);
    assert.equal(wide.listWidth + wide.previewWidth, 200);
  });

  it('a line of the list is at most 80 columns wide, also with the longest values', () => {
    const cols = boardColumns(80);
    const width = (cells: { width: number }[]): number => cells.reduce((n, c) => n + c.width, 0) + cells.length - 1;
    assert.ok(width(headerCells(cols)) <= 80, String(width(headerCells(cols))));
    const long = row('A-VERY-LONG-ID', { state: 'report-ready', duration: '12h 59m', progress: { commits: 120, files: 1300, text: '120c 1300f', repos: [] } });
    assert.ok(width(rowCells(long, true, cols)) <= 80);
    assert.ok(KEY_HINTS.length <= 80, `${KEY_HINTS.length}`);
    for (const l of HELP_LINES) assert.ok(l.length <= 80, l);
    assert.ok(boardColumns(50).who >= 8, 'the agent column shrinks, but not away');
  });

  it('cells: icon and state, progress, report label, agent', () => {
    const cols = boardColumns(80);
    const text = (r: StatusRow, key: string): string => rowCells(r, false, cols).find((c) => c.key === key)?.text ?? '';
    assert.equal(text(row('NC-1'), 'state'), '⚙ working');
    assert.equal(text(row('NC-1', { state: 'needs-input' }), 'state'), '? needs-input');
    assert.equal(text(row('NC-1', { state: 'needs-trust' }), 'state'), '🔒 needs-trust');
    assert.equal(text(row('NC-1'), 'progress'), '2c 7f');
    assert.equal(text(row('NC-1', { progress: null }), 'progress'), '-');
    assert.equal(text(row('NC-1'), 'who'), 'claude opus/high');
    assert.equal(text(row('NC-1', { agent: 'unknown' }), 'who'), 'unknown');
    assert.equal(text(row('NC-1'), 'time'), '12m 04s');
    assert.equal(reportLabel(row('NC-1')), '-');
    assert.equal(reportLabel(row('NC-1', { report: 'yes' })), 'ready');
    assert.equal(reportLabel(row('NC-1', { report: 'yes', pulled: '2026-11-01T08:00:00Z' })), 'pulled');
    assert.equal(rowCells(row('NC-1'), true, cols)[0]?.text, '▸');
    assert.equal(rowCells(row('NC-1'), false, cols)[0]?.text, '');
    assert.equal(rowCells(row('NC-1', { state: 'report-ready' }), false, cols, { working: '>', waiting: 'w', 'needs-input': '?', 'needs-trust': 't', limited: 'L', 'report-ready': 'OK', superseded: 's', orphan: 'x', dead: 'x', closed: 'c', background: 'b' })[3]?.text, 'OK report-ready');
  });

  it('a long list scrolls so that the selected row stays visible', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`T-${i + 1}`));
    const at = (task: string, cap = 5) => visibleRows(boardOf(rows, task), cap);
    assert.deepEqual(at('T-1').rows.map((r) => r.task), ['T-1', 'T-2', 'T-3', 'T-4', 'T-5']);
    assert.ok(at('T-10').rows.some((r) => r.task === 'T-10'));
    assert.deepEqual(at('T-20').rows.map((r) => r.task).slice(-1), ['T-20']);
    assert.equal(visibleRows(boardOf(rows.slice(0, 3)), 5).rows.length, 3);
  });
});

describe('board: loading data', () => {
  function setup(name: string) {
    const config = makeConfig(scratch.sub(name));
    const tmux = new FakeTmux();
    seedTask(config, 'NC-1', { repos: [{ path: '/repo', worktree: '/wt/nc-1', base: 'main' }] });
    seedTask(config, 'NC-2', { repos: [{ path: '/repo', worktree: '/repo' }] });
    seedTask(config, 'NC-3');
    const many = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    tmux.add('⚙ nc-1', `${many}\n\n──────────\n❯ \n──────────\n  ? for shortcuts\n`);
    tmux.add('nc-2', '● idle\n❯ \n  ? for shortcuts\n');
    tmux.add('watch', 'watching');
    tmux.add('board', 'the board');
    tmux.add('stray', '● hello\n');
    let gitCalls = 0;
    const respond = (cmd: string, args: string[], opts: Parameters<FakeTmux['respond']>[2]) => {
      if (cmd === 'git') {
        gitCalls++;
        const sub = args[2];
        if (sub === 'rev-list') return { stdout: '3\n' };
        if (sub === 'diff') return { stdout: 'a.ts\nb.ts\n' };
        return { stdout: '' };
      }
      return tmux.respond(cmd, args, opts);
    };
    return { config, tmux, calls: () => gitCalls, ...makeContext(config, { respond }) };
  }

  it('rows come with progress and removable worktrees; watch and board are not tasks; the stray window is an orphan', async () => {
    const { ctx } = setup('ld1');
    const snap = await loadBoard(ctx, null, new ProgressCache());
    assert.deepEqual(snap.rows.map((r) => r.task), ['NC-1', 'NC-2', 'NC-3', 'STRAY']);
    const [one, two, three, stray] = snap.rows as [BoardRow, BoardRow, BoardRow, BoardRow];
    assert.equal(one.progress?.text, '3c 2f');
    assert.deepEqual(one.worktrees, ['/wt/nc-1']);
    assert.deepEqual(two.worktrees, [], 'the main checkout is never removed');
    assert.equal(three.progress, null);
    assert.equal(three.window, 'gone');
    assert.equal(stray.state, 'orphan');
    assert.match(snap.refreshedAt, /^\d\d:\d\d:\d\d$/);
  });

  it('the preview is the last 30 lines of content of the selected window, without the footer', async () => {
    const { ctx, runner } = setup('ld2');
    const snap = await loadBoard(ctx, 'NC-1', new ProgressCache());
    assert.equal(snap.preview?.task, 'NC-1');
    assert.equal(snap.preview?.lines.length, PREVIEW_LINES);
    assert.equal(snap.preview?.lines.at(-1), 'line 50');
    assert.ok(snap.preview?.lines.every((l) => !/shortcuts|──|^❯/.test(l)));
    assert.ok(runner.queries.some((q) => /capture-pane -p -t @1 -S -70$/.test(q)), runner.queries.filter((q) => q.includes('capture')).join('\n'));
    const second = await loadBoard(ctx, 'NC-2', new ProgressCache());
    assert.deepEqual(second.preview, { task: 'NC-2', lines: ['● idle'] });
  });

  it('a task without a window gets a one-line preview; an unknown selection falls back to the first row', async () => {
    const { ctx } = setup('ld3');
    const closed = await loadBoard(ctx, 'NC-3', new ProgressCache());
    assert.match(closed.preview?.lines[0] ?? '', /no tmux window/);
    const fallback = await loadBoard(ctx, 'NOPE', new ProgressCache());
    assert.equal(fallback.preview?.task, 'NC-1');
  });

  it('git is asked again only after the cache time', async () => {
    const { ctx, calls, runner } = setup('ld4');
    const cache = new ProgressCache();
    await loadBoard(ctx, null, cache);
    const first = calls();
    assert.ok(first > 0);
    await loadBoard(ctx, null, cache);
    assert.equal(calls(), first, 'second refresh within the TTL: no git');
    await runner.sleep(PROGRESS_TTL_MS + 1);
    await loadBoard(ctx, null, cache);
    assert.equal(calls(), first * 2);
  });

  it('an empty installation gives an empty board', async () => {
    const config = makeConfig(scratch.sub('ld5'));
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const snap = await loadBoard(ctx, null, new ProgressCache());
    assert.deepEqual(snap.rows, []);
    assert.equal(snap.preview, null);
  });
});

describe('board: running effects', () => {
  function setup(name: string, windowName = '⚙ nc-1') {
    const config = makeConfig(scratch.sub(name));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add(windowName, '● idle\n❯ \n');
    const made = makeContext(config, { respond: tmux.respond });
    return { config, tmux, ...made };
  }
  const plain = (r: RecordingRunner): string[] => r.commands.map((c) => c.replaceAll("'", ''));

  it('switch inside tmux selects the window and switches the client; outside it explains', async () => {
    const { runner, config } = setup('ef1');
    const ok = await runBoardEffect(runner, config, { type: 'switch', task: 'NC-1', window: 'nc-1' }, { insideTmux: true });
    assert.equal(ok.level, 'info');
    assert.deepEqual(plain(runner), ['tmux select-window -t @1', 'tmux switch-client -t =agentctl']);
    const outside = setup('ef1b');
    const no = await runBoardEffect(outside.runner, outside.config, { type: 'switch', task: 'NC-1', window: 'nc-1' }, { insideTmux: false });
    assert.equal(no.level, 'error');
    assert.match(no.text, /agentctl attach NC-1/);
    assert.deepEqual(outside.runner.commands, []);
  });

  it('send pastes into the window (found by ID despite the icon) and logs it in TASK.md', async () => {
    const { runner, config } = setup('ef2');
    const notice = await runBoardEffect(runner, config, { type: 'send', task: 'NC-1', window: 'nc-1', text: 'please add a test' }, { insideTmux: true });
    assert.deepEqual(notice, { level: 'info', text: 'NC-1: prompt sent' });
    assert.ok(plain(runner).includes('tmux paste-buffer -p -d -b agentctl-nc-1 -t @1'));
    assert.equal(runner.calls.find((c) => c.line.includes('load-buffer'))?.input, 'please add a test');
    assert.match(runner.appended.get(`${config.stateDir}/nc-1/TASK.md`) ?? '', /please add a test/);
  });

  it('interrupt sends the agent key once', async () => {
    const { runner, config } = setup('ef3');
    const notice = await runBoardEffect(runner, config, { type: 'interrupt', task: 'NC-1' }, { insideTmux: true });
    assert.match(notice.text, /NC-1: interrupted \(Escape sent\)/);
    assert.deepEqual(plain(runner), ['tmux send-keys -t @1 Escape']);
  });

  it('close kills the window; with rmWorktree it also removes the worktree, never with force', async () => {
    const config = makeConfig(scratch.sub('ef4'));
    seedTask(config, 'NC-1', { repos: [{ path: '/repo', worktree: scratch.sub('ef4/wt') }] });
    const tmux = new FakeTmux();
    tmux.add('✓ nc-1');
    const { runner } = makeContext(config, { respond: (cmd, args, opts) => (cmd === 'git' && args.includes('rev-parse') ? { stdout: 'nc-1\n' } : tmux.respond(cmd, args, opts)) });
    const notice = await runBoardEffect(runner, config, { type: 'close', task: 'NC-1', rmWorktree: true }, { insideTmux: true });
    assert.equal(notice.level, 'info');
    assert.match(notice.text, /window agentctl:nc-1 closed; NC-1: worktree .* removed/);
    const cmds = plain(runner);
    assert.deepEqual(cmds.filter((c) => c.startsWith('tmux')), ['tmux kill-window -t @1']);
    assert.ok(cmds.some((c) => c.startsWith('git -C /repo worktree remove ') && !c.includes('--force')));
    const keep = setup('ef4b');
    await runBoardEffect(keep.runner, keep.config, { type: 'close', task: 'NC-1', rmWorktree: false }, { insideTmux: true });
    assert.ok(!keep.runner.commands.some((c) => c.startsWith('git')));
  });

  it('a failure becomes an error notice with the first line of the message', async () => {
    const { runner, config } = setup('ef5');
    const notice = await runBoardEffect(runner, config, { type: 'interrupt', task: 'NOPE' }, { insideTmux: true });
    assert.equal(notice.level, 'error');
    assert.match(notice.text, /^unknown task NOPE/);
    assert.ok(!notice.text.includes('\n'));
  });

  it('pull-ready with nothing to pull says so', async () => {
    const { runner, config } = setup('ef6');
    const notice = await runBoardEffect(runner, config, { type: 'pull-ready' }, { insideTmux: true });
    assert.deepEqual(notice, { level: 'info', text: 'No reports ready.' });
  });

  it('pull without a report shows the first line of the fallback', async () => {
    const { runner, config } = setup('ef7');
    const notice = await runBoardEffect(runner, config, { type: 'pull', task: 'NC-1' }, { insideTmux: true });
    assert.match(notice.text, /^No report at /);
  });
});

describe('agentctl board (CLI)', () => {
  function cli(config: ReturnType<typeof makeConfig>, runner: RecordingRunner, argv: string[], extra: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
      confirm: undefined, readClipboard: async () => '', watchCommand: () => 'agentctl watch', boardCommand: () => 'agentctl board', makeRunner: () => runner, ...extra,
    };
    return main(argv, deps).then((code) => ({ code, stdout: out.join(''), stderr: err.join('') }));
  }

  it('--tmux creates window "board" running the board, once', async () => {
    const config = makeConfig(scratch.sub('cli1'));
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const r = await cli(config, runner, ['board', '--tmux']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(runner.commands.map((c) => c.replaceAll("'", '')).slice(0, 1).map((c) => c.split(' -c ')[0]), ['tmux new-window -d -t =agentctl: -n board']);
    assert.ok(runner.commands.some((c) => c.includes('agentctl board')));
    assert.ok(!runner.commands.some((c) => c.startsWith('tmux send-keys')), 'the board is the window process, not typed into a shell');
    assert.match(r.stdout, /Started the board in window agentctl:board/);
    const again = await cli(config, runner, ['board', '--tmux']);
    assert.match(again.stdout, /already exists, left alone/);
  });

  it('--tmux creates the session when it is not up', async () => {
    const config = makeConfig(scratch.sub('cli2'));
    const runner = new RecordingRunner({ dryRun: false, respond: new FakeTmux().respond });
    const r = await cli(config, runner, ['board', '--tmux']);
    assert.ok(runner.commands[0]?.startsWith('tmux new-session -d -s agentctl -n board'));
    assert.match(r.stdout, /session created/);
  });

  it('without --tmux it runs the board in this terminal, told whether it is inside tmux', async () => {
    const config = makeConfig(scratch.sub('cli3'));
    const runner = new RecordingRunner({ dryRun: false, respond: new FakeTmux().respond });
    const seen: boolean[] = [];
    const r = await cli(config, runner, ['board'], { insideTmux: true, runBoard: async (_ctx, inside) => void seen.push(inside), minBoardLifetimeMs: 0 });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen, [true]);
    const none = await cli(config, runner, ['board']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /not available here/);
  });

  it('the status listing never shows the board window as an orphan', async () => {
    const config = makeConfig(scratch.sub('cli4'));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    tmux.add('board');
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const r = await cli(config, runner, ['status', '--json']);
    assert.deepEqual((JSON.parse(r.stdout) as { task: string }[]).map((x) => x.task), ['NC-1']);
  });
});

describe('board: selectedRow', () => {
  it('finds the selected row', () => {
    assert.equal(selectedRow(boardOf([row('A'), row('B')], 'B'))?.task, 'B');
    assert.equal(selectedRow(boardOf([row('A')], null)), undefined);
  });
});

