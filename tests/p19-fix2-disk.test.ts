import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it } from 'node:test';
import { listTaskRecords } from '../src/core/taskstore.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const OriginalWorker = threads.Worker;
let active = 0, peak = 0;
const scanned = new Map<string, number>();
threads.Worker = class extends OriginalWorker {
  constructor(source: string | URL, opts: ConstructorParameters<typeof OriginalWorker>[1]) {
    super(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);\n${source}`, opts);
    const target = String(opts?.workerData?.target);
    scanned.set(target, (scanned.get(target) ?? 0) + 1);
    active++; peak = Math.max(peak, active);
    this.once('exit', () => active--);
  }
} as typeof OriginalWorker;
syncBuiltinESMExports();
const { collectDisk } = await import('../src/core/disk.ts');
const { sizeOf, newestMtime, planGc } = await import('../src/core/gc.ts');
const scratch = useScratch();
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function sampledDisk(ctx: Context) {
  await Promise.all(listTaskRecords(ctx.config).flatMap(r => r.repos.map(repo => sizeOf(repo.worktree, { now: () => ctx.runner.now() }))));
  return collectDisk(ctx);
}

describe('P19 FIX2: worktree measurement ownership and freshness', () => {
  it('R2: cold inventory churn and GC share one scan per path with at most two live workers', async () => {
    const keep = setInterval(() => {}, 100);
    try {
      peak = active; scanned.clear();
      const root = scratch.sub('churn'), config = makeConfig(root);
      const tree = path.join(root, 'tree'); fs.mkdirSync(tree);
      const files = Number(process.env.P19_FIX2_FILES ?? 1000);
      for (let i = 0; i < files; i++) fs.writeFileSync(path.join(tree, `f${i}`), 'x');
      const runner = new DiskRunner({ dryRun: false, startTime: Date.now() });
      const ctx = new Context(runner, config, () => {});
      seedTask(config, 'BIG-1', { repos: [{ path: root, worktree: tree }], closed: true });
      const cold = await collectDisk(ctx, undefined, { budgetMs: 1 });
      assert.equal(cold.measuring, true); assert.equal(cold.worktreeBytes, null);
      await Promise.all(Array.from({ length: 50 }, () => collectDisk(ctx, undefined, { budgetMs: 1 })));
      const shared = Promise.all([sizeOf(tree, { now: () => runner.now() }), newestMtime(tree, { now: () => runner.now() }), planGc(ctx)]);
      for (let i = 0; i < 8; i++) {
        const wt = path.join(root, `small-${i}`); fs.mkdirSync(wt);
        seedTask(config, `SMALL-${i}`, { repos: [{ path: root, worktree: wt }] });
        await collectDisk(ctx, undefined, { budgetMs: 0 });
      }
      await shared; const result = await sampledDisk(ctx);
      for (let i = 0; i < 500 && active; i++) await pause(10);
      console.log('R2', JSON.stringify({ files, peak, active, scans: Object.fromEntries(scanned), total: result.worktreeBytes }));
      assert.ok(peak <= 2, `peak ${peak} exceeds the global cap 2`);
      assert.equal(scanned.get(tree), 1, 'the large tree is scanned once across inventories and GC');
      assert.ok([...scanned.values()].every(n => n === 1), 'each path scanned at most once in the freshness window');
      assert.equal(result.worktreeBytes, files); assert.equal(active, 0);
    } finally { clearInterval(keep); }
  });

  it('R3: path TTLs never renew on inventory churn; aggregate time is the oldest contributing reading', async () => {
    const root = scratch.sub('ages'), config = makeConfig(root);
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() }); const ctx = new Context(runner, config, () => {});
    const add = (task: string) => { const wt = path.join(root, task); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'f'), '12345'); seedTask(config, task, { repos: [{ path: root, worktree: wt }] }); return wt; };
    const first = add('TREE-1'); const initial = await sampledDisk(ctx);
    fs.writeFileSync(path.join(first, 'f'), 'x'.repeat(100));
    await runner.sleep(240000); add('TREE-2'); const four = await sampledDisk(ctx);
    console.log('R3 four minutes', JSON.stringify(four));
    assert.equal(four.measuredAt, initial.measuredAt, 'new paths cannot renew old path timestamps');
    assert.equal(four.worktreeBytes, 10, 'the original size is allowed only until its own TTL expires');
    await runner.sleep(240000); add('TREE-3'); const eight = await sampledDisk(ctx);
    assert.equal(eight.worktreeBytes, 110); assert.equal(Date.parse(eight.measuredAt), runner.now() - 240000);
    await runner.sleep(240000); add('TREE-4'); await sampledDisk(ctx);
    await runner.sleep(240000); add('TREE-5'); const sixteen = await sampledDisk(ctx); assert.equal(sixteen.worktreeBytes, 120);
    fs.rmSync(first, { recursive: true }); await runner.sleep(240000); add('TREE-6'); const removed = await sampledDisk(ctx);
    assert.equal(removed.worktreeBytes, 25); console.log('R3 final', JSON.stringify({ sixteen: sixteen.worktreeBytes, removed: removed.worktreeBytes }));
  });

  it('R3: removed and replaced root identities invalidate fresh path sizes immediately', async () => {
    const root = scratch.sub('identity'), config = makeConfig(root), wt = path.join(root, 'wt'); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'f'), '12345');
    seedTask(config, 'IDENTITY-1', { repos: [{ path: root, worktree: wt }] });
    const ctx = new Context(new DiskRunner({ dryRun: false, startTime: Date.now() }), config, () => {});
    assert.equal((await sampledDisk(ctx)).worktreeBytes, 5);
    fs.renameSync(wt, `${wt}-old`); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'f'), '123456789');
    assert.equal((await sampledDisk(ctx)).worktreeBytes, 9);
    fs.rmSync(wt, { recursive: true }); assert.equal((await sampledDisk(ctx)).worktreeBytes, 0);
  });

  it('R5: a standalone background parent exits promptly; foreground callers wait for their result', async () => {
    const gcUrl = new URL('../src/core/gc.ts', import.meta.url).href;
    const source = (background: boolean) => `import threads from 'node:worker_threads';import{syncBuiltinESMExports}from'node:module';const Original=threads.Worker;threads.Worker=class extends Original{constructor(source,opts){super('Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);\\n'+source,opts)}};syncBuiltinESMExports();const{sizeOf}=await import(${JSON.stringify(gcUrl)});${background ? 'void' : 'const bytes=await'} sizeOf(${JSON.stringify(path.join(scratch.dir, 'absent'))}, {background:${background}});console.log(${background ? '"parent has no more work"' : '"RESULT "+bytes'});`;
    const run = (background: boolean) => new Promise<{ ms: number; code: number | null; out: string }>((resolve, reject) => {
      const start = Date.now(); const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', source(background)], { env: process.env });
      let out = ''; child.stdout.on('data', x => out += x); child.stderr.on('data', x => out += x);
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('standalone measurement did not exit')); }, 10000);
      child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ ms: Date.now() - start, code, out }); });
    });
    const bg = await run(true); console.log('R5 background', JSON.stringify(bg));
    assert.equal(bg.code, 0, bg.out); assert.ok(bg.ms < 1250, `background parent waited ${bg.ms}ms`);
    const fg = await run(false); console.log('R5 foreground', JSON.stringify(fg));
    assert.equal(fg.code, 0, fg.out); assert.match(fg.out, /RESULT 0/); assert.ok(fg.ms >= 1500);
  });
});
