import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli } from './helpers.ts';
import { gcFixture } from './field0253-gc-fixture.ts';

test('FIELD0253-CLI: dirty GC is scoped by task and the all switch requires confirmation', async () => {
  const {config, runner, gitCalls} = gcFixture('cli-gc', 2, true);
  const named = await runCli(config, runner, ['gc', '--force-dirty', 'GC-0', '--json', '--verbose']);
  assert.equal(named.code, 0, named.stderr);
  const plan = JSON.parse(named.stdout);
  assert.deepEqual(plan.worktrees.items.filter((w: {detail: string}) => !w.detail.includes('requires')).map((w: {task: string}) => w.task), ['GC-0']);
  assert.notEqual((await runCli(config, runner, ['gc', '--force-dirty'])).code, 0);
  let prompts = 0;
  let printed = '';
  const all = await runCli(config, runner, ['gc', '--apply', '--force-dirty-all', '--yes'], {
    stdout: text => { printed += text; },
    confirm: async () => { prompts++; assert.match(printed, /GC-0[^\n]*2 dirty files/); assert.match(printed, /GC-1[^\n]*2 dirty files/); return false; },
  });
  assert.equal(all.code, 0, all.stderr);
  assert.equal(prompts, 1);
  assert.ok(!gitCalls.some(args => args[3] === 'remove'));
});
