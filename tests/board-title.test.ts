import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, type TestContext } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import { boardTitle, titleEnd, titleStart, tmuxTitleString } from '../src/core/title.ts';
import { packageVersion } from '../src/core/version.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

class Terminal extends EventEmitter {
  columns = 100;
  rows = 24;
  isTTY = true;
  frames: string[] = [];
  write(chunk: string, ...rest: unknown[]): boolean {
    this.frames.push(String(chunk));
    this.emit('frame', chunk);
    (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
    return true;
  }
}

class Keyboard extends PassThrough {
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

async function run(t: TestContext, name: string, yaml: string, insideTmux: boolean, instance: string | null = 'agentctl', signal = t.signal) {
  const config = makeConfig(scratch.sub(name), `${instance === null ? '' : `ui: {instance_name: ${instance}}\n`}${yaml}`);
  seedTask(config, 'NC-1', { repos: [] });
  const tmux = new FakeTmux();
  tmux.add('nc-1', '● Reading\n  esc to interrupt\n');
  const made = makeContext(config, { respond: tmux.respond });
  const term = new Terminal();
  const keys = new Keyboard();
  const drewTask = new Promise<void>(resolve => {
    const observe = (frame: string) => {
      if (!frame.includes('NC-1')) return;
      term.off('frame', observe);
      resolve();
    };
    term.on('frame', observe);
  });
  const done = runBoardApp(made.ctx, insideTmux, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream, signal });
  await Promise.race([drewTask, done.then(() => { throw new Error('the board exited before drawing the task'); })]);
  return { term, keys, done, runner: made.runner };
}

describe('board: the version in the header and the window title', { timeout: 120_000 }, () => {
  const version = packageVersion();

  it('the version is the one of package.json', () => {
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.equal(boardTitle('1.2.3'), 'agentctl 1.2.3 · board');
    assert.equal(tmuxTitleString('1.2.3'), 'agentctl 1.2.3 · #W');
  });

  it('the header names the version', async t => {
    const { term, keys, done } = await run(t, 't1', '', false);
    // eslint-disable-next-line no-control-regex
    const screen = term.frames.join('').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    assert.ok(screen.includes(`agentctl ${version} board · `), screen.slice(0, 400));
    keys.write('q');
    await done;
  });

  it('an isolated dev home labels both the header and terminal title', async t => {
    const { term, keys, done } = await run(t, 'dev-label', '', false, null);
    assert.ok(term.frames.some(frame => frame.includes(`agentctl-dev ${version} board`)));
    assert.equal(term.frames[0], titleStart(version, 'agentctl-dev'));
    keys.write('q'); await done;
  });

  it('OSC 2 sets the title at start and the saved title comes back when the board ends', async t => {
    const { term, keys, done } = await run(t, 't2', '', false);
    assert.equal(term.frames[0], titleStart(version));
    assert.ok(term.frames[0]?.includes(`\u001b]2;agentctl ${version} · board\u0007`));
    assert.ok(term.frames[0]?.startsWith('\u001b[22;0t'), 'the old title is saved first');
    keys.write('q');
    await done;
    assert.equal(term.frames.at(-1), titleEnd());
  });

  it('inside tmux the titles of the outer terminal are set for the agentctl session only', async t => {
    const { keys, done, runner } = await run(t, 't3', '', true);
    keys.write('q');
    await done;
    const sets = runner.commands.filter((c) => c.includes('set-option')).map((c) => c.replace(/^tmux /, '').replaceAll("'", ''));
    assert.deepEqual(sets, ['set-option -t =agentctl: status-left agentctl ', 'set-option -t =agentctl: status-left-length 20', 'set-option -t =agentctl: set-titles on', `set-option -t =agentctl: set-titles-string agentctl ${version} · #W`, 'set-option -u -t =agentctl: set-titles-string', 'set-option -u -t =agentctl: set-titles']);
    assert.ok(!runner.commands.some((c) => /\s-g\b/.test(c)), 'no global option');
  });

  it('board.window_title: false writes no title and sets no tmux option', async t => {
    const { term, keys, done, runner } = await run(t, 't4', 'board:\n  window_title: false\n', true);
    keys.write('q');
    await done;
    const all = term.frames.join('');
    assert.ok(!all.includes('\u001b]2;') && !all.includes('\u001b[22;0t') && !all.includes('\u001b[23;0t'));
    assert.ok(!runner.commands.some((c) => c.includes('set-titles')));
  });

  it('outside tmux no tmux option is set', async t => {
    const { keys, done, runner } = await run(t, 't5', '', false);
    keys.write('q');
    await done;
    assert.ok(!runner.commands.some((c) => c.includes('set-titles')));
  });

  it('cancellation unmounts the board and restores the previous title', async t => {
    const controller = new AbortController();
    const { term, done } = await run(t, 'cancel', '', false, 'agentctl', AbortSignal.any([t.signal, controller.signal]));
    controller.abort();
    await done;
    assert.equal(term.frames.at(-1), titleEnd());
  });
});
