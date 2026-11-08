import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, planTier, affectedTests, assertClean, acquireLock, heavyCommand, packJson } from '../scripts/gate.ts';
import { checkRuntime, verifyArchive, node22Path, ensureNode22 } from '../scripts/runtime.ts';
import { useScratch } from './helpers.ts';
const scratch = useScratch();
it('plans tiers in order, keeping both runtimes sequential and live last', () => {
  assert.deepEqual(planTier('quick', ['tests/a.test.ts'], []), ['typecheck', 'build', 'git diff --check', 'tests current: tests/a.test.ts']);
  assert.deepEqual(planTier('full', [], []), ['tests Node 22.14.0 (full)', 'tests Node 26 (full)']);
  const plan = planTier('release', [], ['scripts/live-a.ts', 'scripts/live-b.ts']);
  assert.equal(plan.length, 8); assert.match(plan[2]!, /smoke Node 22/); assert.match(plan[5]!, /doctor.*Node 26/);
  assert.deepEqual(plan.slice(-2), ['scripts/live-a.ts', 'scripts/live-b.ts']);
  assert.equal(planTier('release', [], ['scripts/live-a.ts'], true).at(-1), 'SKIP live entries');
  assert.equal(parseArgs(['quick', '--base', 'HEAD~1']).base, 'HEAD~1');
  assert.throws(() => parseArgs(['full', '--base'])); assert.throws(() => parseArgs(['unknown']));
});
it('maps direct and transitive imports and exact names; uncertainty selects all', () => {
  const tests = ['tests/a.test.ts', 'tests/b.test.ts'];
  const sources = { 'src/a.ts': '', 'src/b.ts': "export { a } from './a.js'", 'tests/a.test.ts': "import '../src/b.ts'", 'tests/b.test.ts': '' };
  assert.deepEqual(affectedTests(['src/a.ts'], sources, tests), { tests: [tests[0]], uncertain: false });
  assert.deepEqual(affectedTests(['tests/b.test.ts'], sources, tests).tests, [tests[1]]);
  for (const file of ['README.md', 'scripts/gate.ts', 'src/deleted.ts']) assert.deepEqual(affectedTests([file], sources, tests), { tests, uncertain: true });
  assert.deepEqual(affectedTests([], sources, tests).tests, []);
  assert.equal(affectedTests(['src/a.ts'], { ...sources, 'src/dynamic.ts': 'import(name)' }, tests).uncertain, true);
});
it('refuses dirty full/release unless the explicit exception is recorded', () => {
  for (const tier of ['full', 'release'] as const) {
    const opts = parseArgs([tier]); assert.throws(() => assertClean(opts, true), /dirty tree/);
    assert.doesNotThrow(() => assertClean({ ...opts, allowDirty: true }, true)); assert.doesNotThrow(() => assertClean(opts, false));
  }
  assert.doesNotThrow(() => assertClean(parseArgs(['quick']), true));
});
it('lock is exclusive, reports its owner, waits and releases only after acquisition', async () => {
  const lock = path.join(scratch.dir, 'runtimes/.gate.lock');
  const release = await acquireLock(lock);
  let waited = 0, printed = '';
  const release2 = await acquireLock(lock, owner => { printed = owner; }, async () => { waited++; assert.ok(fs.existsSync(lock)); release(); });
  assert.equal(waited, 1); assert.equal(JSON.parse(printed).pid, process.pid); assert.ok(fs.existsSync(lock));
  release(); assert.ok(fs.existsSync(lock), 'old release cannot remove a new owner');
  release2(); release2(); assert.equal(fs.existsSync(lock), false);
});
it('a lock whose holder pid is dead (SIGKILLed gate) is broken, not waited on (R2)', async () => {
  const lock = path.join(scratch.dir, 'runtimes/.gate-stale.lock');
  // A process that already exited: its pid answers ESRCH.
  const { spawnSync } = await import('node:child_process');
  const dead = spawnSync('true', []).pid!;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ token: 'stale', pid: dead, cwd: '/tmp', started: new Date().toISOString() }));
  let waited = 0;
  const release = await acquireLock(lock, () => {}, async () => { if (++waited > 3) throw new Error('waited on a dead holder'); });
  assert.equal(waited, 0, 'no waiting on a dead holder');
  assert.ok(fs.existsSync(lock), 'the live acquisition holds the lock now');
  release();
  assert.equal(fs.existsSync(lock), false);
  // A live holder is still waited on (the existing test), an unparseable holder too.
  fs.writeFileSync(lock, 'not json');
  let waits = 0;
  const acquired = acquireLock(lock, () => {}, async () => { if (++waits === 2) fs.unlinkSync(lock); });
  (await acquired)();
  assert.equal(waits, 2, 'an unparseable lock file is waited on, never broken');
});
it('takes over the actual lock of a SIGKILLed owner (R2)', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const lock = path.join(scratch.dir, 'sigkill/.gate.lock');
  const module = new URL('../scripts/gate-lock.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
    `import { acquireLock } from ${JSON.stringify(module)}; await acquireLock(${JSON.stringify(lock)}); console.log('ready'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).pid, child.pid);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const release = await acquireLock(lock, () => {}, async () => { throw new Error('waited on SIGKILLed owner'); });
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).pid, process.pid);
    release();
    assert.equal(fs.existsSync(lock), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});
it('F2: reclamation is a single atomic rename; a reclaimer preempted inside it never disturbs the live successor lock', async () => {
  const { spawnSync } = await import('node:child_process');
  const lock = path.join(scratch.dir, 'runtimes/.gate-f2.lock');
  const dead = spawnSync('true', []).pid!;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ token: 'STALE', pid: dead, cwd: '/tmp', started: new Date().toISOString() }));
  // Contender B is preempted at its reclaim rename: A finishes the whole reclamation and a live successor already holds
  // the lock before B's rename runs. B's rename then moves the successor's directory — and must put it back untouched.
  const successor = JSON.stringify({ token: 'SUCCESSOR', pid: process.pid, cwd: '/tmp', started: new Date().toISOString() });
  const rename = fs.renameSync;
  let fired = false;
  fs.renameSync = function (from: fs.PathLike, to: fs.PathLike): void {
    if (from === lock && !fired) {
      fired = true;
      const tomb = `${lock}.tombstone-a`;
      rename.call(fs, lock, tomb);
      fs.rmSync(tomb, { recursive: true, force: true });
      fs.mkdirSync(lock);
      const tmp = path.join(lock, '.owner-a.tmp');
      fs.writeFileSync(tmp, successor);
      rename.call(fs, tmp, path.join(lock, 'owner'));
    }
    rename.call(fs, from, to);
  } as typeof fs.renameSync;
  try {
    let waits = 0;
    const release = await acquireLock(lock, () => {}, async () => {
      waits++;
      if (waits === 1) {
        assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), successor, 'the losing reclaimer must not unlink the live successor lock');
        fs.rmSync(lock, { recursive: true }); // the successor releases
        return;
      }
      throw new Error('contender B should have acquired after the successor released');
    });
    assert.equal(fired, true);
    assert.equal(waits, 1);
    release();
  } finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((n) => n.includes('tombstone')), [], 'no tombstone is left behind');
});
it('X1-R2: a reclaimer preempted after its final verified read cannot destroy the live ownership a successor installed', async () => {
  const { spawnSync } = await import('node:child_process');
  const lock = path.join(scratch.dir, 'runtimes/.gate-x1.lock');
  const dead = spawnSync('true', []).pid!;
  assert.throws(() => process.kill(dead, 0), { code: 'ESRCH' });
  fs.mkdirSync(lock, { recursive: true });
  const stale = JSON.stringify({ token: 'OLD', pid: dead, started: new Date().toISOString() });
  fs.writeFileSync(path.join(lock, 'owner'), stale);
  // The reviewer's deterministic preemption (review2/reproductions.log): B read OLD and is descheduled immediately
  // after the read; A reclaims OLD and publishes its own live ownership before B resumes.
  const live = JSON.stringify({ token: 'A-LIVE', pid: process.pid, started: new Date().toISOString() });
  const read = fs.readFileSync;
  let fired = false;
  fs.readFileSync = function (target: fs.PathOrFileDescriptor, ...args: unknown[]) {
    const result = (read as (...a: unknown[]) => unknown).call(fs, target, ...args);
    if (target === path.join(lock, 'owner') && !fired) {
      fired = true;
      const tomb = `${lock}.tombstone-a`;
      fs.renameSync(lock, tomb);
      fs.rmSync(tomb, { recursive: true, force: true });
      fs.mkdirSync(lock);
      const tmp = path.join(lock, '.owner-a.tmp');
      fs.writeFileSync(tmp, live);
      fs.renameSync(tmp, path.join(lock, 'owner'));
    }
    return result;
  } as typeof fs.readFileSync;
  try {
    let waits = 0;
    const release = await acquireLock(lock, () => {}, async () => {
      waits++;
      if (waits === 1) {
        assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), live, 'B must not destroy the live ownership A installed since B read the stale owner');
        fs.rmSync(lock, { recursive: true }); // A releases
        return;
      }
      throw new Error('contender B should have acquired once A released');
    });
    assert.equal(fired, true);
    assert.equal(waits, 1);
    release();
  } finally { fs.readFileSync = read; }
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lock)).filter((n) => n.includes('tombstone')), [], 'no tombstone is left behind');
});
it('X2: a lock directory left without an owner by a SIGKILL mid-publish is reclaimed after the grace, a fresh one is waited on', async () => {
  const { RECLAIM_GRACE_MS } = await import('../scripts/gate-lock.ts');
  const lock = path.join(scratch.dir, 'runtimes/.gate-x2.lock');
  // The crash window: the holder was SIGKILLed between the atomic mkdir and the owner rename.
  fs.mkdirSync(lock, { recursive: true });
  let waits = 0;
  const release = await acquireLock(lock, () => {}, async () => {
    waits++;
    if (waits === 1) {
      assert.ok(fs.existsSync(lock), 'a fresh ownerless directory is inside its grace: waited on, not broken');
      const old = new Date(Date.now() - RECLAIM_GRACE_MS - 60_000);
      fs.utimesSync(lock, old, old);
      return;
    }
    throw new Error('an ownerless lock past its grace should be reclaimed without another wait');
  });
  assert.equal(waits, 1, 'waited out the grace, then reclaimed without another wait');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8')).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
});
it('checks cached runtime version and archive checksum with fakes and no network', () => {
  assert.equal(checkRuntime('/fake/node', '22.14.0', () => 'v22.14.0'), 'v22.14.0');
  assert.equal(checkRuntime('/fake/node', '26.', () => 'v26.13.0'), 'v26.13.0');
  assert.throws(() => checkRuntime('/fake/node', '22.14.0', () => 'v22.15.0'));
  const data = Buffer.from('fake archive'), hash = createHash('sha256').update(data).digest('hex');
  assert.doesNotThrow(() => verifyArchive(data, `${hash}  node.tar.gz\n`, 'node.tar.gz'));
  assert.throws(() => verifyArchive(data, `${'0'.repeat(64)}  node.tar.gz`, 'node.tar.gz'));
  assert.throws(() => verifyArchive(data, '', 'node.tar.gz'));
  assert.equal(node22Path('/runtime'), '/runtime/node-v22.14.0-darwin-arm64/bin/node');
});
it('wraps every heavy command without shell interpolation or load waiting', () => {
  assert.deepEqual(heavyCommand('node', ['x.ts'], 'darwin'), ['nice', ['-n', '10', 'taskpolicy', '-b', 'node', 'x.ts']]);
  assert.deepEqual(heavyCommand('node', ['x.ts'], 'linux'), ['nice', ['-n', '10', 'node', 'x.ts']]);
});

it('provisions a missing runtime once, verifies before extraction and never deletes the cached runtime', async () => {
  const dir = scratch.sub('runtime'), work = scratch.sub('download');
  const data = Buffer.from('verified archive');
  const hash = createHash('sha256').update(data).digest('hex');
  const downloads: string[] = [];
  const io = { dir, platform: 'darwin', arch: 'arm64', version: () => 'v22.14.0',
    download: async (file: string) => { downloads.push(file); return file === 'SHASUMS256.txt' ? Buffer.from(`${hash}  node-v22.14.0-darwin-arm64.tar.gz`) : data; },
    extract: (archive: string) => { assert.deepEqual(fs.readFileSync(archive), data); fs.mkdirSync(path.dirname(node22Path(dir)), { recursive: true }); fs.writeFileSync(node22Path(dir), 'cached'); },
  };
  assert.equal(await ensureNode22(work, io), node22Path(dir));
  assert.equal(downloads.length, 2);
  await ensureNode22(work, { ...io, download: async () => { throw new Error('must not download cached runtime'); } });
  assert.equal(fs.readFileSync(node22Path(dir), 'utf8'), 'cached'); assert.deepEqual(fs.readdirSync(work), []);
  await assert.rejects(ensureNode22(work, { ...io, dir: scratch.sub('bad-runtime'), download: async () => data, extract: () => assert.fail('unverified extraction') }), /SHA256/);
});

it('full can explicitly record Node 26 only without provisioning Node 22', () => {
  assert.equal(parseArgs(['full', '--node26-only']).node26Only, true);
  assert.equal(parseArgs(['full', '--', '--node26-only']).node26Only, true);
  assert.deepEqual(planTier('full', [], [], false, true), ['tests Node 26 (full)']);
  for (const tier of ['quick', 'release']) assert.throws(() => parseArgs([tier, '--node26-only']), /belongs to full/);
});

it('packJson reads the npm pack array and ignores trailing notices', () => {
  assert.deepEqual(packJson('[{"filename":"agentctl-0.19.0.tgz"}]'), [{ filename: 'agentctl-0.19.0.tgz' }]);
  const noticed = '[{"filename":"a.tgz"}]\nnpm notice\nnpm notice New major version of npm available! 11.20.0 -> 12.2.2\nnpm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2\nnpm notice\n';
  assert.deepEqual(packJson(noticed), [{ filename: 'a.tgz' }]);
  assert.throws(() => packJson('npm notice only, no json'), /no JSON array/);
});
