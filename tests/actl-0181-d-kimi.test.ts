import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { inspectField, fieldText } from '../src/core/input-field.ts';
import { deliverPendingPrompt, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const fixture = fs.readFileSync(new URL('./fixtures/screen-kimi-02-bezczynny.txt', import.meta.url), 'utf8');
const original = fixture.split('\n').find(line => /^\s*│ >/.test(line))!;
function pane(text: string) {
  const rows = text.split('\n').map((line, i) => `${i ? ' │   ' : ' │ > '}${line}`.padEnd(original.length - 1) + '│');
  return fixture.replace(original, rows.join('\n'));
}
async function world() {
  const root = scratch.sub(String(serial++)), config = makeConfig(root, 'providers: [claude, codex, kimi]\n');
  let draft = '', question = false, replace = false, entered = false, alteredPaste = false;
  const keys: string[] = [];
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: (question ? fs.readFileSync(new URL('./fixtures/screen-kimi-05-pytanie.txt', import.meta.url), 'utf8') : '') + pane(replace && entered ? 'FIRST\nCHANGED BODY' : draft) };
    if (args[0] === 'paste-buffer') draft = alteredPaste ? 'FIRST\nCHANGED BODY' : 'FIRST\nORIGINAL BODY';
    if (args[0] === 'send-keys') { keys.push(args.at(-1)!); entered = true; }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'kimi', windowId: '@1' });
  const record = () => readTaskRecord(config, 't1')!;
  await queuePrompt(ctx, record(), 'FIRST\nORIGINAL BODY');
  return { ctx, keys, record, set: (s: string) => { draft = s; }, question: () => { question = true; }, alterAfterEnter: () => { replace = true; }, alterPaste: () => { alteredPaste = true; } };
}
let serial = 0;
it('Kimi real composer captures every body row and rejects an incomplete box', () => {
  const capture = inspectField(pane('FIRST\nORIGINAL BODY'), 'kimi');
  assert.equal(capture.readable, true); assert.equal(fieldText(capture.area), 'FIRST\nORIGINAL BODY');
  assert.equal(inspectField(pane('FIRST').replace(/╰─+╯/g, ''), 'kimi').readable, false);
});
it('Kimi swallowed C-m records ownership and three Enters, then manual recovery uses the same field', async () => {
  const w = await world(); await deliverPendingPrompt(w.ctx, 't1');
  assert.deepEqual(w.keys, ['C-m', 'C-m', 'C-m']); assert.equal(w.record().deliveryEnters, 3);
  assert.ok(w.record().deliveryField); assert.equal(w.record().deliveryResult, 'not-delivered-in-field');
  const preview = await submitDraft(w.ctx, 't1'); assert.equal(preview.outcome, 'ready'); assert.deepEqual(preview.field, ['FIRST', 'ORIGINAL BODY']);
  assert.equal((await submitDraft(w.ctx, 't1', { token: 'wrong-token' })).outcome, 'refused');
  assert.equal(w.keys.length, 3);
  assert.equal((await submitDraft(w.ctx, 't1', { token: preview.token })).outcome, 'not-delivered');
  assert.equal(w.record().deliveryEnters, 4); assert.equal(w.keys.at(-1), 'C-m');
});
it('Kimi altered body keeping first line prevents a retry Enter', async () => {
  const w = await world(); w.alterAfterEnter(); await deliverPendingPrompt(w.ctx, 't1');
  assert.deepEqual(w.keys, ['C-m']); assert.equal(w.record().deliveryResult, 'not-delivered-in-field');
});
it('Kimi token confirmation refuses a changed body without another key', async () => {
  const w = await world(); await deliverPendingPrompt(w.ctx, 't1'); const preview = await submitDraft(w.ctx, 't1');
  w.set('FIRST\nCHANGED BODY'); assert.equal((await submitDraft(w.ctx, 't1', { token: preview.token })).outcome, 'refused');
  assert.equal(w.keys.length, 3);
});
it('Kimi open question blocks paste and manual confirmation', async () => {
  const w = await world(); w.question(); assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'pending'); assert.deepEqual(w.keys, []);
  const x = await world(); await deliverPendingPrompt(x.ctx, 't1'); const preview = await submitDraft(x.ctx, 't1'); x.question();
  assert.equal((await submitDraft(x.ctx, 't1', { token: preview.token })).outcome, 'refused'); assert.equal(x.keys.length, 3);
});

it('Kimi first capture with the same first line but an altered body gets no Enter', async () => {
  const w = await world(); w.alterPaste(); await deliverPendingPrompt(w.ctx, 't1');
  assert.deepEqual(w.keys, []); assert.equal(w.record().deliveryField, undefined);
  assert.equal(w.record().deliveryResult, 'not-delivered-in-field');
});
