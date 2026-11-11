import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { deliveryClass, deliverPendingPrompt, queuePrompt, QUEUED_IN_AGENT } from '../src/core/prompt-delivery.ts';
import { setHeaderFields, taskFile, readTaskRecord } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P64 (DEMO-BUG-1, 2026-11-08 00:29–00:32): a `send` to a working Codex 0.167 showed the message in the window as a
 * queued message ("↳ Additional owner findings…" above the footer), but agentctl raised needs-attention
 * "Prompt delivery not confirmed" once delivery_confirm_s elapsed (journal 23:32:35Z and 00:09:26Z; the turn took the
 * message at 00:25Z). The fixture is reconstructed from the production description on the recorded 0.166 busy frame;
 * the journal lines and the session transcript of the task are the production evidence.
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const busy = fx('screen-codex-0166-busy-paste.txt').replace('v0.166.0', 'v0.167.0').replace('› After this turn reply FOLLOWUP.', '› ');
const queued = fx('screen-codex-0167-busy-queued.txt');
const prompt = 'Additional owner findings from the demo smoke (add to your report, same rules): main cities do not open on demo either, only one place works; check every official place on the live demo API.';

const record = (extra: Partial<TaskRecord>): TaskRecord => ({
  task: 'T1', window: 't1', session: 'agentctl', agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', repos: [], links: [], env: {},
  report: '', started: new Date().toISOString(), requested: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
  pendingPrompt: prompt, deliveryStartedAt: new Date().toISOString(), deliveryWasBusy: true, deliveryField: 'image:x', deliveryEnters: 1,
  ...extra,
});

it('P64 the "↳" echo of the exact pending prompt classifies as queued in the agent; another text does not', () => {
  assert.equal(deliveryClass(record({}), queued), 'queued-in-agent');
  assert.equal(deliveryClass(record({ pendingPrompt: 'Additional owner findings: something else entirely.' }), queued), null, 'a different queued text is not this delivery');
  assert.equal(deliveryClass(record({ deliveryEnters: 0 }), queued), null, 'without our Enter the screen proves nothing');
  assert.equal(deliveryClass(record({}), busy), null, 'a busy screen without the queued echo classifies nothing');
});

it('P64 a visible Codex-queued message stays pending past delivery_confirm_s; the transcript confirms when the turn takes it', async () => {
  const root = scratch.sub('queued'), codexDir = path.join(root, 'codex');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {codex_dir: ${codexDir}}\n`);
  let screen = busy;
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: screen };
    if (args[0] === 'paste-buffer') screen = busy.replace(/^› $/m, '› Additional owner findings from the demo smoke (add to your report, same rules): main cities do not open on demo\n   either, only one place works; check every official place on the live demo API.');
    if (args[0] === 'send-keys') screen = queued;
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', windowId: '@1' });
  const dir = path.join(codexDir, 'sessions', ...new Date(runner.now()).toLocaleDateString('sv').split('-'));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, 'rollout-p64-session.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'p64-session', cwd: root } }) + '\n');
  await rememberSession(runner, config, 't1', 'codex', { id: 'p64-session' });
  await queuePrompt(ctx, readTaskRecord(config, 't1')!, prompt, 'pending', { kind: 'followup' });
  // A delivery already queued in Codex by an older version must still confirm after upgrade.
  await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(runner.now()).toISOString(), delivery_was_busy: true, delivery_enters: 1, delivery_field: 'image:pre-0194' });
  screen = queued;

  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming');
  assert.equal(readTaskRecord(config, 't1')!.deliveryResult, 'queued-in-agent');

  // The turn runs far longer than delivery_confirm_s (production: 54 minutes): as long as the window shows the
  // queued message this is pending, never "Prompt delivery not confirmed".
  await runner.sleep(61_000);
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming', 'a visible queued message must not escalate to needs-attention');
  const during = readTaskRecord(config, 't1')!;
  assert.equal(during.promptDelivery, 'confirming');
  assert.equal(during.deliveryResult, 'queued-in-agent');
  assert.match(during.promptError ?? '', new RegExp(QUEUED_IN_AGENT));
  assert.equal(during.pendingPrompt, prompt, 'the message stays in TASK.md until proof');

  // The turn picks the message up: Codex writes it as a user message, the delivery is confirmed from the transcript.
  await runner.sleep(1000);
  fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date(runner.now()).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }) + '\n');
  screen = busy;
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'sent');
  const done = readTaskRecord(config, 't1')!;
  assert.equal(done.deliverySource, 'transcript');
  assert.equal(done.pendingPrompt, undefined);
});

it('P64 once the queued echo is gone without hook or transcript, the timeout still applies', async () => {
  const root = scratch.sub('gone');
  const config = makeConfig(root, 'capacity: {snapshot: false, codex_refresh: false}\n');
  let screen = queued;
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: screen };
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', windowId: '@1' });
  await queuePrompt(ctx, readTaskRecord(config, 't1')!, prompt, 'pending', { kind: 'followup' });
  const { setHeaderFields } = await import('../src/core/taskstore.ts');
  const { taskFile } = await import('../src/core/taskstore.ts');
  await setHeaderFields(runner, taskFile(config, 't1'), {
    prompt_delivery: 'confirming', delivery_result: 'queued-in-agent', delivery_was_busy: true,
    delivery_started_at: new Date(runner.now()).toISOString(), delivery_field: 'image:x', delivery_enters: 1,
  });
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming', 'still visible: pending');
  screen = busy;
  await runner.sleep(61_000);
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'needs-attention', 'gone without proof after the deadline: a human looks');
});
