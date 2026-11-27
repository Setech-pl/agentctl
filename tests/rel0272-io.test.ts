import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { HostRuntime } from '../src/core/host-runtime.ts';
import { RealRunner } from '../src/core/runner.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

it('REL0272-ASYNC-FSYNC: state writes and log appends of the runner never fsync on the event loop', async t => {
  const dir = scratch.sub('async-fsync');
  const fsyncSync = t.mock.method(fs, 'fsyncSync');
  const runner = new RealRunner();
  const file = path.join(dir, 'queue', '0001-TASK.json');
  await runner.writeFile(file, '{"status":"queued"}\n');
  await runner.writeFile(file, '{"status":"failed"}\n');
  await runner.appendFile(path.join(dir, 'agentctl-watch.log'), 'line 1\n');
  await runner.appendFile(path.join(dir, 'agentctl-watch.log'), 'line 2\n');
  await runner.copyFile(file, path.join(dir, 'copy.json'));
  assert.equal(fsyncSync.mock.callCount(), 0, 'a synchronous fsync blocks every watch stage (77 ms each on a loaded Linux host)');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"status":"failed"}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'agentctl-watch.log'), 'utf8'), 'line 1\nline 2\n');
  assert.equal(fs.readFileSync(path.join(dir, 'copy.json'), 'utf8'), '{"status":"failed"}\n');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'queue')).filter(name => name.endsWith('.tmp')), []);
});

it('REL0272-HOST-PERSIST: an unchanged host state is not rewritten on every window inventory', async () => {
  const config = makeConfig(scratch.sub('host-persist'));
  seedTask(config, 'REMOTE-GONE', { host: 'offline-fixture' });
  const runner = new DiskRunner({ dryRun: false });
  const hostFile = path.join(config.stateDir, 'hosts', 'offline-fixture.json');
  fs.mkdirSync(path.dirname(hostFile), { recursive: true }); // a tracked host directory, as after any remote start
  let writes = 0;
  const write = runner.writeFile.bind(runner);
  runner.writeFile = async (file: string, content: string) => { if (file === hostFile) writes++; return write(file, content); };
  const hosts = new HostRuntime(runner, config);
  for (let i = 0; i < 5; i++) assert.deepEqual(await hosts.windows(), []);
  assert.equal(writes, 1);
  assert.match(fs.readFileSync(hostFile, 'utf8'), /host removed from config/);
  // A new runtime (the next watch process) starts from the file and does not rewrite the same state either.
  const next = new HostRuntime(runner, config);
  await next.windows();
  assert.equal(writes, 1);
});
