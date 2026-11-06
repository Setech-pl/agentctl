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
it('F5: an immediate watch tick cancels a due trailing timer', () => {
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout, nativeNow = Date.now;
  let callback: (() => void) | undefined;
  let clock = 1000;
  const fires: number[] = [];
  try {
    globalThis.setTimeout = ((fn: () => void) => { callback = fn; return { unref() {} }; }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => { callback = undefined; }) as unknown as typeof clearTimeout;
    Date.now = () => clock;
    const gate = new TickGate(500, () => fires.push(clock));
    gate.ping(clock); clock = 1100; gate.ping(clock); clock = 1600; gate.ping(clock); callback?.(); gate.stop();
    assert.deepEqual(fires, [1000, 1600]);
  } finally { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; Date.now = nativeNow; }
});
