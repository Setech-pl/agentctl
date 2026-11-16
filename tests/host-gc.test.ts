import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { planGc, applyGc } from '../src/core/gc.ts';
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
  const config = makeConfig(root, `hosts:\n  pc:\n    ssh: fake@host\n    work_dir: ${work}\n    repos: {app: ${clone}}\n    providers: [claude]\n    env: {PATH: '${bin}:${process.env.PATH}'}\n`);
  let calls = 0, offline = false;
  class SSH extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
      if (cmd !== 'ssh') return { code: 0, stdout: '', stderr: '' };
      calls++;
      if (offline) return { code: 255, stdout: '', stderr: 'Connection refused' };
      try { return { code: 0, stdout: execFileSync('sh', ['-c', args.at(-1)!], { input: opts.input, encoding: 'utf8', env: { ...process.env, HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' }; }
      catch (error) { const e = error as { status: number; stderr: string }; return { code: e.status, stdout: '', stderr: String(e.stderr) }; }
    }
  }
  const runner = new SSH(), ctx = new Context(runner, config, () => {});
  const remoteDir = path.join(work, '.agentctl/gc-1'), reports = path.join(work, 'reports/gc-1');
  fs.mkdirSync(remoteDir, { recursive: true }); fs.mkdirSync(reports, { recursive: true });
  const old = new Date(Date.now() - 9 * 86400_000);
  for (const [dir, name] of [[remoteDir, 'launch.sh'], [reports, 'log.txt']]) { fs.writeFileSync(path.join(dir!, name!), 'evidence'); fs.utimesSync(path.join(dir!, name!), old, old); }
  fs.writeFileSync(path.join(reports, 'GC-1.md'), 'Werdykt: PASS');
  const record = seedTask(config, 'GC-1', { host: 'pc', closed: true, repos: [{ path: clone, worktree: wt, branch: 'gc-task', base: 'main' }], remoteDir, remoteReport: path.join(reports, 'GC-1.md') });
  return { config, ctx, wt, clone, remoteDir, reports, record, git, liveFile, calls: () => calls, offline: () => { offline = true; } };
}
it('remote GC: host sizes, cached preview, on-host deletion, reports preserved', async () => {
  const w = world(), plan = await planGc(w.ctx);
  assert.ok(plan.items.some(i => i.host === 'pc' && i.kind === 'worktree' && i.bytes > 0));
  assert.equal(plan.items.filter(i => i.host === 'pc' && i.kind === 'cache').length, 2);
  const calls = w.calls(); const cached = await planGc(w.ctx, { cachedSizes: true });
  assert.equal(w.calls(), calls, 'cached preview does not connect'); assert.equal(cached.freeBytes, plan.freeBytes);
  const result = await applyGc(w.ctx, plan);
  assert.deepEqual(result.failed, []); assert.ok(!fs.existsSync(w.wt));
  assert.ok(fs.existsSync(path.join(w.reports, 'GC-1.md')));
  assert.ok(!fs.existsSync(path.join(w.remoteDir, 'launch.sh')));
});
it('remote GC: dirty, active/shared, linked, protected and unreachable targets stay', async () => {
  const w = world(); fs.writeFileSync(path.join(w.wt, 'dirty'), 'keep');
  let plan = await planGc(w.ctx); assert.ok(plan.skipped.some(s => /uncommitted/.test(s.reason))); assert.ok(fs.existsSync(w.wt));
  w.git('-C', w.wt, 'add', 'dirty'); w.git('-C', w.wt, '-c', 'user.name=Fake', '-c', 'user.email=fake@example.test', 'commit', '-m', 'dirty now committed');
  seedTask(w.config, 'ACTIVE', { host: 'pc', repos: w.record.repos });
  plan = await planGc(w.ctx); assert.ok(plan.skipped.some(s => /unfinished/.test(s.reason)));
  w.offline(); plan = await planGc(w.ctx); assert.ok(plan.skipped.some(s => /unreachable/.test(s.reason))); assert.equal(plan.items.length, 0);
});
it('remote GC: revalidates live windows and recent cache after preview, never forces', async () => {
  const w = world(), plan = await planGc(w.ctx);
  fs.writeFileSync(w.liveFile, '@77\tGC renamed\tgc-1\n');
  let result = await applyGc(w.ctx, plan); assert.ok(result.failed.length); assert.ok(fs.existsSync(w.wt));
  fs.writeFileSync(w.liveFile, ''); fs.writeFileSync(path.join(w.reports, 'log.txt'), 'fresh');
  result = await applyGc(w.ctx, { ...plan, items: plan.items.filter(i => i.kind === 'cache') });
  assert.ok(result.failed.some(f => /newer/.test(f.reason))); assert.ok(fs.existsSync(path.join(w.reports, 'log.txt')));
});
it('remote GC: symlinks, escaped paths and nested reports are retained', async () => {
  const w = world(); fs.symlinkSync(w.clone, path.join(w.remoteDir, 'alias'));
  const dir = path.join(w.remoteDir, 'nested'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'report.md'), 'keep');
  const plan = await planGc(w.ctx);
  assert.ok(plan.skipped.some(s => /symlink/.test(s.reason)));
  assert.ok(plan.skipped.some(s => /contains a report/.test(s.reason)));
  const malicious = { ...plan.items.find(i => i.kind === 'worktree')!, target: w.clone };
  const result = await applyGc(w.ctx, { ...plan, items: [malicious] });
  assert.equal(result.done.length, 0); assert.ok(fs.existsSync(w.clone));
});
