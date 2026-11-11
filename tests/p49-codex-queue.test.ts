import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { codexQueueKey, inspectField, pasteImage } from '../src/core/input-field.ts';
import { deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// Recorded 0.166 busy frame; 0.167 version/wrap variants below are reconstructed from the P49 description,
// not claimed as the missing 2026-11-07 08:24 production capture.
const captured = fx('screen-codex-0166-busy-paste.txt');
const prompt = 'After this turn reply FOLLOWUP.';
const frame = (body: string, busy = true) => captured.replace('v0.166.0', 'v0.167.0')
  .replace('› After this turn reply FOLLOWUP.', body)
  .replace(busy ? '\0' : /^• Working[^\n]*\n/m, '');

it('P49 reads exact wrapped paste, whether the wrap retains or swallows its separator', () => {
  for (const body of ['› After this turn\n   reply FOLLOWUP.', '› After this turn\n  reply FOLLOWUP.']) {
    const field = inspectField(frame(body), 'codex');
    assert.equal(field.readable, true);
    assert.equal(pasteImage(field.area, prompt, 'codex'), true);
    for (const changed of ['After this turn reply CHANGED.', 'After this turn  reply FOLLOWUP.']) {
      assert.equal(pasteImage(field.area, changed, 'codex'), false, 'different text/spacing never becomes our paste');
    }
  }
  assert.equal(codexQueueKey(frame('› ')), 'Tab');
  assert.equal(codexQueueKey(frame('› tab to queue message').replace('  tab to queue message\n', '  ? for shortcuts\n')), 'Enter', 'body cannot advertise a key');
  assert.equal(codexQueueKey(frame('› ').replace(/  GPT[^\n]*\n/, '')), 'Enter', 'an incomplete footer cannot advertise a key');
});

for (const busy of [true, false]) it(`P49 ${busy ? 'working Codex waits, then submits with Enter after idle' : 'idle Codex submits with Enter'}; exact session transcript confirms`, async () => {
  const root = scratch.sub(busy ? 'busy' : 'idle'), codexDir = path.join(root, 'codex');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {codex_dir: ${codexDir}}\n`);
  let running = busy, screen = frame('› ', busy), submitted = false;
  const keys: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: screen };
    if (args[0] === 'paste-buffer') screen = frame('› After this turn\n   reply FOLLOWUP.', running);
    if (args[0] === 'send-keys') { keys.push(args.at(-1)!); submitted = true; screen = frame('› ', running); }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'codex', windowId: '@1' });
  const record = () => readTaskRecord(config, 't1')!;
  const dir = path.join(codexDir, 'sessions', ...new Date(runner.now()).toLocaleDateString('sv').split('-'));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, 'rollout-p49-session.jsonl');
  const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'p49-session', cwd: root } }) + '\n';
  fs.writeFileSync(transcript, meta);
  await rememberSession(runner, config, 't1', 'codex', { id: 'p49-session' });
  await queuePrompt(ctx, record(), prompt, 'pending', { kind: 'followup' });
  if (busy) {
    assert.equal(await deliverPendingPrompt(ctx, 't1'), 'pending');
    assert.deepEqual(keys, []); assert.equal(submitted, false);
    running = false; screen = frame('› ', false);
  }
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming');
  assert.equal(submitted, true);
  assert.deepEqual(keys, ['Enter']);
  assert.equal(record().pendingPrompt, prompt, 'an empty composer alone never proves delivery');
  fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date(runner.now()).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }) + '\n');
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'sent');
  assert.equal(record().deliverySource, 'transcript');
  assert.equal(record().pendingPrompt, undefined);
  assert.deepEqual(keys, ['Enter'], 'confirmation sends no additional key');
});

it('P49 existing Claude and Kimi recorded footers keep their own composer boundaries', () => {
  for (const [agent, name] of [['claude', 'screen-claude-busy-paste.txt'], ['kimi', 'screen-kimi-02-bezczynny.txt']] as const) {
    assert.equal(inspectField(fx(name), agent).readable, true);
    assert.equal(codexQueueKey(fx(name)), 'Enter');
  }
});
