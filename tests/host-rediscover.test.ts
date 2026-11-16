import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Tmux } from '../src/core/tmux.ts';
import { RecordingRunner } from '../src/core/runner.ts';
it('HOST-REDISCOVER: recover a renamed remote window by task identity rather than stale tmux ID', async () => {
  const runner = new RecordingRunner({respond: () => ({code: 0, stdout: '@88\towner renamed\tr-1\n@1\tother window\tother-1\n'})});
  const tmux = new Tmux(runner, 'agentctl-pc', {taskRoles: true, idFor: () => '@1'});
  const windows = await tmux.windows();
  assert.equal(windows[0]!.plain, 'r-1');
  assert.equal(await tmux.targetFor('r-1', windows), '@88');
  const local = new Tmux(runner, 'agentctl');
  assert.equal((await local.windows())[0]!.plain, 'owner renamed', 'local role semantics stay unchanged');
});
