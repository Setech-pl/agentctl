import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { inspectReport } from '../src/core/report-state.ts';
import { archiveDir, renderTaskMd, snapshotRecords, taskFile } from '../src/core/taskstore.ts';
import { collectStatus } from '../src/core/status.ts';
import { applySnapshot, handleKey, initialBoardState, loadBoard, ProgressCache, TickGate } from '../src/core/board.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const body = 'done\n<!-- agentctl:report-end -->\n';
const time = new Date('2026-11-06T00:00:00Z');
function report(name: string) {
  const config = makeConfig(scratch.sub(name));
  const record = seedTask(config, 'R-1', { started: '2026-01-01T00:00:00Z', turnEndedAt: undefined });
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, body);
  return { config, record };
}
for (const atomic of [false, true]) {
  it(`F2: TASK.md detects ${atomic ? 'atomic replacement' : 'in-place rewrite'} with equal size and mtime`, async () => {
    const config = makeConfig(scratch.sub(`f2-task-${atomic}`));
    seedTask(config, 'R-1');
    const file = taskFile(config, 'r-1');
    fs.utimesSync(file, time, time);
    assert.equal((await snapshotRecords(config)).current[0]!.model, 'opus');
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace('model: opus', 'model: oops');
    assert.notEqual(before, after);
    assert.equal(before.length, after.length);
    const dest = atomic ? file + '.new' : file;
    fs.writeFileSync(dest, after);
    fs.utimesSync(dest, time, time);
    if (atomic) fs.renameSync(dest, file);
    assert.equal((await snapshotRecords(config)).current[0]!.model, 'oops');
  });
  it(`F2: report sentinel detects ${atomic ? 'atomic replacement' : 'in-place rewrite'} with equal size and mtime`, () => {
    const { config, record } = report(`f2-report-${atomic}`);
    fs.utimesSync(record.report, time, time);
    const first = inspectReport(config, record, Date.now(), false);
    assert.equal(first.sentinel, true);
    const dest = atomic ? record.report + '.new' : record.report;
    fs.writeFileSync(dest, body.replace('report-end', 'report-xxx'));
    fs.utimesSync(dest, time, time);
    if (atomic) fs.renameSync(dest, record.report);
    const next = inspectReport(config, record, Date.now(), false);
    assert.equal(next.sentinel, false);
    assert.equal(next.ready, false);
    assert.notEqual(next.signature, first.signature);
  });
}
it('F2: coarse change timestamps fall back to reading TASK.md and report bodies', async () => {
  const { config, record } = report('f2-coarse');
  const file = taskFile(config, record.window);
  fs.utimesSync(file, time, time);
  fs.utimesSync(record.report, time, time);
  const native = fs.lstatSync;
  try {
    // Model a filesystem whose ctime cannot distinguish equal-size writes within one tick.
    fs.lstatSync = ((...args: Parameters<typeof fs.lstatSync>) => {
      const st = native(...args);
      if (st && (args[0] === file || args[0] === record.report)) {
        if (typeof st.ctimeMs === 'bigint') return Object.assign(st, { ctimeMs: BigInt(time.getTime()), ctimeNs: BigInt(time.getTime()) * 1_000_000n });
        return Object.assign(st, { ctimeMs: time.getTime() });
      }
      return st;
    }) as typeof fs.lstatSync;
    await snapshotRecords(config);
    assert.equal(inspectReport(config, record, Date.now(), false).ready, true);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('model: opus', 'model: oops'));
    fs.utimesSync(file, time, time);
    fs.writeFileSync(record.report, body.replace('report-end', 'report-xxx'));
    fs.utimesSync(record.report, time, time);
    assert.equal((await snapshotRecords(config)).current[0]!.model, 'oops');
    assert.equal(inspectReport(config, record, Date.now(), false).ready, false);
  } finally { fs.lstatSync = native; }
});
