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
it('F3: current task repositories win over an archive duplicate', async () => {
  const config = makeConfig(scratch.sub('f3'));
  const record = seedTask(config, 'DUP-1');
  const old = path.join(config.stateDir, 'old-worktree');
  fs.mkdirSync(old, { recursive: true });
  const dir = path.join(archiveDir(config), record.window);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd({ ...record, closed: true, repos: [{ path: config.stateDir, worktree: old, branch: 'old' }] }, 'old'));
  const { ctx, runner } = makeContext(config, { respond: new FakeTmux().respond });
  const snapshot = await loadBoard(ctx, null, new ProgressCache());
  assert.equal(snapshot.rows[0]!.archived, false);
  assert.deepEqual(snapshot.rows[0]!.worktrees, []);
  assert.equal(runner.queries.some(c => c.includes('git') && c.includes(old)), false);
});
