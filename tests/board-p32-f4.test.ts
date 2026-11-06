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
for (const kind of ['closed', 'cancelled', 'duplicate'] as const) {
  it(`F4: live ${kind} rows keep tokens in default board mode`, async () => {
    const config = makeConfig(scratch.sub(`f4-${kind}`));
    const record = seedTask(config, 'TOK-1', kind === 'duplicate' ? {} : { [kind]: true });
    const transcript = path.join(path.dirname(config.path), 'tokens.jsonl');
    fs.copyFileSync(path.resolve('tests/fixtures/usage/claude-transcript.jsonl'), transcript);
    fs.writeFileSync(path.join(path.dirname(taskFile(config, record.window)), 'sessions.json'), JSON.stringify({ claude: [{ id: 'named', transcript }], codex: [] }));
    if (kind === 'duplicate') {
      const dir = path.join(archiveDir(config), record.window);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd({ ...record, closed: true }, 'old'));
    }
    const tmux = new FakeTmux(); tmux.add(record.window, '● idle\n❯ \n');
    const { ctx } = makeContext(config, { respond: tmux.respond });
    const records = await snapshotRecords(config);
    const deep = (await collectStatus(ctx, { records, archived: true, tokens: true }))[0]!;
    const shallow = (await collectStatus(ctx, { records, archived: true, tokens: true, shallowClosed: true }))[0]!;
    assert.equal(shallow.window, 'alive');
    assert.ok(deep.tokens);
    assert.deepEqual(shallow.tokens, deep.tokens);
  });
}
