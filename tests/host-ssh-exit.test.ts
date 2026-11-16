import fs from 'node:fs';
import path from 'node:path';
import { DiskRunner, useScratch } from './helpers.ts';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runOnHost } from '../src/core/host-ssh.ts';
import { RecordingRunner } from '../src/core/runner.ts';

it('HOST-SSH-EXIT: nonzero command status is reachable; only SSH errors/timeouts lose the host', async () => {
  const host = { ssh: 'owner@fake', port: 22, workDir: '/work', repos: {}, providers: ['claude' as const] };
  for (const code of [0, 1, 2, 127]) {
    const runner = new RecordingRunner({ respond: () => ({ code, stderr: code ? 'remote command failed' : '' }) });
    const result = await runOnHost(runner, 'pc', host, 'test -e /missing');
    assert.equal(result.state, 'reachable', `command exit ${code}`);
    assert.equal(result.code, code);
  }
  for (const failure of [{ code: 255, stderr: 'Connection refused' }, { code: 1, stderr: 'ETIMEDOUT after 20000ms' }]) {
    const runner = new RecordingRunner({ respond: () => failure });
    assert.equal((await runOnHost(runner, 'pc', host, 'true')).state, 'unreachable');
  }
});

const scratch = useScratch();
it('HOST-SSH-COLD: the first health/transport call creates its ControlMaster directory before SSH', async () => {
  const home = path.join(scratch.dir, 'fresh-home');
  const runner = new DiskRunner({dryRun: false, respond: (cmd, args) => {
    if (cmd !== 'ssh') return undefined;
    const socket = args[args.indexOf('-S') + 1]!;
    return fs.existsSync(path.dirname(socket)) ? {code: 0, stdout: 'ready'} : {code: 255, stderr: 'unix_listener: No such file or directory'};
  }});
  const host = {ssh: 'owner@fake', port: 2222, workDir: '/work', repos: {}, providers: ['claude' as const]};
  assert.equal((await runOnHost(runner, 'pc', host, 'true', 1000, {AGENTCTL_HOME: home})).state, 'reachable');
  assert.ok(fs.existsSync(path.join(home, 'ssh')));
});
