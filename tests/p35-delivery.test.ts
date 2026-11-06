import { composerFixture } from './composer-fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { readJournal } from '../src/core/journal.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P35: `prompt_delivery: sent` without a real delivery. A start that failed before any paste (needs-attention, no
 * deliveryStartedAt) could be flipped to "sent" by any working-looking screen (a human answered the dialog, the agent
 * initialized) — the prompt never reached the agent. Screen proofs now require a recorded paste, and a never-pasted
 * initial prompt is re-armed to pending so the watcher serves a window that became ready late.
 */

const scratch = useScratch();
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';
const IDLE = composerFixture('❯ \n');

function fixture(name: string) {
  const root = scratch.sub(name), config = makeConfig(root, 'capacity: {snapshot: false, codex_refresh: false}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
  const pane = tmux.add('t1', IDLE);
  const ctx = new Context(runner, config, () => {});
  const notified: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notified.push(text); } };
  seedTask(config, 'T1', { windowId: pane.id });
  const record = () => readTaskRecord(config, 't1')!;
  const pastes = () => runner.commands.filter((c) => c.includes('paste-buffer')).length;
  return { config, tmux, runner, pane, ctx, notified, notifier, record, pastes };
}

/** The state a failed start leaves: the original prompt in TASK.md, needs-attention, never pasted. */
async function failedStart(f: ReturnType<typeof fixture>): Promise<void> {
  await queuePrompt(f.ctx, f.record(), 'Original prompt');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'needs-attention', prompt_error: 'claude did not become ready; original prompt remains in TASK.md' });
}

describe('P35: no sent without a real delivery', () => {
  it('needs-attention + never pasted + a working screen: stays needs-attention, never sent', async () => {
    const f = fixture('phantom');
    await failedStart(f);
    f.pane.screen = WORKING; // the agent works (a human answered the dialog; a turn started by hand)
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    assert.equal(f.record().promptDelivery, 'needs-attention');
    assert.equal(f.record().pendingPrompt, 'Original prompt');
    assert.equal(f.pastes(), 0);
  });

  it('needs-attention + a recorded paste + a working screen: sent (pinned current behavior)', async () => {
    const f = fixture('real-paste');
    await failedStart(f);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { delivery_started_at: new Date(f.runner.now()).toISOString(), delivery_was_busy: null });
    f.pane.screen = WORKING;
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().promptDelivery, 'sent');
  });

  it('a pasted-but-unconfirmed delivery (Enter never taken) stays needs-attention and is never re-pasted', async () => {
    const f = fixture('unconfirmed');
    await failedStart(f);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { delivery_started_at: new Date(f.runner.now()).toISOString(), delivery_result: 'not-delivered-in-field', delivery_field: 'stale-field-image' });
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    assert.equal(f.record().promptDelivery, 'needs-attention');
    assert.equal(f.pastes(), 0, 'no re-paste of a delivery that was pasted');
  });

  it('a never-pasted initial prompt and an idle, readable window: re-armed to pending, then pasted once', async () => {
    const f = fixture('late-ready');
    await failedStart(f);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'pending', 're-armed, not terminal');
    assert.equal(f.record().promptDelivery, 'pending');
    assert.equal(f.pastes(), 0, 'the re-arm itself pastes nothing');
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.pastes(), 1);
    assert.equal(f.record().pendingPrompt, undefined);
  });

  it('a re-arm only happens while the window is idle and readable (a working window waits)', async () => {
    const f = fixture('late-busy');
    await failedStart(f);
    f.pane.screen = WORKING;
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention', 'no re-arm onto a busy screen');
    f.pane.screen = IDLE;
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'pending');
  });

  it('watch level: a failed start whose window became idle gets its original prompt delivered once', async () => {
    const f = fixture('watch-serves');
    await failedStart(f);
    const memory = new WatchMemory();
    await watchTick(f.ctx, memory, f.notifier);
    await watchTick(f.ctx, memory, f.notifier);
    assert.equal(f.record().promptDelivery, 'sent');
    assert.equal(f.pastes(), 1, 'exactly one paste');
  });
});
