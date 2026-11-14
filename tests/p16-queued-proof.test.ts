import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import { drainPromptQueue, promptQueueView } from '../src/core/prompt-queue.ts';
import { sendPrompts } from '../src/core/send.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { composerFixture } from './composer-fixture.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P16 (live-p15-send failed from 0.19.4 on): what a message that waited in the durable queue ends up with. The release scenario read the TASK.md header
 * right after the Codex follow-up was queued and found the delivery of the FIRST prompt there (sent / delivered / source screen): since P90 the queued
 * message does not touch the header until it is pasted. The Codex tests pin the rule the scenario was meant to check: a queued message gets
 * `delivery_source: transcript` when the rollout holds exactly it, and stays unconfirmed (no source, not delivered) when it does not.
 * P16-f1 (found while checking the other agents): GLM runs Claude Code, but its transcript was read with the Codex parser, so a GLM message never
 * got the transcript proof (or the queue-acceptance note) the Claude one gets.
 */
const scratch = useScratch();
let serial = 0;
const prompt = 'Also check the empty case and answer FOLLOWUP-OK when you are done.';
const idle = composerFixture('› Ask Codex to do anything\n');
const working = composerFixture('• Working (esc to interrupt)\n› Ask Codex to do anything\n');

/** The two rows codex-cli 0.167 writes when it takes a user message (checked against a real rollout: the item has `text` parts, the response item `input_text`). */
const codexRows = (text: string, at: number) => [
  { timestamp: new Date(at).toISOString(), ordinal: 11, type: 'response_item', payload: { type: 'message', id: 'msg_x', role: 'user', content: [{ type: 'input_text', text }] } },
  { timestamp: new Date(at).toISOString(), ordinal: 12, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'p16-thread', turn_id: 'turn-2', item: { type: 'UserMessage', id: 'um_x', content: [{ type: 'text', text }] } } },
];

async function codexWorld() {
  const root = scratch.sub(`codex-${++serial}`), codexDir = path.join(root, 'codex');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {codex_dir: ${codexDir}}\nlimits: {codex: 5}\n`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() - 1000, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const pane = tmux.add('t1', working);
  seedTask(config, 'T1', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' });
  const dir = path.join(codexDir, 'sessions', '2026', '11', '14'), transcript = path.join(dir, 'rollout-2026-11-14T10-00-00-p16-thread.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'p16-thread', cwd: root } }) + '\n');
  await rememberSession(runner, config, 't1', 'codex', { id: 'p16-thread' });
  // The first prompt of the task was taken long ago: this is what the header says until the queued message is pasted.
  await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'sent', prompt_kind: 'initial', delivery_result: 'delivered', delivery_source: 'screen', delivery_started_at: new Date(runner.now() - 600_000).toISOString() });
  const record = () => readTaskRecord(config, 't1')!;
  const count = (sub: string) => tmux.seen.filter(s => s.startsWith(sub)).length;
  /** `taken`: what the rollout gets the moment Enter goes in. */
  const wire = (taken: (at: number) => object[]) => {
    const respond = runner.exec.bind(runner);
    runner.exec = async (cmd, args, opts) => {
      const result = await respond(cmd, args, opts);
      if (cmd === 'tmux' && args[0] === 'send-keys' && args.at(-1) === 'Enter') {
        pane.screen = working;
        for (const row of taken(runner.now())) fs.appendFileSync(transcript, JSON.stringify(row) + '\n');
      }
      return result;
    };
  };
  const queueAndDrain = async () => {
    const [sent] = await sendPrompts(ctx, [{ task: 'T1', window: 't1', prompt }]);
    assert.match(sent!.message, /queued_until_turn_end/);
    const waiting = record();
    // While the message waits for the turn end the header still describes the earlier delivery: only the queue lists the new one.
    assert.equal(waiting.deliverySource, 'screen');
    assert.equal(waiting.promptKind, 'initial');
    assert.deepEqual(promptQueueView(ctx, 't1').map(p => p.state), ['queued']);
    pane.screen = idle;
    await drainPromptQueue(ctx, 't1', 'waiting');
  };
  return { ctx, config, runner, transcript, record, count, wire, queueAndDrain };
}

describe('P16: a message of the durable Codex queue and its proof', () => {
  it('P16 queued Codex follow-up: the rollout line of exactly that message delivers it with source transcript', async () => {
    const w = await codexWorld();
    w.wire(at => codexRows(prompt, at));
    await w.queueAndDrain();
    const done = w.record();
    assert.equal(done.promptKind, 'followup');
    assert.equal(done.promptDelivery, 'sent');
    assert.equal(done.deliveryResult, 'delivered');
    assert.equal(done.deliverySource, 'transcript');
    assert.equal(done.pendingPrompt, undefined);
    assert.equal(w.count('paste-buffer'), 1);
    assert.equal(w.count('send-keys'), 1);
    assert.deepEqual(promptQueueView(w.ctx, 't1'), []);
  });

  it('P16 queued Codex follow-up: no rollout line stays unconfirmed (no source, not delivered), then the late line delivers it', async () => {
    const w = await codexWorld();
    w.wire(() => []);
    await w.queueAndDrain();
    const waiting = w.record();
    assert.equal(waiting.promptKind, 'followup');
    assert.equal(waiting.promptDelivery, 'confirming');
    assert.notEqual(waiting.deliveryResult, 'delivered');
    assert.equal(waiting.deliverySource, undefined);
    assert.equal(waiting.pendingPrompt, prompt, 'the message stays in TASK.md until something proves it');
    fs.appendFileSync(w.transcript, codexRows(prompt, w.runner.now() + 1000).map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
    assert.equal(w.record().deliverySource, 'transcript');
    assert.equal(w.count('paste-buffer'), 1, 'confirming never pastes again');
  });

  it('P16 queued Codex follow-up: another message, or the same text from before the delivery began, proves nothing', async () => {
    const w = await codexWorld();
    fs.appendFileSync(w.transcript, codexRows(prompt, w.runner.now() - 60_000).map(r => JSON.stringify(r)).join('\n') + '\n');
    w.wire(at => codexRows('A different message that Codex took meanwhile.', at));
    await w.queueAndDrain();
    const waiting = w.record();
    assert.equal(waiting.promptDelivery, 'confirming');
    assert.notEqual(waiting.deliveryResult, 'delivered');
    assert.equal(waiting.deliverySource, undefined);
    await w.runner.sleep(61_000);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'needs-attention', 'without proof a human looks after delivery_confirm_s');
  });
});

/** Claude-shaped agents: the same transcript and the same rules. */
async function claudeLikeWorld(agent: 'claude' | 'glm') {
  const root = scratch.sub(`${agent}-${++serial}`);
  const config = makeConfig(root, 'providers: [claude, codex, glm]\ncapacity: {snapshot: false, codex_refresh: false}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() - 1000, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  tmux.add('t1', '❯ \n');
  seedTask(config, 'T1', { agent, model: 'opus', effort: 'high' });
  const transcript = path.join(root, `${agent}-session.jsonl`);
  fs.writeFileSync(transcript, '');
  await rememberSession(runner, config, 't1', agent, { id: `${agent}-session`, transcript });
  await setHeaderFields(runner, taskFile(config, 't1'), { pending_prompt: prompt, prompt_kind: 'followup', prompt_delivery: 'confirming', delivery_id: 'p16-delivery', delivery_was_busy: true, delivery_started_at: new Date(runner.now()).toISOString() });
  const at = () => new Date(runner.now() + 500).toISOString();
  const write = (row: object) => fs.appendFileSync(transcript, JSON.stringify(row) + '\n');
  return { ctx, config, record: () => readTaskRecord(config, 't1')!, enqueue: () => write({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: prompt }), typed: () => write({ type: 'user', timestamp: at(), message: { role: 'user', content: prompt } }), injected: () => write({ type: 'user', promptSource: 'queued', timestamp: at(), message: { role: 'user', content: prompt } }) };
}

for (const agent of ['claude', 'glm'] as const) describe(`P16-f1: ${agent} follow-up proof from the transcript`, () => {
  it(`P16-f1 ${agent}: the user line of exactly that message delivers it with source transcript`, async () => {
    const w = await claudeLikeWorld(agent);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent', 'nothing in the transcript yet');
    w.typed();
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
    assert.equal(w.record().deliveryResult, 'delivered');
    assert.equal(w.record().deliverySource, 'transcript');
  });

  it(`P16-f1 ${agent}: the enqueue line only confirms the queue, the injection delivers it`, async () => {
    const w = await claudeLikeWorld(agent);
    w.enqueue();
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming');
    assert.equal(w.record().deliveryResult, 'queued-in-agent-confirmed');
    assert.equal(w.record().deliverySource, 'transcript-queue');
    assert.equal(w.record().pendingPrompt, prompt, 'a queued message is not a delivered one');
    w.injected();
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
    assert.equal(w.record().deliveryResult, 'delivered');
    assert.equal(w.record().deliverySource, 'transcript');
  });
});
