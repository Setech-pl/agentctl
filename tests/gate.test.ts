import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, planTier, affectedTests, assertClean, acquireLock, heavyCommand } from '../scripts/gate.ts';
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
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, child.pid);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const release = await acquireLock(lock, () => {}, async () => { throw new Error('waited on SIGKILLed owner'); });
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
    release();
    assert.equal(fs.existsSync(lock), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
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
