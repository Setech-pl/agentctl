import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P92 (dev 12.11 06:40, ACTL-0194-REVIEW): Kimi did not take the first prompt; the event said "Kimi screen is not stable before Enter" and the
 * prompt stood in the field for the owner. The start screen is the real Kimi Code 2.5.0 capture (screen-kimi-01-start.txt). Its footer, below the
 * composer, rotates tips on Kimi's own clock (the real captures show "/theme …", "/goal …", "/compact …", "@: mention files"), and the old check
 * compared the whole screen twice 200 ms apart, so a tip that turned between the two reads stopped the delivery with no Enter and no retry.
 */
const scratch = useScratch();
const START = fs.readFileSync(new URL('./fixtures/screen-kimi-01-start.txt', import.meta.url), 'utf8');
const ROW = START.split('\n').find(line => /^\s*│ >/.test(line))!;
const TIP = '/theme to switch the terminal UI theme';
const TIPS = [TIP, '/goal for multi-step work with a clear finish line', '/compact compresses context when it gets long', '@: mention files'];
const PROMPT = 'Review agentctl 0.19.4.\nRead the report protocol below and write REVIEW.md.';

/** The start screen with `text` in the composer (wrapped rows as Kimi draws them) and the footer showing `tip`. */
function screen(text: string, tip: string, above = ''): string {
  const rows = text.split('\n').map((line, i) => `${i ? ' │   ' : ' │ > '}${line}`.padEnd(ROW.length - 1) + '│');
  return START.replace(ROW, rows.join('\n')).replace(TIP, tip).replace('No session yet', `${above}No session yet`);
}

let serial = 0;
function world(opts: { fold?: boolean; unsettledLooks?: number; drawing?: number } = {}) {
  const config = makeConfig(scratch.sub(String(serial++)), 'providers: [claude, codex, kimi]\n');
  let draft = '', captures = 0, shownDraft = 0, submitted = false, unsettled = opts.unsettledLooks ?? 0, drawing = opts.drawing ?? 0;
  const keys: string[] = [], pastes: string[] = [];
  const runner: DiskRunner = new DiskRunner({ dryRun: false, respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tk1\ttask' };
    if (args[0] === 'capture-pane') {
      captures++;
      // Every read shows the next tip: the footer never reads the same twice in a row.
      const tip = TIPS[captures % TIPS.length]!;
      // A start screen that is still being drawn above the composer (the session line fills in), or a screen that keeps changing after the paste.
      const above = drawing > 0 ? `${drawing--} ` : draft && !submitted && unsettled > 0 ? `${unsettled--} ` : '';
      // Kimi folds a multi-line paste into a placeholder a moment after it showed the text: every read after the first sees the fold.
      const field = submitted ? '' : draft && opts.fold && ++shownDraft > 1 ? '[paste #1 +1 lines]' : draft;
      return { stdout: screen(field, tip, above) };
    }
    if (args[0] === 'load-buffer' || args[0] === 'set-buffer') return {};
    if (args[0] === 'paste-buffer') {
      pastes.push(args.join(' '));
      draft = PROMPT;
      return {};
    }
    if (args[0] === 'send-keys') {
      keys.push(args.at(-1)!);
      if (args.at(-1) === 'C-m' && draft) {
        submitted = true;
        // The passive wire (turn.prompt) acknowledges the exact prompt: what kimi-events writes as delivery-evidence.json.
        const record = readTaskRecord(config, 'k1')!;
        fs.writeFileSync(path.join(config.stateDir, 'k1', 'delivery-evidence.json'), JSON.stringify({ deliveryId: record.deliveryId, at: new Date(runner.now()).toISOString(), accepted: true, type: 'turn.prompt' }));
      }
      return {};
    }
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'K1', { agent: 'kimi', model: 'k3', windowId: '@1' });
  return { ctx, config, keys, pastes, record: () => readTaskRecord(config, 'k1')!, captures: () => captures };
}

it('P92: Kimi start screen with a rotating footer tip takes the first prompt: one paste, one Enter, verified by the wire turn.prompt', async () => {
  const w = world();
  await queuePrompt(w.ctx, w.record(), PROMPT);
  // Before the fix: 'confirming', not-delivered-in-field, "Kimi screen is not stable before Enter", no Enter at all.
  assert.equal(await deliverPendingPrompt(w.ctx, 'k1'), 'sent', w.record().promptError ?? '');
  assert.deepEqual(w.keys, ['C-m'], 'exactly one Enter');
  assert.equal(w.pastes.length, 1, 'exactly one paste');
  assert.equal(w.record().promptDelivery, 'sent');
  assert.equal(w.record().deliverySource, 'hook', 'the wire acknowledgement proves it, not the screen');
  assert.equal(w.record().deliveryResult, 'delivered');
});

it('P92: Kimi folding the paste into "[paste #1 …]" before Enter keeps the delivery: the newer image of our own paste replaces the first', async () => {
  const w = world({ fold: true });
  await queuePrompt(w.ctx, w.record(), PROMPT);
  assert.equal(await deliverPendingPrompt(w.ctx, 'k1'), 'sent');
  assert.deepEqual(w.keys, ['C-m']);
  assert.equal(w.record().promptDelivery, 'sent');
});

it('P92: a Kimi screen that keeps changing gets no Enter in that pass; the next watch pass presses it once the screen holds still', async () => {
  const w = world({ unsettledLooks: 20 });
  await queuePrompt(w.ctx, w.record(), PROMPT);
  assert.equal(await deliverPendingPrompt(w.ctx, 'k1'), 'confirming');
  assert.deepEqual(w.keys, [], 'no Enter while the screen changes');
  assert.equal(w.record().deliveryResult, undefined, 'not "not-delivered-in-field": the owner is not called');
  assert.match(w.record().promptError ?? '', /ekran Kimi jeszcze się zmienia/);
  assert.equal(w.record().deliveryEnters, 0);
  assert.ok(w.record().deliveryField, 'the field of our paste is recorded');
  // The screen settles; the watcher's next pass (deliverPendingPrompt again) resumes the same paste.
  for (let pass = 0; pass < 5 && w.record().promptDelivery !== 'sent'; pass++) await deliverPendingPrompt(w.ctx, 'k1');
  assert.equal(w.record().promptDelivery, 'sent');
  assert.deepEqual(w.keys, ['C-m'], 'one Enter in all');
  assert.equal(w.pastes.length, 1, 'never pasted twice');
});

it('P92: a Kimi start screen still being drawn gets no paste; the next pass pastes into the settled composer', async () => {
  const w = world({ drawing: 2 });
  await queuePrompt(w.ctx, w.record(), PROMPT);
  assert.equal(await deliverPendingPrompt(w.ctx, 'k1'), 'pending');
  assert.equal(w.pastes.length, 0, 'nothing pasted into a screen that did not hold still');
  assert.equal(w.record().deliveryStartedAt, undefined);
  for (let pass = 0; pass < 3 && w.record().promptDelivery !== 'sent'; pass++) await deliverPendingPrompt(w.ctx, 'k1');
  assert.equal(w.record().promptDelivery, 'sent');
  assert.deepEqual(w.keys, ['C-m']);
  assert.equal(w.pastes.length, 1);
});
