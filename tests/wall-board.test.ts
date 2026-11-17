import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import { handleKey, HELP_LINES, initialBoardState, KEY_HINTS } from '../src/core/board.ts';
import type { BoardState } from '../src/core/board.ts';
import { WALL_BADGE_REFRESH_MS, wallBadgeDue, wallMessages, wallView } from '../src/core/board-wall.ts';
import { Context } from '../src/core/context.ts';
import { isRead, loadWallBoard, OWNER_IDENTITY, postMessage, readOwnerState, wallIdentity } from '../src/core/wall.ts';
import { DiskRunner, FakeTmux, makeConfig, makeContext, useScratch } from './helpers.ts';

/* WALL-1: the WALL view of the board (W). The model is pure (handleKey/wallView); the Ink front is driven with a fake terminal. */
const scratch = useScratch();

async function seeded(name: string) {
  const config = makeConfig(scratch.sub(name));
  const ctx = new Context(new DiskRunner({ dryRun: false }), config, () => {});
  const nc = wallIdentity(config, { as: 'chat:nc' });
  const hems = wallIdentity(config, { as: 'chat:hems' });
  await postMessage(ctx, OWNER_IDENTITY, { channel: 'agentctl', kind: 'info', subject: 'agentctl 0.21.0-dev: WALL', body: 'Read the guide.' });
  const q = await postMessage(ctx, nc, { channel: 'shared:sim', kind: 'decision-request', subject: 'Building heights v2?', body: 'Towers 120 m, helipads on top.', refs: ['~/Projects/cache/nc/heights.md'] });
  await postMessage(ctx, hems, { channel: 'shared:sim', kind: 'answer', subject: 'Re: heights', body: 'HEMS agrees.', replyTo: q.id });
  await postMessage(ctx, hems, { channel: 'shared:sim', kind: 'info', subject: 'helipad layer published', body: '' });
  return { config, ctx };
}

const key = (state: BoardState, input: string, k: Parameters<typeof handleKey>[2] = {}) => handleKey(state, input, k);

describe('WALL view: the model', () => {
  it('W opens the channels, Enter the messages (newest first), Enter one message; filters and read marks are effects; Esc goes back', async () => {
    const { config, ctx } = await seeded('model');
    let r = key(initialBoardState(120, 30), 'W');
    assert.equal(r.state.mode.kind, 'wall');
    assert.deepEqual(r.effects, [{ type: 'wall-load' }]);
    let state: BoardState = { ...r.state, wall: loadWallBoard(config, ctx.runner.now()) };
    const channels = wallView(state, state.mode as never);
    assert.match(channels.title, /the owner reads every channel/);
    assert.deepEqual(channels.lines.map((l) => l.text.split(/\s+/)[0]), ['agentctl', 'hems', 'nc', 'shared:maps', 'shared:sim', 'shared:weather']);
    assert.match(channels.lines[4]!.text, /^shared:sim\s+3 unread\s+1 open\s+3 msg/);
    r = key(state, '', { downArrow: true }); r = key(r.state, 'j'); r = key(r.state, 'j'); r = key(r.state, 'j');
    r = key(r.state, '', { return: true });
    state = r.state;
    const mode = state.mode as Extract<BoardState['mode'], { kind: 'wall' }>;
    assert.equal(mode.level, 'messages');
    assert.deepEqual(wallMessages(state, mode).map((m) => m.id), ['shared:sim-3', 'shared:sim-2', 'shared:sim-1']);
    const list = wallView(state, mode);
    assert.match(list.lines[2]!.text, /^● .*chat:nc\s+decision-request\s+open\s+Building heights v2\?/);
    assert.equal(list.lines[2]!.color, 'yellow', 'an open decision stands out');
    // Filters: s cycles the status, t the kind.
    r = key(state, 's');
    assert.deepEqual(wallMessages(r.state, r.state.mode as never).map((m) => m.id), ['shared:sim-1'], 'status=open');
    r = key(r.state, 's');
    assert.deepEqual(wallMessages(r.state, r.state.mode as never).map((m) => m.id), ['shared:sim-3', 'shared:sim-2'], 'status=answered');
    for (let i = 0; i < 5; i++) r = key(r.state, 's');
    r = key(r.state, 't');
    assert.deepEqual(wallMessages(r.state, r.state.mode as never).map((m) => m.id), ['shared:sim-3'], 'status cycled back to all; kind=info');
    // Enter on the decision: its lines are loaded and it is marked read.
    r = key(key(state, 'j').state, 'j');
    r = key(r.state, '', { return: true });
    assert.deepEqual(r.effects, [{ type: 'wall-message', id: 'shared:sim-1' }, { type: 'wall-read', channel: 'shared:sim', ids: ['shared:sim-1'] }]);
    assert.equal((r.state.mode as { level: string }).level, 'message');
    r = key(r.state, '', { escape: true });
    assert.equal((r.state.mode as { level: string }).level, 'messages');
    assert.deepEqual(key(r.state, 'R').effects, [{ type: 'wall-read', channel: 'shared:sim', all: true }]);
    r = key(r.state, '', { escape: true });
    assert.equal((r.state.mode as { level: string }).level, 'channels');
    r = key(r.state, '', { escape: true });
    assert.equal(r.state.mode.kind, 'list');
    assert.ok(KEY_HINTS.length <= 80 && KEY_HINTS.includes(' W '));
    assert.ok(HELP_LINES.some((l) => l.startsWith('  W ') && l.includes('WALL')));
  });
});

/** A terminal that is a TTY of a given size and keeps what is written to it. */
class FakeTerminal extends EventEmitter {
  isTTY = true;
  frames: string[] = [];
  columns: number;
  rows: number;
  constructor(columns: number, rows: number) { super(); this.columns = columns; this.rows = rows; }
  write(chunk: string, ...rest: unknown[]): boolean {
    this.frames.push(String(chunk));
    (rest.find((r) => typeof r === 'function') as (() => void) | undefined)?.();
    return true;
  }
  // eslint-disable-next-line no-control-regex
  last(): string { return ([...this.frames].reverse().find((f) => f.length > 80) ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''); }
  seen(text: string): boolean { return this.frames.some((f) => f.includes(text)); }
}
class FakeKeyboard extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let screen = (): string => '';
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error(`timed out waiting for the screen:\n${screen()}`); await wait(25); }
}

describe('WALL view: the Ink front', () => {
  it('renders the channels, a channel and one message with its thread, and stores the owner\'s read mark', async () => {
    const { config } = await seeded('ink');
    const made = makeContext(config, { respond: new FakeTmux().respond });
    const term = new FakeTerminal(120, 30);
    const keys = new FakeKeyboard();
    screen = () => term.last();
    const done = runBoardApp(made.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    try {
    await until(() => term.seen('TASK'));
    await wait(100);
    keys.write('W');
    await until(() => term.seen('WALL – channels'));
    await until(() => term.seen('shared:sim'));
    for (let i = 0; i < 4; i++) { keys.write('j'); await wait(30); }
    keys.write('\r');
    await until(() => term.seen('Building heights v2?'));
    keys.write('j'); await wait(30); keys.write('j'); await wait(30);
    keys.write('\r');
    await until(() => term.seen('Towers 120 m, helipads on top.'));
    await until(() => term.seen('HEMS agrees.'));
    assert.ok(term.seen('refs: '), 'the refs are shown');
    await until(() => isRead(readOwnerState(config), { channel: 'shared:sim', seq: 1 }) && !isRead(readOwnerState(config), { channel: 'shared:sim', seq: 2 }));
    keys.write('\u001b'); await wait(80);
    keys.write('\u001b'); await wait(80);
    keys.write('\u001b'); await wait(80);
    await until(() => term.seen('WALL 3 unread (W)'), 2000);
    } finally {
      // Out of any WALL level first: q there goes back, it does not leave the board.
      for (let i = 0; i < 3; i++) { keys.write('\u001b'); await wait(60); }
      keys.write('q');
      await done;
    }
  });
});

describe('WALL-2: the header count without opening W', () => {
  it('the background read is due at once, then at most every WALL_BADGE_REFRESH_MS', () => {
    assert.equal(wallBadgeDue(null, 0), true);
    assert.equal(wallBadgeDue(1_000, 1_000 + WALL_BADGE_REFRESH_MS - 1), false);
    assert.equal(wallBadgeDue(1_000, 1_000 + WALL_BADGE_REFRESH_MS), true);
  });

  it('the board header shows the unread WALL count from the start, before W was ever pressed', async () => {
    const { config } = await seeded('badge');
    const made = makeContext(config, { respond: new FakeTmux().respond });
    const term = new FakeTerminal(120, 30);
    const keys = new FakeKeyboard();
    screen = () => term.last();
    const done = runBoardApp(made.ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream });
    try {
      await until(() => term.seen('WALL 4 unread (W)'));
      assert.ok(!term.seen('WALL – channels'), 'the view itself was never opened');
    } finally {
      keys.write('q');
      await done;
    }
  });
});
