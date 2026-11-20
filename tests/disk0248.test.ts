import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { closeTask } from '../src/core/close.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { collectDisk, diskStartHold } from '../src/core/disk.ts';
import { applyGc, planGc } from '../src/core/gc.ts';
import { readJournal } from '../src/core/journal.ts';
import { newTasks } from '../src/core/new.ts';
import { describeQueue, QueueMemory, queueTick, readQueue, registerDirectStart, unblockEntry } from '../src/core/queue.ts';
import { RealRunner, type ExecOptions } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const sameFs = fs.statSync;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function world(name: string, yaml: (root: string) => string = () => '') {
  const root = scratch.sub(name), repo = scratch.sub(`${name}/repo`), trash = scratch.sub(`${name}/fixture-trash`);
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.cache/\ndist*/\nprofile/\n');
  fs.mkdirSync(path.join(repo, 'dist-tracked'));
  fs.writeFileSync(path.join(repo, 'dist-tracked', 'tracked.txt'), 'keep');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n');
  git(repo, 'add', '.');
  git(repo, 'add', '-f', 'dist-tracked/tracked.txt');
  git(repo, 'commit', '-m', 'fixture');
  const config = makeConfig(root, yaml(root));
  const tmux = new FakeTmux(config.session), real = new RealRunner();
  const installs: string[] = [], copies: string[][] = [], moves: string[] = [], notifications: string[] = [];
  let failClone = false;
  let interceptGit: ((args: string[]) => { code: number; stdout: string; stderr: string } | undefined) | undefined;
  class FixtureRunner extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}) {
      if (cmd === 'git') return interceptGit?.(args) ?? real.exec(cmd, args, opts);
      if (cmd === 'sh' && args.at(-1)?.startsWith('npm ci')) {
        const worktree = opts.cwd!;
        installs.push(worktree);
        const nm = path.join(worktree, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'dependency'), 'original');
        if (!fs.existsSync(path.join(nm, '.bin/tool'))) fs.symlinkSync('../dependency', path.join(nm, '.bin/tool'));
        return { code: 0, stdout: 'fixture install\n', stderr: '' };
      }
      if (cmd === 'cp') {
        copies.push(args);
        if (failClone) {
          fs.mkdirSync(args.at(-1)!);
          return { code: 1, stdout: '', stderr: 'fixture clone failure' };
        }
        fs.cpSync(args.at(-2)!, args.at(-1)!, { recursive: true, verbatimSymlinks: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'osascript' || cmd === 'gio') {
        const target = args.at(-1)!;
        moves.push(target);
        fs.renameSync(target, path.join(trash, `${moves.length}-${path.basename(target)}`));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd.endsWith('lsof')) return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'df') return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 5242880 4194304 1048576 80% /mount\n', stderr: '' };
      return super.exec(cmd, args, opts);
    }
  }
  const runner = new FixtureRunner({ dryRun: false, respond: tmux.respond.bind(tmux), startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const spec = (task: string, explicit = true) => {
    const raw = splitSpecs(`---\ntask: ${task}\nagent: claude\nrepos: [{path: ${repo}${explicit ? `, worktree: ${root}/${task.toLowerCase()}` : ''}}]\n---\nFixture prompt.`)[0]!;
    return { raw, spec: resolveSpec(raw, { config }) };
  };
  const notifier = { clickable: false, notify: async (_title: string, message: string) => { notifications.push(message); } };
  return { root, repo, config, ctx, runner, spec, notifier, installs, copies, moves, notifications, failCopy: () => { failClone = true; }, interceptGit: (f: typeof interceptGit) => { interceptGit = f; } };
}

it('DISK0248-NM: same lockfile installs once, creates independent copies and exposes store bytes and counters', async () => {
  const w = world('store', () => 'setup: [npm ci]\n');
  // Set the parsed option directly so the v0.23.3 proof reaches setup and fails on repeated installs.
  Object.assign(w.config, { nodeModules: 'clone' });
  const a = w.spec('NMA').spec, b = w.spec('NMB').spec;
  await Promise.all([newTasks(w.ctx, [a], { noAgent: true }), newTasks(w.ctx, [b], { noAgent: true })]);
  assert.equal(w.installs.length, 1);
  assert.equal(w.copies.length, 2);
  assert.ok(w.copies.every(args => args.includes(process.platform === 'darwin' ? '-c' : '--reflink=auto')));
  const file = (spec: typeof a) => path.join(spec.repos[0]!.worktree, 'node_modules/dependency');
  fs.writeFileSync(file(a), 'changed');
  assert.equal(fs.readFileSync(file(b), 'utf8'), 'original');
  assert.equal(fs.readlinkSync(path.join(b.repos[0]!.worktree, 'node_modules/.bin/tool')), '../dependency');
  const disk = await collectDisk(w.ctx);
  assert.deepEqual([disk.nodeModulesStore?.hits, disk.nodeModulesStore?.misses, disk.nodeModulesStore?.entries], [1, 1, 1]);
  assert.ok(disk.nodeModulesStore!.bytes > 0);
  assert.deepEqual(readJournal(w.config).filter(event => event.nodeModules).map(event => event.nodeModules!.result), ['miss', 'hit']);

  fs.appendFileSync(path.join(w.repo, 'package-lock.json'), '\n');
  git(w.repo, 'commit', '-am', 'new lockfile');
  await newTasks(w.ctx, [w.spec('NMC').spec], { noAgent: true });
  assert.equal(w.installs.length, 2);
  assert.equal((await collectDisk(w.ctx)).nodeModulesStore?.entries, 2);
  w.failCopy();
  const d = w.spec('NMD').spec;
  await newTasks(w.ctx, [d], { noAgent: true });
  assert.equal(w.installs.length, 3);
  assert.equal(fs.readFileSync(file(d), 'utf8'), 'original');
  assert.ok(!fs.readdirSync(d.repos[0]!.worktree).some(name => name.startsWith('.agentctl-nm-')));

  await w.runner.sleep(60_000);
  const preview = await planGc(w.ctx, { olderThan: '1m' });
  const entries = preview.items.filter(item => item.kind === 'node-modules');
  assert.equal(entries.length, 2);
  assert.equal(w.moves.length, 0);
  const applied = await applyGc(w.ctx, preview);
  assert.equal(applied.failed.length, 0);
  assert.equal(w.moves.length, 2);
  assert.equal(applied.freedBytes, 0, 'Trash retains allocated bytes');
  assert.equal(fs.readFileSync(file(b), 'utf8'), 'original');
});

it('node_modules and worktree settings support project overrides and invalid paths are rejected', () => {
  const w = world('settings', root => `worktrees: {root: ${root}/a}\nsetup: {node_modules: clone, commands: [npm ci]}\n`);
  assert.equal(w.spec('SETTINGS', false).spec.repos[0]!.worktree, `${w.root}/a/repo-settings`);
  assert.equal(w.spec('SETTINGS', false).spec.repos[0]!.nodeModules, 'clone');
  fs.writeFileSync(path.join(w.repo, '.agentctl.yaml'), `worktrees: {root: ${w.root}/b, mount: ${w.root}}\nsetup: {node_modules: off}\n`);
  const settings = w.spec('SETTINGS', false).spec.repos[0]!;
  assert.equal(settings.worktree, `${w.root}/b/repo-settings`);
  assert.equal(settings.worktreeMount, w.root);
  assert.equal(settings.nodeModules, undefined);
});

function fakeMount(t: TestContext, mount: string) {
  let mounted = true;
  const stat = ((target: fs.PathLike, ...options: unknown[]) => {
    const value = Reflect.apply(sameFs, fs, [target, ...options]) as fs.Stats | undefined;
    if (!value || typeof target !== 'string' || !mounted || !(target === mount || target.startsWith(`${mount}/`))) return value;
    return Object.assign(Object.create(value), { dev: value.dev + 1 });
  }) as typeof fs.statSync;
  t.mock.method(fs, 'statSync', stat);
  return (present: boolean) => { mounted = present; };
}

it('DISK0248-VOLUME: unmounted worktree stays blocked once, then unblock checks that volume and resumes', async t => {
  const w = world('volume', () => 'disk: {min_free_start_gb: 2}\n');
  const mount = path.join(w.root, 'volume');
  fs.mkdirSync(mount);
  Object.assign(w.config, { worktreeRoot: path.join(mount, 'checkouts'), worktreeMount: mount });
  const setMounted = fakeMount(t, mount);
  setMounted(false);
  const item = w.spec('VOLUME', false);
  await registerDirectStart(w.ctx, [item], { noAgent: true });
  const memory = new QueueMemory();
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), []);
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), []);
  assert.equal(describeQueue(w.config, readQueue(w.config), [])[0]?.condition.kind, 'blocked');
  assert.equal(w.notifications.filter(msg => msg.includes('volume missing')).length, 1);
  assert.ok(!fs.existsSync(item.spec.repos[0]!.worktree));
  await assert.rejects(unblockEntry(w.ctx, 'VOLUME'), /volume missing/);
  const disk = await collectDisk(w.ctx);
  assert.equal(disk.volumes.find(volume => volume.mount === mount)?.error, 'volume missing');
  setMounted(true);
  const statfs = ((target: string) => ({ bavail: target.startsWith(mount) ? 1 : 256, bsize: 1024 ** 3 })) as unknown as typeof fs.statfsSync;
  assert.match(diskStartHold(w.config, item.spec.repos, statfs)!, /dysk 1 GB < 2 GB/);
  const df = await collectDisk(w.ctx, (async () => { throw Error('fixture statfs unavailable'); }) as typeof fs.promises.statfs);
  assert.equal(df.volumes.find(volume => volume.mount === mount)?.availableBytes, 1024 ** 3);
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), [], 'mounting alone leaves the start blocked');
  await unblockEntry(w.ctx, 'VOLUME');
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), ['VOLUME']);
  await memory.idle();
  assert.ok(fs.existsSync(path.join(item.spec.repos[0]!.worktree, '.git')));
  assert.deepEqual(readQueue(w.config), []);
});

it('DISK0248-LOCK: interrupted checkout clears only its initializing locks and preserves detached metadata on unblock', async t => {
  const w = world('lock');
  const mount = path.join(w.root, 'mount');
  fs.mkdirSync(mount);
  Object.assign(w.config, { worktreeRoot: path.join(mount, 'checkouts'), worktreeMount: mount });
  const setMounted = fakeMount(t, mount);
  const item = w.spec('LOCK', false), wt = item.spec.repos[0]!.worktree, admin = path.join(w.repo, '.git');
  const interrupted = path.join(admin, 'worktrees/fixture'), unrelated = path.join(admin, 'worktrees/unrelated');
  const simulate = (args: string[]) => {
    if (!args.includes('worktree') || !args.includes('add')) return undefined;
    for (const target of [interrupted, unrelated]) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'gitdir'), `${target === interrupted ? wt : `${wt}-unrelated`}/.git\n`);
      fs.writeFileSync(path.join(target, 'locked'), 'initializing\n');
      fs.writeFileSync(path.join(target, 'index.lock'), 'fixture');
    }
    setMounted(false);
    return { code: 1, stdout: '', stderr: 'fixture volume unplugged' };
  };
  w.interceptGit(simulate);
  await registerDirectStart(w.ctx, [item], { noAgent: true });
  const memory = new QueueMemory();
  await queueTick(w.ctx, memory, w.notifier);
  await memory.idle();
  assert.ok(!fs.existsSync(path.join(interrupted, 'locked')));
  assert.ok(!fs.existsSync(path.join(interrupted, 'index.lock')));
  assert.ok(fs.existsSync(path.join(unrelated, 'locked')));
  assert.ok(fs.existsSync(path.join(unrelated, 'index.lock')));
  assert.equal(readQueue(w.config)[0]?.volumeBlock, mount);
  setMounted(true);
  await unblockEntry(w.ctx, 'LOCK');
  assert.ok(!fs.existsSync(interrupted));
  assert.equal(fs.readdirSync(path.join(admin, 'agentctl-interrupted-worktrees')).length, 1);
  w.interceptGit(undefined);
  await queueTick(w.ctx, memory, w.notifier);
  await memory.idle();
  assert.ok(fs.existsSync(path.join(wt, '.git')));
  assert.ok(fs.existsSync(path.join(unrelated, 'locked')));
});
