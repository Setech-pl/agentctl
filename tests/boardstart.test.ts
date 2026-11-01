import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { appendStartLog, describeTerminal, loggedRun, MIN_BOARD_LIFETIME_MS, startLogPath, waitForSize } from '../src/core/boardstart.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { ensureWindow } from '../src/core/windows.ts';
import { FakeTmux, makeConfig, makeContext, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();

describe('board start: waiting for a terminal size', () => {
  it('waits while the window reports 0x0 (no client attached yet) and returns the first real size', async () => {
    const stream = { columns: 0, rows: 0 };
    let clock = 0;
    const sleeps: number[] = [];
    const size = await waitForSize(stream, {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
        if (sleeps.length === 3) Object.assign(stream, { columns: 120, rows: 40 });
      },
    });
    assert.deepEqual(size, { columns: 120, rows: 40, waitedMs: 600 });
    assert.equal(sleeps.length, 3);
  });

  it('a size that is there at once costs no waiting; a missing columns or rows counts as no size', async () => {
    assert.deepEqual(await waitForSize({ columns: 80, rows: 24 }), { columns: 80, rows: 24, waitedMs: 0 });
    let clock = 0;
    await assert.rejects(
      waitForSize({ columns: 80, rows: undefined }, { timeoutMs: 1000, now: () => clock, sleep: async (ms) => void (clock += ms) }),
      (e: Error & { hint?: string }) => {
        assert.match(e.message, /reported no size \(80x0\) for 1 s/);
        assert.match(e.hint ?? '', /tmux attach/);
        return true;
      },
    );
  });
});

describe('board start: the log', () => {
  it('logs start and end, and a run that ends within the first moments is reported', async () => {
    const file = startLogPath(makeConfig(scratch.sub('l1')), 'board');
    assert.match(file, /home\/board\.log$/);
    let clock = Date.UTC(2026, 10, 1, 12, 0, 0);
    const fast = await loggedRun(file, 'board', async () => void (clock += 40), { now: () => clock, startNote: 'size=0x0' });
    assert.match(fast ?? '', /board ended after 40 ms without an error \(see .*board\.log\)/);
    const slow = await loggedRun(file, 'board', async () => void (clock += 60_000), { now: () => clock });
    assert.equal(slow, undefined);
    const log = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    assert.equal(log.length, 4);
    assert.match(log[0] ?? '', /^2026-11-01T12:00:00\.000Z {2}board start pid=\d+ size=0x0$/);
    assert.match(log[1] ?? '', /board ended after 40 ms/);
    assert.match(log[3] ?? '', /board ended after 60000 ms/);
    assert.ok(MIN_BOARD_LIFETIME_MS > 0);
  });

  it('an exception is logged with its stack and thrown on, so the window shows it', async () => {
    const file = startLogPath(makeConfig(scratch.sub('l2')), 'board');
    await assert.rejects(loggedRun(file, 'board', async () => { throw new Error('Raw mode is not supported'); }), /Raw mode is not supported/);
    assert.match(fs.readFileSync(file, 'utf8'), /board failed after \d+ ms: Error: Raw mode is not supported\n\s+at /);
  });

  it('a log that cannot be written does not stop the board', () => {
    appendStartLog('/proc/nope/board.log', 'x');
  });

  it('describes the terminal, with the CI variable that makes Ink draw nothing', () => {
    assert.equal(describeTerminal({ TERM: 'xterm-256color' }, { isTTY: true, columns: 80, rows: 24 }, { isTTY: true }), 'stdin.isTTY=true stdout.isTTY=true size=80x24 TERM=xterm-256color');
    assert.match(describeTerminal({ CI: '1', TMUX: '/x' }, { isTTY: true }, { isTTY: true }), /size=0x0 TERM= CI=1 \(Ink would draw nothing unless forced interactive\) inside tmux/);
  });
});

describe('board start: the CLI', () => {
  it('a board that throws exits 1 with the error on stderr (the window keeps it) and in board.log', async () => {
    const config = makeConfig(scratch.sub('c1'));
    const r = await runCli(config, new RecordingRunner({ dryRun: false }), ['board'], { runBoard: async () => { throw new Error('boom in render'); } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /boom in render/);
    assert.match(fs.readFileSync(startLogPath(config, 'board'), 'utf8'), /board failed .*boom in render/);
  });

  it('a board that just ends at once says so and exits 1; after a normal run it exits 0', async () => {
    const config = makeConfig(scratch.sub('c2'));
    const runner = new RecordingRunner({ dryRun: false });
    const quick = await runCli(config, runner, ['board'], { runBoard: async () => {} });
    assert.equal(quick.code, 1);
    assert.match(quick.stderr, /board ended after \d+ ms without an error/);
    let waited = 0;
    const ok = await runCli(config, runner, ['board'], { runBoard: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); waited++; }, minBoardLifetimeMs: 10 });
    assert.deepEqual([ok.code, waited], [0, 1]);
  });
});

describe('board start: the tmux commands', () => {
  const sh = (c: string): string => c.replaceAll("'", '');

  it('creates the window running the command, with remain-on-exit set in the same tmux call, and types nothing', async () => {
    const config = makeConfig(scratch.sub('t1'));
    const tmux = new FakeTmux();
    tmux.add('first');
    const { ctx, runner } = makeContext(config, { respond: tmux.respond });
    assert.equal(await ensureWindow(ctx, 'board', 'AGENTCTL_HOME=/h node /x/agentctl.ts board', '/work'), 'created');
    const create = runner.commands.find((c) => c.includes('new-window'));
    assert.equal(sh(create ?? ''), 'tmux new-window -d -t =agentctl: -n board -c /work AGENTCTL_HOME=/h node /x/agentctl.ts board ; set-option -w -t =agentctl:board remain-on-exit failed');
    assert.ok(!runner.commands.some((c) => c.startsWith('tmux send-keys')));
  });

  it('creates the session with the board as its first window when no session is up', async () => {
    const config = makeConfig(scratch.sub('t2'));
    const { ctx, runner } = makeContext(config, { respond: new FakeTmux().respond });
    assert.equal(await ensureWindow(ctx, 'board', 'agentctl board', '/work'), 'session-created');
    assert.equal(sh(runner.commands[0] ?? ''), 'tmux new-session -d -s agentctl -n board -c /work agentctl board ; set-option -w -t =agentctl:board remain-on-exit failed');
  });

  it('a window that exists is left alone; one whose process ended (kept by remain-on-exit) is started again in place', async () => {
    const config = makeConfig(scratch.sub('t3'));
    const tmux = new FakeTmux();
    tmux.add('board');
    let dead = false;
    const respond = (cmd: string, args: string[], opts: ExecOptions) => (cmd === 'tmux' && args[0] === 'display-message' ? { stdout: dead ? '1\n' : '0\n' } : tmux.respond(cmd, args, opts));
    const { ctx, runner } = makeContext(config, { respond });
    assert.equal(await ensureWindow(ctx, 'board', 'agentctl board', '/work'), 'exists');
    assert.ok(!runner.commands.some((c) => c.includes('respawn')));
    dead = true;
    assert.equal(await ensureWindow(ctx, 'board', 'agentctl board', '/work'), 'restarted');
    assert.equal(sh(runner.commands.at(-1) ?? ''), 'tmux respawn-pane -k -t @1 -c /work agentctl board');
  });

  it('on a tmux without remain-on-exit "failed" it falls back to "on"', async () => {
    const config = makeConfig(scratch.sub('t4'));
    const tmux = new FakeTmux();
    tmux.add('first');
    const respond = (cmd: string, args: string[], opts: ExecOptions) =>
      cmd === 'tmux' && args.includes('failed') ? { code: 1, stderr: 'invalid value: remain-on-exit failed' } : tmux.respond(cmd, args, opts);
    const { ctx, runner } = makeContext(config, { respond });
    assert.equal(await ensureWindow(ctx, 'board', 'agentctl board', '/work'), 'created');
    assert.equal(sh(runner.commands.at(-1) ?? ''), 'tmux set-option -w -t =agentctl:board remain-on-exit on');
  });

  it('a tmux that refuses to create the window is an error, not a silent success', async () => {
    const config = makeConfig(scratch.sub('t5'));
    const { ctx } = makeContext(config, { respond: (cmd, args) => (cmd === 'tmux' ? (args[0] === 'new-session' ? { code: 1, stderr: 'no server' } : args[0] === 'has-session' ? { code: 1 } : undefined) : undefined) });
    await assert.rejects(ensureWindow(ctx, 'board', 'agentctl board', '/work'), /could not start window "board": no server/);
  });
});
