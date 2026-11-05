import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { deliveryNote, deliveryProof, deliverPendingPrompt, echoLines, ENTER_RETRY_S, MAX_ENTERS, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { sendPrompts } from '../src/core/send.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { dimInputText, screenMetadata } from '../src/core/tmux.ts';
import { classifyScreen } from '../src/core/state.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import type { AgentName } from '../src/core/config.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';

/*
 * P15/P15b/P16: send to a working agent. The screens are real captures of Claude Code 2.1.311 and codex-cli 0.166.0 (tests/fixtures/screen-*-busy-*,
 * screen-codex-question-*), recorded with `tmux -L p15` on 2026-11-04; the pane below replays them at the moments where the real CLI showed them.
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const busyPaste = fx('screen-claude-busy-paste.txt'), busyPasteSingle = fx('screen-claude-busy-paste-single.txt');
const busyQueued = fx('screen-claude-busy-queued.txt'), busyQueuedAnsi = fx('screen-claude-busy-queued-ansi.txt'), busyQueuedShown = fx('screen-claude-busy-queued-shown.txt');
const busyQueuedShownAnsi = fx('screen-claude-busy-queued-shown-ansi.txt'), busyInjected = fx('screen-claude-busy-injected.txt');
const codexSteered = fx('screen-codex-busy-steered.txt'), codexQuestion = fx('screen-codex-question-collapsed.txt'), codexQuestionPasted = fx('screen-codex-question-pasted.txt');

/** The text the live runs sent: a long first line (wrapped by the TUI) and seven filler lines; 1155 characters. */
const FILLER = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog, again and again, to pad the message out to about one thousand characters.`);
const LONG = ['FOLLOWUP-LONG-A: when your current work is finished, reply with the single line ACK-LONG-A and nothing else. Context padding follows so that this message is long enough to be collapsed by the terminal UI into a pasted text placeholder instead of being shown inline.', ...FILLER].join('\n');
const CODEX_LONG = ['FOLLOWUP-CX-LONG: when your current work is finished, reply with the single line ACK-CX-LONG and nothing else. This padding makes the message long enough for the terminal UI to treat it as a large paste.', ...FILLER].join('\n');
/** The screen with `text` in the input field (the last "❯" line that holds a paste placeholder; the real captures have a no-break space after the marker). */
const PLACEHOLDER = /^❯\s\[Pasted text #\d+(?: \+\d+ lines)?\]$/m;
const withField = (screen: string, text: string) => screen.replace(PLACEHOLDER, `❯\u00a0${text}`);
/** The same busy screen with an empty input field: what the agent showed just before the paste. */
const emptied = (screen: string, _placeholder?: RegExp) => withField(screen, '');

interface Model {
  screen: () => string;
  styled?: () => string | undefined;
  paste?: (payload: string) => void;
  enter?: (n: number) => void;
}
function pane(model: Model) {
  const seen = { pastes: 0, enters: 0, payload: '' };
  const respond = (cmd: string, args: string[], opts?: ExecOptions): Partial<ExecResult> | undefined => {
    if (cmd !== 'tmux') return undefined;
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'load-buffer') { seen.payload = opts?.input ?? ''; return {}; }
    if (args[0] === 'paste-buffer') { seen.pastes++; model.paste?.(seen.payload); return {}; }
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { seen.enters++; model.enter?.(seen.enters); return {}; }
    if (args[0] === 'capture-pane') return { stdout: args.includes('-e') ? (model.styled?.() ?? model.screen()) : model.screen() };
    return {};
  };
  return { seen, respond };
}

function fixture(name: string, model: Model, agent: AgentName = 'claude', extra = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [send, send_enter]}\n${extra}`);
  const p = pane(model);
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: p.respond });
  const ctx = new Context(runner, config, () => {}), notified: string[] = [];
  seedTask(config, 'T1', { agent, windowId: '@1' });
  const record = () => readTaskRecord(config, 't1')!;
  const header = () => fs.readFileSync(taskFile(config, 't1'), 'utf8');
  const call = (tool: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === tool)!.run({ context: () => ctx, notify: async (m: string) => { notified.push(m); } } as never, args as never);
  const hook = (payload: unknown, kind: 'user-prompt-submit' = 'user-prompt-submit') => handleEvent(ctx, new Alerts(ctx, { notify: async () => {} }), { task: 'T1', agent: 'claude', kind, payload });
  return { root, config, runner, ctx, seen: p.seen, record, header, call, hook, notified };
}
/** A follow-up the way the queue hands it to the delivery: kind "followup", so a working agent may take it. */
const followup = async (f: ReturnType<typeof fixture>, text: string) => queuePrompt(f.ctx, f.record(), text, 'pending', { kind: 'followup' });

describe('P15b: Claude takes a collapsed paste into its queue while it works', () => {
  it('Enter during the turn: the queue sign confirms at once as queued-in-agent, one paste, one Enter', async () => {
    let state: 'busy' | 'pasted' | 'queued' = 'busy';
    const f = fixture('p15b-queued', { screen: () => state === 'busy' ? emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m) : state === 'pasted' ? busyPaste : busyQueued, styled: () => state === 'queued' ? busyQueuedAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.deepEqual([f.seen.pastes, f.seen.enters], [1, 1]);
    const record = f.record();
    assert.equal(record.promptDelivery, 'sent'); assert.equal(record.deliveryResult, 'queued-in-agent'); assert.equal(record.deliveryWasBusy, true);
    assert.equal(record.pendingPrompt, undefined);
    assert.match(deliveryNote(record)!, /w kolejce agenta/);
  });
  it('the dim "Press up to edit queued messages" is read from the colour, not taken for a draft', async () => {
    const plain = busyQueued.replace(/^  ctrl\+x ctrl\+s to send now\n/m, '');
    assert.equal(screenMetadata(plain).draft_input, 'Press up to edit queued messages');
    assert.equal(dimInputText(plain, busyQueuedAnsi), plain.split('\n').length === busyQueuedAnsi.split('\n').length ? 'Press up to edit queued messages' : '');
    let state: 'busy' | 'pasted' | 'queued' = 'busy';
    // Only the placeholder in the field: the sign must come from dimInput, because the dim text is taken out of the screen.
    const dim = busyQueuedAnsi.split('\n').filter(l => !/ctrl\+x ctrl\+s/.test(l)).join('\n');
    const f = fixture('p15b-dim', { screen: () => state === 'busy' ? emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m) : state === 'pasted' ? busyPaste : plain, styled: () => state === 'queued' ? dim : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG);
    const record0 = f.record(); assert.equal(record0.promptDelivery, 'pending');
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
    assert.equal(screenMetadata((await f.ctx.tmux.capture('t1', undefined, undefined, '@1', true)).stdout).draft_input, null);
  });
  it('a single long line collapses to "[Pasted text #2]" and is taken the same way', async () => {
    let state: 'busy' | 'pasted' | 'queued' = 'busy';
    const f = fixture('p15b-single', { screen: () => state === 'busy' ? emptied(busyPasteSingle, /^❯ \[Pasted text #2\]$/m) : state === 'pasted' ? busyPasteSingle : busyQueued, styled: () => state === 'queued' ? busyQueuedAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG.replace(/\n/g, ' ').slice(0, 970));
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
    assert.equal(f.record().deliveryField, 'collapsed:[Pasted text #2]');
  });
  it('queued while the agent thinks: the queued message with "ctrl+x ctrl+s to send now" is the sign, not a draft', async () => {
    let state: 'busy' | 'pasted' | 'queued' = 'busy';
    const f = fixture('p15b-thinking', { screen: () => state === 'busy' ? emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m) : state === 'pasted' ? busyPaste : busyQueuedShown, styled: () => state === 'queued' ? busyQueuedShownAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
  });
  it('the real hook payload of a collapsed paste (<pasted_content id=…>) confirms the delivery', async () => {
    const payload = JSON.parse(fx('claude-user-prompt-submit-pasted.json')) as { prompt: string };
    assert.match(payload.prompt, /^<pasted_content id="[0-9a-f]+">\n/);
    const inner = payload.prompt.replace(/^<pasted_content id="[^"]*">\n/, '').replace(/\n<\/pasted_content id="[^"]*">$/, '');
    const f = fixture('p15b-hook', { screen: () => '❯ Try "x"\n' });
    await followup(f, inner);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(f.runner.now()).toISOString() });
    assert.equal(deliveryProof(f.ctx, f.record(), ''), null, 'before the hook nothing proves it');
    await f.hook(payload);
    assert.equal(deliveryProof(f.ctx, f.record(), ''), 'delivered');
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().deliveryResult, 'delivered');
  });
  it('a hook with other text still does not confirm', async () => {
    const f = fixture('p15b-hook-other', { screen: () => '❯ Try "x"\n' });
    await followup(f, 'the real message');
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(f.runner.now()).toISOString() });
    await f.hook({ prompt: '<pasted_content id="ab12">\nsomething else\n</pasted_content id="ab12">' });
    assert.equal(deliveryProof(f.ctx, f.record(), ''), null);
  });
  it('the transcript echo of the injected message (long first line wrapped by the TUI) confirms a later watch tick', async () => {
    const f = fixture('p15b-echo', { screen: () => busyInjected });
    await followup(f, LONG);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(f.runner.now()).toISOString() });
    assert.equal(echoLines(busyInjected, '❯', LONG), 1);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.record().deliveryResult, 'delivered');
  });
  it('an echo that was on the screen before the delivery is not a confirmation (same text sent twice)', async () => {
    let state: 'busy' | 'pasted' = 'busy';
    const f = fixture('p15b-twice', { screen: () => state === 'busy' ? busyInjected : busyInjected.replace(/^❯\s*$/m, '❯\u00a0[Pasted text #3 +7 lines]'), paste: () => { state = 'pasted'; } });
    await followup(f, LONG);
    // The first user line "Run exactly…" and our text are both there already: only a new echo may count.
    const result = await deliverPendingPrompt(f.ctx, 't1');
    assert.notEqual(f.record().deliveryResult, 'delivered', `result ${result}`);
  });
});

describe('P15: the paste must not stay in the field', () => {
  // A real capture (sonnet/high, 2026-11-04): the spinner is on its "✳" frame, the footer "esc to interrupt" is not drawn (a paste was made a moment ago).
  const star = fx('screen-claude-spinner-star-no-footer.txt');
  // The "✳" frame is not in the configured pattern (a quoted spinner line would match it anywhere): the status area above the input box decides (state.ts).
  const noStarPattern = { ...DEFAULT_AGENT_SETTINGS.claude, workingPattern: DEFAULT_AGENT_SETTINGS.claude.workingPattern.replace(/✳/g, '') };
  it('every spinner frame of Claude Code is a working screen, "✳" too (58 of 554 recorded spinner lines); before, that frame read as idle without the footer', () => {
    assert.ok(!/esc to interrupt/.test(star));
    assert.equal(classifyScreen(star.replace(/^✳.*$/m, ''), noStarPattern), 'idle');
    for (const glyph of ['·', '✢', '✳', '✶', '✻', '✽']) assert.equal(classifyScreen(star.replace('✳', glyph), DEFAULT_AGENT_SETTINGS.claude), 'working', glyph);
  });
  it('the frame that used to read as idle: a follow-up is a busy follow-up (queued in the agent), one paste, one Enter', async () => {
    let state: 'before' | 'pasted' | 'queued' = 'before';
    const f = fixture('p15-star', { screen: () => state === 'before' ? star : state === 'pasted' ? star.replace(/^❯\s*$/m, '❯\u00a0[Pasted text #2]').replace('✳', '✶') : busyQueued, styled: () => state === 'queued' ? busyQueuedAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG.replace(/\n/g, ' ').slice(0, 970));
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.deepEqual([f.seen.pastes, f.seen.enters], [1, 1]);
    assert.equal(f.record().deliveryWasBusy, true);
  });
  it('the agent read as idle before the paste (the spinner line was not drawn yet) and working after it: Enter is still pressed, as it was not before the fix', async () => {
    let state: 'before' | 'pasted' | 'queued' = 'before';
    const f = fixture('p15-old-pattern', { screen: () => state === 'before' ? star.replace(/^✳.*$/m, '') : state === 'pasted' ? star.replace(/^❯\s*$/m, '❯\u00a0[Pasted text #2]').replace('✳', '✶') : busyQueued, styled: () => state === 'queued' ? busyQueuedAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG.replace(/\n/g, ' ').slice(0, 970));
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.deepEqual([f.seen.pastes, f.seen.enters], [1, 1]);
    assert.equal(f.record().deliveryWasBusy, true, 'recognised as busy once the paste was in');
  });
  it('the state flips to working between the check and the paste: Enter is still pressed (it used to stop with the paste in the field)', async () => {
    let state: 'idle' | 'pasted' | 'queued' = 'idle';
    const idleScreen = emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m).replace(/^· Clauding….*$/m, '').replace(/^  Sleeping 20 seconds.*$/m, '');
    assert.equal(screenMetadata(idleScreen).draft_input, null);
    const f = fixture('p15-race', { screen: () => state === 'idle' ? idleScreen : state === 'pasted' ? busyPaste : busyQueued, styled: () => state === 'queued' ? busyQueuedAnsi : undefined, paste: () => { state = 'pasted'; }, enter: () => { state = 'queued'; } });
    await followup(f, LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.seen.enters, 1);
    assert.equal(f.record().deliveryWasBusy, true);
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
  });
  it('an initial prompt is never pressed into a working agent', async () => {
    let state: 'idle' | 'pasted' = 'idle';
    const idleScreen = emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m).replace(/^· Clauding….*$/m, '').replace(/^  Sleeping 20 seconds.*$/m, '');
    const f = fixture('p15-initial', { screen: () => state === 'idle' ? idleScreen : busyPaste, paste: () => { state = 'pasted'; } });
    await queuePrompt(f.ctx, f.record(), LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
    assert.equal(f.seen.enters, 0);
    assert.equal(f.record().deliveryResult, 'not-delivered-in-field');
  });
  it('Enter swallowed three times: not-delivered-in-field, said plainly in send, status and the journal; the text is not pasted again', async () => {
    let swallow = 99, field = '';
    const f = fixture('p15-swallowed', { screen: () => field ? withField(busyPaste, field) : emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m), paste: () => { field = '[Pasted text #1 +7 lines]'; }, enter: n => { if (n > swallow) field = ''; } });
    const results = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: LONG }]);
    assert.equal(f.seen.pastes, 1); assert.equal(f.seen.enters, 3);
    assert.match(results[0]!.message, /^nie dostarczono – tekst w polu wpisywania/);
    assert.match(results[0]!.message, /agentctl send --enter-only T1/);
    assert.ok(results[0]!.warning);
    assert.match(f.record().promptError!, /two retries/);
    const row = (await collectStatus(f.ctx))[0]!;
    assert.equal(row.deliveryResult, 'not-delivered-in-field');
    assert.match(row.hint!, /nie dostarczono – tekst w polu wpisywania/);
    assert.match(readJournal(f.config).find(e => e.kind === 'delivery')!.text, /nie dostarczono/);
    void swallow;
  });
  it('watch presses Enter again after the pause while the field shows only our paste, and the delivery then ends as queued-in-agent', async () => {
    let field = '', gone = false;
    const idle = emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m);
    const f = fixture('p15-retry', { screen: () => gone ? busyQueued : field ? busyPaste : idle, styled: () => gone ? busyQueuedAnsi : undefined, paste: () => { field = 'x'; }, enter: n => { if (n >= 4) { field = ''; gone = true; } } });
    await followup(f, LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
    assert.equal(f.seen.enters, 3);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming', 'too soon: no Enter yet');
    assert.equal(f.seen.enters, 3);
    await f.runner.sleep(ENTER_RETRY_S * 1000 + 100);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.seen.enters, 4); assert.equal(f.seen.pastes, 1);
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
  });
  it('no retry when the field is not exactly our paste (the human typed on) or when a dialog is open', async () => {
    let field = '';
    const idle = emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m);
    const f = fixture('p15-retry-foreign', { screen: () => field ? withField(busyPaste, field) : idle, paste: () => { field = '[Pasted text #1 +7 lines]'; } });
    await followup(f, LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
    assert.equal(f.record().deliveryField, 'collapsed:[Pasted text #1 +7 lines]');
    await f.runner.sleep(ENTER_RETRY_S * 1000 + 100);
    field = '[Pasted text #1 +7 lines] and a word of the human';
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3, 'a changed field gets no Enter');
    field = '[Pasted text #1 +7 lines]';
    const dialog = busyPaste + '\nEnter to select · ↑/↓ to navigate · Esc to cancel\n';
    const g = fixture('p15-retry-dialog', { screen: () => withField(dialog, field) });
    await followup(g, LONG);
    await setHeaderFields(g.runner, taskFile(g.config, 't1'), { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', delivery_field: 'collapsed:[Pasted text #1 +7 lines]', delivery_enters: 3, delivery_enter_at: new Date(g.runner.now() - 20000).toISOString(), delivery_started_at: new Date(g.runner.now() - 20000).toISOString() });
    await deliverPendingPrompt(g.ctx, 't1');
    assert.equal(g.seen.enters, 0, 'an open dialog gets no Enter');
  });
  it(`after ${MAX_ENTERS} Enter presses the text is still there: needs-attention with the words "nie dostarczono – tekst w polu wpisywania"`, async () => {
    const f = fixture('p15-exhausted', { screen: () => busyPaste, paste: () => {} });
    await followup(f, LONG);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', delivery_field: 'collapsed:[Pasted text #1 +7 lines]', delivery_enters: MAX_ENTERS, delivery_enter_at: new Date(f.runner.now() - 20000).toISOString(), delivery_started_at: new Date(f.runner.now() - 20000).toISOString() });
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    assert.match(f.record().promptError!, /^nie dostarczono – tekst w polu wpisywania/);
    assert.match(f.record().promptError!, /send --enter-only T1/);
    assert.equal(f.seen.enters, 0);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention', 'and it stays quiet');
  });
  it('watch tick: the stuck paste is retried and reaches the journal as a delivery event', async () => {
    let field = '', done = false;
    const idle = emptied(busyPaste, /^❯ \[Pasted text #1 \+7 lines\]$/m);
    const f = fixture('p15-watch', { screen: () => done ? busyQueued : field ? busyPaste : idle, styled: () => done ? busyQueuedAnsi : undefined, paste: () => { field = 'x'; }, enter: n => { if (n >= 4) { field = ''; done = true; } } });
    f.runner.exec = ((orig) => async (cmd: string, args: string[], opts?: ExecOptions) => orig(cmd, args, opts))(f.runner.exec.bind(f.runner));
    await followup(f, LONG);
    await deliverPendingPrompt(f.ctx, 't1');
    await f.runner.sleep(ENTER_RETRY_S * 1000 + 100);
    await watchTick(f.ctx, new WatchMemory(), { notify: async () => {} });
    assert.equal(f.record().promptDelivery, 'sent');
    assert.equal(f.record().deliveryResult, 'queued-in-agent');
  });
});

describe('submitDraft (send --enter-only)', () => {
  const stuck = async (name: string, field: string, screenOf = (text: string) => withField(busyPaste, text)) => {
    let text = field, taken = false;
    const f = fixture(name, { screen: () => taken ? busyQueued : screenOf(text), styled: () => taken ? busyQueuedAnsi : undefined, enter: () => { taken = true; text = ''; } });
    await followup(f, LONG);
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_result: 'not-delivered-in-field', delivery_field: 'collapsed:[Pasted text #1 +7 lines]', delivery_started_at: new Date(f.runner.now()).toISOString() });
    return f;
  };
  it('presses Enter for the text our paste left and records the result', async () => {
    const f = await stuck('submit-ours', '[Pasted text #1 +7 lines]');
    const done = await submitDraft(f.ctx, 't1');
    assert.equal(done.outcome, 'submitted'); assert.match(done.message, /w kolejce agenta/);
    assert.equal(f.seen.enters, 1);
    assert.equal(f.record().promptDelivery, 'sent'); assert.equal(f.record().deliveryResult, 'queued-in-agent');
  });
  it('refuses somebody else’s draft, an empty field and an open dialog; nothing is pressed', async () => {
    const other = await stuck('submit-other', 'my own unfinished sentence');
    const a = await submitDraft(other.ctx, 't1');
    assert.equal(a.outcome, 'refused'); assert.match(a.message, /co innego niż to, co agentctl wkleił/); assert.equal(other.seen.enters, 0);
    const empty = await stuck('submit-empty', '');
    const b = await submitDraft(empty.ctx, 't1');
    assert.equal(b.outcome, 'refused'); assert.match(b.message, /puste/); assert.equal(empty.seen.enters, 0);
    const dialog = await stuck('submit-dialog', '[Pasted text #1 +7 lines]', t => `${withField(busyPaste, t)}\nEnter to select · ↑/↓ to navigate · Esc to cancel\n`);
    const c = await submitDraft(dialog.ctx, 't1');
    assert.equal(c.outcome, 'refused'); assert.match(c.message, /needs-input/); assert.equal(dialog.seen.enters, 0);
  });
  it('a delivery that is already sent never lets a draft through', async () => {
    const f = await stuck('submit-sent', '[Pasted text #1 +7 lines]');
    await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'sent' });
    assert.equal((await submitDraft(f.ctx, 't1')).outcome, 'refused'); assert.equal(f.seen.enters, 0);
  });
  it('MCP send with enter_only: presses Enter, refuses text next to it, and still needs text otherwise', async () => {
    const f = await stuck('submit-mcp', '[Pasted text #1 +7 lines]');
    const mixed = await f.call('send', { task: 'T1', text: 'hello', enter_only: true });
    assert.equal(mixed.isError, true); assert.match(mixed.text, /do not give text/);
    const none = await f.call('send', { task: 'T1' });
    assert.equal(none.isError, true); assert.match(none.text, /text is required/);
    assert.equal(f.seen.enters, 0);
    const preview = await f.call('send', { task: 'T1', enter_only: true });
    assert.ok(!preview.isError, preview.text); assert.match(preview.text, /Nie wciśnięto nic/);
    assert.equal(f.seen.enters, 0, 'without confirm nothing is pressed');
    const r = await f.call('send', { task: 'T1', enter_only: true, confirm: true });
    assert.ok(!r.isError, r.text); assert.match(r.text, /^T1: Enter wysłany: tak; dostarczenie potwierdzone: tak/);
    assert.equal(f.seen.enters, 1);
  });
});

describe('P16: Codex', () => {
  it('Enter steers the running turn: the echo of a long first line (wrapped by the TUI) confirms delivered, once', async () => {
    assert.equal(echoLines(codexSteered, '›', CODEX_LONG), 1);
    let state: 'busy' | 'pasted' | 'steered' = 'busy';
    const busy = codexSteered.replace(/^› FOLLOWUP-CX-LONG[^\n]*\n(?:  [^\n]*\n)*?(?=• Working)/m, '');
    const f = fixture('p16-steer', { screen: () => state === 'steered' ? codexSteered : state === 'pasted' ? busy.replace(/^› Ask Codex to do anything$/m, '› [Pasted Content 1155 chars]') : busy, paste: () => { state = 'pasted'; }, enter: () => { state = 'steered'; } }, 'codex');
    await followup(f, CODEX_LONG);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
    assert.equal(f.seen.pastes, 1); assert.equal(f.seen.enters, 1);
    assert.equal(f.record().deliveryResult, 'delivered');
  });
  it('an open (collapsed) question: nothing is pasted, and send says why in plain words', async () => {
    assert.equal(screenMetadata(codexQuestion).draft_input, null);
    const f = fixture('p16-question', { screen: () => codexQuestion }, 'codex');
    const results = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'SHORT-Q1: also add EXTRA' }]);
    assert.equal(f.seen.pastes, 0); assert.equal(f.seen.enters, 0);
    assert.match(results[0]!.message, /^w kolejce 1; Codex ma otwarte pytanie „Which colour: red or blue\?” \(zwinięte, 1\) – wiadomość nie jest wklejana w pole pytania/);
    assert.equal(f.record().promptDelivery, 'pending');
  });
  it('the question appears after the paste: no Enter, the text is reported as left in the field', async () => {
    let state: 'idle' | 'pasted' = 'idle';
    const idle = codexSteered.replace(/^• Working[^\n]*\n/m, '').replace(/^• Queued follow-up inputs\n(?:  [^\n]*\n)*/m, '');
    const asked = codexQuestionPasted;
    const f = fixture('p16-late-question', { screen: () => state === 'idle' ? idle : asked, paste: () => { state = 'pasted'; } }, 'codex');
    await followup(f, 'MANUAL-Q2: this text was pasted into the field while a question is open.');
    const result = await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(result, 'confirming'); assert.equal(f.seen.enters, 0);
    assert.equal(f.record().deliveryResult, 'not-delivered-in-field');
    assert.match(f.record().promptError!, /needs-input; no Enter was sent/);
  });
});
