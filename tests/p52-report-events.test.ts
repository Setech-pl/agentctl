import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { journalOutputs } from '../src/core/outputs.ts';
import { recordJournal, readJournal } from '../src/core/journal.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('P52: repeated report writes emit once per attempt and legacy summaries dedupe decisions', async () => {
  const config = makeConfig(scratch.sub('p52'), 'report: {settle_s: 0}\n');
  const tmux = new FakeTmux();
  const ctx = new Context(new DiskRunner({ dryRun: false, respond: tmux.respond }), config, () => {});
  const record = seedTask(config, 'P52', { attemptId: 'attempt-one', outputsProtocol: 1 });
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(record.report, `Werdykt: PASS\n<!-- agentctl:attempt attempt-one -->\nedit ${i}\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ndecisions: [D1, D1]\nactions: []\n\`\`\`\n<!-- agentctl:report-end -->\n`);
    await journalOutputs(ctx, record);
    await recordJournal(ctx, { kind: 'report-ready', task: record.task, text: 'report ready' });
  }
  assert.equal(readJournal(config).filter(e => e.kind === 'report-outputs').length, 1);
  assert.equal(readJournal(config).filter(e => e.kind === 'report-ready').length, 1);
  const events = await collectEvents(ctx, { client: 'mcp', since: '1h', keep: true });
  assert.equal(events.summary.needYou.filter(s => s.includes('decision: D1')).length, 1);
});
it('P52: a completed new attempt is announced even inside the previous cross-source dedupe window', async () => {
  const { Alerts } = await import('../src/core/alert.ts');
  const config = makeConfig(scratch.sub('new-attempt-alert'));
  const ctx = new Context(new DiskRunner({ dryRun: false }), config, () => {});
  const alerts = new Alerts(ctx, { notify: async () => {} });
  const target = { task: 'P52', window: 'p52' };
  seedTask(config, 'P52', { attemptId: 'first' });
  assert.equal(await alerts.send(target, 'report-ready', 'First report', 'event'), 'sent');
  seedTask(config, 'P52', { attemptId: 'second' });
  assert.equal(await alerts.send(target, 'report-ready', 'Second report', 'watch'), 'sent');
  assert.equal(await alerts.send(target, 'report-ready', 'Second report edited', 'event'), 'duplicate');
});
