import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { answerMenu, menuInFrame } from '../src/core/answer.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P63 (FACADE-S34-REVIEW, 2026-11-08 00:25): a `send` of "1" to a Kimi standing on the command-approval menu
 * ("Run this command? 1. Approve once …") went into the FIFO instead of answering the menu. The `answer` operation
 * (CLI + MCP, preview → confirm, its own mcp.allow entry) selects a numbered option of the menu in the current frame,
 * and status lists the options of a needs-input menu. The menu frame is the recorded screen-kimi-04-zgoda.txt — the
 * same approval menu (Kimi 2.5.x) the production window showed.
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const MENU = fx('screen-kimi-04-zgoda.txt');
const IDLE = fx('screen-kimi-02-bezczynny.txt');
const WORKING = fx('screen-kimi-03-praca-1.txt');

it('P63 menuInFrame reads the numbered menu of the current frame (not the prose lists above)', () => {
  const menu = menuInFrame(MENU)!;
  assert.deepEqual(menu.options.map((o) => `${o.n}. ${o.label}`), ['1. Approve once', '2. Approve for this session', '3. Reject', '4. Reject with feedback']);
  assert.equal(menu.options[0]!.selected, true);
  assert.equal(menu.options[1]!.selected, false);
  assert.match(menu.question ?? '', /Run this command\?/);
  assert.equal(menuInFrame(IDLE), undefined, 'an idle screen has no menu');
});

function fakeKimi(root: string, initial: string, extraYaml = '') {
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\n${extraYaml}`);
  let screen = initial;
  const keys: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: screen };
    if (args[0] === 'send-keys') { keys.push(args.at(-1)!); screen = WORKING; return {}; }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'kimi', model: 'k3', effort: 'high', windowId: '@1' });
  return { ctx, config, keys, runner, setScreen: (value: string) => { screen = value; } };
}

it('P63 preview names the options and sends no key; confirm with the token sends the digit', async () => {
  const { ctx, keys } = fakeKimi(scratch.sub('flow'), MENU);
  const preview = await answerMenu(ctx, 't1', 1);
  assert.equal(preview.outcome, 'ready');
  assert.deepEqual(preview.menu, ['1. Approve once', '2. Approve for this session', '3. Reject', '4. Reject with feedback']);
  assert.equal(preview.screenState, 'needs-input');
  assert.equal(keys.length, 0, 'a preview sends no key');
  const wrong = await answerMenu(ctx, 't1', 1, { token: '0000000000000000' });
  assert.equal(wrong.outcome, 'refused');
  assert.equal(keys.length, 0, 'a wrong token sends no key');
  const done = await answerMenu(ctx, 't1', 1, { token: preview.token! });
  assert.equal(done.outcome, 'answered');
  assert.deepEqual(keys, ['1']);
  assert.equal(readTaskRecord(ctx.config, 't1')!.task, 'T1');
});

it('P63 refuses: option out of range, no menu on screen, unknown state', async () => {
  const { ctx, keys } = fakeKimi(scratch.sub('refuse'), MENU);
  assert.equal((await answerMenu(ctx, 't1', 9)).outcome, 'refused');
  const { ctx: idle, keys: idleKeys } = fakeKimi(scratch.sub('refuse-idle'), IDLE);
  const denied = await answerMenu(idle, 't1', 1);
  assert.equal(denied.outcome, 'refused');
  assert.match(denied.message, /nie menu/);
  assert.equal(keys.length + idleKeys.length, 0);
});

it('P63 status lists the options of a needs-input menu', async () => {
  const { ctx } = fakeKimi(scratch.sub('status'), MENU);
  const rows = await collectStatus(ctx, { progress: false });
  const row = rows.find((r) => r.task === 'T1')!;
  assert.equal(row.state, 'needs-input');
  assert.deepEqual(row.menuOptions, ['1. Approve once', '2. Approve for this session', '3. Reject', '4. Reject with feedback']);
});

it('P63 MCP answer is a write tool of its own permission and honours preview → confirm', async () => {
  const tool = MCP_TOOLS.find((t) => t.name === 'answer')!;
  assert.equal(tool.kind, 'write');
  const { ctx, config, keys } = fakeKimi(scratch.sub('mcp'), MENU);
  const deps = { context: () => ctx, notify: async () => {} };
  const denied = await tool.run(deps as never, { task: 'T1', option: 1 } as never);
  assert.match(String((denied as { text?: string }).text ?? ''), /not in mcp\.allow/);
  assert.equal(keys.length, 0);
  config.mcp.allow.push('answer');
  const preview = await tool.run(deps as never, { task: 'T1', option: 1 } as never);
  const token = (preview as { data?: { token?: string } }).data?.token;
  assert.ok(token, 'preview carries a token');
  assert.equal(keys.length, 0);
  const done = await tool.run(deps as never, { task: 'T1', option: 1, confirm: true, token } as never);
  assert.deepEqual(keys, ['1']);
  assert.match(String((done as { text?: string }).text ?? ''), /Approve once/);
});

it('integration: a changed command, expired token and replay never send approval', async () => {
  const f = fakeKimi(scratch.sub('changed-command'), MENU);
  const preview = await answerMenu(f.ctx, 't1', 1);
  f.setScreen(MENU.replace('$ git status', '$ git diff'));
  assert.equal((await answerMenu(f.ctx, 't1', 1, { token: preview.token! })).outcome, 'refused');
  assert.equal(f.keys.length, 0);
  f.setScreen(MENU);
  const fresh = await answerMenu(f.ctx, 't1', 1);
  assert.equal((await answerMenu(f.ctx, 't1', 1, { token: fresh.token! })).keySent, true);
  f.setScreen(MENU);
  assert.equal((await answerMenu(f.ctx, 't1', 1, { token: fresh.token! })).outcome, 'refused');
  assert.deepEqual(f.keys, ['1']);
  const expiry = await answerMenu(f.ctx, 't1', 1);
  await f.runner.sleep((f.config.preview.ttlS + 1) * 1000);
  assert.equal((await answerMenu(f.ctx, 't1', 1, { token: expiry.token! })).outcome, 'refused');
  assert.deepEqual(f.keys, ['1']);
});
