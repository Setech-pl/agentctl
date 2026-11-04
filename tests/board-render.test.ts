import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
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
  function setup(name: string, columns: number, yaml = '') {
    const config = makeConfig(scratch.sub(name), yaml);
    seedTask(config, 'NC-1', { repos: [] });
    seedTask(config, 'NC-2', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    const tmux = new FakeTmux();
    tmux.add('nc-1', '● Reading src/menu.ts\n  ⏵⏵ auto (shift+tab to cycle) · esc to interrupt\n');
    const made = makeContext(config, { respond: tmux.respond });
    const term = new FakeTerminal(columns, 24);
    const keys = new FakeKeyboard();
    const done = runBoardApp(made.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    return { ...made, tmux, term, keys, done };
  }

  it('at 80 columns it shows the list without the preview, each line within 80 columns, and q leaves', async () => {
    const { term, keys, done } = setup('rd1', 80);
    await until(() => term.screen().includes('Finished (1)'));
    let screen = term.screen();
    assert.match(screen, /TASK\s+AGENT\s+STATE\s+TIME\s+TOKENS\s+PROGRESS\s+REPORT/);
    assert.match(screen, /claude\s+n\/d/, 'the usage panel: no reading of the plan, so n/d');
    assert.match(screen, /codex\s+n\/d/);
    assert.match(screen, /NC-1\s+cl O HI\s+⚙ working/);
    assert.ok(!screen.includes('NC-2'), 'NC-2 has no window: it waits under the closed "Finished" title');
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
