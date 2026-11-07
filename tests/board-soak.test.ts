import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { it } from 'node:test';
import { runBoardApp } from '../src/board/app.ts';
import type { RefreshClock } from '../src/board/refresh-scheduler.ts';
import { sharedReader } from '../src/core/usage.ts';
import { RefreshScheduler } from '../src/board/refresh-scheduler.ts';
import { ProgressCache, TickGate } from '../src/core/board.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
/** All JS deadlines (including Ink, debounce and notice timers) run on this clock. */
class Clock implements RefreshClock {
  now = Date.now();
  timers = new Map<object, { at: number; callback: () => void; interval: number }>();
  set(callback: () => void, delay: number, interval = 0): object {
    const id = { unref() { return this; }, ref() { return this; }, refresh() { return this; } };
    this.timers.set(id, { at: this.now + delay, callback, interval });
    return id;
  }
  clear(id: unknown): void { this.timers.delete(id as object); }
  advance(ms: number): void {
    this.now += ms;
    // Coarse steps deliberately coalesce expired deadlines, as a suspended laptop does.
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.now && this.timers.has(id)) {
      this.timers.delete(id);
      if (timer.interval) this.timers.set(id, { ...timer, at: this.now + timer.interval });
      timer.callback();
    }
  }
}
class Terminal extends EventEmitter {
  columns = 120; rows = 30; isTTY = true;
  renders = 0; last = ''; onWrite?: () => void;
  write(chunk: string, ...args: unknown[]): boolean {
    this.last = String(chunk); this.renders++; this.onWrite?.();
    (args.find(a => typeof a === 'function') as (() => void) | undefined)?.();
    return true;
  }
}
class Keyboard extends PassThrough {
  isTTY = true;
  setRawMode(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
}
const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function drain(check: () => boolean, advance?: () => void): Promise<void> {
  for (let i = 0; i < 2000; i++) { if (check()) return; advance?.(); await turn(); }
  assert.fail('board failed to complete within 2000 event-loop turns');
}

it('eight-hour Ink soak keeps timers, watchers, listeners, caches and tick work bounded', async t => {
  const clock = new Clock();
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms = 0) => clock.set(fn, ms));
  t.mock.method(globalThis, 'clearTimeout', (id: unknown) => clock.clear(id));
  t.mock.method(globalThis, 'setInterval', (fn: () => void, ms = 0) => clock.set(fn, ms, ms));
  t.mock.method(globalThis, 'clearInterval', (id: unknown) => clock.clear(id));
  t.mock.method(Date, 'now', () => clock.now);
  const config = makeConfig(scratch.sub('soak'), 'board: {window_title: false}\n');
  const tmux = new FakeTmux();
  const records = Array.from({ length: 230 }, (_, i) => seedTask(config, `SOAK-${i}`, {
    repos: i < 8 ? [{ path: scratch.dir, worktree: scratch.dir, branch: 'soak' }] : [],
  }));
  for (const record of records) fs.mkdirSync(path.dirname(record.report), { recursive: true });
  let priorReport = records[8]!.report;
  fs.writeFileSync(priorReport, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  for (let i = 0; i < 8; i++) tmux.add(`soak-${i}`, 'Working (esc to interrupt)\n');
  const { ctx, runner } = makeContext(config, { respond: tmux.respond });
  t.mock.method(runner, 'now', () => clock.now);
  const term = new Terminal(), keys = new Keyboard();
  let ticks = 0, progressEntries = 0, queries = 0, watchers = 0, fileOps = 0;
  let overlap = 0, maxOverlap = 0;
  // Count actual fake-provider calls without retaining the RecordingRunner's query history.
  const exec = runner.exec.bind(runner);
  t.mock.method(runner, 'exec', async (...args: Parameters<typeof runner.exec>) => {
    queries++; overlap++; maxOverlap = Math.max(maxOverlap, overlap);
    try { return await exec(...args); }
    finally { overlap--; runner.queries.length = 0; runner.calls.length = 0; tmux.seen.length = 0; }
  });
  for (const name of ['readFileSync', 'statSync', 'lstatSync', 'readdirSync'] as const) {
    const original = fs[name];
    t.mock.method(fs, name, (...args: unknown[]) => { fileOps++; return Reflect.apply(original, fs, args); });
  }
  const watch = fs.watch.bind(fs);
  const liveWatchers = new Set<fs.FSWatcher>();
  t.mock.method(fs, 'watch', (...args: Parameters<typeof fs.watch>) => {
    const w = watch(...args); watchers++; liveWatchers.add(w);
    w.once('close', () => { watchers--; liveWatchers.delete(w); });
    return w;
  });
  const done = runBoardApp(ctx, false, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream }, undefined, {
    clock, now: () => clock.now, refreshed: count => { ticks++; progressEntries = count; },
  });
  const hooks = [globalThis.setTimeout, globalThis.clearTimeout, globalThis.setInterval, globalThis.clearInterval, Date.now, runner.now, runner.exec, fs.watch, fs.readFileSync, fs.statSync, fs.lstatSync, fs.readdirSync] as unknown as { mock: { resetCalls(): void } }[];
  const metrics: Record<string, number>[] = [];
  const base = clock.now;
  let oldSession = '';
  try {
    await drain(() => ticks > 0, () => clock.advance(1));
    await drain(() => [...clock.timers.values()].some(timer => timer.at > clock.now + 1000), () => clock.advance(1));
    for (let hour = 1; hour <= 8; hour++) {
      let tickMs = 0, work = 0, ioWork = 0;
      const beforeRenders = term.renders, beforeTicks = ticks;
      // 120 refreshes/hour with 30-second suspended/resumed clock steps, plus real watch storms.
      for (let step = 0; step < 120; step++) {
        const started = performance.now(), beforeQueries = queries, beforeIO = fileOps, before = ticks;
        clock.advance(29_950);
        const previous = records[7]!;
        fs.rmSync(path.join(config.stateDir, previous.window), { recursive: true });
        records[7] = seedTask(config, `ROTATE-${hour}-${step}`, { repos: previous.repos });
        tmux.windows = tmux.windows.filter(w => w.name !== previous.window);
        tmux.add(records[7]!.window, 'Working (esc to interrupt)\n');
        const session = path.join(scratch.dir, `session-${hour}-${step}.jsonl`);
        fs.writeFileSync(session, JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: scratch.dir }, timestamp: new Date(base).toISOString() }) + '\n');
        // Exercise the same shared reader as loadBoard, with rotating provider logs.
        const reader = sharedReader(config);
        // Unique, valid session files exercise both persistent metadata and parser states.
        for (let n = 0; n < 24; n++) {
          const file = `${session}-${n}`;
          fs.renameSync(session, file); reader.meta(file, 'codex'); reader.stats(file, 'codex'); fs.renameSync(file, session);
        }
        if (oldSession) fs.rmSync(oldSession);
        oldSession = session;
        const report = records[8 + step % 222]!.report;
        fs.rmSync(priorReport, { force: true });
        priorReport = report;
        fs.writeFileSync(report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
        for (let n = 0; n < 8; n++) fs.writeFileSync(path.join(config.stateDir, records[n]!.window, 'event.json'), '{}');
        await drain(() => ticks > before, () => clock.advance(1));
        // Flush fs.watch delivery, the trailing debounce and Ink's rendering deadlines.
        for (let n = 0; n < 5; n++) await turn();
        clock.advance(50); await turn();
        // A watcher may have started a follow-up after the observed snapshot. Wait for
        // scheduler completion/re-arm before jumping time or replacing fixture folders.
        await drain(() => [...clock.timers.values()].some(timer => timer.at > clock.now + 1000), () => clock.advance(1));
        for (const hook of hooks) hook.mock.resetCalls();
        tickMs += performance.now() - started; work += queries - beforeQueries; ioWork += fileOps - beforeIO;
      }
      // Let the coalesced trailing refresh settle before sampling a resource plateau.
      clock.advance(500); await turn();
      await drain(() => overlap === 0 && [...clock.timers.values()].some(timer => timer.at > clock.now + 1000));
      clock.advance(50); for (let n = 0; n < 5; n++) await turn();
      const keyAt = clock.now; let latency = -1;
      term.onWrite = () => { if (latency < 0 && term.last.includes('leave the board')) latency = clock.now - keyAt; };
      keys.write('?'); await turn(); clock.advance(50); await turn();
      await drain(() => latency >= 0);
      term.onWrite = undefined;
      keys.write('x'); await turn(); clock.advance(50); await turn();
      const cacheFile = path.join(path.dirname(config.path), 'usage-cache.json');
      const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const sizes = Object.values(saved as Record<string, unknown>).filter(v => typeof v === 'object' && v !== null).map(v => Object.keys(v!).length);
      const listeners = ([process, term, keys, ...liveWatchers] as EventEmitter[]).reduce((sum, emitter) => sum + emitter.eventNames().reduce((n, event) => n + emitter.listenerCount(event), 0), 0);
      for (const hook of hooks) hook.mock.resetCalls();
      (globalThis as typeof globalThis & { gc?: () => void }).gc?.();
      metrics.push({ hour, heapUsed: process.memoryUsage().heapUsed, timers: clock.timers.size,
        intervals: [...clock.timers.values()].filter(t => t.interval).length,
        handles: process.getActiveResourcesInfo().filter(n => n !== 'Immediate').length,
        watchers, listeners, progressEntries, usageEntries: sizes.reduce((a, b) => a + b, 0),
        tickMs: tickMs / (ticks - beforeTicks), tickWork: work / (ticks - beforeTicks), fileOps: ioWork / (ticks - beforeTicks), cacheBytes: fs.statSync(cacheFile).size, renders: term.renders - beforeRenders,
        ticks: ticks - beforeTicks, keyToRenderMs: latency, maxOverlap });
      if (process.env.AGENTCTL_SOAK_OUTPUT) fs.writeFileSync(process.env.AGENTCTL_SOAK_OUTPUT, JSON.stringify({ clockStepMs: 30000, records: 230, workingWindows: 8, metrics }, null, 2));
    }
  } finally {
    // Escape any view even when an assertion interrupts the key probe.
    keys.write('q'); await turn(); keys.write('q'); clock.advance(100); await turn(); await done;
    for (let n = 0; n < 5; n++) { clock.advance(100); await turn(); }
    if (process.env.AGENTCTL_SOAK_OUTPUT) fs.writeFileSync(process.env.AGENTCTL_SOAK_OUTPUT, JSON.stringify({ clockStepMs: 30000, records: 230, workingWindows: 8, metrics, teardown: { timers: clock.timers.size, watchers, keyboardListeners: keys.listenerCount('readable') } }, null, 2) + '\n');
  }
  assert.equal(metrics.length, 8);
  const first = metrics[0]!;
  for (const sample of metrics.slice(1)) {
    for (const key of ['timers', 'intervals', 'handles', 'watchers', 'listeners', 'progressEntries', 'usageEntries']) assert.ok(sample[key]! <= first[key]! + 2, `${key} grew: ${JSON.stringify(metrics)}`);
    assert.ok(sample.tickWork! <= first.tickWork! + 10, 'provider work per tick stays bounded');
    assert.ok(sample.cacheBytes! <= first.cacheBytes! + 32768, 'serialized cache work stays bounded');
    assert.ok(sample.fileOps! <= first.fileOps! + 50, 'filesystem work per tick stays bounded');
    assert.ok(sample.renders! / sample.ticks! <= first.renders! / first.ticks! + 0.25, 'render work per completed refresh stays bounded');
    assert.equal(sample.maxOverlap, 1);
    if ((globalThis as typeof globalThis & { gc?: () => void }).gc) assert.ok(sample.heapUsed! <= first.heapUsed! + 8 * 1024 ** 2, 'post-GC heap stays within an 8 MiB warm-up allowance');
    assert.ok(sample.keyToRenderMs! <= 50, 'key renders in one virtual render quantum');
  }
  assert.equal(watchers, 0);
  assert.equal(clock.timers.size, 0, 'all board and Ink deadlines released');
});

it('progress cache forgets removed tasks instead of retaining their repositories', async () => {
  const cache = new ProgressCache();
  const { runner } = makeContext(makeConfig(scratch.sub('progress')));
  for (let hour = 0; hour < 8; hour++) {
    for (let task = 0; task < 230; task++) await cache.get(runner, `${hour}-${task}`, [], hour * 3_600_000);
    cache.retain(Array.from({ length: 230 }, (_, task) => `${hour}-${task}`));
    assert.equal(cache.size, 230);
  }
});

it('held action keys do not build a backlog; exit clears notices and ignores late completion', async t => {
  const clock = new Clock();
  const config = makeConfig(scratch.sub('actions'), 'board: {window_title: false}\n');
  seedTask(config, 'ACTION');
  const tmux = new FakeTmux(); tmux.add('action', 'Working (esc to interrupt)\n');
  const { ctx, runner } = makeContext(config, { respond: tmux.respond });
  let calls = 0, release!: () => void, ticks = 0;
  const exec = runner.exec.bind(runner);
  t.mock.method(runner, 'exec', async (...args: Parameters<typeof runner.exec>) => {
    if (args[0] === 'tmux' && args[1][0] === 'select-window') { calls++; await new Promise<void>(resolve => { release = resolve; }); }
    return exec(...args);
  });
  const term = new Terminal(), keys = new Keyboard();
  const done = runBoardApp(ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream }, undefined, { clock, now: () => clock.now, refreshed: () => { ticks++; } });
  await drain(() => ticks > 0);
  keys.write('\r'); await drain(() => calls === 1);
  for (let n = 0; n < 100; n++) { keys.write('\r'); await turn(); }
  assert.equal(calls, 1);
  release(); for (let n = 0; n < 10; n++) await turn();
  assert.equal(calls, 1, 'no deferred commands after the slow action completes');
  assert.ok([...clock.timers.values()].some(timer => timer.at === clock.now + 6000), 'notice timer armed');
  keys.write('q'); await done; await turn();
  assert.equal(clock.timers.size, 0, 'unmount releases notice and refresh timers');
  ticks = 0;
  const lateKeys = new Keyboard();
  const lateDone = runBoardApp(ctx, true, { stdout: term as unknown as NodeJS.WriteStream, stdin: lateKeys as unknown as NodeJS.ReadStream }, undefined, { clock, now: () => clock.now, refreshed: () => { ticks++; } });
  await drain(() => ticks > 0);
  lateKeys.write('\r'); await drain(() => calls === 2);
  lateKeys.write('q'); await lateDone;
  release(); for (let n = 0; n < 10; n++) await turn();
  assert.equal(clock.timers.size, 0, 'late action completion cannot arm a notice after exit');
});

it('reopening a slow view coalesces to one active load and one latest request', async t => {
  const clock = new Clock();
  const config = makeConfig(scratch.sub('views'), 'board: {window_title: false}\n');
  seedTask(config, 'VIEW');
  const tmux = new FakeTmux(); tmux.add('view', 'Working (esc to interrupt)\n');
  const { ctx, runner } = makeContext(config, { respond: tmux.respond });
  let calls = 0, release!: () => void, ticks = 0;
  const exec = runner.exec.bind(runner);
  t.mock.method(runner, 'exec', async (...args: Parameters<typeof runner.exec>) => {
    if (args[0] === 'codex' && args[1][0] === 'app-server') { calls++; await new Promise<void>(resolve => { release = resolve; }); }
    return exec(...args);
  });
  const term = new Terminal(), keys = new Keyboard();
  const done = runBoardApp(ctx, false, { stdout: term as unknown as NodeJS.WriteStream, stdin: keys as unknown as NodeJS.ReadStream }, undefined, { clock, now: () => clock.now, refreshed: () => { ticks++; } });
  t.after(async () => { release?.(); keys.write('q'); await turn(); keys.write('q'); await done; });
  await drain(() => ticks > 0);
  keys.write('C'); await drain(() => calls === 1);
  for (let n = 0; n < 50; n++) { keys.write('q'); await turn(); keys.write('C'); await turn(); }
  assert.equal(calls, 1, 'a slow view has only one active provider request');
  release(); await drain(() => calls === 2);
  keys.write('q'); await turn(); keys.write('q'); await done;
  release(); for (let n = 0; n < 20; n++) await turn();
  assert.equal(calls, 2, 'the latest request replaces the reopening backlog');
  assert.equal(clock.timers.size, 0);
});

it('full-cadence eight-hour timer storm retains only one refresh deadline', async () => {
  const clock = new Clock();
  let calls = 0, running = 0, maxRunning = 0;
  const scheduler = new RefreshScheduler(async () => {
    running++; maxRunning = Math.max(maxRunning, running); calls++;
    await Promise.resolve(); running--;
  }, () => 2000, error => assert.fail(String(error)), clock);
  const gate = new TickGate(500, () => scheduler.request(), clock, () => clock.now);
  scheduler.start();
  let first = 0;
  for (let hour = 0; hour < 8; hour++) {
    const before = calls;
    for (let step = 0; step < 7200; step++) {
      clock.advance(500);
      for (let event = 0; event < 8; event++) gate.ping(clock.now);
      for (let promise = 0; promise < 8; promise++) await Promise.resolve();
      assert.ok(clock.timers.size <= 2);
    }
    if (hour === 0) first = calls - before;
    else assert.equal(calls - before, first, 'refresh work per full simulated hour is constant');
  }
  assert.equal(maxRunning, 1);
  scheduler.stop(); gate.stop();
  assert.equal(clock.timers.size, 0);
});
