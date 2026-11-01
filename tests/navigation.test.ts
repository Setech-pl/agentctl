import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyNavigation, describeNavigation, navigationHint, returnKeyCondition } from '../src/core/navigation.ts';
import { runBoardEffect } from '../src/core/board.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { FakeTmux, makeConfig, makeContext, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();

function withSession(name: string, yaml = '', binding = '') {
  const config = makeConfig(scratch.sub(name), yaml);
  const tmux = new FakeTmux();
  tmux.add('nc-1');
  const respond = (cmd: string, args: string[], opts: ExecOptions) => (cmd === 'tmux' && args[0] === 'list-keys' ? (binding ? { stdout: `${binding}\n` } : { code: 1, stderr: `unknown key: ${args.at(-1)}` }) : tmux.respond(cmd, args, opts));
  return { config, ...makeContext(config, { respond }) };
}

describe('navigation: config', () => {
  it('mouse on and F12 by default; both can be changed or switched off', () => {
    const d = makeConfig(scratch.sub('c1')).board;
    assert.deepEqual([d.mouse, d.returnKey], [true, 'F12']);
    const c = makeConfig(scratch.sub('c2'), 'board: {mouse: false, return_key: M-b}\n').board;
    assert.deepEqual([c.mouse, c.returnKey], [false, 'M-b']);
    assert.equal(makeConfig(scratch.sub('c3'), 'board: {return_key: false}\n').board.returnKey, null);
    assert.throws(() => makeConfig(scratch.sub('c4'), 'board: {return_key: "F12; run-shell x"}\n'), /return_key must be a tmux key name/);
    assert.throws(() => makeConfig(scratch.sub('c5'), 'board: {mouse: sometimes}\n'), /board\.mouse must be true or false/);
  });
});

describe('navigation: the tmux session', () => {
  it('sets mouse for this session only and binds the key conditionally, so other sessions keep it', async () => {
    const { ctx, runner } = withSession('n1');
    const result = await applyNavigation(ctx);
    assert.deepEqual(result, { session: true, mouse: 'on', key: { name: 'F12', state: 'bound' } });
    const cmds = runner.commands.filter((c) => /set-option|bind-key/.test(c));
    assert.deepEqual(cmds, [
      "tmux set-option -t '=agentctl:' mouse on",
      `tmux bind-key -n F12 if-shell -F '${returnKeyCondition('agentctl')}' 'select-window -t '\\''=agentctl:board'\\''' 'send-keys F12'`,
    ]);
    assert.ok(!cmds.some((c) => /\s-g\s/.test(c)), 'nothing global');
  });

  it('leaves a key alone that something else is bound to; runs again over its own binding', async () => {
    const taken = withSession('n2', '', 'bind-key  -T root F12 display-message hello');
    assert.deepEqual(((await applyNavigation(taken.ctx)) as { key: unknown }).key, { name: 'F12', state: 'taken' });
    assert.ok(!taken.runner.commands.some((c) => c.includes('bind-key')));
    const own = withSession('n3', '', `bind-key  -T root F12 if-shell -F "${returnKeyCondition('agentctl')}" "select-window -t '=agentctl:board'" "send-keys F12"`);
    assert.deepEqual(((await applyNavigation(own.ctx)) as { key: unknown }).key, { name: 'F12', state: 'bound' });
    assert.ok(own.runner.commands.some((c) => c.includes('bind-key')));
  });

  it('board.mouse: false and board.return_key: false touch nothing', async () => {
    const { ctx, runner } = withSession('n4', 'board: {mouse: false, return_key: false}\n');
    assert.deepEqual(await applyNavigation(ctx), { session: true, mouse: 'left-alone', key: null });
    assert.ok(!runner.commands.some((c) => /set-option|bind-key/.test(c)));
  });

  it('does nothing while the session is not running', async () => {
    const config = makeConfig(scratch.sub('n5'));
    const { ctx, runner } = makeContext(config, { respond: new FakeTmux().respond });
    assert.deepEqual(await applyNavigation(ctx), { session: false });
    assert.deepEqual(runner.commands, []);
  });

  it('reports a tmux that refuses', async () => {
    const config = makeConfig(scratch.sub('n6'));
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const { ctx } = makeContext(config, { respond: (cmd, args, opts) => (cmd === 'tmux' && (args[0] === 'set-option' || args[0] === 'bind-key') ? { code: 1, stderr: 'nope' } : cmd === 'tmux' && args[0] === 'list-keys' ? { code: 1 } : tmux.respond(cmd, args, opts)) });
    const result = await applyNavigation(ctx);
    assert.deepEqual(result, { session: true, mouse: { failed: 'nope' }, key: { name: 'F12', state: { failed: 'nope' } } });
    assert.match(describeNavigation(result, 'agentctl').join('\n'), /Mouse not set – nope[\s\S]*F12 not bound – nope/);
  });
});

describe('navigation: what is said', () => {
  it('the CLI explains the mouse (fn to select text) and the key; every new run says only problems', async () => {
    const { ctx } = withSession('s1');
    const result = await applyNavigation(ctx);
    const text = describeNavigation(result, 'agentctl').join('\n');
    assert.match(text, /Mouse on in session agentctl only: click a window name in the status bar\. To select text hold fn \(Terminal\.app\)/);
    assert.match(text, /F12 goes back to the board from any window of session agentctl \(other sessions keep F12 for their programs\)/);
    assert.deepEqual(describeNavigation(result, 'agentctl', true), []);
    assert.match(describeNavigation({ session: true, mouse: 'on', key: { name: 'F12', state: 'taken' } }, 'agentctl', true).join('\n'), /F12 is already bound to something else in tmux, left alone/);
  });

  it('board --tmux prints it, after starting the window', async () => {
    const config = makeConfig(scratch.sub('s2'));
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args, opts) => (cmd === 'tmux' && args[0] === 'list-keys' ? { code: 1 } : tmux.respond(cmd, args, opts)) });
    const r = await runCli(config, runner, ['board', '--tmux']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Started the board[\s\S]*Mouse on in session agentctl[\s\S]*F12 goes back to the board/);
    assert.ok(runner.commands.some((c) => c.includes('bind-key -n F12')));
  });

  it('the footer of the board and the notice after Enter name the key', async () => {
    assert.equal(navigationHint('F12'), 'Enter – open the agent · F12 – back to the list');
    assert.equal(navigationHint(null), 'Enter – open the agent · Ctrl-b l – back to the list');
    const config = makeConfig(scratch.sub('s3'));
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const notice = await runBoardEffect(runner, config, { type: 'switch', task: 'NC-1', window: 'nc-1' }, { insideTmux: true });
    assert.match(notice.text, /Back to the board: F12/);
  });
});
