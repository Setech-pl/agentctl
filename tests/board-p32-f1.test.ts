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
it('F1: a warm digest still checks the current config and owner', () => {
  const { config, record } = report('f1-owner');
  assert.equal(inspectReport(config, record, Date.now(), false).ready, true);
  const other = makeConfig(scratch.sub('f1-other'));
  const denied = inspectReport(other, { ...record, repos: [] }, Date.now(), false);
  assert.equal(denied.ready, false);
  assert.match(denied.reason, /outside/);
});
it('F1: a warm digest rejects a newly symlinked ancestor', () => {
  const { config, record } = report('f1-symlink');
  assert.equal(inspectReport(config, record, Date.now(), false).ready, true);
  const parent = path.dirname(record.report);
  fs.renameSync(parent, parent + '-moved');
  fs.symlinkSync(parent + '-moved', parent);
  const denied = inspectReport(config, record, Date.now(), false);
  assert.equal(denied.ready, false);
  assert.match(denied.reason, /symlink/);
});
