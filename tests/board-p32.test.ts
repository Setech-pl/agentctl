import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { inspectReport, reportDigestStats } from '../src/core/report-state.ts';
import { DISK_INTERVAL_MS } from '../src/core/disk.ts';
import { collectStatus } from '../src/core/status.ts';
import { archiveDir, readTaskRecord, renderTaskMd, snapshotRecords, taskDir, recordScanStats } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { sharedReader } from '../src/core/usage.ts';
import { boardRefreshMs, BOARD_IDLE_REFRESH_MS, BOARD_REFRESH_MS, handleKey, initialBoardState, loadBoard, ProgressCache, TickGate } from '../src/core/board.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

/** A minimal archived record (the archive counts it as closed, whatever the header says). */
function archiveTask(config: ReturnType<typeof makeConfig>, task: string, extra: Partial<TaskRecord> = {}): void {
  const window = task.toLowerCase();
  const record: TaskRecord = {
    task,
    window,
    session: config.session,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    repos: [],
    links: [],
    env: {},
    report: path.join(config.cache, window, `${task}.md`),
    started: new Date(Date.UTC(2026, 9, 31, 11, 0, 0)).toISOString(),
    closed: true,
    closedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
    turnEndedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
    requested: { agent: 'claude', model: 'opus', effort: 'high' },
    ...extra,
  };
  const dir = path.join(archiveDir(config), window);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd(record, `Do ${task}.`));
}

describe('p32: record scan cache', () => {
  it('parses each TASK.md once; an unchanged scan parses nothing again', async () => {
    const config = makeConfig(scratch.sub('rc1'));
    seedTask(config, 'RC-1');
    seedTask(config, 'RC-2');
    archiveTask(config, 'RC-3');
    const first = await snapshotRecords(config);
    assert.equal(first.parsed, 3);
    assert.deepEqual(first.current.map((r) => r.task), ['RC-1', 'RC-2']);
    assert.deepEqual(first.archived.map((r) => r.task), ['RC-3']);
    assert.deepEqual(first.all.map((r) => r.task), ['RC-1', 'RC-2', 'RC-3']);
    const second = await snapshotRecords(config);
    assert.equal(second.parsed, 0, 'no TASK.md changed: nothing is read or parsed again');
    assert.deepEqual(second.all.map((r) => r.task), ['RC-1', 'RC-2', 'RC-3']);
  });

  it('re-parses only the TASK.md that changed, and drops removed tasks', async () => {
    const config = makeConfig(scratch.sub('rc2'));
    seedTask(config, 'RC-1');
    seedTask(config, 'RC-2');
    const first = await snapshotRecords(config);
    assert.equal(first.parsed, 2);
    // A different size makes the change visible even inside one mtime tick.
    const file = path.join(taskDir(config, 'rc-1'), 'TASK.md');
    fs.appendFileSync(file, '\nmore prompt text\n');
    const second = await snapshotRecords(config);
    assert.equal(second.parsed, 1, 'only the appended TASK.md is read again');
    fs.rmSync(taskDir(config, 'rc-2'), { recursive: true, force: true });
    const third = await snapshotRecords(config);
    assert.equal(third.parsed, 0);
    assert.deepEqual(third.all.map((r) => r.task), ['RC-1'], 'the removed task leaves the snapshot');
  });

  it('counts the parses cumulatively for the tick regression assertions', async () => {
    const config = makeConfig(scratch.sub('rc3'));
    seedTask(config, 'RC-1');
    const before = recordScanStats.parsed;
    await snapshotRecords(config);
    assert.equal(recordScanStats.parsed, before + 1);
    await snapshotRecords(config);
    assert.equal(recordScanStats.parsed, before + 1, 'cached: no further parses');
  });
});

const REPORT_WITH_OUTPUTS = [
  '# Report',
  '',
  'Done.',
  '',
  '```agentctl-outputs',
  'version: 1',
  'verdict: PASS',
  'commits: []',
  'integrate: []',
  'decisions: []',
  'actions: []',
  'checks: []',
  'notes: []',
  '```',
  '',
  '<!-- agentctl:report-end -->',
  '',
].join('\n');

describe('p32: cheap rows for closed tasks', () => {
  it('a report body is read and hashed once per report version (dev/ino/mtime/size)', () => {
    const config = makeConfig(scratch.sub('cr1'));
    seedTask(config, 'CR-1');
    const record = readTaskRecord(config, 'cr-1')!;
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, REPORT_WITH_OUTPUTS);
    const before = reportDigestStats.reads;
    const first = inspectReport(config, record, Date.now(), true);
    assert.equal(first.ready, true);
    assert.equal(reportDigestStats.reads, before + 1);
    const second = inspectReport(config, record, Date.now(), true);
    assert.equal(second.ready, true);
    assert.equal(second.signature, first.signature);
    assert.equal(reportDigestStats.reads, before + 1, 'unchanged report: the body is not read again');
    fs.appendFileSync(record.report, 'late addition\n');
    const third = inspectReport(config, record, Date.now(), true);
    assert.equal(reportDigestStats.reads, before + 2, 'a changed report is read again');
    assert.notEqual(third.signature, first.signature);
  });

  it('shallowClosed skips the prompt queue and the outputs of closed rows, keeps the report state', async () => {
    const config = makeConfig(scratch.sub('cr2'));
    seedTask(config, 'CR-1', { closed: true, closedAt: new Date().toISOString() });
    const record = readTaskRecord(config, 'cr-1')!;
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, REPORT_WITH_OUTPUTS);
    fs.writeFileSync(path.join(taskDir(config, 'cr-1'), 'prompt-queue.json'), JSON.stringify([{ id: 'q1', text: 'hello', queuedAt: new Date().toISOString() }]));
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const fullRow = (await collectStatus(ctx, { archived: true })).find((r) => r.task === 'CR-1')!;
    assert.equal(fullRow.closed, true);
    assert.equal(fullRow.report, 'yes');
    assert.equal(fullRow.promptQueue?.length, 1, 'the deep row sees the queued prompt');
    assert.ok(fullRow.outputs, 'the deep row carries the outputs of a ready report');
    const shallowRow = (await collectStatus(ctx, { archived: true, shallowClosed: true })).find((r) => r.task === 'CR-1')!;
    assert.equal(shallowRow.closed, true);
    assert.equal(shallowRow.report, 'yes', 'the report state itself stays');
    assert.deepEqual(shallowRow.promptQueue, []);
    assert.equal(shallowRow.outputs, undefined);
    assert.equal(shallowRow.decisionsCount, undefined);
  });

  it('shallowClosed leaves active rows fully detailed', async () => {
    const config = makeConfig(scratch.sub('cr3'));
    seedTask(config, 'CR-1');
    const record = readTaskRecord(config, 'cr-1')!;
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, REPORT_WITH_OUTPUTS);
    fs.writeFileSync(path.join(taskDir(config, 'cr-1'), 'prompt-queue.json'), JSON.stringify([{ id: 'q1', text: 'hello', queuedAt: new Date().toISOString() }]));
    const tmux = new FakeTmux();
    tmux.add('cr-1', '● idle\n❯ \n');
    const { ctx } = makeContext(config, { respond: tmux.respond });
    const row = (await collectStatus(ctx, { archived: true, shallowClosed: true })).find((r) => r.task === 'CR-1')!;
    assert.equal(row.window, 'alive');
    assert.equal(row.promptQueue?.length, 1);
    assert.ok(row.outputs);
  });
});

describe('p32: one usage reader per board process', () => {
  it('sharedReader is one instance per agentctl home', () => {
    const one = makeConfig(scratch.sub('ur1'));
    const two = makeConfig(scratch.sub('ur2'));
    assert.equal(sharedReader(one), sharedReader(one), 'same home: the same reader');
    assert.notEqual(sharedReader(one), sharedReader(two), 'another home: another reader');
  });

  it('a long-lived reader still sees new session logs after dropListings', () => {
    const config = makeConfig(scratch.sub('ur3'));
    const reader = sharedReader(config);
    const dir = scratch.sub('ur3/logs');
    fs.writeFileSync(path.join(dir, 'a.jsonl'), '{}\n');
    assert.deepEqual(reader.list(dir, '.jsonl'), ['a.jsonl']);
    fs.writeFileSync(path.join(dir, 'b.jsonl'), '{}\n');
    assert.deepEqual(reader.list(dir, '.jsonl'), ['a.jsonl'], 'listings are cached within a tick');
    reader.dropListings();
    assert.deepEqual(reader.list(dir, '.jsonl'), ['a.jsonl', 'b.jsonl'], 'the next tick lists again');
  });

  it('a tick that read nothing new does not rewrite usage-cache.json', async () => {
    const config = makeConfig(scratch.sub('ur4'));
    seedTask(config, 'UR-1');
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const cacheFile = path.join(path.dirname(config.path), 'usage-cache.json');
    await loadBoard(ctx, null, new ProgressCache());
    const before = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).mtimeMs : null;
    await loadBoard(ctx, null, new ProgressCache());
    const after = fs.existsSync(cacheFile) ? fs.statSync(cacheFile).mtimeMs : null;
    assert.equal(after, before, 'the second tick leaves the cache file untouched');
  });
});

describe('p32: disk report off the tick', () => {
  it('the disk report is re-collected on its own cadence, not on every tick', async () => {
    const config = makeConfig(scratch.sub('dk1'));
    seedTask(config, 'DK-1');
    const { ctx, runner } = makeContext(config, { respond: new FakeTmux().respond });
    const cache = new ProgressCache();
    const first = await loadBoard(ctx, null, cache);
    assert.ok(first.disk);
    const second = await loadBoard(ctx, null, cache);
    assert.equal(second.disk, first.disk, 'within the cadence the last report is kept');
    await runner.sleep(DISK_INTERVAL_MS + 1);
    const third = await loadBoard(ctx, null, cache);
    assert.ok(third.disk);
    assert.notEqual(third.disk, first.disk, 'after the cadence it is collected again');
  });
});

describe('p32: adaptive refresh and the watch debounce', () => {
  it('fast while any task is alive or unfinished, slow when everything is closed', () => {
    const active = { closed: false, cancelled: false, finished: false };
    assert.equal(boardRefreshMs([active]), BOARD_REFRESH_MS);
    assert.equal(boardRefreshMs([{ ...active, finished: true }]), BOARD_IDLE_REFRESH_MS);
    assert.equal(boardRefreshMs([{ ...active, closed: true }]), BOARD_IDLE_REFRESH_MS);
    assert.equal(boardRefreshMs([{ ...active, cancelled: true }]), BOARD_IDLE_REFRESH_MS);
    assert.equal(boardRefreshMs([{ ...active, finished: true }, active]), BOARD_REFRESH_MS, 'one active task is enough');
    assert.equal(boardRefreshMs([]), BOARD_IDLE_REFRESH_MS);
  });

  it('watch events tick at once, then at most one trailing tick per window', async () => {
    let fired = 0;
    const gate = new TickGate(80, () => fired++);
    gate.ping(Date.now());
    assert.equal(fired, 1, 'the first event fires right away');
    gate.ping(Date.now());
    gate.ping(Date.now());
    assert.equal(fired, 1, 'events inside the window are coalesced');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fired, 2, 'exactly one trailing tick after the window');
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.ping(Date.now());
    assert.equal(fired, 3, 'past the window the next event fires right away again');
    gate.stop();
  });
});

// ---- the 230-archived-tasks regression fixture (generated under AGENTCTL_LIVE_CACHE when set, else the scratch dir)

function buildFixture(root: string, count: number): ReturnType<typeof makeConfig> {
  const config = makeConfig(root);
  for (let i = 0; i < count; i++) {
    const task = `P32-${String(i + 1).padStart(3, '0')}`;
    const window = task.toLowerCase();
    const report = path.join(config.cache, window, `${task}.md`);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, REPORT_WITH_OUTPUTS);
    archiveTask(config, task);
  }
  return config;
}

const fixtures = new Map<string, ReturnType<typeof makeConfig>>();
function fixture(name: string, count: number): ReturnType<typeof makeConfig> {
  let config = fixtures.get(name);
  if (!config) {
    const base = process.env.AGENTCTL_LIVE_CACHE ?? scratch.dir;
    config = buildFixture(path.join(base, name), count);
    fixtures.set(name, config);
  }
  return config;
}

describe('p32: regression on 230 archived tasks', () => {
  it('the second tick parses no TASK.md and reads no report body, and stays under 100 ms', async () => {
    const config = fixture('p32-fixture-230', 230);
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const cache = new ProgressCache();
    const first = await loadBoard(ctx, null, cache);
    assert.equal(first.rows.length, 230);
    const parsedBefore = recordScanStats.parsed;
    const readsBefore = reportDigestStats.reads;
    const at = performance.now();
    const second = await loadBoard(ctx, null, cache);
    const ms = performance.now() - at;
    assert.equal(second.rows.length, 230);
    assert.equal(recordScanStats.parsed, parsedBefore, 'no TASK.md is parsed on the second tick');
    assert.equal(reportDigestStats.reads, readsBefore, 'no report body is read on the second tick');
    assert.ok(ms < 100, `second tick took ${ms.toFixed(1)} ms`);
  });

  it('50 arrow keys are each handled within 150 ms while a cold tick runs', async () => {
    const config = fixture('p32-fixture-latency-230', 230);
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const pending = loadBoard(ctx, null, new ProgressCache());
    let state = initialBoardState(100, 30);
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const at = performance.now();
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          state = handleKey(state, '', { downArrow: true }).state;
          worst = Math.max(worst, performance.now() - at);
          resolve();
        });
      });
    }
    await pending;
    assert.ok(worst < 150, `worst key latency ${worst.toFixed(1)} ms`);
  });

  it('an idle board stays under 2% of one core over 60 s', { skip: process.env.AGENTCTL_P32_PERF !== '1' }, async () => {
    const config = fixture('p32-fixture-230', 230);
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const cache = new ProgressCache();
    await loadBoard(ctx, null, cache); // warm, as a long-running board is
    const cpuStart = process.cpuUsage();
    const started = Date.now();
    let ticks = 0;
    while (Date.now() - started < 60_000) {
      await loadBoard(ctx, null, cache);
      ticks++;
      const wait = started + ticks * BOARD_IDLE_REFRESH_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const cpu = process.cpuUsage(cpuStart);
    const pct = ((cpu.user + cpu.system) / 1000 / (Date.now() - started)) * 100;
    assert.ok(pct < 2, `idle board used ${pct.toFixed(2)}% of one core over ${ticks} ticks`);
  });
});
