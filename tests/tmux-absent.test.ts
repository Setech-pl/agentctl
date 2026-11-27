import assert from 'node:assert/strict';
import { it } from 'node:test';
import { RecordingRunner } from '../src/core/runner.ts';
import { Tmux } from '../src/core/tmux.ts';

// stderr as printed by tmux 3.4 (Ubuntu 24.04) and by other versions for a session-scoped list-panes whose session is gone.
const absent = [
  "can't find window: agentctl",
  'no current target',
  "can't find session: agentctl",
  'no server running on /tmp/tmux-1000/default',
];

it('REL0272-TMUX-ABSENT: a gone agentctl session is an empty pane inventory on every tmux version', async () => {
  for (const stderr of absent) {
    const runner = new RecordingRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1, stdout: '', stderr } : undefined });
    assert.deepEqual(await new Tmux(runner, 'agentctl').livePanes(), [], stderr);
  }
  const broken = new RecordingRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1, stdout: '', stderr: 'server exited unexpectedly' } : undefined });
  await assert.rejects(new Tmux(broken, 'agentctl').livePanes(), /Cannot verify tmux pane inventory: server exited unexpectedly/);
});
