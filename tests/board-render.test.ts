import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { runBoardApp } from '../src/board/app.ts';
import { parseAnsi, THEME } from '../scripts/render-ansi.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { commitQueueAdd, planQueueAdd } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

/** A terminal that is a TTY of a given size and keeps what is written to it. */
class FakeTerminal extends EventEmitter {
  columns: number;
  rows: number;
  isTTY = true;
  frames: string[] = [];
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(chunk: string, ...rest: unknown[]): boolean {
    this.frames.push(String(chunk));
    this.emit('frame', String(chunk));
    // Like a real stream: tell the writer it is done (Ink waits for this when it exits).
    const done = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }
  /** The text of the last full frame: control sequences removed. */
  screen(): string {
    const last = [...this.frames].reverse().find((f) => f.includes('TASK'));
    // eslint-disable-next-line no-control-regex
    return (last ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
  }
  async frameMatching(match: (frame: string) => boolean, after = 0): Promise<string> {
    const previous = this.frames.slice(after).findLast(match);
    if (previous !== undefined) return previous;
    return new Promise((resolve, reject) => {
      const listener = (frame: string) => {
        if (!match(frame)) return;
        clearTimeout(timer);
        this.off('frame', listener);
        resolve(frame);
      };
      const timer = setTimeout(() => {
        this.off('frame', listener);
        reject(new Error(`expected terminal frame was never emitted:\n${stripVTControlCharacters(this.frames.at(-1) ?? '')}`));
      }, 10_000);
      this.on('frame', listener);
    });
  }
}

function terminalEnv(values: NodeJS.ProcessEnv): () => void {
  const names = ['TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const apply = (env: NodeJS.ProcessEnv) => {
    for (const name of names) {
      const value = env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  apply(values);
  return () => apply(original);
}

function rowStyle(frame: string, width: number, row: string, expected: { bg: string; fg: string; bold: boolean }) {
  const line = frame.split('\n').find(l => stripVTControlCharacters(l).trimStart().startsWith(row));
  assert.ok(line, `missing row ${row} in:\n${stripVTControlCharacters(frame)}`);
  const cells = parseAnsi(line, width)[0]!;
  for (const [column, { bg, fg, bold, dim }] of cells.slice(0, width).entries()) {
    assert.deepEqual({ bg, fg, bold, dim }, { ...expected, dim: false }, `${row} column ${column + 1}`);
  }
  return cells;
}

class FakeKeyboard extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the screen');
    await wait(25);
  }
}

describe('board: the Ink front renders the model', () => {
  function launch(config: GlobalConfig, columns: number, tmux: FakeTmux, snapshotAgeMs?: number) {
    const made = makeContext(config, { respond: tmux.respond });
    if (snapshotAgeMs !== undefined) fs.writeFileSync(path.join(config.stateDir, 'mcp-state-snapshot.json'), JSON.stringify({version: 1, at: made.runner.now() - snapshotAgeMs}));
    const term = new FakeTerminal(columns, 24);
    const keys = new FakeKeyboard();
    const done = runBoardApp(made.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    return { ...made, tmux, term, keys, done };
  }

  function setup(name: string, columns: number, yaml = '', snapshotAgeMs?: number, reportReady = false) {
    const config = makeConfig(scratch.sub(name), yaml);
    const active = seedTask(config, 'NC-1', { repos: [] });
    if (reportReady) {
      fs.mkdirSync(path.dirname(active.report), { recursive: true });
      fs.writeFileSync(active.report, 'Werdykt: PASS\n\n<!-- agentctl:report-end -->\n');
    }
    const finished = seedTask(config, 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', supersededBy: 'NC-1' });
    fs.mkdirSync(path.dirname(finished.report), { recursive: true });
    fs.writeFileSync(finished.report, 'Werdykt: PASS\n');
    const tmux = new FakeTmux();
    if (!reportReady) tmux.add('nc-1', '● Reading src/menu.ts\n  ⏵⏵ auto (shift+tab to cycle) · esc to interrupt\n');
    return launch(config, columns, tmux, snapshotAgeMs);
  }

  it('ROWSEL0252: a report-ready warning row, including its clipped cells and padding, is one 256-color bar', async () => {
    const restore = terminalEnv({ TERM: 'screen-256color' });
    const { term, keys, done } = setup('selection-256', 55, 'watch: {window_icons: {report-ready: "⚠"}}\n', undefined, true);
    try {
      const frame = await term.frameMatching(f => /NC-1\s+.*⚠ report-ready/.test(stripVTControlCharacters(f)));
      const cells = rowStyle(frame, 55, '▸ NC-1', { bg: 'rgb(0,95,135)', fg: THEME.ansi[15]!, bold: true });
      assert.equal(cells.length, 55);
      assert.match(cells.map(cell => cell.ch).join(''), /⚠ report-ready/);
    } finally { keys.write('q'); await done; restore(); }
  });

  for (const [name, env, yaml, style] of [
    ['16-color', { TERM: 'xterm' }, '', { bg: THEME.foreground, fg: THEME.background, bold: true }],
    ['NO_COLOR', { TERM: 'xterm-256color', COLORTERM: 'truecolor', NO_COLOR: '1' }, '', { bg: THEME.foreground, fg: THEME.background, bold: false }],
    ['monochrome', { TERM: 'dumb' }, '', { bg: THEME.foreground, fg: THEME.background, bold: false }],
    ['custom palette', { TERM: 'xterm-256color' }, 'board: {selection: {bg: "#005f87", fg: 231, bold: false}}\n', { bg: 'rgb(0,95,135)', fg: 'rgb(255,255,255)', bold: false }],
    ['custom reverse', { TERM: 'xterm-256color' }, 'board: {selection: {style: reverse, bold: false}}\n', { bg: THEME.foreground, fg: THEME.background, bold: false }],
  ] as const) {
    it(`renders the entire selection in ${name}`, async () => {
      const restore = terminalEnv(env);
      const { term, keys, done } = setup(`selection-${name}`, 80, yaml);
      try {
        const frame = await term.frameMatching(f => f.includes('Finished (1)'));
        rowStyle(frame, 80, '▸ NC-1', style);
      } finally { keys.write('q'); await done; restore(); }
    });
  }

  it('changes only the selected row when focus changes, with no data refresh', async () => {
    const restore = terminalEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    const { term, keys, done, runner } = setup('selection-focus', 160, 'board: {list_width: 100}\n');
    try {
      const left = await term.frameMatching(f => stripVTControlCharacters(f).includes('NC-1 · last'));
      const count = runner.queries.length;
      const fg = THEME.ansi[15]!;
      const leftCells = rowStyle(left, 100, '▸ NC-1', { bg: 'rgb(47,79,127)', fg, bold: true });
      assert.equal(leftCells[99]?.ch, ' ');
      assert.equal(leftCells[100]?.ch, '│');
      assert.equal(leftCells[100]?.bg, null);
      keys.write('\u001b[C');
      const right = await term.frameMatching(f => f.includes('51;58;69'));
      rowStyle(right, 100, '▸ NC-1', { bg: 'rgb(51,58,69)', fg, bold: true });
      const lines = left.split('\n');
      const changed = right.split('\n').filter((line, i) => line !== lines[i]);
      assert.equal(changed.length, 1);
      assert.match(stripVTControlCharacters(changed[0]!), /▸ NC-1/);
      const countBeforeReturn = term.frames.length;
      keys.write('\t');
      assert.equal(await term.frameMatching(f => f === left, countBeforeReturn), left);
      assert.equal(runner.queries.length, count);
    } finally { keys.write('q'); await done; restore(); }
  });

  it('uses the same full-width style in the queue, pulled cohort and WALL lists', async () => {
    const config = makeConfig(scratch.sub('selection-lists'));
    const tmux = new FakeTmux();
    const read = seedTask(config, 'READ-1', { cohort: 'wave', turnEndedAt: '2026-10-31T11:30:00.000Z', pulled: '2026-10-31T11:50:00.000Z' });
    fs.mkdirSync(path.dirname(read.report), { recursive: true });
    fs.writeFileSync(read.report, 'Werdykt: PASS\n\n<!-- agentctl:report-end -->\n');
    const reportedAt = new Date('2026-10-31T11:45:00Z');
    fs.utimesSync(read.report, reportedAt, reportedAt);
    const { ctx } = makeContext(config, { respond: tmux.respond });
    const repo = scratch.sub('selection-lists/repo');
    const queue = await planQueueAdd(ctx, splitSpecs(`---\ntask: Q-1\nagent: claude\nrepos: [{path: ${repo}, worktree: ${repo}-q1}]\n---\nTest task.\n`, 'board-test'));
    await commitQueueAdd(ctx, queue.items);
    const restore = terminalEnv({ TERM: 'screen-256color' });
    const { term, keys, done } = launch(config, 100, tmux);
    const style = { bg: 'rgb(0,95,135)', fg: THEME.ansi[15]!, bold: true };
    let wallOpen = false;
    try {
      const queued = await term.frameMatching(f => stripVTControlCharacters(f).includes('Q-1') && f.includes('odebrane'));
      rowStyle(queued, 100, '▸ Q-1', style);
      keys.write('j');
      const cohort = await term.frameMatching(f => /▸.*odebrane/.test(stripVTControlCharacters(f)));
      rowStyle(cohort, 100, '▸', style);
      keys.write('W');
      wallOpen = true;
      const wall = await term.frameMatching(f => f.includes('WALL – channels') && f.includes('agentctl        '));
      rowStyle(wall, 100, 'agentctl        ', style);
    } finally {
      if (wallOpen) {
        const after = term.frames.length;
        keys.write('W');
        await term.frameMatching(f => f.includes('TASK') && f.includes('Q-1'), after);
      }
      keys.write('q');
      await done;
      restore();
    }
  });

  it('at 80 columns it shows the list without the preview, each line within 80 columns, and q leaves', async () => {
    const { term, keys, done } = setup('rd1', 80);
    await until(() => term.screen().includes('Finished (1)'));
    let screen = term.screen();
    assert.match(screen, /TASK\s+AGENT\s+STATE\s+TIME\s+TOKENS\s+PROGRESS\s+REPORT/);
    assert.match(screen, /claude\s+n\/d/, 'the usage panel: no reading of the plan, so n/d');
    assert.match(screen, /codex\s+n\/d/);
    assert.match(screen, /NC-1\s+cl O HI\s+⚙ working/);
    assert.ok(!screen.includes('NC-2'), 'NC-2 is superseded and has no window: it waits under the closed "Finished" title');
    assert.match(screen, /\+ Finished \(1\) – z opens/);
    assert.match(screen, /Enter – open the agent · F12 – back to the list/);
    keys.write('z');
    await until(() => term.screen().includes('NC-2'));
    screen = term.screen();
    assert.match(screen, /- Finished \(1\) – z closes/);
    assert.match(screen, /NC-2\s+cx S 6\.1 LO/);
    assert.ok(!screen.includes('last 1 lines'), 'no preview below 110 columns');
    for (const l of screen.split('\n')) assert.ok([...l].length <= 80, `too wide (${[...l].length}): ${l}`);
    keys.write('q');
    await done;
  });

  it('SNAP0247: a narrow board shows disk and the stale watch restart guidance', async () => {
    const { term, keys, done } = setup('watch-warning', 80, '', 121_000);
    try {
      await until(() => term.screen().includes('NC-1'));
      assert.match(term.screen(), /Disk: .*free /);
      assert.match(term.screen(), /watch nie odpowiada od 2 min – agentctl watch --tmux --restart/);
    } finally { keys.write('q'); await done; }
  });

  it('at 120 columns the preview of the selected window is next to the list', async () => {
    const { term, keys, done } = setup('rd2', 120);
    await until(() => term.screen().includes('NC-1 · last'));
    assert.match(term.screen(), /● Reading src\/menu\.ts/);
    assert.ok(!term.screen().includes('esc to interrupt'), 'footer lines are not in the preview');
    keys.write('q');
    await done;
  });

  it('keys reach the model: ? opens the help, m opens the message field', async () => {
    const { term, keys, done } = setup('rd3', 100);
    await until(() => term.screen().includes('NC-1'));
    await wait(100);
    keys.write('?');
    await until(() => term.frames.some((f) => f.includes('Press any other key')));
    keys.write('\u001b[6~'); // page down twice: help is bounded at 24 rows
    await wait(50);
    keys.write('\u001b[6~');
    await until(() => term.frames.some((f) => f.includes('leave the board')));
    keys.write('x'); // any key closes the help
    await wait(100);
    keys.write('m');
    await until(() => term.frames.some((f) => f.includes('Message to NC-1')));
    keys.write('\u001b'); // Esc
    await wait(100);
    keys.write('q');
    await done;
  });

  it('l shows the log of the tasks (the history), Esc comes back to the list', async () => {
    const { term, keys, done } = setup('rd4', 100);
    await until(() => term.screen().includes('NC-1'));
    await wait(100);
    keys.write('l');
    await until(() => term.frames.some((f) => f.includes('Log –')));
    assert.ok(term.frames.some((f) => f.includes('No history yet')));
    keys.write('\u001b');
    await wait(150);
    keys.write('q');
    await done;
  });
  it('at 160 columns compact models, 20-character IDs and full preview/help facts survive NO_COLOR', async () => {
    const previous = process.env.NO_COLOR; process.env.NO_COLOR = '1';
    const { config, term, keys, done, tmux } = (() => {
      const result = setup('wide-model', 160, 'board: {model_versions: {opus: "5.5"}}\n');
      return { ...result, config: result.ctx.config };
    })();
    try {
      seedTask(config, 'NEON-BACKEND-TASK-12', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
      tmux.add('neon-backend-task-12', 'Working (esc to interrupt)\n');
      keys.write('r');
      await until(() => /NEON-BACKEND-TASK-12\s+cx S 6\.1 XH/.test(term.screen()), 6000);
      assert.match(term.screen(), /cl O 5\.5 HI/);
      assert.match(term.screen(), /TASK\s+AGENT\s+STATE\s+TIME\s+TOKENS\s+PROGRESS\s+REPORT/);
      assert.match(term.screen(), /model: opus.*effort: high/);
      keys.write('?');
      await until(() => term.frames.some(f => f.includes('model: opus') && f.includes('MN minimal')));
      assert.ok(!term.frames.some(f => /\u001b\[(?:3[0-7]|9[0-7]|38);?/.test(f)), 'NO_COLOR has no foreground color escape');
    } finally {
      keys.write('q');
      // Any key leaves help; send q again to leave the list.
      await wait(100); keys.write('q'); await done;
      if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous;
    }
  });

});
