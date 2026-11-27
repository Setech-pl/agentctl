import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { loadGlobalConfig, type GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { applyGc, checkAutomaticGc, type GcItem } from '../src/core/gc.ts';
import { readJournal } from '../src/core/journal.ts';
import { queueDir } from '../src/core/queue.ts';
import { claimStartPaths } from '../src/core/start-paths.ts';
import { withStartLock } from '../src/core/start-lock.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * 0.26.4: auto_gc at production scale (M1), ignored files (M2), the queue (M3), CLI hand-off (L1), reloads, run journal and path
 * claims (L2). Git is faked per command (no repositories needed for 2000 worktrees); everything else is the real filesystem.
 */

const scratch = useScratch();
const GiB = 1024 ** 3;
type GitReply = { code: number; stdout: string; stderr: string };

interface World {
  root: string; repo: string; config: GlobalConfig; ctx: Context; runner: DiskRunner;
  gitLog: string[][];
  onGit: (handler: (cwd: string, args: string[]) => GitReply | undefined | Promise<GitReply | undefined>) => void;
  worktrees: Map<string, string>; // worktree -> repo
  ignored: Map<string, string>; // worktree -> `git status --ignored` rows
}

function world(name: string, autoGc: string, extra = ''): World {
  const root = scratch.sub(name), repo = scratch.sub(`${name}/repo`);
  const config = makeConfig(root, `disk:\n  auto_gc:\n${autoGc.split('\n').filter(Boolean).map(line => `    ${line.trim()}`).join('\n')}\n${extra}`);
  const tmux = new FakeTmux(config.session);
  const gitLog: string[][] = [];
  const worktrees = new Map<string, string>(), ignored = new Map<string, string>();
  let custom: ((cwd: string, args: string[]) => GitReply | undefined | Promise<GitReply | undefined>) | undefined;
  const ok = (stdout = ''): GitReply => ({ code: 0, stdout, stderr: '' });
  class FixtureRunner extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}) {
      if (cmd !== 'git') return super.exec(cmd, args, opts);
      const at = args.indexOf('-C'), cwd = at >= 0 ? args[at + 1]! : '', rest = at >= 0 ? args.slice(at + 2) : args;
      gitLog.push([cwd, ...rest]);
      const own = await custom?.(cwd, rest);
      if (own) return own;
      if (rest[0] === 'worktree' && rest[1] === 'list') {
        const rows = [`worktree ${cwd}\nHEAD 0\nbranch refs/heads/main\n`];
        for (const [wt, owner] of worktrees) if (owner === cwd) rows.push(`worktree ${wt}\nHEAD 1\nbranch refs/heads/${path.basename(wt)}\n`);
        return ok(rows.join('\n'));
      }
      if (rest[0] === 'worktree' && rest[1] === 'remove') { fs.rmSync(rest.at(-1)!, { recursive: true, force: true }); worktrees.delete(rest.at(-1)!); return ok(); }
      if (rest[0] === 'status' && rest.includes('--ignored')) return ok(ignored.get(cwd) ?? '!! node_modules/\0');
      if (rest[0] === 'status') return ok('');
      if (rest[0] === 'rev-parse' && rest.includes('@{upstream}')) return { code: 1, stdout: '', stderr: '' };
      if (rest[0] === 'rev-list') return ok('0');
      if (rest[0] === 'rev-parse') return ok(path.basename(cwd));
      return ok();
    }
  }
  const runner = new FixtureRunner({ dryRun: false, respond: tmux.respond.bind(tmux), startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  return { root, repo, config, ctx, runner, gitLog, worktrees, ignored, onGit: handler => { custom = handler; } };
}

/** A closed task worktree with a small node_modules tree (.bin link, scoped package) and a dist folder. */
function addWorktree(w: World, task: string, opts: { repo?: string; closed?: boolean; extra?: Parameters<typeof seedTask>[2] } = {}): string {
  const repo = opts.repo ?? w.repo;
  fs.mkdirSync(repo, { recursive: true });
  const wt = path.join(w.root, 'wt', path.basename(repo), task.toLowerCase());
  for (const dir of ['src', 'node_modules/a', 'node_modules/b', 'node_modules/.bin', 'node_modules/@s/d', 'dist']) fs.mkdirSync(path.join(wt, dir), { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${repo}/.git/worktrees/${task}\n`);
  fs.writeFileSync(path.join(wt, 'src/index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(wt, 'node_modules/a/index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(wt, 'node_modules/b/index.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(wt, 'node_modules/@s/d/index.js'), 'module.exports = 3;\n');
  fs.symlinkSync('../a/index.js', path.join(wt, 'node_modules/.bin/a'));
  fs.writeFileSync(path.join(wt, 'dist/out.js'), 'built\n');
  w.worktrees.set(wt, repo);
  return wt;
}

function seed(w: World, task: string, worktrees: string[], closed = true, extra: Parameters<typeof seedTask>[2] = {}) {
  return seedTask(w.config, task, { closed, repos: worktrees.map(wt => ({ path: w.worktrees.get(wt)!, worktree: wt, branch: path.basename(wt), base: 'main' })), ...extra });
}

function freeSpace(t: TestContext, free: () => number) {
  const statfs = fs.promises.statfs;
  t.mock.method(fs.promises, 'statfs', async (dir: string) => ({ ...await statfs(dir), bsize: 1024 ** 2, bavail: Math.floor(free() / 1024 ** 2) }));
}

const volume = (w: World) => [{ path: w.root, device: String(fs.statSync(w.root).dev) }];
const autoGcText = (w: World) => readJournal(w.config).filter(e => e.kind === 'disk-auto-gc').map(e => e.text).join('\n');

function queueEntry(w: World, seq: number, task: string, spec: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(queueDir(w.config), { recursive: true });
  fs.writeFileSync(path.join(queueDir(w.config), `${String(seq).padStart(4, '0')}-${task}.json`), JSON.stringify({
    seq, task, order: seq, priority: 'normal', status: 'queued', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: [], spec, ...extra,
  }));
}

it('AUTOGC0266-SCALE: 1800 records and 2300 worktrees with node_modules finish one run inside max_run_s with one inventory, one walk and a responsive event loop', { timeout: 240_000 }, async t => {
  const w = world('scale', `
    enabled: true
    dry_run: true
    trigger_free_gb: 30
    target_free_gb: 100000
    older_than: 2d
    categories: [closed_clean_worktrees]
    max_per_run_gb: 100000`);
  const second = path.join(w.root, 'repo2');
  const fixtureStart = performance.now();
  let closed = 0;
  for (let i = 0; i < 1800; i++) {
    const own = [addWorktree(w, `PS-${i}`)];
    if (i < 500) own.push(addWorktree(w, `PS-${i}`, { repo: second }));
    const done = i % 5 !== 0;
    if (done) closed += own.length;
    seed(w, `PS-${i}`, own, done);
  }
  assert.equal(w.worktrees.size, 2300);
  await w.runner.sleep(3 * 86400_000);
  freeSpace(t, () => 20 * GiB);
  // Tripwire: the run may list each folder of the fixture a small number of times, never once per candidate.
  const dirs = 2300 * 7 + 1800 + 10;
  let reads = 0;
  const count = <T extends (...args: never[]) => unknown>(target: object, name: string) => {
    const original = (target as Record<string, T>)[name]!;
    t.mock.method(target as never, name as never, ((...args: never[]) => {
      if (++reads > dirs * 3) throw Object.assign(new Error('readdir tripwire: the run lists folders once per candidate'), { code: 'EMFILE' });
      return original.apply(target, args);
    }) as never);
  };
  count(fs, 'readdirSync'); count(fs.promises, 'readdir'); count(fs.promises, 'opendir');
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 5);
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  const started = performance.now();
  t.diagnostic(`fixture ready after ${Math.round(started - fixtureStart)} ms`);
  try { await runAutoGc(w.ctx, volume(w)); }
  finally { clearInterval(timer); }
  const seconds = (performance.now() - started) / 1000;
  t.diagnostic(`run ${seconds.toFixed(1)} s, readdir ${reads}, max event-loop gap ${Math.round(maxGap)} ms`);
  const text = autoGcText(w);
  assert.ok(reads <= dirs * 3, `readdir calls ${reads}`);
  assert.match(text, new RegExp(`plan: ${closed} pozycji`), text.slice(0, 400));
  assert.match(text, /wyczerpano dostępne kategorie; czas \d/);
  assert.ok(seconds < 300, `run took ${seconds}s`);
  // A watch tick shares this event loop: no synchronous stretch may hold it for a second.
  assert.ok(maxGap < 1000, `event loop blocked for ${Math.round(maxGap)} ms`);
  const event = readJournal(w.config).find(e => e.kind === 'disk-auto-gc') as { diskGc?: { prechecks: number; durationMs: number }[] } | undefined;
  assert.equal(event?.diskGc?.[0]?.prechecks, closed);
});

it('AUTOGC0266-SCALE: prechecks are lazy and a run stops at max_run_s with a journal entry', async t => {
  const w = world('lazy', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 35
    older_than: 2d
    categories: [closed_clean_worktrees]
    max_run_s: 60`);
  const all = Array.from({ length: 10 }, (_, i) => addWorktree(w, `LZ-${i}`));
  all.forEach((wt, i) => seed(w, `LZ-${i}`, [wt]));
  await w.runner.sleep(3 * 86400_000);
  let removed = 0, phase = 1;
  freeSpace(t, () => (phase === 1 && removed ? 40 : 20) * GiB);
  w.onGit((_cwd, args) => { if (args[0] === 'worktree' && args[1] === 'remove') removed++; return undefined; });
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  await runAutoGc(w.ctx, volume(w));
  assert.equal(removed, 1);
  const risked = new Set(w.gitLog.filter(row => row[1] === 'status' && !row.includes('--ignored')).map(row => row[0]));
  assert.equal(risked.size, 1, `checked ${[...risked].join(', ')}`);
  assert.match(autoGcText(w), /usunięto 1;.*osiągnięto cel; czas/);

  // Deadline: the clock passes max_run_s inside the third check; nothing after it is checked or deleted.
  phase = 2;
  const d = world('deadline', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 35
    older_than: 2d
    categories: [closed_clean_worktrees]
    max_run_s: 60`);
  const more = Array.from({ length: 8 }, (_, i) => addWorktree(d, `DL-${i}`));
  more.forEach((wt, i) => seed(d, `DL-${i}`, [wt]));
  await d.runner.sleep(3 * 86400_000);
  let statuses = 0;
  d.onGit(async (_cwd, args) => {
    if (args[0] === 'status' && !args.includes('--ignored') && ++statuses === 3) await d.runner.sleep(120_000);
    return undefined;
  });
  await runAutoGc(d.ctx, volume(d));
  // Status runs in the precheck, in the recheck under the claim and before `git worktree remove`: the third call is the first item's last.
  assert.equal(statuses, 3);
  assert.match(autoGcText(d), /usunięto 1;.*limit czasu max_run_s \(60 s\)/);
  assert.equal(more.filter(wt => fs.existsSync(wt)).length, 7);
});

it('AUTOGC0266-IGNORED: worktrees with ignored files outside ignored_ok or referenced by a report stay', async t => {
  const w = world('ignored', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 1000
    older_than: 2d
    categories: [closed_clean_worktrees]`);
  const env = addWorktree(w, 'IG-ENV'), cache = addWorktree(w, 'IG-CACHE'), cited = addWorktree(w, 'IG-CITED'), plain = addWorktree(w, 'IG-PLAIN'), vite = addWorktree(w, 'IG-VITE');
  fs.writeFileSync(path.join(env, '.env'), 'SECRET=1\n');
  w.ignored.set(env, '!! .env\0!! node_modules/\0');
  for (const dir of ['.cache/vite/deps', '.cache/evidence']) fs.mkdirSync(path.join(cache, dir), { recursive: true });
  fs.writeFileSync(path.join(cache, '.cache/evidence/shot.png'), 'png');
  w.ignored.set(cache, '!! .cache/\0!! node_modules/\0');
  fs.mkdirSync(path.join(vite, '.cache/vite/deps'), { recursive: true });
  w.ignored.set(vite, '!! .cache/\0!! node_modules/\0!! dist/\0');
  w.ignored.set(cited, '!! dist/\0!! node_modules/\0');
  for (const [task, wt] of [['IG-ENV', env], ['IG-CACHE', cache], ['IG-PLAIN', plain], ['IG-VITE', vite]] as const) seed(w, task, [wt]);
  const record = seed(w, 'IG-CITED', [cited]);
  fs.mkdirSync(path.dirname(record.report!), { recursive: true });
  fs.writeFileSync(record.report!, `Werdykt: PASS\nEvidence: ${path.join(cited, 'dist/out.js')}\n`);
  await w.runner.sleep(3 * 86400_000);
  freeSpace(t, () => 20 * GiB);
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  await runAutoGc(w.ctx, volume(w));
  assert.ok(fs.existsSync(path.join(env, '.env')));
  assert.ok(fs.existsSync(path.join(cache, '.cache/evidence/shot.png')));
  assert.ok(fs.existsSync(path.join(cited, 'dist/out.js')));
  assert.ok(!fs.existsSync(plain) && !fs.existsSync(vite));
  const text = autoGcText(w);
  assert.match(text, /ignored files outside auto_gc\.ignored_ok: \.env/);
  assert.match(text, /ignored files outside auto_gc\.ignored_ok: \.cache\/evidence/);
  assert.match(text, /referenced by report/);
});

it('AUTOGC0266-QUEUE: queued tasks keep their authors, bases and named paths, and a start/GC race resolves through path claims', async t => {
  const w = world('queue', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 1000
    older_than: 2d
    categories: [closed_clean_worktrees]`);
  const author = addWorktree(w, 'QA-AUTHOR'), base = addWorktree(w, 'QA-BASE'), named = addWorktree(w, 'QA-NAMED'), after = addWorktree(w, 'QA-AFTER'), free = addWorktree(w, 'QA-FREE');
  for (const [task, wt] of [['QA-AUTHOR', author], ['QA-BASE', base], ['QA-NAMED', named], ['QA-AFTER', after], ['QA-FREE', free]] as const) seed(w, task, [wt]);
  queueEntry(w, 1, 'QA-REVIEW', `---\ntask: QA-REVIEW\nagent: claude\nreview_of: QA-AUTHOR\nrepos: [{path: ${w.repo}}]\n---\nReview it.`, { reviewOf: 'QA-AUTHOR' });
  queueEntry(w, 2, 'QA-NEXT', `---\ntask: QA-NEXT\nagent: claude\nrepos: [{path: ${w.repo}, base: "@QA-BASE"}]\n---\nContinue.`);
  queueEntry(w, 3, 'QA-READ', `---\ntask: QA-READ\nagent: claude\nrepos: [{path: ${w.repo}}]\n---\nCompare with ${named}/src/index.ts please.`, { status: 'failed' });
  queueEntry(w, 4, 'QA-LATER', `---\ntask: QA-LATER\nagent: claude\nafter: [QA-AFTER]\nrepos: [{path: ${w.repo}}]\n---\nLater.`, { after: ['QA-AFTER'], status: 'starting' });
  await w.runner.sleep(3 * 86400_000);
  freeSpace(t, () => 20 * GiB);
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  await runAutoGc(w.ctx, volume(w));
  for (const wt of [author, base, named, after]) assert.ok(fs.existsSync(wt), wt);
  assert.ok(!fs.existsSync(free));
  const text = autoGcText(w);
  assert.match(text, /needed by queued task QA-REVIEW/);
  assert.match(text, /needed by queued task QA-NEXT/);
  assert.match(text, /path named by queued task QA-READ/);
  assert.match(text, /needed by queued task QA-LATER/);

  // Race 1: a task is queued after the precheck passed; the recheck under start.lock keeps the worktree.
  const late = addWorktree(w, 'QA-LATE');
  seed(w, 'QA-LATE', [late]);
  const device = String(fs.statSync(late).dev);
  const item: GcItem = { kind: 'worktree', task: 'QA-LATE', target: late, repo: w.repo, base: 'main', bytes: 0, detail: 'closed task' };
  item.bytes = await checkAutomaticGc(w.ctx, item, device, 2 * 86400_000);
  queueEntry(w, 5, 'QA-FIX', `---\ntask: QA-FIX\nagent: claude\nafter: [QA-LATE]\nrepos: [{path: ${w.repo}}]\n---\nFix.`, { after: ['QA-LATE'] });
  const plan = { includeCache: true, items: [item], skipped: [], freeBytes: 0, olderThanMs: 2 * 86400_000, unknownCacheDirs: 0, automatic: { device } };
  const first = await applyGc(w.ctx, plan);
  assert.equal(first.done.length, 0);
  assert.match(first.failed[0]?.reason ?? '', /needed by queued task QA-FIX/);
  assert.ok(fs.existsSync(late));

  // Race 2: a start holds its path claim; GC of the same path waits for the next run.
  fs.rmSync(path.join(queueDir(w.config), '0005-QA-FIX.json'));
  const releaseStart = await withStartLock(w.ctx, () => claimStartPaths(w.ctx, 'start', [late]));
  const second = await applyGc(w.ctx, plan);
  assert.match(second.failed[0]?.reason ?? '', /in use by a start/);
  releaseStart();

  // Race 3: GC holds the claim; a start of that path is held until the deletion is over.
  const { claimGcPath } = await import('../src/core/start-paths.ts');
  const releaseGc = await claimGcPath(w.ctx, late, async () => {});
  await assert.rejects(withStartLock(w.ctx, () => claimStartPaths(w.ctx, 'start', [late])), /trwa GC/);
  releaseGc();
});

it('AUTOGC0266-CLI: a CLI disk hold leaves the run to the watcher, and a stopped watcher finishes the current item only', async t => {
  const w = world('cli', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 1000
    older_than: 2d
    categories: [closed_clean_worktrees]`);
  const items = Array.from({ length: 3 }, (_, i) => addWorktree(w, `CL-${i}`));
  items.forEach((wt, i) => seed(w, `CL-${i}`, [wt]));
  await w.runner.sleep(3 * 86400_000);
  freeSpace(t, () => 20 * GiB);
  const { kickAutoGc, hostAutoGc, autoGcIdle } = await import('../src/core/auto-gc.ts');
  kickAutoGc(w.ctx, volume(w), { held: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(path.join(w.config.stateDir, 'auto-gc-kick.json')), 'the CLI leaves a request for the watcher');
  assert.equal(items.filter(wt => fs.existsSync(wt)).length, 3, 'a CLI process deletes nothing');
  assert.equal(readJournal(w.config).some(e => e.kind === 'disk-auto-gc'), false);

  // The watcher takes the request; Ctrl-C during the first deletion lets that item finish and stops before the next one.
  const stop = new AbortController();
  const unhost = hostAutoGc({ signal: stop.signal });
  w.onGit((_cwd, args) => { if (args[0] === 'worktree' && args[1] === 'remove') stop.abort(); return undefined; });
  const { takeAutoGcKick } = await import('../src/core/auto-gc.ts');
  assert.equal(await takeAutoGcKick(w.ctx), true);
  await new Promise(resolve => setTimeout(resolve, 20));
  await autoGcIdle();
  unhost();
  assert.equal(items.filter(wt => fs.existsSync(wt)).length, 2);
  const gone = items.find(wt => !fs.existsSync(wt))!;
  assert.ok(!fs.existsSync(path.join(gone, 'node_modules')), 'the interrupted item is removed whole');
  assert.match(autoGcText(w), /usunięto 1;.*zatrzymanie watch/);
});

it('AUTOGC0266-RELOAD: a reload of other settings keeps a run going, the journal records duration and statfs bytes, and a reused PID does not pin a path', async t => {
  const w = world('reload', `
    enabled: true
    trigger_free_gb: 30
    target_free_gb: 1000
    older_than: 2d
    categories: [closed_clean_worktrees]`);
  const items = Array.from({ length: 3 }, (_, i) => addWorktree(w, `RL-${i}`));
  items.forEach((wt, i) => seed(w, `RL-${i}`, [wt]));
  await w.runner.sleep(3 * 86400_000);
  let removed = 0;
  freeSpace(t, () => (20 + removed) * GiB);
  w.onGit((_cwd, args) => {
    if (args[0] === 'worktree' && args[1] === 'remove') {
      removed++;
      // set_limits or a hand edit of another key: a new config object with the same auto_gc settings.
      const reloaded = loadGlobalConfig(path.dirname(w.config.path));
      w.ctx.setConfig({ ...reloaded, watch: { ...reloaded.watch, interval: reloaded.watch.interval + 1 } });
    }
    return undefined;
  });
  // A claim left by a process whose PID now belongs to this (later started) process.
  const claims = path.join(w.config.stateDir, 'start-path-claims');
  fs.mkdirSync(claims, { recursive: true });
  fs.writeFileSync(path.join(claims, '00000000-0000-4000-8000-000000000000.json'), JSON.stringify({ pid: process.pid, kind: 'start', paths: [fs.realpathSync(items[0]!)], at: '2026-01-01T00:00:00.000Z', pidStartedAt: Date.parse('2025-12-31T00:00:00Z') }));
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  await runAutoGc(w.ctx, volume(w));
  assert.equal(removed, 3);
  const event = readJournal(w.config).find(e => e.kind === 'disk-auto-gc') as { text: string; diskGc?: { durationMs: number; freedBytes: number }[] } | undefined;
  assert.match(event?.text ?? '', /usunięto 3; odzyskano 3\.00 GiB \(statfs\).*czas \d+\.\d s/);
  assert.equal(event?.diskGc?.[0]?.freedBytes, 3 * GiB);
  assert.equal(typeof event?.diskGc?.[0]?.durationMs, 'number');
});

it('FIELD0268-AUTOGC: unchanged plans repeat only after the report interval and pinned tasks have measured sizes', async t => {
  const w = world('field-pinned', `
    enabled: true
    dry_run: true
    trigger_free_gb: 30
    target_free_gb: 40
    categories: [closed_clean_worktrees]`);
  const wt = addWorktree(w, 'PIN-ONE');
  seed(w, 'PIN-ONE', [wt], true, {pin: true});
  const data = path.join(wt, 'node_modules', 'payload');
  fs.writeFileSync(data, '');
  fs.truncateSync(data, 2 * GiB);
  freeSpace(t, () => 20 * GiB);
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  const { readWall, OWNER_IDENTITY } = await import('../src/core/wall.ts');
  const count = () => readWall(w.ctx, OWNER_IDENTITY, {channel: 'agentctl', archive: true}).messages
    .filter(message => message.subject === 'Automatyczne GC — plan').length;
  await runAutoGc(w.ctx, volume(w));
  assert.match(autoGcText(w), /worktree · pinned: 1 zadań, 2\.00 GiB.*agentctl unpin \/ WT-PARK.*pomiar/);
  assert.equal(count(), 1);
  await w.runner.sleep(10 * 60_000);
  await runAutoGc(w.ctx, volume(w));
  assert.equal(count(), 1);
  await w.runner.sleep(12 * 3600_000);
  await runAutoGc(w.ctx, volume(w));
  assert.equal(count(), 2);
});

it('FIELD0268-AUTOGC: after a dry-run deadline the next slice resumes the same inventory and candidate', async t => {
  const w = world('field-resume', `
    enabled: true
    dry_run: true
    trigger_free_gb: 30
    target_free_gb: 40
    categories: [closed_clean_worktrees]
    max_run_s: 1`);
  for (const task of ['SLOW-A', 'SLOW-B']) seed(w, task, [addWorktree(w, task)]);
  await w.runner.sleep(3 * 86400_000);
  freeSpace(t, () => 20 * GiB);
  let first = true;
  w.onGit(async (_cwd, args) => {
    if (first && args[0] === 'status' && !args.includes('--ignored')) {
      first = false;
      await w.runner.sleep(2000);
    }
    return undefined;
  });
  const { runAutoGc } = await import('../src/core/auto-gc.ts');
  await runAutoGc(w.ctx, volume(w));
  assert.equal(autoGcText(w), '', 'partial plans must stay off WALL and out of the completed-plan journal');
  await runAutoGc(w.ctx, volume(w));
  assert.match(autoGcText(w), /plan: 2 pozycji/);
  assert.equal(w.gitLog.filter(([, cmd, sub]) => cmd === 'worktree' && sub === 'list').length, 1);
  assert.equal(w.gitLog.filter(([, cmd, ...args]) => cmd === 'status' && !args.includes('--ignored')).length, 2);
});
