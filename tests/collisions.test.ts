import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { attachCollisions, collideOf, collideText, collectOverlaps, CollisionMemory, collisionTick, findOverlaps, globToRegExp, matchesAny, pairKey, renderOverlaps, touchWarnings } from '../src/core/collisions.ts';
import type { TaskFiles } from '../src/core/collisions.ts';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { renderStatusTable } from '../src/render.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

/** A scripted git: per worktree the committed files over `main` and the uncommitted ones. */
class FakeGit {
  committed = new Map<string, string[]>();
  dirty = new Map<string, string[]>();
  calls = 0;
  respond = (cmd: string, args: string[]): { code?: number; stdout?: string } | undefined => {
    if (cmd !== 'git' || args[0] !== '-C') return undefined;
    this.calls++;
    const wt = args[1] as string;
    const rest = args.slice(2);
    if (rest[0] === 'status') return { stdout: (this.dirty.get(wt) ?? []).map((f) => ` M ${f}`).join('\n') };
    if (rest[0] === 'rev-parse') return { code: 0, stdout: 'abc' };
    if (rest[0] === 'rev-list') return { stdout: `${(this.committed.get(wt) ?? []).length > 0 ? 1 : 0}\n` };
    if (rest[0] === 'diff') return { stdout: (this.committed.get(wt) ?? []).join('\n') };
    return undefined;
  };
}

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  const git = new FakeGit();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => git.respond(cmd, args) ?? tmux.respond(cmd, args, opts) });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  /** A running task in the repo (worktree <repo>-<task>) that changed these files. */
  const task = (id: string, files: { committed?: string[]; dirty?: string[] }, repoPath = repo): string => {
    const worktree = `${repoPath}-${id.toLowerCase()}`;
    tmux.add(id.toLowerCase());
    seedTask(config, id, { repos: [{ path: repoPath, worktree }] });
    git.committed.set(worktree, files.committed ?? []);
    git.dirty.set(worktree, files.dirty ?? []);
    return worktree;
  };
  return { root, repo, config, tmux, git, runner, ctx, out, notified, notifier, task };
}

describe('collisions: globs', () => {
  it('* stays in a folder, ** crosses folders, ? is one character, {a,b} alternatives, a bare pattern matches the file name anywhere', () => {
    const m = (glob: string, file: string): boolean => globToRegExp(glob).test(file);
    assert.ok(m('src/menu/*.ts', 'src/menu/a.ts'));
    assert.ok(!m('src/menu/*.ts', 'src/menu/deep/a.ts'));
    assert.ok(m('src/menu/**', 'src/menu/deep/a.ts'));
    assert.ok(m('src/**/a.ts', 'src/a.ts'));
    assert.ok(m('src/**/a.ts', 'src/x/y/a.ts'));
    assert.ok(m('src/a?.ts', 'src/ab.ts'));
    assert.ok(!m('src/a?.ts', 'src/a/.ts'));
    assert.ok(m('*.{css,scss}', 'web/theme/site.scss'));
    assert.ok(m('package-lock.json', 'client/package-lock.json'));
    assert.ok(!m('src/menu/*.ts', 'other/src/menu/a.ts'));
    assert.ok(!m('a.b', 'aXb'), 'a dot is a dot');
    assert.ok(matchesAny('x/y.lock', ['*.md', '*.lock']));
  });
});

describe('collisions: finding them', () => {
  const t = (task: string, ...repos: [string, string[]][]): TaskFiles => ({ task, repos: repos.map(([repoPath, files]) => ({ repoPath, files })) });

  it('tasks of the same repository that share files; different repositories never collide', () => {
    const overlaps = findOverlaps([t('A', ['/r', ['a.ts', 'b.ts', 'c.ts']]), t('B', ['/r', ['b.ts', 'c.ts', 'd.ts']]), t('C', ['/other', ['b.ts']])]);
    assert.deepEqual(overlaps, [{ a: 'A', b: 'B', repo: '/r', files: ['b.ts', 'c.ts'] }]);
    assert.deepEqual(collideOf(overlaps, 'A'), [{ task: 'B', files: 2 }]);
    assert.deepEqual(collideOf(overlaps, 'C'), []);
    assert.equal(collideText(collideOf(overlaps, 'B')), '⚠ A: 2');
  });

  it('collisions.ignore leaves out lock files and the like', () => {
    const tasks = [t('A', ['/r', ['a.ts', 'package-lock.json']]), t('B', ['/r', ['package-lock.json']])];
    assert.equal(findOverlaps(tasks).length, 1);
    assert.deepEqual(findOverlaps(tasks, ['**/package-lock.json']), []);
  });

  it('pairKey does not depend on the order', () => {
    assert.equal(pairKey('B', 'A'), pairKey('A', 'B'));
  });
});

describe('collisions: status', () => {
  it('collectStatus fills collide from the git data of the worktrees; finished and other-repo tasks are left out', async () => {
    const s = setup('status');
    s.task('LANDING-QS-1', { committed: ['src/a.ts', 'src/b.ts'] });
    s.task('LANDING-BRAND-1', { dirty: ['src/a.ts', 'src/b.ts', 'src/z.ts'] });
    const elsewhere = scratch.sub('status/elsewhere');
    s.task('OTHER-1', { committed: ['src/a.ts'] }, elsewhere);
    const rows = await collectStatus(s.ctx);
    const by = Object.fromEntries(rows.map((r) => [r.task, r.collide]));
    assert.deepEqual(by['LANDING-QS-1'], [{ task: 'LANDING-BRAND-1', files: 2 }]);
    assert.deepEqual(by['LANDING-BRAND-1'], [{ task: 'LANDING-QS-1', files: 2 }]);
    assert.deepEqual(by['OTHER-1'], []);
    // the window of one task goes away: it no longer takes part
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'landing-qs-1');
    assert.deepEqual((await collectStatus(s.ctx)).find((r) => r.task === 'LANDING-BRAND-1')!.collide, []);
  });

  it('status shows a COLLIDE column only while something collides, like "⚠ LANDING-QS-1: 2"', async () => {
    const s = setup('status-col');
    s.task('LANDING-QS-1', { committed: ['a.ts', 'b.ts'] });
    s.task('LANDING-BRAND-1', { committed: ['a.ts', 'b.ts'] });
    const r = await runCli(s.config, s.runner, ['status']);
    assert.match(r.stdout.split('\n').find((line) => line.includes('PROGRESS'))!, /PROGRESS\s+COLLIDE\s+REPORT/);
    assert.match(r.stdout, /LANDING-BRAND-1[^\n]*⚠ LANDING-QS-1: 2/);
    assert.match(r.stdout, /LANDING-QS-1[^\n]*⚠ LANDING-BRAND-1: 2/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['status', '--json'])).stdout) as { task: string; collide: unknown }[];
    assert.deepEqual(json.find((x) => x.task === 'LANDING-QS-1')!.collide, [{ task: 'LANDING-BRAND-1', files: 2 }]);
    const clean = setup('status-clean');
    clean.task('A-1', { committed: ['a.ts'] });
    clean.task('A-2', { committed: ['b.ts'] });
    assert.doesNotMatch((await runCli(clean.config, clean.runner, ['status'])).stdout, /COLLIDE/);
  });

  it('collisions.enabled: false switches the column off', async () => {
    const s = setup('status-off', 'collisions: {enabled: false}\n');
    s.task('A-1', { committed: ['a.ts'] });
    s.task('A-2', { committed: ['a.ts'] });
    assert.deepEqual((await collectStatus(s.ctx)).map((r) => r.collide), [[], []]);
    assert.equal(attachCollisions([], [], false).length, 0);
    assert.doesNotMatch(renderStatusTable(await collectStatus(s.ctx)).join('\n'), /COLLIDE/);
  });
});

describe('collisions: overlap command', () => {
  it('lists the shared files per pair, or only the pairs with one task', async () => {
    const s = setup('overlap');
    s.task('A-1', { committed: ['x/1.ts', 'x/2.ts'] });
    s.task('A-2', { committed: ['x/1.ts', 'x/2.ts', 'y.ts'] });
    s.task('A-3', { committed: ['y.ts'] });
    let r = await runCli(s.config, s.runner, ['overlap']);
    assert.match(r.stdout, /A-1 <-> A-2 {2}2 shared files {2}\(.*app\)\n {2}x\/1\.ts\n {2}x\/2\.ts/);
    assert.match(r.stdout, /A-2 <-> A-3 {2}1 shared file /);
    r = await runCli(s.config, s.runner, ['overlap', 'a-3']);
    assert.doesNotMatch(r.stdout, /A-1/);
    assert.match(r.stdout, /A-2 <-> A-3/);
    r = await runCli(s.config, s.runner, ['overlap', '--json']);
    assert.equal((JSON.parse(r.stdout) as unknown[]).length, 2);
    r = await runCli(s.config, s.runner, ['overlap', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no task "nope"/);
    const none = setup('overlap-none');
    none.task('B-1', { committed: ['a.ts'] });
    assert.match((await runCli(none.config, none.runner, ['overlap'])).stdout, /No two active tasks change the same files\./);
    assert.deepEqual(renderOverlaps([]), ['No two active tasks change the same files.']);
    assert.deepEqual(await collectOverlaps(none.ctx), []);
  });
});

describe('collisions: watch notifications', () => {
  it('one notification per new pair, not again while it lasts, again when it comes back; the pairs survive a restart of the watcher', async () => {
    const s = setup('watch', 'collisions: {interval: 300}\n');
    const wtA = s.task('A-1', { committed: ['a.ts'] });
    s.task('A-2', { committed: ['a.ts', 'b.ts'] });
    const memory = new CollisionMemory();
    await collisionTick(s.ctx, memory, s.notifier);
    assert.deepEqual(s.notified, ['⚠ A-1 i A-2 zmieniają te same pliki (1): a.ts']);
    // not time yet
    const calls = s.git.calls;
    assert.equal(await collisionTick(s.ctx, memory, s.notifier), undefined);
    assert.equal(s.git.calls, calls, 'git is not asked before the interval is over');
    // time passes: still colliding, no second message
    await s.runner.sleep(301_000);
    await collisionTick(s.ctx, memory, s.notifier);
    assert.equal(s.notified.length, 1);
    // a restart of the watcher does not announce it again
    await s.runner.sleep(301_000);
    await collisionTick(s.ctx, new CollisionMemory(), s.notifier);
    assert.equal(s.notified.length, 1);
    // the collision is resolved, later it happens again: a new message
    s.git.committed.set(wtA, ['other.ts']);
    await s.runner.sleep(301_000);
    await collisionTick(s.ctx, memory, s.notifier);
    s.git.committed.set(wtA, ['a.ts', 'c.ts']);
    await s.runner.sleep(301_000);
    await collisionTick(s.ctx, memory, s.notifier);
    assert.equal(s.notified.length, 2);
    assert.match(s.notified[1]!, /A-1 i A-2 zmieniają te same pliki \(1\)/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(path.dirname(s.config.path), 'collisions.json'), 'utf8')).pairs.includes('A-1|A-2'));
  });

  it('three tasks make three pairs; notify: false and enabled: false say nothing', async () => {
    const s = setup('watch3');
    for (const id of ['A-1', 'A-2', 'A-3']) s.task(id, { committed: ['same.ts'] });
    await collisionTick(s.ctx, new CollisionMemory(), s.notifier);
    assert.equal(s.notified.length, 3);
    const quiet = setup('watch-quiet', 'collisions: {notify: false}\n');
    quiet.task('A-1', { committed: ['same.ts'] });
    quiet.task('A-2', { committed: ['same.ts'] });
    await collisionTick(quiet.ctx, new CollisionMemory(), quiet.notifier);
    assert.equal(quiet.notified.length, 0);
    const off = setup('watch-off', 'collisions: {enabled: false}\n');
    off.task('A-1', { committed: ['same.ts'] });
    off.task('A-2', { committed: ['same.ts'] });
    assert.equal(await collisionTick(off.ctx, new CollisionMemory(), off.notifier), undefined);
  });

  it('a watch tick runs the check at its interval', async () => {
    const s = setup('watch-tick');
    s.task('A-1', { committed: ['same.ts'] });
    s.task('A-2', { committed: ['same.ts'] });
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    assert.ok(s.notified.some((m) => m.includes('A-1 i A-2')));
  });
});

describe('collisions: touches', () => {
  const specs = (s: ReturnType<typeof setup>, text: string) => splitSpecs(text, 't').map((raw) => resolveSpec(raw, { config: s.config, loadProject: () => undefined }));
  const specText = (s: ReturnType<typeof setup>, touches: string, task = 'N-1'): string => `---\ntask: ${task}\nagent: claude\ntouches: ${touches}\nrepos:\n  - {path: ${s.repo}, worktree: ${s.repo}-${task.toLowerCase()}}\n---\nDo it.\n`;

  it('warns when an active task of the repo already changes files that match', async () => {
    const s = setup('touches');
    s.task('A-1', { committed: ['src/menu/a.ts', 'src/menu/b.ts', 'docs/x.md'] });
    const warnings = await touchWarnings(s.ctx, specs(s, specText(s, '[src/menu/**, "*.css"]')));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /N-1 touches src\/menu\/\*\*, \*\.css, and A-1 already changes 2 matching files in .*app: src\/menu\/a\.ts, src\/menu\/b\.ts/);
    assert.deepEqual(await touchWarnings(s.ctx, specs(s, specText(s, 'src/other/**'))), []);
    assert.deepEqual(await touchWarnings(s.ctx, specs(s, specText(s, 'src/menu/**').replace(/touches: .*\n/, ''))), [], 'no touches, no check');
  });

  it('touches must be globs', () => {
    const s = setup('touches-bad');
    assert.throws(() => specs(s, specText(s, '[1]')), /touches must be a glob or a list of globs/);
  });

  it('queue shows the warning in the summary and asks "anyway"; new prints it and asks "Start anyway?"', async () => {
    const s = setup('touches-cli');
    s.task('A-1', { committed: ['src/menu/a.ts'] });
    const asked: string[] = [];
    let r = await runCli(s.config, s.runner, ['queue', '-'], { readStdin: () => specText(s, 'src/menu/**'), confirm: async (q) => (asked.push(q), false) });
    assert.match(r.stdout, /⚠ N-1 touches src\/menu\/\*\* and A-1 already changes|⚠ N-1 touches src\/menu\/\*\*, and A-1 already changes/);
    assert.deepEqual(asked, ['Add to the queue anyway? [y/N] ']);
    asked.length = 0;
    s.tmux.newWindowScreen = '❯ \n';
    r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => specText(s, 'src/menu/**'), confirm: async (q) => (asked.push(q), false) });
    assert.match(r.stdout, /⚠ N-1 touches/);
    assert.match(r.stdout, /Aborted, nothing was done\./);
    assert.deepEqual(asked, ['Start anyway? [y/N] ']);
    assert.ok(!s.tmux.windows.some((w) => w.name === 'n-1'));
    // -y does not ask; without a terminal the warning is printed and the task starts
    r = await runCli(s.config, s.runner, ['new', '-y', '-'], { readStdin: () => specText(s, 'src/menu/**'), confirm: async () => assert.fail('asked') });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(s.tmux.windows.some((w) => w.name === 'n-1'));
    r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => specText(s, 'src/menu/**', 'N-2') });
    assert.match(r.stdout, /⚠ N-2 touches/);
    assert.equal(r.code, 0, r.stderr);
  });
});
