import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { collectDisk } from '../src/core/disk.ts';
import { MCP_TOOLS, publishDegradedMcpSnapshot, publishMcpSnapshot } from '../src/core/mcp-tools.ts';
import { WatchMemory, watchLogPath, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}

const diskStats = (free: number) => ({ bavail: free, blocks: 1000, bsize: 1024 ** 3 });
const snapshotFile = (ctx: Context) => path.join(ctx.config.stateDir, 'mcp-state-snapshot.json');

it('REL0272-COLD-SNAPSHOT: an initial scan failure does not publish a rowless replacement', () => {
  const config = makeConfig(scratch.sub('cold-degraded'));
  const ctx = new Context(new DiskRunner({dryRun: false}), config, () => {});
  publishDegradedMcpSnapshot(ctx, undefined, 'status collection');
  assert.equal(fs.existsSync(snapshotFile(ctx)), false);
});

it('REL0272-MAINTENANCE: a delayed usage observation does not delay publishing status', async t => {
  const config = makeConfig(scratch.sub('slow-usage'));
  seedTask(config, 'READY-TO-OBSERVE', {closed: true});
  const ctx = new Context(new DiskRunner({dryRun: false, respond: new FakeTmux().respond}), config, () => {});
  const finished = deferred<void>();
  const memory = new WatchMemory(async (name, work) => {
    if (name === 'usage') await finished.promise;
    return work();
  });
  t.after(() => { memory.launchHealth.close(); memory.archive.close(); });
  const tick = watchTick(ctx, memory, {notify: async () => {}}, {backgroundStarts: true});
  try {
    // This deadline breaks a deterministic circular dependency in the old serial scheduler.
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([tick, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('usage still blocks status publication')), 5000); })]);
    } finally { clearTimeout(timeout); }
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile(ctx), 'utf8'));
    assert.equal(snapshot.rows[0]?.task, 'READY-TO-OBSERVE');
  } finally {
    finished.resolve();
    await tick;
    await Promise.allSettled(memory.maintenance);
  }
});

it('REL0272-DISK-ASYNC: watch can resolve worktree volume identity off the event loop', async t => {
  const root = scratch.sub('async-disk');
  const config = makeConfig(root);
  const worktree = path.join(root, 'checkout');
  fs.mkdirSync(worktree);
  const record = seedTask(config, 'VOLUME-SAMPLE', {repos: [{path: root, worktree}]});
  const ctx = new Context(new DiskRunner({dryRun: false}), config, () => {});
  const stat = t.mock.method(fs, 'statSync');
  const report = await collectDisk(ctx, undefined, {records: [record], asyncPaths: true});
  assert.equal(report.worktreeCount, 1);
  assert.ok(report.volumes.some(volume => volume.device !== null && volume.availableBytes !== null));
  assert.ok(!stat.mock.calls.some(call => call.arguments[0] === worktree));
});

it('REL0272-TICK-ROWS: degraded publication retains last good rows and their actual age', async () => {
  const config = makeConfig(scratch.sub('degraded-rows'));
  seedTask(config, 'LAST-GOOD', {closed: true});
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {});
  await publishMcpSnapshot(ctx);
  const good = JSON.parse(fs.readFileSync(snapshotFile(ctx), 'utf8'));
  await runner.sleep(13_000);
  publishDegradedMcpSnapshot(ctx, good.capacity.disk, 'status collection');
  const degraded = JSON.parse(fs.readFileSync(snapshotFile(ctx), 'utf8'));
  assert.deepEqual(degraded.rows, good.rows);
  assert.equal(degraded.at, good.at);
  assert.equal(degraded.degraded, 'status collection');
  const deps = {context: () => ctx, notify: async () => {}};
  const response = await MCP_TOOLS.find(tool => tool.name === 'status')!.run(deps, {format: 'json', all: true});
  const status = JSON.parse(response.text);
  assert.equal(status.tasks[0]?.task, 'LAST-GOOD');
  assert.equal(status.snapshot_age_s, 13);
  assert.match(status.snapshot_note, /status collection/);
});

it('SNAP0247: a hung disk notification times out while watch publishes and continues ticking', async t => {
  const config = makeConfig(scratch.sub('disk-watch'), 'watch: {interval: 2}\n');
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {});
  const memory = new WatchMemory();
  let free = 4;
  t.mock.method(fs.promises, 'statfs', async () => diskStats(free));
  const entered = deferred<void>();
  const notification = deferred<void>();
  let diskNotices = 0;
  const notifier = {clickable: false, async notify(_title: string, text: string) {
    if (!text.startsWith('Disk:')) return;
    diskNotices++;
    entered.resolve();
    await notification.promise;
  }};
  let expire: (() => void) | undefined;
  const stepClock = {now: () => runner.now(), schedule(fn: () => void) {
    expire = fn;
    return () => { expire = undefined; };
  }};
  const tick = watchTick(ctx, memory, notifier, {stepClock});
  try {
    await entered.promise;
    assert.equal(typeof expire, 'function', 'the disk-alert wait must have a watchdog deadline');
    expire!();
    await tick;
    assert.match(fs.readFileSync(watchLogPath(ctx), 'utf8'), /watch disk alerts: timed out/);
    assert.equal(JSON.parse(fs.readFileSync(snapshotFile(ctx), 'utf8')).capacity.disk.volumes[0].availableBytes, 4 * 1024 ** 3);
    await runner.sleep(302_000);
    free = 92;
    await watchTick(ctx, memory, notifier, {stepClock});
    const snapshot = JSON.parse(fs.readFileSync(snapshotFile(ctx), 'utf8'));
    assert.equal(snapshot.at, runner.now());
    assert.equal(snapshot.capacity.disk.volumes[0].availableBytes, 92 * 1024 ** 3);
    assert.equal(diskNotices, 1, 'a previous in-flight step must not run twice');
    assert.ok('disk alerts' in JSON.parse(fs.readFileSync(path.join(config.stateDir, 'watch-heartbeat.json'), 'utf8')).running);
  } finally {
    notification.resolve();
    await tick;
  }
});

it('SNAP0247: stale MCP status uses durable state and fresh disk with dated capacity, and doctor warns', async t => {
  const config = makeConfig(scratch.sub('stale-watch'), 'watch: {interval: 2}\n');
  seedTask(config, 'MISSING-SIZE', {repos: [{path: scratch.dir, worktree: path.join(scratch.dir, 'removed-tree')}]});
  const tmux = new FakeTmux(config.session);
  let failProbes = false;
  const runner = new DiskRunner({dryRun: false, respond(cmd, args, opts) {
    if (failProbes && cmd === 'tmux') assert.fail('stale snapshot fallback spawned tmux');
    return tmux.respond(cmd, args, opts);
  }});
  const ctx = new Context(runner, config, () => {});
  const deps = {context: () => ctx, notify: async () => {}};
  let free = 4;
  t.mock.method(fs.promises, 'statfs', async () => diskStats(free));
  await publishMcpSnapshot(ctx, []);
  await runner.sleep(301_000);
  free = 92;
  failProbes = true;
  const status = MCP_TOOLS.find(tool => tool.name === 'status')!;
  const response = await status.run(deps, {capacity: true});
  assert.match(response.text, /watch nie odpowiada od 5 min – agentctl watch --tmux --restart/);
  assert.match(response.text, /Durable queue/);
  assert.match(response.text, /free 92\.0 GiB.*measuring/);
  assert.match(response.text, /Capacity from snapshot/);
  const json = JSON.parse((await status.run(deps, {capacity: true, format: 'json'})).text);
  assert.equal(json.snapshot_age_s, 301);
  assert.equal(json.disk.volumes[0].availableBytes, 92 * 1024 ** 3);
  assert.equal(json.disk.measuring, true);
  failProbes = false;
  const doctor = await runDoctor(runner, () => config, null, '26.0.0', 'darwin', scratch.dir, {});
  assert.equal(doctor.find(check => check.name === 'watch snapshot')?.status, 'warn');
});

it('SNAP0247: a stuck statfs falls back to df and keeps worktree sizes independent', async t => {
  const config = makeConfig(scratch.sub('statfs-watch'));
  seedTask(config, 'PENDING', {repos: [{path: scratch.dir, worktree: path.join(scratch.dir, 'pending-tree')}]});
  const tmux = new FakeTmux(config.session);
  const runner = new DiskRunner({dryRun: false, respond(cmd, args, opts) {
    if (cmd === 'df') return { stdout: '/dev/test 104857600 1048576 96468992 8% /\n' };
    return tmux.respond(cmd, args, opts);
  }});
  const ctx = new Context(runner, config, () => {});
  const entered = deferred<void>(), stat = deferred<ReturnType<typeof diskStats>>();
  t.mock.method(fs.promises, 'statfs', () => { entered.resolve(); return stat.promise; });
  const { collectDisk } = await import('../src/core/disk.ts');
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = collectDisk(ctx);
  try {
    await entered.promise;
    t.mock.timers.tick(500);
    // On the previous release there is no timeout. Resolve the fixture on the next event-loop turn.
    const signal = await Promise.race([pending, new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)))]);
    assert.ok(signal, 'a hung statfs must stop delaying the disk summary');
    assert.equal(signal.volumes[0]?.availableBytes, 92 * 1024 ** 3);
    assert.equal(signal.worktreeBytes, null);
    assert.equal(signal.measuring, true);
  } finally { stat.resolve(diskStats(1)); await pending; }
});

it('W110-MCP-AGE: a recent complete snapshot still serves full queue and limits after a missed interval', async () => {
  const config = makeConfig(scratch.sub('recent-admission-snapshot'), 'watch: {interval: 2}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  await publishMcpSnapshot(ctx);
  await runner.sleep(20_000);
  const deps = {context: () => ctx, notify: async () => {}};
  for (const name of ['queue_list', 'limits']) {
    const result = await MCP_TOOLS.find(tool => tool.name === name)!.run(deps, {});
    assert.match(result.text, /Watch snapshot age: 20.0 s/, name);
    assert.doesNotMatch(result.text, /fallback/i, name);
  }
});
