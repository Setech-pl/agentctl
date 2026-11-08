import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import { applySnapshot, handleKey, initialBoardState, loadBoard, managerLine, MANAGER_SELECT, navTasks, ProgressCache, runBoardEffect } from '../src/core/board.ts';
import type { BoardRow, BoardState, KeyPress } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import type { ManagerView } from '../src/core/manager.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Working\n  esc to interrupt\n';
const CONNECTED = '❯ Try "x"\n  /rc active\n';

function row(task: string): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: null, hint: null, question: null, pin: false,
    finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null,
    cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [],
  };
}

const view = (state: ManagerView['state']): ManagerView => ({ name: 'agentctl manager', window: 'manager', state, text: '' });
const press = (state: BoardState, input: string, key: KeyPress = {}) => handleKey(state, input, key);
const snapshot = (state: BoardState, manager: ManagerView | undefined, rows = [row('A-1'), row('A-2')]) =>
  applySnapshot(state, { rows, ...(manager ? { manager } : {}), preview: null, refreshedAt: '09:00:00' });

describe('board: the manager line', () => {
  it('says what the manager is doing, in its own line, and nothing when it is neither running nor configured', () => {
    const s = (m: ManagerView | null, selected: string | null = null): Pick<BoardState, 'manager' | 'selected'> => ({ manager: m, selected });
    assert.deepEqual(managerLine(s(view('connected')), false), { text: '🧭 agentctl manager: połączony', selected: false, dim: false });
    assert.equal(managerLine(s(view('waiting')), false)?.text, '🧭 agentctl manager: czeka na połączenie');
    assert.equal(managerLine(s(view('confirm')), false)?.text, '🧭 agentctl manager: czeka na potwierdzenie w oknie');
    assert.equal(managerLine(s(view('failed')), false)?.text, '🧭 agentctl manager: połączenie nie działa');
    assert.equal(managerLine(s(view('connected'), MANAGER_SELECT), false)?.text, '🧭 agentctl manager: połączony · ⏎ wejście');
    assert.equal(managerLine(s(view('connected'), MANAGER_SELECT), false)?.selected, true);
    assert.equal(managerLine(s(view('missing')), false), null);
    assert.equal(managerLine(s(null), true), null, 'before the first refresh');
    assert.deepEqual(managerLine(s(view('missing')), true), { text: '🧭 agentctl manager: nie działa – agentctl manager', selected: false, dim: true });
  });
});

describe('board: selecting the manager', () => {
  it('a refresh selects a task, not the manager; the arrow up from the first task reaches the manager, down leaves it', () => {
    const s0 = snapshot(initialBoardState(100, 30), view('connected'));
    assert.deepEqual(navTasks(s0), [MANAGER_SELECT, 'A-1', 'A-2']);
    assert.equal(s0.selected, 'A-1');
    const up = press(s0, '', { upArrow: true });
    assert.equal(up.state.selected, MANAGER_SELECT);
    assert.deepEqual(up.effects.map((e) => e.type), ['refresh']);
    assert.equal(press(up.state, '', { upArrow: true }).state.selected, MANAGER_SELECT, 'it is the top');
    assert.equal(press(up.state, '', { downArrow: true }).state.selected, 'A-1');
    assert.equal(snapshot(up.state, view('connected')).selected, MANAGER_SELECT, 'a refresh keeps it');
  });

  it('without a window there is no line to stand on', () => {
    assert.deepEqual(navTasks(snapshot(initialBoardState(100, 30), view('missing'))), ['A-1', 'A-2']);
    assert.deepEqual(navTasks(snapshot(initialBoardState(100, 30), undefined)), ['A-1', 'A-2']);
    // the window disappears while the cursor is on it: the selection moves to a task
    const on = snapshot(snapshot(initialBoardState(100, 30), view('connected')), view('connected'));
    const gone = snapshot({ ...on, selected: MANAGER_SELECT }, view('missing'));
    assert.equal(gone.selected, 'A-1');
  });

  it('Enter goes to the window "manager"; the task keys explain instead of acting on a task', () => {
    const on = { ...snapshot(initialBoardState(100, 30), view('connected')), selected: MANAGER_SELECT };
    const enter = press(on, '', { return: true });
    assert.deepEqual(enter.effects, [{ type: 'switch', task: 'manager', window: 'manager' }]);
    for (const k of ['x', 'm', 'i', 'c', 'h', 'M']) {
      const r = press(on, k);
      assert.deepEqual(r.effects, [], k);
      assert.match(r.state.notice?.text ?? '', /This is the manager, not a task/, k);
    }
    // other keys of the list still work
    assert.equal(press(on, 'w').state.mode.kind, 'confirm');
    assert.equal(press(on, 'q').state.quit, true);
  });
});

describe('board: loadBoard and the Ink front with the manager', () => {
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

  function world(name: string) {
    const config = makeConfig(scratch.sub(name));
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'A-1');
    tmux.add('a-1', WORKING);
    return { config, tmux, ctx };
  }

  it('loadBoard brings the manager and, with the cursor on it, the screen of its window; the manager is no row', async () => {
    const w = world('lb');
    w.tmux.add('manager', `${CONNECTED}Session: https://claude.ai/code/session_01X\n`);
    const snap = await loadBoard(w.ctx, 'A-1', new ProgressCache());
    assert.deepEqual(snap.rows.map((r) => r.task), ['A-1']);
    assert.equal(snap.manager?.state, 'connected');
    assert.equal(snap.preview?.task, 'A-1');
    const onManager = await loadBoard(w.ctx, MANAGER_SELECT, new ProgressCache());
    assert.equal(onManager.preview?.task, MANAGER_SELECT);
    assert.match(onManager.preview?.lines.join('\n') ?? '', /rc active/);
    w.tmux.windows = w.tmux.windows.filter((x) => x.name !== 'manager');
    assert.equal((await loadBoard(w.ctx, 'A-1', new ProgressCache())).manager?.state, 'missing');
  });

  it('the screen shows the line, Enter on it switches to the window, and a task stays selected by default', async () => {
    const w = world('ink');
    w.tmux.add('manager', CONNECTED);
    const term = new Term();
    const keys = new Keys();
    const done = runBoardApp(w.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    try {
      await until(() => /🧭 agentctl manager: połączony\n/.test(term.screen()), term);
      assert.doesNotMatch(term.screen(), /⏎ wejście/, 'a task is selected first');
      keys.write('\u001b[A');
      await until(() => term.screen().includes('⏎ wejście'), term);
      keys.write('\r');
      await until(() => term.screen().includes('Switched to manager.'), term);
      assert.ok(w.tmux.seen.some((s) => s.startsWith('select-window')), 'tmux was told to select the window');
      keys.write('q');
      await done;
      for (const l of term.screen().split('\n')) assert.ok([...l].length <= 100, `too wide: ${l}`);
    } finally {
      keys.write('q');
      await done;
    }
  });

  it('outside tmux Enter says how to get there, without a task command that would not find the window', async () => {
    const w = world('out');
    const notice = await runBoardEffect(w.ctx.runner, w.config, { type: 'switch', task: 'manager', window: 'manager' }, { insideTmux: false });
    assert.equal(notice.level, 'error');
    assert.match(notice.text, /tmux attach -t '=agentctl' \\; select-window -t manager/);
  });
});
