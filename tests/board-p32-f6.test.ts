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
it('F6: expansion requests deep data even when selection stays on an active row', async () => {
  const { config, record } = report('f6');
  seedTask(config, 'ACTIVE-1');
  fs.writeFileSync(taskFile(config, record.window), renderTaskMd({ ...record, closed: true }, 'closed'));
  const tmux = new FakeTmux(); tmux.add('active-1', '● idle\n❯ \n');
  const { ctx } = makeContext(config, { respond: tmux.respond });
  const snap = await loadBoard(ctx, 'ACTIVE-1', new ProgressCache());
  const state = applySnapshot(initialBoardState(100, 30), snap);
  const expanded = handleKey(state, 'a', {});
  assert.equal(expanded.state.selected, state.selected);
  assert.equal(expanded.state.showHidden, true);
  assert.deepEqual(expanded.effects, [{ type: 'refresh' }]);
});
