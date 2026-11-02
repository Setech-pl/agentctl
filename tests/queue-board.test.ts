import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import { applySnapshot, boardColumns, handleKey, HELP_LINES, initialBoardState, KEY_HINTS, listItems, loadBoard, navTasks, ProgressCache, promptText, queueCells, queueTitle, rowCells, runBoardEffect, selectedQueueView } from '../src/core/board.ts';
import type { BoardEffect, BoardRow, BoardState, KeyPress } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { liveWindows } from '../src/core/plan.ts';
import { commitQueueAdd, describeQueue, isPaused, planQueueAdd, readQueue, waiting } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { statusTmuxLine, tmuxLine } from '../src/core/statusline.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

function row(task: string, extra: Partial<BoardRow> = {}): BoardRow {
  return {
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'working', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '2026-11-01 08:00', startedLocal: '2026-11-01 09:00',
    duration: '12m 04s', report: 'missing', reportPath: `/r/${task}.md`, pulled: null, lastLine: '', progress: { commits: 2, files: 7, text: '2c 7f', repos: [] },
    hint: null, question: null, pin: false, finished: false, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false, cancelled: false, cancelledAt: null, cancelReason: null, supersededBy: null, continues: null, worktrees: [], collide: [], ...extra,
  };
}

function setup(name: string, extraYaml = 'limits: {claude: 1}\n') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const specOf = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const add = async (text: string): Promise<void> => {
    const plan = await planQueueAdd(ctx, splitSpecs(text, 't'));
    await commitQueueAdd(ctx, plan.items);
  };
  return { config, tmux, runner, ctx, repo, specOf, add };
}

const press = (state: BoardState, input: string, key: KeyPress = {}) => handleKey(state, input, key);
const types = (effects: BoardEffect[]): string[] => effects.map((e) => e.type);

async function boardWithQueue(s: ReturnType<typeof setup>, rows: BoardRow[] = [row('NC-9')]): Promise<BoardState> {
  const entries = readQueue(s.config);
  const queue = describeQueue(s.config, entries, await liveWindows(s.ctx), []);
  const base = initialBoardState(100, 30);
  return applySnapshot(base, { rows, queue, queuePaused: queue.some((v) => v.condition.kind === 'paused'), preview: null, refreshedAt: '09:00:00' });
}

describe('board: the Queue section', () => {
  it('is listed under the active tasks with its title; the cursor walks through the rows and then the queue', async () => {
    const s = setup('section');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1') + s.specOf('Q-2'));
    const state = await boardWithQueue(s);
    assert.deepEqual(listItems(state).map((i) => i.kind), ['row', 'queue-title', 'queue', 'queue']);
    assert.deepEqual(navTasks(state), ['NC-9', 'Q-1', 'Q-2']);
    assert.equal(queueTitle(2, false), 'Queue (2) – u front  d remove  p pause');
    assert.equal(queueTitle(2, true), 'Queue (2) – PAUSED (p resumes)');
    assert.equal(state.selected, 'NC-9');
    const r = press(state, 'j');
    assert.equal(r.state.selected, 'Q-1');
    assert.equal(selectedQueueView(r.state)?.entry.task, 'Q-1');
    assert.deepEqual(types(r.effects), ['refresh']);
    assert.equal(press(press(r.state, 'j').state, 'j').state.selected, 'Q-2', 'clamped at the end');
  });

  it('a queued row shows its place and what it waits for in the cells', async () => {
    const s = setup('cells');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1', 'priority: high\n'));
    const state = await boardWithQueue(s);
    const cells = queueCells(state.queue[0]!, false, boardColumns(71));
    assert.deepEqual(cells.map((c) => c.key), ['marker', 'task', 'who', 'report']);
    assert.equal(cells[1]!.text, 'Q-1');
    assert.equal(cells[2]!.text, 'claude default/high');
    assert.match(cells[3]!.text, /^1\. czeka na miejsce: claude 1\/1 · high$/);
    const total = cells.reduce((n, c) => n + c.width + 1, 0) - 1;
    assert.equal(total, 71 - 0, 'the wide cell fills the line like a task row');
  });

  it('u moves the selected queued task to the front, d asks and removes it, p pauses and resumes', async () => {
    const s = setup('keys');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1') + s.specOf('Q-2'));
    let state: BoardState = { ...(await boardWithQueue(s)), selected: 'Q-2' };
    let r = press(state, 'u');
    assert.deepEqual(r.effects, [{ type: 'queue-up', task: 'Q-2' }]);
    r = press(state, 'd');
    assert.deepEqual(r.state.mode, { kind: 'confirm', action: 'queue-rm', task: 'Q-2' });
    assert.equal(promptText(r.state), 'Remove Q-2 from the queue? [y/N]');
    assert.deepEqual(press(r.state, 'n').effects, []);
    assert.equal(press(r.state, 'n').state.mode.kind, 'list');
    assert.deepEqual(press(r.state, 'y').effects, [{ type: 'queue-rm', task: 'Q-2' }]);
    state = await boardWithQueue(s);
    assert.deepEqual(press(state, 'p').effects, [{ type: 'queue-pause', paused: true }]);
    assert.deepEqual(press({ ...state, queuePaused: true }, 'p').effects, [{ type: 'queue-pause', paused: false }]);
    // u and d outside the queue, and the other keys on a queued row
    const onRow = { ...state, selected: 'NC-9' };
    assert.equal(press(onRow, 'u').state.notice?.level, 'error');
    assert.deepEqual(press(onRow, 'd').effects, []);
    const queued = { ...state, selected: 'Q-1' };
    for (const key of ['x', 'm', 'c', 'i', 'h', 'M']) {
      const res = press(queued, key);
      assert.deepEqual(res.effects, [], key);
      assert.match(res.state.notice?.text ?? '', /Q-1 is in the queue and has no window yet/);
    }
    assert.match(press(queued, '', { return: true }).state.notice?.text ?? '', /in the queue/);
  });

  it('the effects run the core functions: front, remove, pause and resume', async () => {
    const s = setup('effects');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1') + s.specOf('Q-2'));
    const env = { insideTmux: true };
    assert.deepEqual(await runBoardEffect(s.runner, s.config, { type: 'queue-up', task: 'Q-2' }, env), { level: 'info', text: 'Q-2: first in line' });
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['Q-2', 'Q-1']);
    assert.match((await runBoardEffect(s.runner, s.config, { type: 'queue-pause', paused: true }, env)).text, /Queue paused/);
    assert.equal(isPaused(s.config), true);
    assert.match((await runBoardEffect(s.runner, s.config, { type: 'queue-pause', paused: false }, env)).text, /Queue resumed/);
    assert.equal(isPaused(s.config), false);
    assert.deepEqual(await runBoardEffect(s.runner, s.config, { type: 'queue-rm', task: 'Q-2' }, env), { level: 'info', text: 'Q-2: removed from the queue' });
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['Q-1']);
    const missing = await runBoardEffect(s.runner, s.config, { type: 'queue-rm', task: 'Q-2' }, env);
    assert.equal(missing.level, 'error');
  });

  it('loadBoard loads the queue, its pause state and the preview of a queued task', async () => {
    const s = setup('load');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1', 'after: NC-9\n'));
    let snap = await loadBoard(s.ctx, 'Q-1', new ProgressCache());
    assert.deepEqual(snap.queue?.map((v) => [v.entry.task, v.condition.kind]), [['Q-1', 'after']]);
    assert.equal(snap.queuePaused, false);
    assert.equal(snap.preview?.task, 'Q-1');
    assert.match(snap.preview!.lines.join('\n'), /Q-1 · queued · position 1\nclaude default\/high · priority normal\nafter: NC-9\nstart: czeka na NC-9[\s\S]*Prompt of Q-1\./);
    fs.writeFileSync(`${s.config.path.replace('config.yaml', '')}queue/paused`, '');
    snap = await loadBoard(s.ctx, 'NC-9', new ProgressCache());
    assert.equal(snap.queuePaused, true);
    assert.equal(snap.preview?.task, 'NC-9');
  });

  it('the help and the key line name the queue keys', () => {
    assert.match(KEY_HINTS, /u\/d\/p/);
    const help = HELP_LINES.join('\n');
    for (const key of ['u  ', 'd  ', 'p  ', '⚠']) assert.ok(help.includes(`  ${key}`) || help.includes(key), key);
  });
});

describe('board: collision marker', () => {
  it('a colliding task gets ⚠ in the first column (the selection marker wins), and its preview says with whom', async () => {
    const cols = boardColumns(71);
    const colliding = row('A-1', { collide: [{ task: 'A-2', files: 3 }] });
    assert.equal(rowCells(colliding, false, cols)[0]!.text, '⚠');
    assert.equal(rowCells(colliding, true, cols)[0]!.text, '▸');
    assert.equal(rowCells(row('A-3'), false, cols)[0]!.text, '');
  });

  it('loadBoard works the collisions out of the progress and puts them in the preview title', async () => {
    const root = scratch.sub('collide');
    const repo = scratch.sub('collide/app');
    const config = makeConfig(root);
    const tmux = new FakeTmux();
    const git = (cmd: string, args: string[]) => {
      if (cmd !== 'git') return undefined;
      const sub = args[2];
      if (sub === 'status') return { stdout: '' };
      if (sub === 'rev-parse') return { stdout: 'abc' };
      if (sub === 'rev-list') return { stdout: '1\n' };
      if (sub === 'diff') return { stdout: 'shared.ts\n' };
      return undefined;
    };
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (c, a, o) => git(c, a) ?? tmux.respond(c, a, o) });
    const ctx = new Context(runner, config, () => {});
    for (const id of ['A-1', 'A-2']) {
      tmux.add(id.toLowerCase(), '● Working\n  esc to interrupt\n');
      seedTask(config, id, { repos: [{ path: repo, worktree: `${repo}-${id.toLowerCase()}` }] });
    }
    const snap = await loadBoard(ctx, 'A-1', new ProgressCache());
    assert.deepEqual(snap.rows.find((r) => r.task === 'A-1')!.collide, [{ task: 'A-2', files: 1 }]);
    assert.equal(snap.preview?.note, '⚠ A-2: 1');
  });
});

describe('tmux status line: the queue', () => {
  it('"2⚙ 1⏸ 3⧗": the queue count comes last; alone it is just the count', () => {
    const rows = [{ state: 'working', pulled: null }, { state: 'working', pulled: null }, { state: 'waiting', pulled: null }] as Parameters<typeof tmuxLine>[0];
    assert.equal(tmuxLine(rows, null, 3), '2⚙ 1⏸ 3⧗');
    assert.equal(tmuxLine(rows, null), '2⚙ 1⏸');
    assert.equal(tmuxLine([], null, 2), '2⧗');
    assert.equal(tmuxLine([], null, 0), '');
  });

  it('statusTmuxLine counts waiting and starting entries, not failed ones; status --tmux-line prints it', async () => {
    const s = setup('line');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1') + s.specOf('Q-2') + s.specOf('Q-3'));
    const [, second, third] = readQueue(s.config);
    fs.writeFileSync(`${s.config.path.replace('config.yaml', '')}queue/${String(third!.seq).padStart(4, '0')}-${third!.task}.json`, JSON.stringify({ ...third, status: 'failed' }));
    fs.writeFileSync(`${s.config.path.replace('config.yaml', '')}queue/${String(second!.seq).padStart(4, '0')}-${second!.task}.json`, JSON.stringify({ ...second, status: 'starting' }));
    assert.equal(await statusTmuxLine(s.ctx), '1⏸ 2⧗');
    const r = await runCli(s.config, s.runner, ['status', '--tmux-line']);
    assert.equal(r.stdout.trim(), '1⏸ 2⧗');
  });
});

describe('board: the Ink front draws the queue', () => {
  class Term extends EventEmitter {
    columns = 90;
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
  const until = async (check: () => boolean, term?: Term): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for the screen:\n${term?.screen() ?? ''}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('shows "Queue (2)", the entries with their conditions, the count in the header, and d asks before removing', async () => {
    const s = setup('ink');
    s.tmux.add('nc-9', '● Working\n  esc to interrupt\n');
    seedTask(s.config, 'NC-9');
    await s.add(s.specOf('Q-1') + s.specOf('Q-2', 'after: Q-1\n'));
    const term = new Term();
    const keys = new Keys();
    const done = runBoardApp(s.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    try {
      await until(() => term.screen().includes('Queue (2)'), term);
      let screen = term.screen();
      assert.match(screen, /2 queued/);
      assert.match(screen, /- Queue \(2\) – u front {2}d remove {2}p pause/);
      assert.match(screen, /Q-1\s+claude default\/hi…\s+1\. czeka na miejsce: claude 1\/1/);
      assert.match(screen, /Q-2\s+claude default\/hi…\s+2\. czeka na Q-1/);
      keys.write('j');
      await new Promise((r) => setTimeout(r, 150));
      keys.write('d');
      await until(() => term.frames.some((f) => f.includes('Remove Q-1 from the queue? [y/N]')), term);
      keys.write('y');
      await until(() => term.screen().includes('Queue (1)'), term);
      assert.deepEqual(readQueue(s.config).map((e) => e.task), ['Q-2']);
      assert.match(term.screen(), /Q-2\s+claude default\/hi…\s+1\. ⛓ zablokowane – Q-1 anulowane/, 'Q-2 waited for the task that was just cancelled');
      keys.write('p');
      await until(() => term.screen().includes('PAUSED'), term);
      assert.equal(isPaused(s.config), true);
      keys.write('q');
      await done;
      screen = term.screen();
      for (const l of screen.split('\n')) assert.ok([...l].length <= 90, `too wide: ${l}`);
    } finally {
      keys.write('q');
      await done;
    }
  });
});
