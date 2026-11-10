import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import threads from 'node:worker_threads';
import { PassThrough } from 'node:stream';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { runMcpServer } from '../src/mcp/server.ts';
import { syncBuiltinESMExports } from 'node:module';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { RealRunner } from '../src/core/runner.ts';
import { makeConfig, seedTask, useScratch, DiskRunner } from './helpers.ts';

const NativeWorker = threads.Worker;
let mode: 'normal' | 'crash' | 'hang' = 'normal', active = 0, peak = 0;
threads.Worker = class extends NativeWorker {
  constructor(source: string | URL, opts: ConstructorParameters<typeof NativeWorker>[1]) {
    super(mode === 'crash' ? 'throw Error("injected worker crash")' : `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${mode === 'hang' ? 5000 : 100});\n${source}`, opts);
    active++; peak = Math.max(peak, active); this.once('exit', () => active--);
  }
} as typeof NativeWorker;
syncBuiltinESMExports();
const { configureMeasurements, shutdownMeasurements, sizeOf, newestMtime } = await import('../src/core/fs-measure.ts');
const { collectDisk } = await import('../src/core/disk.ts');
const { applyGc } = await import('../src/core/gc.ts');
const scratch = useScratch();
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const defaults = () => configureMeasurements({ workers: 2, measurementTimeoutS: 600 });

describe('P19 FIX2: measurement failure and lifecycle controls', () => {
  it('disk.workers=1 caps disk, size and age requests together', async () => {
    const root = scratch.sub('cap-one'), config = makeConfig(root, 'disk: {workers: 1}\n');
    const ctx = new Context(new DiskRunner({ dryRun: false, startTime: Date.now() }), config, () => {});
    const paths = Array.from({ length: 4 }, (_, i) => { const wt = path.join(root, `wt${i}`); fs.mkdirSync(wt); fs.writeFileSync(path.join(wt, 'f'), '123'); seedTask(config, `CAP-${i}`, { repos: [{ path: root, worktree: wt }] }); return wt; });
    peak = active;
    configureMeasurements(config.disk);
    try {
      const disk = collectDisk(ctx); await Promise.all([disk, ...paths.map(p => sizeOf(p)), ...paths.map(p => newestMtime(p))]);
      assert.equal(peak, 1); assert.equal(active, 0); console.log('configured worker cap', peak);
    } finally { defaults(); }
  });

  it('a crashed foreground worker falls back within its slot; symlinks are not followed', async () => {
    const root = scratch.sub('crash'); fs.writeFileSync(path.join(root, 'f'), '12345'); fs.symlinkSync(path.join(root, 'f'), path.join(root, 'link'));
    const expected = 5 + fs.lstatSync(path.join(root, 'link')).size;
    mode = 'crash';
    try { assert.equal(await sizeOf(root), expected); assert.equal(active, 0); }
    finally { mode = 'normal'; }
  });

  it('a hung worker times out, exits and frees its slot without an unbounded fallback', async () => {
    const root = scratch.sub('timeout'); fs.writeFileSync(path.join(root, 'f'), 'abc');
    configureMeasurements({ workers: 1, measurementTimeoutS: 0.05 }); mode = 'hang'; const start = Date.now();
    try {
      await assert.rejects(sizeOf(root), /measurement timed out/); assert.equal(active, 0);
      assert.ok(Date.now() - start < 1500); console.log('timeout freed slot', Date.now() - start);
    } finally { mode = 'normal'; defaults(); }
    assert.equal(await sizeOf(root), 3);
  });

  it('shutdown cancels active and queued background requests without leaking workers', async () => {
    const root = scratch.sub('shutdown'), config = makeConfig(root, 'disk: {workers: 1}\n');
    const paths = Array.from({ length: 3 }, (_, i) => { const wt = path.join(root, `wt${i}`); fs.mkdirSync(wt); seedTask(config, `STOP-${i}`, { repos: [{ path: root, worktree: wt }] }); return wt; });
    const ctx = new Context(new DiskRunner({ dryRun: false, startTime: Date.now() }), config, () => {});
    const keep = setInterval(() => {}, 100); mode = 'hang';
    try {
      await collectDisk(ctx, undefined, { budgetMs: 1 });
      const results = Promise.allSettled(paths.map(p => sizeOf(p, { background: true })));
      await shutdownMeasurements(); const ended = await results;
      assert.ok(ended.every(r => r.status === 'rejected')); assert.equal(active, 0);
      console.log('shutdown', JSON.stringify({ rejected: ended.length, active }));
    } finally { mode = 'normal'; defaults(); clearInterval(keep); }
  });

  it('MCP stdin end cancels its background measurements before the server returns', async () => {
    const root = scratch.sub('mcp-close'), config = makeConfig(root);
    const ctx = new Context(new DiskRunner({ dryRun: false, startTime: Date.now() }), config, () => {});
    const transport: Transport = { async start() {}, async send() {}, async close() { transport.onclose?.(); } };
    const stdin = new PassThrough(); stdin.resume(); const keep = setInterval(() => {}, 100); mode = 'hang';
    try {
      const server = runMcpServer({ context: () => ctx, notify: async () => {} }, '0.17.4', transport, stdin);
      await pause(20);
      const result = Promise.allSettled([sizeOf(root, { background: true })]);
      stdin.end(); await server;
      assert.equal((await result)[0]?.status, 'rejected'); assert.equal(active, 0);
    } finally { mode = 'normal'; defaults(); clearInterval(keep); }
  });

  it('GC rechecks a cached age before deleting contents edited after the preview', async () => {
    const root = scratch.sub('gc-age'), config = makeConfig(root);
    const target = path.join(root, 'old-cache'); fs.mkdirSync(target); const file = path.join(target, 'f'); fs.writeFileSync(file, 'old');
    const old = new Date(Date.now() - 8 * 86400000); fs.utimesSync(file, old, old);
    await newestMtime(target);
    fs.writeFileSync(file, 'new content');
    const ctx = new Context(new RealRunner(), config, () => {});
    const result = await applyGc(ctx, { items: [{ kind: 'cache', task: 'AGE-1', target, bytes: 3, detail: 'old' }], skipped: [], freeBytes: 3, olderThanMs: 7 * 86400000, unknownCacheDirs: 0 });
    assert.equal(result.done.length, 0); assert.match(result.failed[0]?.reason ?? '', /changed since the plan/); assert.ok(fs.existsSync(file));
  });
});
