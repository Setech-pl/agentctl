import { stateWriteFailure } from './atomic-file.ts';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inspectReport, reportFingerprint } from './report-state.ts';
import { PATTERN_FLAGS } from './config.ts';
import type { AgentSettings } from './config.ts';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { compact, fieldIsOurs, fieldSignature, inputFieldLines, ownPasteSignature } from './input-field.ts';
import { recordJournal } from './journal.ts';
import type { ScreenState } from './state.ts';
import { screenMetadata } from './tmux.ts';
import type { Capture } from './tmux.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { errorMessage } from './util.ts';

/** Persist before waiting for trust, so a watcher can finish the same delivery after new returns. */
export async function queuePrompt(ctx: Context, record: TaskRecord, text: string, delivery: 'launching' | 'pending' = 'pending', options: { kind?: 'followup'; id?: string } = {}): Promise<void> {
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { pending_prompt: text, prompt_delivery: delivery, prompt_error: null, prompt_sent_at: null, delivery_id: options.id ?? randomUUID(), prompt_kind: options.kind ?? 'initial', delivery_was_busy: null, delivery_started_at: null, delivery_report_baseline: reportFingerprint(record.report), delivery_result: null, delivery_field: null, delivery_enters: null, delivery_enter_at: null, delivery_echo_baseline: null, delivery_queue_sign: null });
}

const outputFingerprint = (screen: string, pattern: string) => createHash('sha256').update(screen.split('\n').filter(line => new RegExp(pattern, PATTERN_FLAGS).test(line)).join('\n')).digest('hex');

export const DELIVERY_WARNING = 'dostarczenie niepotwierdzone – sprawdzam';
/** The paste stands in the input field and no Enter took it. */
export const NOT_DELIVERED = 'nie dostarczono – tekst w polu wpisywania';
/** The agent took the message into its own queue while it works. */
export const QUEUED_IN_AGENT = 'w kolejce agenta – agent weźmie wiadomość w trakcie tury';
/** Enter presses of one delivery: PASTE_ENTERS right after the paste, the rest from `watch`, ENTER_RETRY_S apart. */
export const MAX_ENTERS = 6;
export const ENTER_RETRY_S = 8;
const PASTE_ENTERS = 3;

export type DeliveryProof = 'delivered' | 'queued-in-agent';

/**
 * What an agent shows while a message waits in its own queue (recorded from the real CLIs: tests/fixtures/screen-claude-busy-queued*.txt).
 * Claude Code 2.1.311 puts a dim "Press up to edit queued messages" in the empty field, and during thinking shows the queued message with
 * "ctrl+x ctrl+s to send now" on a line of its own. Codex has no such sign: Enter steers the running turn and the echo of the message follows at once.
 * The sign is never an acknowledgement by itself (an older queue, a quoted answer or another message show it too): see `queueSignProof`.
 */
const QUEUE_SIGNS: Partial<Record<'claude' | 'codex', RegExp>> = { claude: /^\s*(?:Press up to edit queued messages|ctrl\+x ctrl\+s to send now)\s*$/i };

/** Is a queue sign on the screen: a line of its own, or the dim text of the input field? */
export function queueSignShown(agent: TaskRecord['agent'], screen: string, dimInput = ''): boolean {
  const sign = agent === 'unknown' ? undefined : QUEUE_SIGNS[agent];
  return Boolean(sign && (sign.test(dimInput) || screen.split('\n').some(line => sign.test(line))));
}

/**
 * The echo of `prompt` in the transcript: a line that starts with the agent's prompt marker plus the lines that continue it (the TUI wraps
 * long lines and indents the rest), as one block. The block must hold the whole prompt: neither a start of it nor a longer message with the
 * same start counts. White space is the TUI's own (wrapping, indentation) and is not compared. Counts the blocks above the input field.
 */
export function echoLines(screen: string, marker: string, prompt: string | undefined): number {
  const want = compact(prompt ?? '');
  if (!want) return 0;
  const lines = screen.split('\n');
  const isMarker = (line: string) => line.trimStart().startsWith(marker);
  const field = lines.findLastIndex(isMarker);
  let count = 0;
  for (let i = 0; i < field; i++) {
    if (!isMarker(lines[i]!)) continue;
    let block = lines[i]!.trimStart().slice(marker.length);
    for (let j = i + 1; j < field && (lines[j]!.trim() === '' || (/^\s{2,}\S/.test(lines[j]!) && !isMarker(lines[j]!))); j++) block += lines[j]!;
    if (compact(block) === want) count++;
  }
  return count;
}

/** The agent's marker in front of what the user sent. */
const markerOf = (record: TaskRecord) => record.agent === 'claude' ? '❯' : '›';

/**
 * The queue sign classifies an acknowledgement that is already correlated with this message; it is not one by itself. All of it must hold:
 * agentctl pasted for this delivery (a recorded field signature), pressed Enter for it, the sign was NOT on the screen just before that Enter,
 * and now the field no longer holds our paste while the sign is there.
 */
function queueSignProof(record: TaskRecord, screen: string, dimInput: string): boolean {
  return Boolean(record.deliveryWasBusy && record.deliveryStartedAt && record.deliveryField && (record.deliveryEnters ?? 0) >= 1 && record.deliveryQueueSign === false
    && !screenMetadata(screen).draft_input && queueSignShown(record.agent, screen, dimInput));
}

/**
 * Hooks are checked first; screen evidence is adapter-specific and never an input draft. The answer says how the message arrived:
 * `delivered` (the agent took it up) or `queued-in-agent` (it waits in the agent's own queue); null while nothing proves either.
 */
export function deliveryProof(ctx: Context, record: TaskRecord, screen: string, dimInput = ''): DeliveryProof | null {
  const draft = screenMetadata(screen).draft_input;
  if (draft) return null;
  // The queue sign comes first: the hook fires when the message is submitted, queued or not, and a message that waits is not yet read.
  if (queueSignProof(record, screen, dimInput)) return 'queued-in-agent';
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), 'utf8'));
    if (record.deliveryId && evidence.accepted === true && evidence.deliveryId === record.deliveryId && Date.parse(evidence.at) >= Date.parse(record.deliveryStartedAt ?? '')) return 'delivered';
  } catch { /* no current hook acknowledgement */ }
  const report = inspectReport(ctx.config, record, ctx.runner.now(), false);
  if (report.ready && (!record.deliveryStartedAt || report.signature !== record.deliveryReportBaseline)) return 'delivered';
  if (record.agent === 'unknown') return null;
  const settings = ctx.config.agents[record.agent], state = classifyScreen(screen, settings);
  if ((state === 'working' || state === 'background') && !record.deliveryWasBusy) return 'delivered';
  // Only output from after this delivery started can acknowledge a fast completed turn.
  if (!record.deliveryStartedAt) return null;
  // A question or idle notification alone can belong to the previous turn; the queued message must be shown whole.
  if (record.deliveryWasBusy && /Queued follow-up inputs|Queued messages?/i.test(screen) && record.pendingPrompt && compact(screen).includes(compact(record.pendingPrompt))) return 'delivered';
  if (!record.deliveryWasBusy && new RegExp(settings.deliveryPattern, PATTERN_FLAGS).test(screen) && outputFingerprint(screen, settings.deliveryPattern) !== record.deliveryOutputBaseline) return 'delivered';
  // A submitted user line followed by an empty composer is a transcript echo, not a draft.
  return echoLines(screen, markerOf(record), record.pendingPrompt) > (record.deliveryEchoBaseline ?? 0) ? 'delivered' : null;
}

export function deliveryEvidence(ctx: Context, record: TaskRecord, screen: string, dimInput = ''): boolean {
  return deliveryProof(ctx, record, screen, dimInput) !== null;
}

/** May Enter be pressed with this screen state: an idle agent, or a working one that takes a follow-up into its queue. */
const mayPressEnter = (state: ScreenState, record: TaskRecord, settings: Pick<AgentSettings, 'acceptsBusyPrompt'>) =>
  state === 'idle' || (['working', 'background'].includes(state) && record.promptKind === 'followup' && settings.acceptsBusyPrompt !== false);

/** Will `watch` still press Enter for this delivery? */
const retriesLeft = (record: TaskRecord) => Boolean(record.deliveryField) && record.promptDelivery !== 'needs-attention' && (record.deliveryEnters ?? 0) < MAX_ENTERS;

/** What `send` says when the delivery is not simply done. */
export function deliveryNote(record: TaskRecord | undefined): string | undefined {
  if (!record) return undefined;
  if (record.deliveryResult === 'not-delivered-in-field' && record.promptDelivery !== 'sent') {
    const why = record.promptError ? ` (${record.promptError.replace(/^[^:]*:\s*/, '')})` : '';
    // Without the recorded signature of our paste neither watch nor --enter-only may press Enter: only the window is left.
    if (!record.deliveryField) return `${NOT_DELIVERED}${why}; watch nie ponowi Enter – wciśnij go w oknie (attach)`;
    return `${NOT_DELIVERED}${why}; ${retriesLeft(record) ? 'watch ponowi Enter, albo' : 'watch nie ponowi już Enter – wciśnij go w oknie (attach) albo'}: agentctl send --enter-only ${record.task}`;
  }
  if (record.deliveryResult === 'queued-in-agent' && record.promptDelivery === 'sent') return `wklejono; ${QUEUED_IN_AGENT}`;
  return undefined;
}

/** One line for the journal: every result of a delivery, `delivered` included. */
function deliveryText(record: TaskRecord): string | undefined {
  if (record.deliveryResult === 'delivered' && record.promptDelivery === 'sent') return 'dostarczono – agent przyjął wiadomość';
  return deliveryNote(record);
}

/** Journal (and so `events`) entry for every change of the delivery result, whoever caused it: send, watch or send --enter-only. */
async function recordDelivery(ctx: Context, window: string, before: { id?: string | undefined; result?: string | undefined }): Promise<void> {
  const record = readTaskRecord(ctx.config, window);
  if (!record?.deliveryResult || (record.deliveryResult === before.result && record.deliveryId === before.id)) return;
  // The first prompt of every task would add a line for each start: only the results that need a look (and every result of a follow-up) are recorded.
  if (record.deliveryResult === 'delivered' && record.promptKind !== 'followup') return;
  const text = deliveryText(record);
  if (text) await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: ${text} [dostawa ${(record.deliveryId ?? '').slice(0, 8)}]` });
}

/**
 * The one place that presses Enter for a delivery after its paste. Persists the count first (a crash must not double an Enter), looks at the
 * field once more right before the key, and presses nothing unless the field has the signature recorded after our paste. `verified`: the
 * caller has just checked the field of `screen` itself (the Enters right after the paste). Also records whether the queue sign was already on
 * the screen: then it proves nothing later.
 */
async function enterForOurPaste(ctx: Context, record: TaskRecord, file: string, window: string, settings: AgentSettings, options: { verified: boolean; screen?: Capture }): Promise<{ pressed: true; result: Awaited<ReturnType<Context['tmux']['pressEnter']>> } | { pressed: false; why: string }> {
  const count = (record.deliveryEnters ?? 0) + 1, previous = { enters: record.deliveryEnters, at: record.deliveryEnterAt };
  await setHeaderFields(ctx.runner, file, { delivery_enters: count, delivery_enter_at: new Date(ctx.runner.now()).toISOString() });
  const last = options.screen ?? await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
  const ours = last.code === 0 && (options.verified || fieldIsOurs(last.stdout, settings.footerPatterns, record.deliveryField));
  if (!ours) {
    await setHeaderFields(ctx.runner, file, { delivery_enters: previous.enters ?? 0, delivery_enter_at: previous.at ?? null });
    return { pressed: false, why: last.code !== 0 ? 'the pane cannot be read' : 'the input no longer shows exactly our paste' };
  }
  record.deliveryEnters = count;
  record.deliveryQueueSign = queueSignShown(record.agent, last.stdout, last.dimInput);
  await setHeaderFields(ctx.runner, file, { delivery_queue_sign: record.deliveryQueueSign });
  return { pressed: true, result: await ctx.tmux.pressEnter(window) };
}

/** Initial prompts and resume instructions are pasted once. Only Enter can be retried, and only while the field shows nothing but our paste. */
export async function deliverPendingPrompt(ctx: Context, window: string): Promise<'sent' | 'pending' | 'confirming' | 'needs-attention'> {
  if (ctx.runner.dryRun) return 'sent';
  const was = readTaskRecord(ctx.config, window), before = { id: was?.deliveryId, result: was?.deliveryResult };
  const outcome = await deliverOnce(ctx, window);
  await recordDelivery(ctx, window, before);
  return outcome;
}

async function deliverOnce(ctx: Context, window: string): Promise<'sent' | 'pending' | 'confirming' | 'needs-attention'> {
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) return 'needs-attention';
    if (record.promptDelivery === 'sent') return 'sent';
    const file = taskFile(ctx.config, window);
    if (stateWriteFailure(file)) return 'needs-attention';
    const attention = async (why: string) => {
      const field = record.deliveryResult === 'not-delivered-in-field';
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'needs-attention', prompt_error: field ? `${NOT_DELIVERED}: ${why}. The text is in the input of ${record.task}: attach and press Enter${record.deliveryField ? `, or run "agentctl send --enter-only ${record.task}"` : ''}. agentctl does not paste it again.` : `Prompt delivery not confirmed: ${why}. Inspect ${record.task} with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.` });
      return 'needs-attention' as const;
    };
    const uncertain = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', prompt_error: `${DELIVERY_WARNING}: ${why}` });
      return 'confirming' as const;
    };
    /** The paste stands in the field (or the field changed under it) and no Enter has taken it. */
    const notDelivered = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: ${why}` });
      return 'confirming' as const;
    };
    const sent = async (proof: DeliveryProof = 'delivered') => {
      await setHeaderFields(ctx.runner, file, { delivery_id: record.deliveryId ?? randomUUID(), prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, delivery_result: proof, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
      return 'sent' as const;
    };
    if (['sending', 'confirming', 'needs-attention'].includes(record.promptDelivery ?? '')) {
      const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      const text = screen.code === 0 ? screen.stdout : '';
      const proof = deliveryProof(ctx, record, text, screen.dimInput);
      if (proof) return sent(proof);
      // Our paste still stands in an input field that shows exactly what the paste left there (not a line less, not a line more): press Enter again, a few times, spaced out.
      if (record.deliveryResult === 'not-delivered-in-field' && record.deliveryField && record.agent !== 'unknown' && screen.code === 0) {
        const settings = ctx.config.agents[record.agent];
        const left = (record.deliveryEnters ?? 0) < MAX_ENTERS;
        const due = ctx.runner.now() - Date.parse(record.deliveryEnterAt ?? record.deliveryStartedAt ?? record.started) >= ENTER_RETRY_S * 1000;
        if (fieldIsOurs(text, settings.footerPatterns, record.deliveryField) && mayPressEnter(classifyScreen(text, settings), record, settings)) {
          if (left && due) {
            const enter = await enterForOurPaste(ctx, record, file, window, settings, { verified: false });
            if (!enter.pressed) return notDelivered(`${enter.why}; no Enter was sent`);
            if (enter.result.code !== 0) return notDelivered(`Enter failed: ${enter.result.stderr}`);
            for (let poll = 0; poll < 8; poll++) {
              await ctx.runner.sleep(150);
              const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
              const again = pane.code === 0 ? deliveryProof(ctx, record, pane.stdout !== text ? pane.stdout : '', pane.dimInput) : null;
              if (again) return sent(again);
            }
          }
          if (!left && due && record.promptDelivery !== 'needs-attention') return attention(`Enter pressed ${record.deliveryEnters} times and the text is still in the field`);
        }
      }
      if (record.promptDelivery === 'needs-attention') return 'needs-attention';
      if (ctx.runner.now() - Date.parse(record.deliveryStartedAt ?? record.started) >= ctx.config.deliveryConfirmS * 1000) return attention('no acknowledgement before delivery_confirm_s elapsed');
      return record.deliveryResult === 'not-delivered-in-field' ? 'confirming' : uncertain('awaiting hook, working screen, transcript echo or canonical report');
    }
    if (!record.pendingPrompt || record.agent === 'unknown') return 'needs-attention';
    const settings = ctx.config.agents[record.agent], text = record.pendingPrompt;
    if (record.promptDelivery === 'launching') return 'pending';
    const before = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    const beforeState = classifyScreen(before.stdout, settings);
    const busyFollowup = record.promptKind === 'followup' && settings.acceptsBusyPrompt !== false && ['working', 'background'].includes(beforeState);
    if (before.code !== 0 || !inputVisible(before.stdout, settings) || (!busyFollowup && beforeState !== 'idle')) return 'pending';

    record.deliveryWasBusy = busyFollowup;
    record.deliveryStartedAt = new Date(ctx.runner.now()).toISOString();
    record.deliveryOutputBaseline = outputFingerprint(before.stdout, settings.deliveryPattern);
    record.deliveryEchoBaseline = echoLines(before.stdout, markerOf(record), text);
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sending', delivery_was_busy: busyFollowup, delivery_started_at: record.deliveryStartedAt, delivery_output_baseline: record.deliveryOutputBaseline, delivery_echo_baseline: record.deliveryEchoBaseline, delivery_enters: 0 });
    record.deliveryEnters = 0;
    if (screenMetadata(before.stdout).draft_input) return uncertain('the input already contains a draft; it was not overwritten');
    // The Enters right after the paste (same call, well under a second later) accept what the TUI shows of the paste: the text, its first line or a placeholder.
    // Later Enters (watch, send --enter-only) need more: the whole field with the signature recorded below.
    const ownsDraft = (draft: string) => text.startsWith(draft) || draft.startsWith(text.split('\n')[0]!) || /\[Pasted|pasted (?:text|content)/i.test(draft);
    try {
      await ctx.tmux.pasteText(window, text);
      await ctx.runner.sleep(400);
      for (let attempt = 0; attempt < PASTE_ENTERS; attempt++) {
        if (attempt > 0) await ctx.runner.sleep(400);
        const ready = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        const currentState = classifyScreen(ready.stdout, settings), field = inputFieldLines(ready.stdout, settings.footerPatterns);
        const proof = deliveryProof(ctx, record, ready.stdout !== before.stdout ? ready.stdout : '', ready.stdout !== before.stdout ? ready.dimInput : '');
        if (proof) return sent(proof);
        const currentDraft = screenMetadata(ready.stdout).draft_input;
        if (currentDraft && !ownsDraft(currentDraft)) return notDelivered('the input changed before Enter; no Enter was sent');
        // The paste is strictly ours when the field shows all of it (or the one placeholder that stands for it). That signature is also the proof that agentctl pasted for this delivery.
        const signature = ownPasteSignature(field, text);
        if (record.deliveryField && field.length && fieldSignature(field) !== record.deliveryField) return notDelivered('the input changed since our paste; no Enter was sent');
        if (ready.code !== 0) return uncertain('the pane cannot be read');
        // The screen of a working agent can look idle for a moment before the paste: what counts is the state with our paste in the field.
        if (attempt === 0 && !record.deliveryWasBusy && ['working', 'background'].includes(currentState) && record.promptKind === 'followup') {
          record.deliveryWasBusy = true;
          await setHeaderFields(ctx.runner, file, { delivery_was_busy: true });
        }
        if (signature && record.deliveryField !== signature) {
          record.deliveryField = signature;
          await setHeaderFields(ctx.runner, file, { delivery_field: signature });
        }
        if (!mayPressEnter(currentState, record, settings)) return notDelivered(`the agent shows ${currentState}; no Enter was sent`);
        const enter = await enterForOurPaste(ctx, record, file, window, settings, { verified: true, screen: ready });
        if (!enter.pressed) return notDelivered(`${enter.why}; no Enter was sent`);
        if (enter.result.code !== 0) return notDelivered(`Enter failed: ${enter.result.stderr}`);
        let ourDraft = false;
        for (let poll = 0; poll < 8; poll++) {
          await ctx.runner.sleep(150);
          const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          if (pane.code !== 0) return uncertain('the pane cannot be read');
          const state = classifyScreen(pane.stdout, settings), draft = screenMetadata(pane.stdout).draft_input;
          // A quick completed turn can finish between polls; require new assistant output as its acknowledgement.
          const seen = pane.stdout !== before.stdout;
          const again = deliveryProof(ctx, record, seen ? pane.stdout : '', seen ? pane.dimInput : '');
          if (again) return sent(again);
          if (state !== 'idle' && !(record.deliveryWasBusy && ['working', 'background'].includes(state))) return uncertain(`the agent shows ${state}; no further key was sent`);
          ourDraft = Boolean(draft && ownsDraft(draft));
          if (draft && !ourDraft) return notDelivered('the input changed to another draft');
          if (record.deliveryField && draft && fieldSignature(inputFieldLines(pane.stdout, settings.footerPatterns)) !== record.deliveryField) return notDelivered('the input changed to another draft');
        }
        // Never send another Enter into an empty input: the first submission may already have been accepted.
        if (!ourDraft) return uncertain('no working state, queue sign or completed-turn acknowledgement was observed');
      }
      return notDelivered(`the pasted prompt is still in the input after Enter and two retries; watch tries again every ${ENTER_RETRY_S} s`);
    } catch (e) { return uncertain(errorMessage(e)); }
  });
}

export interface SubmitDraftResult {
  /**
   * `submitted`: Enter went in and the agent took the message; `pending`: Enter went in, nothing proves it yet; `not-delivered`: Enter went in
   * and the text still stands in the field; `refused`: no key was pressed; `ready`: preview only, Enter would be pressed.
   */
  outcome: 'submitted' | 'pending' | 'not-delivered' | 'refused' | 'ready';
  message: string;
  /** An Enter key was sent (submitted, pending, not-delivered). */
  keySent?: boolean;
  deliveryId?: string | undefined;
}

/**
 * `send --enter-only`: press Enter for the text that our own paste left in the input field. Needs the persisted origin (agentctl pasted for
 * this delivery) and the whole field to have the signature recorded after that paste. Anybody else's draft, a partial or changed paste, an
 * empty field or an open dialog is refused with no key. `preview` only checks.
 */
export async function submitDraft(ctx: Context, window: string, options: { preview?: boolean } = {}): Promise<SubmitDraftResult> {
  if (ctx.runner.dryRun) return { outcome: options.preview ? 'ready' : 'submitted', message: 'dry run: Enter would be pressed' };
  const done = await submitOnce(ctx, window, options);
  // Every Enter that was pressed for a delivery is written down, whether or not it changed the result.
  if (done.keySent) {
    const record = readTaskRecord(ctx.config, window);
    if (record) await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: send --enter-only – ${done.message} [dostawa ${(done.deliveryId ?? '').slice(0, 8)}]` });
  }
  return done;
}

async function submitOnce(ctx: Context, window: string, options: { preview?: boolean }): Promise<SubmitDraftResult> {
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const refused = (message: string, record?: TaskRecord): SubmitDraftResult => ({ outcome: 'refused', message, deliveryId: record?.deliveryId });
    const record = readTaskRecord(ctx.config, window);
    if (!record || record.agent === 'unknown') return refused('nie ma stanu zadania tego okna – nic nie zatwierdzam');
    const file = taskFile(ctx.config, window), settings = ctx.config.agents[record.agent];
    const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (screen.code !== 0) return refused(`okno ${window} nie daje się odczytać – nic nie zatwierdzam`, record);
    const field = inputFieldLines(screen.stdout, settings.footerPatterns);
    if (!field.length) return refused('pole wpisywania jest puste – nie ma czego zatwierdzić', record);
    if (record.promptDelivery === 'sent' || !record.deliveryId || !record.deliveryField) return refused('agentctl nie wkleił w to pole tekstu żadnej oczekującej wiadomości (brak śladu wklejki dla tej dostawy) – nie zatwierdzam; sprawdź peek albo attach', record);
    if (!fieldIsOurs(screen.stdout, settings.footerPatterns, record.deliveryField)) return refused(`w polu jest co innego niż to, co agentctl wkleił („${field.join(' ').slice(0, 60)}”) – nie zatwierdzam cudzego ani zmienionego szkicu; sprawdź peek albo attach`, record);
    const state = classifyScreen(screen.stdout, settings);
    if (!mayPressEnter(state, { ...record, promptKind: 'followup' }, settings)) return refused(`agent pokazuje ${state} – nie wciskam Enter; odpowiedz w oknie (attach)`, record);
    if (options.preview) return { outcome: 'ready', message: `w polu stoi dokładnie wklejka agentctl (${field.join(' ').slice(0, 60)}); Enter zostanie wciśnięty`, deliveryId: record.deliveryId };
    const busy = ['working', 'background'].includes(state);
    if (record.deliveryWasBusy === undefined) { record.deliveryWasBusy = busy; await setHeaderFields(ctx.runner, file, { delivery_was_busy: busy }); }
    const enter = await enterForOurPaste(ctx, record, file, window, settings, { verified: false });
    if (!enter.pressed) return refused(`${enter.why} – nic nie zatwierdzam`, record);
    const keySent = { keySent: true as const, deliveryId: record.deliveryId };
    if (enter.result.code !== 0) return { outcome: 'not-delivered', message: `Enter nie poszedł: ${enter.result.stderr.trim()}`, keySent: false, deliveryId: record.deliveryId };
    for (let poll = 0; poll < 10; poll++) {
      await ctx.runner.sleep(150);
      const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (pane.code !== 0) break;
      const proof = deliveryProof(ctx, record, pane.stdout !== screen.stdout ? pane.stdout : '', pane.dimInput);
      if (proof) {
        await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, delivery_result: proof, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
        return { outcome: 'submitted', message: proof === 'queued-in-agent' ? `zatwierdzono Enter; ${QUEUED_IN_AGENT}` : 'zatwierdzono Enter; agent przyjął wiadomość', ...keySent };
      }
      if (!fieldIsOurs(pane.stdout, settings.footerPatterns, record.deliveryField)) break;
    }
    const after = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (after.code === 0 && fieldIsOurs(after.stdout, settings.footerPatterns, record.deliveryField)) {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: Enter was pressed and the text is still in the field` });
      return { outcome: 'not-delivered', message: `${NOT_DELIVERED}; Enter poszedł, ale tekst nadal stoi w polu – wciśnij Enter w oknie (attach)`, ...keySent };
    }
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: null, prompt_error: `${DELIVERY_WARNING}: Enter pressed by send --enter-only` });
    return { outcome: 'pending', message: `zatwierdzono Enter; ${DELIVERY_WARNING} (watch)`, ...keySent };
  });
}
