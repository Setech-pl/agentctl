import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tryFileLock, withFileLock } from '../src/core/file-lock.ts';
import { requestMeasurement, shutdownMeasurements } from '../src/core/fs-measure.ts';
import { withResponseBudget } from '../src/core/response-budget.ts';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, ToolResult } from '../src/core/mcp-tools.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { readQueue } from '../src/core/queue.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, specText, useScratch } from './helpers.ts';
const scratch = useScratch();
class Clock {
  time = 0;
  timers = new Map<() => void, number>();
  now = () => this.time;
  schedule = (fn: () => void, ms: number) => { this.timers.set(fn, this.time + ms); return () => { this.timers.delete(fn); }; };
  advance(ms: number) { this.time += ms; for (const [fn, at] of this.timers) if (at <= this.time) { this.timers.delete(fn); fn(); } }
}
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(name: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [queue]}\ncapacity: {snapshot: false, codex_refresh: false}\n');
  const tmux = new FakeTmux();
  for (let i = 0; i < 4; i++) { seedTask(config, `LIVE-${i}`); tmux.add(`live-${i}`, 'Working (esc to interrupt)'); }
  const clock = new Clock();
  let slow = false;
  let release!: () => void;
  const held = new Promise<void>(yes => { release = yes; });
  class SlowRunner extends DiskRunner {
    override async exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
      if (slow) await held;
      return super.exec(cmd, args, opts);
    }
  }
  const runner = new SlowRunner({ dryRun: false, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const deps: McpDeps = { context: () => ctx, notify: async () => {}, budgetClock: clock };
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args as never);
  const repo = scratch.sub(`${name}-repo`); fs.mkdirSync(repo, { recursive: true });
  const spec = specText({ task: 'P62', agent: 'claude' }, repo);
  return { ctx, config, deps, call, spec, clock, hold: () => { slow = true; }, release };
}
for (const operation of ['queue preview', 'queue confirm', 'status', 'gc_preview']) it(`P62: ${operation} returns ${operation === 'queue confirm' ? 'its durable registration' : 'partial'} at the injected 8s budget under four-window load`, async () => {
  const f = fixture(operation.replaceAll(' ', '-'));
  let args: Record<string, unknown> = operation.startsWith('queue') ? { spec: f.spec } : {};
  if (operation === 'queue confirm') {
    const preview = await f.call('queue', args); assert.ok(!preview.isError, preview.text);
    args = { confirm: true, preview_token: /preview_token: (\S+)/.exec(preview.text)![1] };
  }
  f.hold();
  let result: ToolResult | undefined;
  const pending = f.call(operation.startsWith('queue') ? 'queue' : operation, args).then(r => { result = r; });
  await drain();
  f.clock.advance(8000); await drain();
  const bounded = result !== undefined;
  // Release the injected work even when the baseline fails this regression.
  f.clock.advance(60001); f.release(); await pending; await drain();
  assert.ok(bounded, `${operation}: still blocked at virtual 8s (held beyond 60s)`);
  if (operation === 'queue confirm') {
    // P93: the confirm needs no process at all: it records the accepted spec and the watcher validates it.
    assert.match(result!.text, /^Queued: P62 \(accepted\)/);
    assert.deepEqual(readQueue(f.config).map(e => [e.task, e.status]), [['P62', 'accepted']]);
    return;
  }
  assert.match(result!.text, /Partial result:/);
  assert.equal(readQueue(f.config).length, 0, 'expired confirmation cannot register work later');
});
it('P62: confirm retries share one durable registration, even while notifications are blocked', async () => {
  const f = fixture('receipt');
  let release!: () => void;
  f.deps.notify = () => new Promise<void>(yes => { release = yes; });
  const preview = await f.call('queue', { spec: f.spec });
  const token = /preview_token: (\S+)/.exec(preview.text)![1]!;
  let first: ToolResult | undefined;
  const pending = f.call('queue', { confirm: true, preview_token: token }).then(r => { first = r; });
  await drain();
  const immediate = first !== undefined;
  release?.(); await pending;
  assert.ok(immediate, 'confirm must not wait for the notification after the durable write');
  assert.ok(!first!.isError, first!.text);
  const retry = await f.call('queue', { confirm: true, preview_token: token });
  assert.match(retry.text, /already executed: P62/);
  assert.equal(readQueue(f.config).length, 1);
  const restarted = { ...f.deps };
  const replay = await MCP_TOOLS.find(t => t.name === 'queue')!.run(restarted, { confirm: true, preview_token: token } as never);
  assert.match(replay.text, /already executed: P62/);
  const status = await f.call('status', { format: 'json' });
  assert.match(status.text, /P62/);
  assert.match(status.text, /"state": "accepted"/);
});
it('P62: concurrent confirms for one preview share exactly one execution', async () => {
  const f = fixture('concurrent');
  const preview = await f.call('queue', { spec: f.spec });
  const token = /preview_token: (\S+)/.exec(preview.text)![1]!;
  const results = await Promise.all([f.call('queue', { confirm: true, preview_token: token }), f.call('queue', { confirm: true, preview_token: token })]);
  assert.ok(results.every(r => !r.isError), JSON.stringify(results));
  assert.equal(results.filter(r => r.text.includes('already executed: P62')).length, 1);
  assert.equal(readQueue(f.config).length, 1);
});

it('P62: an injected live lock cannot perform a late write after budget expiry', async () => {
  const f = fixture('slow-lock');
  const lock = path.join(f.config.stateDir, 'injected-watch.lock');
  const release = tryFileLock(lock)!;
  let wrote = false;
  let worker!: Promise<void>;
  const pending = withResponseBudget(() => {
    worker = withFileLock(lock, async () => { wrote = true; });
    return worker.then(() => 'complete');
  }, () => 'Partial result: held lock', f.clock);
  await drain(); f.clock.advance(8000);
  assert.equal(await pending, 'Partial result: held lock');
  release(); await assert.rejects(worker, /Partial result:/);
  assert.equal(wrote, false);
});

it('P62: GC returns unknown sizes immediately and reuses a completed background measurement', async () => {
  const f = fixture('gc-sizes');
  const record = seedTask(f.config, 'SIZED', { closed: true });
  const target = path.join(path.dirname(record.report), 'build.bin');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'x'.repeat(12345)); fs.utimesSync(target, 1, 1);
  try {
    const first = await f.call('gc_preview');
    assert.match(first.text, /Partial result:/);
    const lease = requestMeasurement(target);
    try { await lease.promise; } finally { lease.release(); }
    const second = await f.call('gc_preview');
    assert.equal(JSON.parse(second.text).freeBytes, 12345);
  } finally { await shutdownMeasurements(); }
});
it('P62: cloned contexts apply the selected tmux socket exactly once', async () => {
  const config = makeConfig(scratch.sub('clone-socket'), 'tmux: {socket: p62-test}\n');
  const seen: string[][] = [];
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => {
    if (cmd === 'tmux') seen.push(args);
    return { code: 0 };
  } });
  const first = new Context(runner, config, () => {});
  const clone = new Context(first.runner, config, () => {});
  await clone.tmux.hasSession();
  assert.deepEqual(seen[0]?.slice(0, 3), ['-L', 'p62-test', 'has-session']);
  assert.equal(seen[0]?.filter(arg => arg === '-L').length, 1);
});
it('P62: fresh registrations survive a partial response with a large cached payload', async () => {
  const f = fixture('cached-partial');
  const preview = await f.call('queue', { spec: f.spec });
  const token = /preview_token: (\S+)/.exec(preview.text)![1]!;
  f.config.mcp.maxResponseKb = 1;
  await f.call('status', { format: 'json' });
  const confirmed = await f.call('queue', { confirm: true, preview_token: token });
  assert.ok(!confirmed.isError, confirmed.text);
  f.hold();
  const pending = f.call('status', { format: 'json' });
  await drain(); f.clock.advance(8000);
  const partial = await pending;
  f.release(); await drain();
  assert.match(partial.text, /P62: accepted/);
  assert.ok(Buffer.byteLength(partial.text) <= 1024);
});
