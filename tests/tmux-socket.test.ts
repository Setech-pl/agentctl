import { attachHint } from '../src/core/tmux-socket.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeConfig, makeContext, useScratch } from './helpers.ts';
import { runDoctor } from '../src/core/doctor.ts';
const scratch = useScratch();
test('dedicated socket scopes wrapper and direct tmux calls, including reload', async () => {
  const config = makeConfig(scratch.sub('socket'), 'tmux: {socket: agentctl-dev}\n');
  assert.equal(attachHint(config), "tmux -L agentctl-dev attach -t '=agentctl'");
  const seen: string[][] = [];
  const { ctx } = makeContext(config, { respond: (cmd, args) => {
    if (cmd === 'tmux') { seen.push(args); return { code: 0, stdout: '@1\ttask\ttask' }; }
    return undefined;
  } });
  await ctx.tmux.hasSession();
  await ctx.tmux.capture('task');
  await ctx.tmux.sendKey('task', 'Escape');
  await ctx.tmux.killWindow('task');
  await ctx.tmux.startWindow('watch', '.', 'true', true);
  await ctx.tmux.attachSession();
  await ctx.runner.exec('tmux', ['display-message', '-p']);
  assert.ok(seen.length >= 7);
  assert.ok(seen.every(args => args[0] === '-L' && args[1] === 'agentctl-dev'));
  ctx.setConfig(makeConfig(scratch.sub('default')));
  await ctx.tmux.hasSession();
  assert.equal(seen.at(-1)?.[0], 'has-session');
});
test('doctor names socket and detects global and session home contamination', async () => {
  const config = makeConfig(scratch.sub('doctor'), 'tmux: {socket: agentctl-dev}\n');
  const { runner } = makeContext(config, { respond: (cmd, args) => {
    if (cmd === 'tmux') {
      assert.deepEqual(args.slice(0, 2), ['-L', 'agentctl-dev']);
      if (args.includes('-V')) return { stdout: 'tmux 3.5' };
      if (args.includes('show-environment')) return { stdout: `AGENTCTL_HOME=/wrong-${args.includes('-g') ? 'global' : 'session'}` };
    }
    return { code: 1 };
  } });
  const checks = await runDoctor(runner, () => config, null, '26.0.0', process.platform, scratch.dir, { ...process.env, AGENTCTL_HOME: '/expected' });
  assert.ok(checks.some(c => c.name === 'tmux socket' && c.detail.includes('agentctl-dev')));
  assert.ok(checks.some(c => c.status === 'warn' && c.detail.includes('/wrong-global') && c.detail.includes('/wrong-session')));
});
