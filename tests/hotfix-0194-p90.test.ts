import { watchTick, WatchMemory } from '../src/core/watch.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { world, scratch } from './hotfix-0194-fixture.ts';
import { seedTask } from './helpers.ts';
import { Alerts } from '../src/core/alert.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { sendPrompts } from '../src/core/send.ts';
import { drainPromptQueue, enqueuePrompt, promptQueueView, withdrawPrompt } from '../src/core/prompt-queue.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { readJournal } from '../src/core/journal.ts';
import { composerFixture } from './composer-fixture.ts';
for (const existingReport of [false, true]) it(`P90: busy Codex queues until confirmed turn end (existing report: ${existingReport})`, async () => {
  const w = world(`busy-${existingReport}`);
  const record = seedTask(w.config, 'BUSY', { agent: 'codex' });
  if (existingReport) {
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, 'Verdict: PASS\nExisting result.\n<!-- agentctl:report-end -->\n');
  }
  const pane = w.tmux.add('busy', composerFixture('• Working (esc to interrupt)\n› Ask Codex to do anything\n'));
  const [sent] = await sendPrompts(w.ctx, [{ task: 'BUSY', window: 'busy', prompt: 'Follow up after this turn.' }]);
  assert.match(sent!.message, /queued_until_turn_end/);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 0);
  const queued = promptQueueView(w.ctx, 'busy');
  assert.equal(queued.length, 1);
  if (existingReport) {
    const report = await w.call('get_report', { task: 'BUSY', detail: true });
    assert.equal(report.isError, undefined, report.text);
    assert.match(report.text, /Existing result/); assert.match(report.text, /report may predate it/);
  }
  assert.match((await w.call('status', { all: true, detail: true })).text, new RegExp(queued[0]!.id));
  assert.ok(readJournal(w.config).some(e => e.kind === 'delivery-queued' && e.text.includes(queued[0]!.id)));
  const extra = await enqueuePrompt(w.ctx, 'busy', 'Withdraw this');
  await withdrawPrompt(w.ctx, 'busy', extra.id);
  await drainPromptQueue(w.ctx, 'busy');
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 0);
  pane.screen = composerFixture('› Ask Codex to do anything\n');
  // One idle redraw in a busy turn is not a confirmed turn end.
  const memory = new WatchMemory(), notifier = { notify: async () => {} };
  await watchTick(w.ctx, memory, notifier);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 0);
  pane.screen = composerFixture('• Working (esc to interrupt)\n› Ask Codex to do anything\n');
  await watchTick(w.ctx, memory, notifier);
  pane.screen = composerFixture('› Ask Codex to do anything\n');
  await watchTick(w.ctx, memory, notifier);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 0, 'working resets the idle confirmation');
  const respond = w.runner.exec.bind(w.runner);
  w.runner.exec = async (cmd, args, opts) => {
    const result = await respond(cmd, args, opts);
    if (cmd === 'tmux' && args[0] === 'send-keys' && args.at(-1) === 'Enter') {
      pane.screen = composerFixture('• Working (esc to interrupt)\n› Ask Codex to do anything\n');
      await handleEvent(w.ctx, new Alerts(w.ctx, { notify: async () => {} }), { task: 'BUSY', agent: 'codex', payload: { type: 'agent-turn-complete', 'thread-id': 'hotfix-thread', 'input-messages': ['Follow up after this turn.'], 'last-assistant-message': 'Accepted' } });
    }
    if (cmd === 'tmux' && args[0] === 'capture-pane' && w.tmux.seen.some(s => s.startsWith('send-keys'))) return { ...result, stdout: pane.screen };
    return result;
  };
  await watchTick(w.ctx, memory, notifier);
  assert.equal(readTaskRecord(w.config, 'busy')!.promptDelivery, 'sent', JSON.stringify(readTaskRecord(w.config, 'busy')));
  assert.equal(readTaskRecord(w.config, 'busy')!.deliveryResult, 'delivered');
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 1);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('send-keys')).length, 1);
  await drainPromptQueue(w.ctx, 'busy');
  assert.equal(w.tmux.seen.filter(s => s.startsWith('send-keys')).length, 1);
});

it('P90: an idle Codex still receives the paste and Enter immediately', async () => {
  const w = world('idle');
  seedTask(w.config, 'IDLE', { agent: 'codex' });
  w.tmux.add('idle', composerFixture('› Ask Codex to do anything\n'));
  const [result] = await sendPrompts(w.ctx, [{ task: 'IDLE', window: 'idle', prompt: 'Immediate follow-up' }]);
  assert.equal(result!.outcome, undefined);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('paste-buffer')).length, 1);
  assert.equal(w.tmux.seen.filter(s => s.startsWith('send-keys')).length, 1);
});
