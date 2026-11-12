import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { world, scratch } from './hotfix-0194-fixture.ts';
import { seedTask } from './helpers.ts';
import { queuePrompt } from '../src/core/prompt-delivery.ts';
import { enqueuePrompt, readPromptQueue, withdrawPrompt } from '../src/core/prompt-queue.ts';
import { readJournal } from '../src/core/journal.ts';
import { closeTask } from '../src/core/close.ts';
import { reportFingerprint } from '../src/core/report-state.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
for (const state of ['pending', 'withdrawn', 'stale', 'closed'] as const) it(`P91: get_report returns existing content and warning with ${state} follow-up`, async () => {
  const w = world(`report-${state}`);
  const record = seedTask(w.config, 'REPORT');
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, 'Verdict: PASS\nExisting result.\n<!-- agentctl:report-end -->\n');
  await queuePrompt(w.ctx, record, 'Undelivered follow-up', 'pending', { kind: 'followup' });
  await setHeaderFields(w.runner, taskFile(w.config, 'report'), { delivery_started_at: new Date(w.runner.now()).toISOString(), delivery_report_baseline: reportFingerprint(record.report) });
  const id = readTaskRecord(w.config, 'report')!.deliveryId!;
  if (state === 'withdrawn') {
    await setHeaderFields(w.runner, taskFile(w.config, 'report'), { delivery_started_at: null });
    await withdrawPrompt(w.ctx, 'report', id);
  }
  if (state === 'stale') await withdrawPrompt(w.ctx, 'report', id);
  if (state === 'closed') await closeTask(w.ctx, 'REPORT');
  for (const detail of [false, true]) {
    const result = await w.call('get_report', { task: 'REPORT', detail });
    assert.equal(result.isError, undefined, result.text);
    assert.match(result.text, /Existing result/);
    assert.match(result.text, /warning/);
    assert.match(result.text, /report may predate it/);
  }
  if (state !== 'pending') assert.equal(readTaskRecord(w.config, 'report')!.deliveryReportBaseline, undefined);
});
it('close journals one entry per message it drops (queued FIFO items and the unsent active prompt)', async () => {
  const w = world('close-journal');
  const record = seedTask(w.config, 'DROPS');
  await queuePrompt(w.ctx, record, 'Active, never delivered', 'pending', { kind: 'followup' });
  const active = readTaskRecord(w.config, 'drops')!.deliveryId!;
  const first = await enqueuePrompt(w.ctx, 'drops', 'Queued one', { waitForTurnEnd: true });
  const second = await enqueuePrompt(w.ctx, 'drops', 'Queued two', { waitForTurnEnd: true });
  await closeTask(w.ctx, 'DROPS');
  const dropped = readJournal(w.config).filter(e => e.kind === 'delivery' && e.task === 'DROPS' && /close odrzucił/.test(e.text));
  assert.equal(dropped.length, 3);
  for (const id of [active, first.id, second.id]) assert.equal(dropped.filter(e => e.text.includes(id.slice(0, 8))).length, 1, id);
  assert.deepEqual(readPromptQueue(w.ctx, 'drops'), []);
});
it('close journals nothing when no message was waiting', async () => {
  const w = world('close-journal-none');
  seedTask(w.config, 'CLEAN');
  await closeTask(w.ctx, 'CLEAN');
  assert.equal(readJournal(w.config).filter(e => /close odrzucił/.test(e.text)).length, 0);
});
