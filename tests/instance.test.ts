import assert from 'node:assert/strict';
import path from 'node:path';
import { it } from 'node:test';
import { instanceName } from '../src/core/instance.ts';
import { beginTitle, titleStart, titleEnd, tmuxTitleString } from '../src/core/title.ts';
import { runWatch } from '../src/core/watch.ts';
import { FakeTmux, makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();
it('instance name shares doctor dev detection and supports an explicit override', () => {
  const home = scratch.dir, stable = path.join(home, 'stable.js');
  const prod = { path: path.join(home, '.agentctl/config.yaml') };
  const options = { home, env: {}, script: stable, stable };
  assert.equal(instanceName(prod, options), 'agentctl');
  assert.equal(instanceName({ path: path.join(home, '.agentctl-dev/config.yaml') }, options), 'agentctl-dev');
  assert.equal(instanceName(prod, { ...options, env: { AGENTCTL_HOME: path.join(home, 'dev-home') } }), 'agentctl-dev');
  assert.equal(instanceName(prod, { ...options, script: path.join(home, 'checkout.js') }), 'agentctl-dev');
  assert.equal(instanceName({ ...prod, ui: { instanceName: 'review' } }, options), 'review');
});
it('ui.instance_name validates plain text and title sequences save/set/restore in order', () => {
  const config = makeConfig(scratch.sub('override'), 'ui: {instance_name: staging}\n');
  assert.equal(instanceName(config), 'staging');
  assert.equal(titleStart('1.2.3', 'agentctl-dev', 'watch'), '\u001b[22;0t\u001b]2;agentctl-dev 1.2.3 · watch\u0007');
  assert.equal(titleEnd(), '\u001b[23;0t');
  assert.equal(tmuxTitleString('1.2.3', 'agentctl-dev'), 'agentctl-dev 1.2.3 · #W');
  assert.throws(() => makeConfig(scratch.sub('bad'), 'ui: {instance_name: "bad#(command)"}\n'), /instance_name/);
});
it('title scope restores prior tmux title settings before popping the saved title, once', async () => {
  const config = makeConfig(scratch.sub('restore'), 'ui: {instance_name: agentctl-dev}\n');
  const events: string[] = [];
  const { ctx } = makeContext(config, { respond: (_cmd, args) => {
    events.push(args.join(' '));
    if (args[0] === 'show-options') return { stdout: args.at(-1) === 'set-titles' ? 'off\n' : 'previous title\n' };
    return {};
  } });
  const restore = await beginTitle(ctx, { write: text => events.push(text) }, '1.2.3', 'board', true);
  await restore(); await restore();
  assert.equal(events[0], titleStart('1.2.3', 'agentctl-dev'));
  assert.deepEqual(events.slice(-3), ['set-option -t =agentctl: set-titles-string previous title', 'set-option -t =agentctl: set-titles off', titleEnd()]);
});
it('watch scopes its own terminal title and restores it on exit', async () => {
  const config = makeConfig(scratch.sub('watch-title'), 'ui: {instance_name: agentctl-dev}\n');
  const tmux = new FakeTmux(); tmux.add('watch');
  const { ctx } = makeContext(config, { respond: tmux.respond });
  const output: string[] = [];
  await runWatch(ctx, { notify: async () => undefined }, { maxTicks: 0, titleOutput: { write: text => output.push(text) }, insideTmux: false });
  assert.match(output[0]!, /^\u001b\[22;0t\u001b\]2;agentctl-dev .* · watch\u0007$/);
  assert.equal(output.at(-1), titleEnd());
});
