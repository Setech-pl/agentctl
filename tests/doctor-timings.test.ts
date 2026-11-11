import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { readQueue } from '../src/core/queue.ts';
import { DiskRunner, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('doctor --timings reports five wall times and thresholds without registering a task', async () => {
  const config = makeConfig(scratch.sub('doctor'));
  const repo = scratch.sub('doctor/repo');
  seedTask(config, 'DOCTOR-EXISTING', { closed: true, repos: [{ path: repo, worktree: repo }] });
  const runner = new DiskRunner({ dryRun: false, respond: cmd => cmd === 'tmux' ? { code: 1 } : {} });
  const before = fs.readdirSync(config.stateDir);
  const result = await runCli(config, runner, ['doctor', '--timings']);
  assert.equal(result.code, 0, result.stderr);
  for (const [name, budget] of [['status', 1500], ['queue list', 500], ['events', 2000], ['queue preview', 2000], ['close preview', 2000]]) assert.match(result.stdout, new RegExp(`PASS ${name}: [0-9.]+ ms.*${budget} ms`));
  for (const section of ['installation', 'disk/config', 'tools/providers', 'notifications/phone', 'MCP registrations/processes', 'task diagnostics', 'project/session', 'manager']) assert.ok(result.stdout.includes(`doctor ${section}`), section);
  assert.deepEqual(readQueue(config), []);
  assert.deepEqual(fs.readdirSync(config.stateDir), before);
});

it('doctor timing verdicts warn at the boundary and on errors, and continue the smoke', async () => {
  const { measureReadTimings } = await import('../src/core/doctor-timings.ts');
  let clock = 0;
  const rows = await measureReadTimings(async name => {
    clock += name === 'status' ? 1500 : 1;
    if (name === 'events') throw new Error('read failed');
  }, () => clock);
  assert.deepEqual(rows.map(r => r.result), ['WARN', 'PASS', 'WARN', 'PASS', 'PASS']);
  assert.equal(rows[2]!.error, 'read failed');
});
