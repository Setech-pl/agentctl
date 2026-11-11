import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { world, scratch } from './hotfix-0194-fixture.ts';
import { seedTask } from './helpers.ts';
import { queuePrompt } from '../src/core/prompt-delivery.ts';
import { withdrawPrompt } from '../src/core/prompt-queue.ts';
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
