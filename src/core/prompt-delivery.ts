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
import type { ScreenState } from './state.ts';
import { screenMetadata } from './tmux.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { errorMessage } from './util.ts';

/** Persist before waiting for trust, so a watcher can finish the same delivery after new returns. */
export async function queuePrompt(ctx: Context, record: TaskRecord, text: string, delivery: 'launching' | 'pending' = 'pending', options: { kind?: 'followup'; id?: string } = {}): Promise<void> {
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { pending_prompt: text, prompt_delivery: delivery, prompt_error: null, prompt_sent_at: null, delivery_id: options.id ?? randomUUID(), prompt_kind: options.kind ?? 'initial', delivery_was_busy: null, delivery_started_at: null, delivery_report_baseline: reportFingerprint(record.report), delivery_result: null, delivery_field: null, delivery_enters: null, delivery_enter_at: null, delivery_echo_baseline: null });
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
 * "ctrl+x ctrl+s to send now". Codex has no such sign: Enter steers the running turn and the echo of the message follows at once.
 */
const QUEUE_SIGNS: Partial<Record<'claude' | 'codex', RegExp>> = { claude: /Press up to edit queued messages|ctrl\+x ctrl\+s to send now/i };

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Lines above the input field that start with the prompt marker and with the start of `prompt`: the transcript echo (the TUI breaks long lines itself, so only the start is compared). */
export function echoLines(screen: string, marker: string, prompt: string | undefined): number {
  const first = squash(prompt?.split('\n').find(line => line.trim()) ?? '').slice(0, 60);
  if (!first) return 0;
  return screen.split('\n').filter(line => line.trimStart().startsWith(marker)).slice(0, -1).filter(line => squash(line.trim().slice(marker.length)).startsWith(first)).length;
}

/** The agent's marker in front of what the user sent. */
const markerOf = (record: TaskRecord) => record.agent === 'claude' ? '❯' : '›';

/**
 * Hooks are checked first; screen evidence is adapter-specific and never an input draft. The answer says how the message arrived:
 * `delivered` (the agent took it up) or `queued-in-agent` (it waits in the agent's own queue); null while nothing proves either.
 */
export function deliveryProof(ctx: Context, record: TaskRecord, screen: string, dimInput = ''): DeliveryProof | null {
  const draft = screenMetadata(screen).draft_input;
  if (draft) return null;
  // The queue sign comes first: the hook fires when the message is submitted, queued or not, and a message that waits is not yet read.
  if (record.deliveryWasBusy && record.deliveryStartedAt && record.agent !== 'unknown' && QUEUE_SIGNS[record.agent]?.test(`${screen}\n${dimInput}`)) return 'queued-in-agent';
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
  // A question or idle notification alone can belong to the previous turn.
  if (record.deliveryWasBusy && /Queued follow-up inputs|Queued messages?/i.test(screen) && record.pendingPrompt && screen.includes(record.pendingPrompt.split('\n')[0]!)) return 'delivered';
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

/** What `send` says when the delivery is not simply done. */
export function deliveryNote(record: TaskRecord | undefined): string | undefined {
  if (!record) return undefined;
  if (record.deliveryResult === 'not-delivered-in-field' && record.promptDelivery !== 'sent') return `${NOT_DELIVERED}${record.promptError ? ` (${record.promptError.replace(/^[^:]*:\s*/, '')})` : ''}; watch ponowi Enter, albo: agentctl send --enter-only ${record.task}`;
  if (record.deliveryResult === 'queued-in-agent' && record.promptDelivery === 'sent') return `wklejono; ${QUEUED_IN_AGENT}`;
  return undefined;
}

/** Initial prompts and resume instructions are pasted once. Only Enter can be retried, and only while the field shows nothing but our paste. */
export async function deliverPendingPrompt(ctx: Context, window: string): Promise<'sent' | 'pending' | 'confirming' | 'needs-attention'> {
  if (ctx.runner.dryRun) return 'sent';
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) return 'needs-attention';
    if (record.promptDelivery === 'sent') return 'sent';
    const file = taskFile(ctx.config, window);
    if (stateWriteFailure(file)) return 'needs-attention';
    const attention = async (why: string) => {
      const field = record.deliveryResult === 'not-delivered-in-field';
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'needs-attention', prompt_error: field ? `${NOT_DELIVERED}: ${why}. The text is in the input of ${record.task}: attach and press Enter, or run "agentctl send --enter-only ${record.task}". agentctl does not paste it again.` : `Prompt delivery not confirmed: ${why}. Inspect ${record.task} with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.` });
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
    const pressEnter = async () => {
      record.deliveryEnters = (record.deliveryEnters ?? 0) + 1;
      await setHeaderFields(ctx.runner, file, { delivery_enters: record.deliveryEnters, delivery_enter_at: new Date(ctx.runner.now()).toISOString() });
      return ctx.tmux.pressEnter(window);
    };
    if (['sending', 'confirming', 'needs-attention'].includes(record.promptDelivery ?? '')) {
      const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      const text = screen.code === 0 ? screen.stdout : '';
      const proof = deliveryProof(ctx, record, text, screen.dimInput);
      if (proof) return sent(proof);
      // Our paste still stands in an input field that shows nothing else: press Enter again, a few times, spaced out.
      if (record.deliveryResult === 'not-delivered-in-field' && record.deliveryField && record.agent !== 'unknown' && screen.code === 0) {
        const settings = ctx.config.agents[record.agent];
        const left = (record.deliveryEnters ?? 0) < MAX_ENTERS;
        const due = ctx.runner.now() - Date.parse(record.deliveryEnterAt ?? record.deliveryStartedAt ?? record.started) >= ENTER_RETRY_S * 1000;
        if (screenMetadata(text).draft_input === record.deliveryField && mayPressEnter(classifyScreen(text, settings), record, settings)) {
          if (left && due) {
            const enter = await pressEnter();
            if (enter.code !== 0) return notDelivered(`Enter failed: ${enter.stderr}`);
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

    const ownsDraft = (draft: string) => text.startsWith(draft) || draft.startsWith(text.split('\n')[0]!) || /\[Pasted|pasted (?:text|content)/i.test(draft);
    record.deliveryWasBusy = busyFollowup;
    record.deliveryStartedAt = new Date(ctx.runner.now()).toISOString();
    record.deliveryOutputBaseline = outputFingerprint(before.stdout, settings.deliveryPattern);
    record.deliveryEchoBaseline = echoLines(before.stdout, markerOf(record), text);
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sending', delivery_was_busy: busyFollowup, delivery_started_at: record.deliveryStartedAt, delivery_output_baseline: record.deliveryOutputBaseline, delivery_echo_baseline: record.deliveryEchoBaseline, delivery_enters: 0 });
    record.deliveryEnters = 0;
    if (screenMetadata(before.stdout).draft_input) return uncertain('the input already contains a draft; it was not overwritten');
    try {
      await ctx.tmux.pasteText(window, text);
      await ctx.runner.sleep(400);
      for (let attempt = 0; attempt < PASTE_ENTERS; attempt++) {
        if (attempt > 0) await ctx.runner.sleep(400);
        const ready = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        const currentState = classifyScreen(ready.stdout, settings), currentDraft = screenMetadata(ready.stdout).draft_input;
        const proof = deliveryProof(ctx, record, ready.stdout !== before.stdout ? ready.stdout : '', ready.stdout !== before.stdout ? ready.dimInput : '');
        if (proof) return sent(proof);
        if (currentDraft && !ownsDraft(currentDraft)) return notDelivered('the input changed before Enter; no Enter was sent');
        if (ready.code !== 0) return uncertain('the pane cannot be read');
        // The screen of a working agent can look idle for a moment before the paste: what counts is the state with our paste in the field.
        if (attempt === 0 && !record.deliveryWasBusy && ['working', 'background'].includes(currentState) && record.promptKind === 'followup') {
          record.deliveryWasBusy = true;
          await setHeaderFields(ctx.runner, file, { delivery_was_busy: true });
        }
        // What our paste left in the field is the only text that a later Enter (watch, send --enter-only) may take.
        if (currentDraft && record.deliveryField !== currentDraft) {
          record.deliveryField = currentDraft;
          await setHeaderFields(ctx.runner, file, { delivery_field: currentDraft });
        }
        if (!mayPressEnter(currentState, record, settings)) return notDelivered(`the agent shows ${currentState}; no Enter was sent`);
        const enter = await pressEnter();
        if (enter.code !== 0) return notDelivered(`Enter failed: ${enter.stderr}`);
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
        }
        // Never send another Enter into an empty input: the first submission may already have been accepted.
        if (!ourDraft) return uncertain('no working state, queue sign or completed-turn acknowledgement was observed');
      }
      return notDelivered(`the pasted prompt is still in the input after Enter and two retries; watch tries again every ${ENTER_RETRY_S} s`);
    } catch (e) { return uncertain(errorMessage(e)); }
  });
}

export interface SubmitDraftResult {
  /** `submitted`: Enter went in and the agent took the message; `pending`: Enter went in, nothing proves it yet; `refused`: nothing was pressed. */
  outcome: 'submitted' | 'pending' | 'refused';
  message: string;
}

/**
 * `send --enter-only`: press Enter for the text that our own paste left in the input field. The field must show exactly what the delivery
 * recorded after its paste (or the start of the prompt that is waiting); anybody else's draft, an empty field or an open dialog is refused.
 */
export async function submitDraft(ctx: Context, window: string): Promise<SubmitDraftResult> {
  if (ctx.runner.dryRun) return { outcome: 'submitted', message: 'dry run: Enter would be pressed' };
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record || record.agent === 'unknown') return { outcome: 'refused' as const, message: 'nie ma stanu zadania tego okna – nic nie zatwierdzam' };
    const file = taskFile(ctx.config, window), settings = ctx.config.agents[record.agent];
    const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (screen.code !== 0) return { outcome: 'refused' as const, message: `okno ${window} nie daje się odczytać – nic nie zatwierdzam` };
    const field = screenMetadata(screen.stdout).draft_input;
    if (!field) return { outcome: 'refused' as const, message: 'pole wpisywania jest puste – nie ma czego zatwierdzić' };
    const pending = record.pendingPrompt;
    const ours = record.promptDelivery !== 'sent' && (field === record.deliveryField || Boolean(pending && (field === pending || (field.length >= 20 && pending.startsWith(field)))));
    if (!ours) return { outcome: 'refused' as const, message: `w polu jest tekst, którego agentctl nie wkleił („${field.slice(0, 60)}”) – nie zatwierdzam cudzego szkicu; sprawdź peek albo attach` };
    const state = classifyScreen(screen.stdout, settings);
    if (!mayPressEnter(state, { ...record, promptKind: 'followup' }, settings)) return { outcome: 'refused' as const, message: `agent pokazuje ${state} – nie wciskam Enter; odpowiedz w oknie (attach)` };
    record.deliveryEnters = (record.deliveryEnters ?? 0) + 1;
    const busy = ['working', 'background'].includes(state);
    await setHeaderFields(ctx.runner, file, { delivery_enters: record.deliveryEnters, delivery_enter_at: new Date(ctx.runner.now()).toISOString(), ...(record.deliveryWasBusy === undefined ? { delivery_was_busy: busy } : {}) });
    if (record.deliveryWasBusy === undefined) record.deliveryWasBusy = busy;
    const enter = await ctx.tmux.pressEnter(window);
    if (enter.code !== 0) return { outcome: 'refused' as const, message: `Enter nie poszedł: ${enter.stderr.trim()}` };
    for (let poll = 0; poll < 10; poll++) {
      await ctx.runner.sleep(150);
      const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (pane.code !== 0) break;
      const proof = deliveryProof(ctx, record, pane.stdout !== screen.stdout ? pane.stdout : '', pane.dimInput);
      if (proof) {
        await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, delivery_result: proof, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
        return { outcome: 'submitted' as const, message: proof === 'queued-in-agent' ? `zatwierdzono Enter; ${QUEUED_IN_AGENT}` : 'zatwierdzono Enter; agent przyjął wiadomość' };
      }
      if (screenMetadata(pane.stdout).draft_input !== field) break;
    }
    const left = screenMetadata((await ctx.tmux.capture(window, undefined, undefined, record.windowId, true)).stdout).draft_input === field;
    if (left) {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: Enter was pressed and the text is still in the field` });
      return { outcome: 'refused' as const, message: `${NOT_DELIVERED}; Enter poszedł, ale tekst nadal stoi w polu – sprawdź attach` };
    }
    if (record.promptDelivery !== 'sent') await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: null, prompt_error: `${DELIVERY_WARNING}: Enter pressed by send --enter-only` });
    return { outcome: 'pending' as const, message: `zatwierdzono Enter; ${DELIVERY_WARNING} (watch)` };
  });
}
