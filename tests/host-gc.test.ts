import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { remoteGcProgram } from '../src/core/host-gc.ts';
import { planGc, applyGc, renderGc } from '../src/core/gc.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
const scratch = useScratch();
let serial = 0;
function world() {
  const root = scratch.sub(`gc-${serial++}`), work = path.join(root, 'work'), clone = path.join(root, 'app'), bin = path.join(root, 'bin');
  fs.mkdirSync(bin); fs.mkdirSync(work); fs.mkdirSync(clone);
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git('init', '-b', 'main', clone); git('-C', clone, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.test', 'commit', '--allow-empty', '-m', 'fixture');
  const wt = path.join(work, 'app-gc-1'); git('-C', clone, 'worktree', 'add', '-b', 'gc-task', wt);
  const liveFile = path.join(root, 'windows'); fs.writeFileSync(liveFile, '');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh\nif [ -s '${liveFile}' ]; then cat '${liveFile}'; else echo 'no sessions' >&2; exit 1; fi\n`, { mode: 0o700 });
  const now = Date.now(), timing = path.join(root, 'gc-timing.cjs');
  // Isolate the remote program's clock and child deadlines from load on the test machine.
  fs.writeFileSync(timing, `
    Date.now = () => ${now};
    const child = require('node:child_process');
    const spawn = child.spawnSync;
    child.spawnSync = (command, args, options) => spawn(command, args, { ...options, timeout: 0 });
  `);
  const config = makeConfig(root, `hosts:\n  pc:\n    ssh: fake@host\n    work_dir: ${work}\n    repos: {app: ${clone}}\n    providers: [claude]\n    env: {PATH: '${bin}:${process.env.PATH}'}\n`);
  let calls = 0, offline = false;
  class SSH extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
      if (cmd !== 'ssh') return { code: 0, stdout: '', stderr: '' };
      calls++;
      if (offline) return { code: 255, stdout: '', stderr: 'Connection refused' };
      try { return { code: 0, stdout: execFileSync('sh', ['-c', args.at(-1)!], { input: opts.input, encoding: 'utf8', env: { ...process.env, HOME: root, NODE_OPTIONS: `--require=${JSON.stringify(timing)}` }, stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' }; }
      catch (error) { const e = error as { status: number; stderr: string }; return { code: e.status, stdout: '', stderr: String(e.stderr) }; }
    }
  }
  const runner = new SSH({ dryRun: false }), ctx = new Context(runner, config, () => {});
  const remoteDir = path.join(work, '.agentctl/gc-1'), reports = path.join(work, 'reports/gc-1');
  fs.mkdirSync(remoteDir, { recursive: true }); fs.mkdirSync(reports, { recursive: true });
  const old = new Date(now - 9 * 86400_000);
  for (const [dir, name] of [[remoteDir, 'launch.sh'], [reports, 'log.txt']]) { fs.writeFileSync(path.join(dir!, name!), 'evidence'); fs.utimesSync(path.join(dir!, name!), old, old); }
  fs.writeFileSync(path.join(reports, 'GC-1.md'), 'Werdykt: PASS');
  const record = seedTask(config, 'GC-1', { host: 'pc', closed: true, repos: [{ path: clone, worktree: wt, branch: 'gc-task', base: 'main' }], remoteDir, remoteReport: path.join(reports, 'GC-1.md') });
  return { config, ctx, wt, clone, remoteDir, reports, record, git, liveFile, calls: () => calls, offline: () => { offline = true; } };
}
it('remote GC: host sizes, cached preview, on-host deletion, reports preserved', async () => {
  const w = world(), plan = await planGc(w.ctx, {includeCache: true});
  assert.match(renderGc(plan).join('\n'), /host pc:/);
  assert.ok(plan.items.some(i => i.host === 'pc' && i.kind === 'worktree' && i.bytes > 0));
  assert.equal(plan.items.filter(i => i.host === 'pc' && i.kind === 'cache').length, 2);
  const calls = w.calls(); const cached = await planGc(w.ctx, { cachedSizes: true, includeCache: true });
  assert.equal(w.calls(), calls, 'cached preview does not connect'); assert.equal(cached.freeBytes, plan.freeBytes);
  const result = await applyGc(w.ctx, plan);
  assert.deepEqual(result.failed, []); assert.ok(!fs.existsSync(w.wt));
  assert.ok(fs.existsSync(path.join(w.reports, 'GC-1.md')));
  assert.ok(!fs.existsSync(path.join(w.remoteDir, 'launch.sh')));
});
it('remote GC: dirty, active/shared, linked, protected and unreachable targets stay', async () => {
  const w = world(); fs.writeFileSync(path.join(w.wt, 'dirty'), 'keep');
  let plan = await planGc(w.ctx, {includeCache: true}); assert.ok(plan.skipped.some(s => /uncommitted/.test(s.reason))); assert.ok(fs.existsSync(w.wt));
  w.git('-C', w.wt, 'add', 'dirty'); w.git('-C', w.wt, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.test', 'commit', '-m', 'dirty now committed');
  seedTask(w.config, 'ACTIVE', { host: 'pc', repos: w.record.repos });
  plan = await planGc(w.ctx, {includeCache: true}); assert.ok(plan.skipped.some(s => /unfinished/.test(s.reason)));
  w.offline(); plan = await planGc(w.ctx, {includeCache: true}); assert.ok(plan.skipped.some(s => /unreachable/.test(s.reason))); assert.equal(plan.items.length, 0);
});
it('remote GC: revalidates live windows and recent cache after preview, never forces', async () => {
  const w = world(), plan = await planGc(w.ctx, {includeCache: true});
  fs.writeFileSync(w.liveFile, '@77\tGC renamed\tgc-1\n');
  let result = await applyGc(w.ctx, plan); assert.ok(result.failed.length); assert.ok(fs.existsSync(w.wt));
  fs.writeFileSync(w.liveFile, ''); fs.writeFileSync(path.join(w.reports, 'log.txt'), 'fresh');
  result = await applyGc(w.ctx, { ...plan, items: plan.items.filter(i => i.kind === 'cache') });
  assert.ok(result.failed.some(f => /newer/.test(f.reason))); assert.ok(fs.existsSync(path.join(w.reports, 'log.txt')));
});
it('remote GC: symlinks, escaped paths and nested reports are retained', async () => {
  const w = world(); fs.symlinkSync(w.clone, path.join(w.remoteDir, 'alias'));
  const dir = path.join(w.remoteDir, 'nested'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'report.md'), 'keep');
  const plan = await planGc(w.ctx, {includeCache: true});
  assert.ok(plan.skipped.some(s => /symlink/.test(s.reason)));
  assert.ok(plan.skipped.some(s => /contains a report/.test(s.reason)));
  const malicious = { ...plan.items.find(i => i.kind === 'worktree')!, target: w.clone };
  const result = await applyGc(w.ctx, { ...plan, items: [malicious] });
  assert.equal(result.done.length, 0); assert.ok(fs.existsSync(w.clone));
});
it('HOST-GC-TARGET: changing the SSH endpoint invalidates an owner-reviewed remote GC plan', async () => {
  assert.equal(typeof remoteGcProgram, 'function');
  const w = world(), plan = await planGc(w.ctx, {includeCache: true}), calls = w.calls();
  w.config.hosts.pc!.ssh = 'fake@other-host';
  const result = await applyGc(w.ctx, plan);
  assert.equal(result.done.length, 0); assert.ok(result.failed.every(f => /Host target changed/.test(f.reason)));
  assert.equal(w.calls(), calls, 'refuse before connecting to the changed host'); assert.ok(fs.existsSync(w.wt));
});
it('remote GC: links and protected checked-out branches remain intact', async () => {
  const w = world(); seedTask(w.config, 'LINKS', {host: 'pc', closed: true, links: [{from: 'dependency', to: w.wt}]});
  assert.ok((await planGc(w.ctx, {includeCache: true})).skipped.some(s => /links target/.test(s.reason)));
  const protectedWorld = world(); protectedWorld.git('-C', protectedWorld.wt, 'checkout', '--ignore-other-worktrees', 'main');
  assert.ok((await planGc(protectedWorld.ctx)).skipped.some(s => /main\/master/.test(s.reason)));
});

it('REL0243-GC: remote cache is opt-in and pin/keep/keep_cache protect at preview and apply', async () => {
  const w = world();
  let plan = await planGc(w.ctx);
  assert.equal(plan.items.filter(i => i.host && i.kind === 'cache').length, 0);
  assert.ok(plan.skipped.some(i => /include_cache/.test(i.reason)));
  plan = await planGc(w.ctx, {includeCache: true});
  seedTask(w.config, 'GC-1', {...w.record, pin: true});
  const applied = await applyGc(w.ctx, plan);
  assert.equal(applied.done.length, 0); assert.ok(fs.existsSync(w.wt));
  assert.equal((await planGc(w.ctx, {includeCache: true})).items.filter(i => i.host).length, 0);
  seedTask(w.config, 'GC-1', {...w.record, pin: false, keepCache: true});
  assert.equal((await planGc(w.ctx, {includeCache: true})).items.filter(i => i.host && i.kind === 'cache').length, 0);
  assert.equal((await planGc(w.ctx, {includeCache: true, keep: ['GC-1']})).items.filter(i => i.host).length, 0);
});
it('REL0243-GC: remote unpushed commits and report artifact references stay', async () => {
  const w = world();
  w.git('-C', w.wt, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.test', 'commit', '--allow-empty', '-m', 'not pushed');
  fs.writeFileSync(path.join(w.reports, 'GC-1.md'), '```agentctl-outputs\nversion: 1\nartifacts: [log.txt]\n```');
  const plan = await planGc(w.ctx, {includeCache: true});
  const details = renderGc(plan).join('\n');
  const worktree = plan.skipped.find(i => i.kind === 'worktree' && i.target === w.wt);
  assert.equal(worktree?.unpushedCommits, 1, details);
  assert.match(worktree.reason, /unpushed commits/, details);
  assert.ok(plan.skipped.some(i => i.target.endsWith('/log.txt') && /referenced/.test(i.reason)), details);
  assert.ok(!plan.items.some(i => i.target === w.wt || i.target.endsWith('/log.txt')), details);
});
