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
  function setup(name: string, columns: number) {
    const config = makeConfig(scratch.sub(name));
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
    await until(() => term.screen().includes('NC-2'));
    const screen = term.screen();
    assert.match(screen, /TASK\s+AGENT\s+STATE\s+TIME\s+PROGRESS\s+REPORT/);
    assert.match(screen, /NC-1\s+claude opus\/high\s+⚙ working/);
    assert.match(screen, /NC-2\s+codex gpt-6\.1-sol/);
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
});
