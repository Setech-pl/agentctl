import { provider } from './providers/registry.ts';
import { stateWriteFailure } from './atomic-file.ts';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inspectReport, reportFingerprint } from './report-state.ts';
import { PATTERN_FLAGS } from './config.ts';
import type { AgentName, AgentSettings } from './config.ts';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { codexQueueKey, areaKey, fieldArea, fieldText, inspectField, pasteImage, readsAs } from './input-field.ts';
import { eol } from './paste-wrapper.ts';
import { recordJournal } from './journal.ts';
import type { ScreenState } from './state.ts';
import { screenMetadata } from './tmux.ts';
import type { Capture } from './tmux.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { transcriptMessage } from './transcript.ts';
import { errorMessage } from './util.ts';

/** Persist before waiting for trust, so a watcher can finish the same delivery after new returns. */
export async function queuePrompt(ctx: Context, record: TaskRecord, text: string, delivery: 'launching' | 'pending' = 'pending', options: { kind?: 'followup'; id?: string } = {}): Promise<void> {
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { pending_prompt: text, prompt_delivery: delivery, prompt_error: null, prompt_sent_at: null, delivery_id: options.id ?? randomUUID(), prompt_kind: options.kind ?? 'initial', delivery_was_busy: null, delivery_started_at: null, delivery_report_baseline: reportFingerprint(record.report), delivery_result: null, delivery_field: null, delivery_source: null, delivery_enters: null, delivery_enter_at: null, delivery_echo_baseline: null, delivery_queue_sign: null });
}

const outputFingerprint = (screen: string, pattern: string) => createHash('sha256').update(screen.split('\n').filter(line => new RegExp(pattern, PATTERN_FLAGS).test(line)).join('\n')).digest('hex');

export const DELIVERY_WARNING = 'dostarczenie niepotwierdzone – sprawdzam';
/** Kimi: our paste stands in the field, no Enter has gone in yet, and the screen has not held still; the watcher presses Enter once it does. */
export const KIMI_SETTLING = 'ekran Kimi jeszcze się zmienia – Enter po ustabilizowaniu';
/** The paste stands in the input field and no Enter took it. */
export const NOT_DELIVERED = 'nie dostarczono – tekst w polu wpisywania';
/** The screen shows the message in the agent's queue; no hook and no transcript has said so. It is a classification, not a confirmation. */
export const QUEUED_IN_AGENT = 'w kolejce agenta – niepotwierdzone';
/** Enters of one delivery: all in the call that pasted. After it agentctl presses Enter only when a human confirms the exact text (`send --enter-only`). */
const PASTE_ENTERS = 3;
/**
 * Kimi only (stablePaste): how often and how far apart the screen is read until two reads agree before a paste or an Enter. Bounded on purpose:
 * a screen that keeps changing gets no Enter in this call; the watcher looks again on its next pass (no global timeout is widened).
 */
const SETTLE_LOOKS = 8;
const SETTLE_MS = 250;

/**
 * The part of a Kimi screen that has to hold still: the composer and everything above it. Below the composer Kimi redraws its footer on its own
 * clock (a rotating tip, the context gauge), so a whole-screen comparison never settles for long (P92, dev 12.11: "Kimi screen is not stable before
 * Enter" on the start screen left the first prompt in the field for the owner). Undefined while the composer box is not whole.
 */
export function kimiSettledView(screen: string): string | undefined {
  const field = inspectField(screen, 'kimi');
  if (!field.readable || field.bottom === undefined) return undefined;
  return screen.split('\n').slice(0, field.bottom + 1).map(line => line.trimEnd()).join('\n');
}

export type DeliveryProof = 'delivered';

/**
 * What an agent shows while a message waits in its own queue (recorded from the real CLIs: tests/fixtures/screen-claude-busy-queued*.txt).
 * Claude Code 2.1.311 puts a dim "Press up to edit queued messages" in the empty field, and during thinking shows the queued message with
 * "ctrl+x ctrl+s to send now" on a line of its own. Codex advertises Tab to queue while working; older Enter submissions steer and echo the message.
 * The sign classifies a message as "queued, not confirmed" (an older queue, a quoted answer or another message show it too); it confirms nothing.
 */
const QUEUE_SIGNS: Partial<Record<'claude' | 'codex', RegExp>> = { claude: /^\s*(?:Press up to edit queued messages|ctrl\+x ctrl\+s to send now)\s*$/i };

/** Is a queue sign on the screen: a line of its own, or the dim text of the input field? */
export function queueSignShown(agent: TaskRecord['agent'], screen: string, dimInput = ''): boolean {
  const sign = agent === 'claude' || agent === 'codex' ? QUEUE_SIGNS[agent] : undefined;
  return Boolean(sign && (sign.test(dimInput) || screen.split('\n').some(line => sign.test(line))));
}

/** The agent's marker in front of what the user sent. */
const markerOf = (record: TaskRecord) => record.agent === 'unknown' ? '❯' : provider(record.agent).screen.echoMarker;

/**
 * Codex 0.167 renders a message queued while a turn runs as "↳ <text>" (wrapped rows indented) right above the composer
 * (P64: DEMO-BUG-1, 2026-11-08; tests/fixtures/screen-codex-0167-busy-queued.txt). True when such a block reads back as
 * exactly `prompt`. The "↳" is Codex's own queue marker, not the "›" echo of a steered message.
 */
export function codexQueuedEcho(screen: string, prompt: string | undefined): boolean {
  if (!prompt?.trim()) return false;
  const lines = screen.split('\n').map(line => line.trimEnd());
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*↳\s*\S/.test(lines[i]!)) continue;
    const rows = [lines[i]!.replace(/^\s*↳\s*/, '')];
    for (let j = i + 1; j < lines.length && /^\s{2,}\S/.test(lines[j]!) && !/^\s*↳/.test(lines[j]!); j++) rows.push(lines[j]!.replace(/^ {1,2}/, ''));
    if (readsAs(rows, prompt, 'codex', true)) return true;
  }
  return false;
}

/**
 * The echo of `prompt` in the transcript of the screen: a line that starts with the agent's prompt marker plus the rows that continue it (the TUI
 * wraps long lines and indents the rest), read back to exactly the prompt - nothing squeezed, nothing left out. Counts the blocks above the input field.
 */
export function echoLines(screen: string, marker: string, prompt: string | undefined, agent?: 'claude' | 'codex' | 'kimi' | 'unknown'): number {
  if (!prompt?.trim()) return 0;
  const lines = screen.split('\n').map(line => line.trimEnd());
  const isMarker = (line: string) => line.trimStart().startsWith(marker);
  const field = lines.findLastIndex(isMarker);
  let count = 0;
  for (let i = 0; i < field; i++) {
    if (!isMarker(lines[i]!)) continue;
    const rows = [lines[i]!.trimStart().slice(marker.length).replace(/^ /, '')];
    for (let j = i + 1; j < field && (lines[j] === '' || (/^\s{2,}\S/.test(lines[j]!) && !isMarker(lines[j]!))); j++) rows.push(lines[j]!.replace(/^ {1,2}/, ''));
    while (rows.length > 1 && rows.at(-1) === '') rows.pop();
    if (readsAs(rows, prompt, agent, true)) count++;
  }
  return count;
}

/**
 * The screen only classifies. The agent shows the message in its own queue (Claude: the queue sign, correlated as below; Codex: the echo of the
 * steered message): "queued in the agent, not confirmed". The sign needs a recorded paste, an Enter of ours and a sign that was not there before it.
 */
export function deliveryClass(record: TaskRecord, screen: string, dimInput = ''): 'queued-in-agent' | null {
  if (!record.deliveryStartedAt || !record.deliveryWasBusy || !record.deliveryField || (record.deliveryEnters ?? 0) < 1 || screenMetadata(screen).draft_input) return null;
  if (record.deliveryQueueSign === false && queueSignShown(record.agent, screen, dimInput)) return 'queued-in-agent';
  if (record.agent === 'codex' && codexQueuedEcho(screen, record.pendingPrompt)) return 'queued-in-agent';
  if (record.agent === 'codex' && echoLines(screen, markerOf(record), record.pendingPrompt, record.agent) > (record.deliveryEchoBaseline ?? 0)) return 'queued-in-agent';
  return null;
}

/**
 * The rows under a "Queued follow-up inputs" / "Queued messages" heading, down to the input field, read back to exactly `prompt`.
 */
function queuedListShows(screen: string, prompt: string, agent: TaskRecord['agent']): boolean {
  const lines = screen.split('\n').map(line => line.trimEnd());
  const composer = inspectField(screen, agent);
  if (!composer.readable || composer.top === undefined) return false;
  const heading = lines.findLastIndex((line, i) => i < composer.top! && /Queued follow-up inputs|Queued messages?/i.test(line));
  if (heading < 0) return false;
  // The exact same structural edge as fieldArea: a border-like row in the queued text itself stays text.
  const rows = lines.slice(heading + 1, composer.top).map(line => line.replace(/^ {1,2}/, ''));
  while (rows.length && rows.at(-1) === '') rows.pop();
  return rows.length > 0 && readsAs(rows, prompt, agent, true);
}

/**
 * What proves that the agent took this message: its hook (the exact prompt) and its transcript (the exact message, written after the delivery began).
 * Both are exact and neither is a screen. The older signs stay only for the cases that the first prompt of every task has always used and that older tests pin,
 * each as exact as the text allows (no white space squeezed, the whole message): an idle agent started its turn, the canonical report changed, the message
 * echoed whole above an empty composer, a queue list that shows the whole message. The screen of a busy agent otherwise proves nothing (see `deliveryClass`).
 * Returns where the proof came from; null while nothing proves it. A draft in the composer holds every proof back: the message is not yet out of it.
 */
function proofSource(ctx: Context, record: TaskRecord, screen: string): string | null {
  // Kimi's composer is its own box (screen.draft / the field area); its ❯ lines are echoes and dialog options — the generic
  // draft reading (screenMetadata) would mistake an answered "❯ Trust and continue" or a prompt echo for a draft and block every proof.
  const genericDraft = record.agent === 'kimi' ? null : screenMetadata(screen).draft_input;
  if (inspectField(screen, record.agent).area.length || (record.agent !== 'unknown' ? provider(record.agent).screen.draft?.(screen) : undefined) || genericDraft) return null;
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), 'utf8'));
    if (record.deliveryId && evidence.accepted === true && evidence.deliveryId === record.deliveryId && Date.parse(evidence.at) >= Date.parse(record.deliveryStartedAt ?? '')) return 'hook';
  } catch { /* no current hook acknowledgement */ }
  if (record.pendingPrompt && record.deliveryStartedAt) {
    const seen = transcriptMessage(ctx, record, record.pendingPrompt, Date.parse(record.deliveryStartedAt));
    if (seen?.kind === 'user') return 'transcript';
    if (seen) return null; // Queue acceptance and ambiguous/old injection must not fall through to legacy screen signs.
  }
  // Follow-ups require current hook/wire evidence or exact user transcript injection.
  // Reports and screen queues describe the running turn; neither proves this message was taken.
  if (record.promptKind === 'followup') return null;
  // Initial-prompt compatibility only.
  if (record.deliveryResult === 'queued-in-agent-confirmed') return null;
  const report = inspectReport(ctx.config, record, ctx.runner.now(), false);
  if (report.ready && (!record.deliveryStartedAt || report.signature !== record.deliveryReportBaseline)) return 'report';
  if (record.agent === 'unknown') return null;
  // A screen sign proves something only about a prompt that was actually pasted: without a recorded paste a "working"
  // screen is the agent's own doing (a human answered a dialog, a turn started by hand), never proof of this delivery.
  if (!record.deliveryStartedAt) return null;
  const settings = ctx.config.agents[record.agent], state = classifyScreen(screen, settings);
  if ((state === 'working' || state === 'background') && !record.deliveryWasBusy) return 'screen';
  if (record.deliveryWasBusy) return record.pendingPrompt && queuedListShows(screen, record.pendingPrompt, record.agent) ? 'screen' : null;
  if (new RegExp(settings.deliveryPattern, PATTERN_FLAGS).test(screen) && outputFingerprint(screen, settings.deliveryPattern) !== record.deliveryOutputBaseline) return 'screen';
  return echoLines(screen, markerOf(record), record.pendingPrompt, record.agent) > (record.deliveryEchoBaseline ?? 0) ? 'screen' : null;
}

export function deliveryProof(ctx: Context, record: TaskRecord, screen: string, _dimInput = ''): DeliveryProof | null {
  return proofSource(ctx, record, screen) ? 'delivered' : null;
}

export function deliveryEvidence(ctx: Context, record: TaskRecord, screen: string, dimInput = ''): boolean {
  return deliveryProof(ctx, record, screen, dimInput) !== null;
}

/** The enqueue is an exact source for queue acceptance, never for injection. Keep the message pending, even after the turn/timeout. */
async function keepConfirmedQueue(ctx: Context, record: TaskRecord): Promise<boolean> {
  const seen = record.pendingPrompt && record.deliveryStartedAt ? transcriptMessage(ctx, record, record.pendingPrompt, Date.parse(record.deliveryStartedAt)) : undefined;
  if (record.deliveryResult !== 'queued-in-agent-confirmed' && seen?.kind !== 'queued') return false;
  record.deliveryResult = 'queued-in-agent-confirmed';
  const note = deliveryNote(record)!;
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { prompt_delivery: 'confirming', delivery_result: 'queued-in-agent-confirmed', delivery_source: 'transcript-queue', prompt_error: note });
  return true;
}

/** May Enter be pressed with this screen state: an idle agent, or a working one that takes a follow-up into its queue. */
const mayPressEnter = (state: ScreenState, record: Pick<TaskRecord, 'promptKind'>, settings: Pick<AgentSettings, 'acceptsBusyPrompt'>) =>
  state === 'idle' || (['working', 'background'].includes(state) && record.promptKind === 'followup' && settings.acceptsBusyPrompt !== false);

const SOURCES: Record<string, string> = { hook: 'hook UserPromptSubmit', transcript: 'transkrypt sesji', 'transcript-queue': 'transkrypt sesji: agent zapisał wiadomość w swojej kolejce', screen: 'agent bezczynny zaczął turę', report: 'zmieniony raport' };

/** What `send` says when the delivery is not simply done. */
export function deliveryNote(record: TaskRecord | undefined): string | undefined {
  if (!record) return undefined;
  if (record.deliveryResult === 'stale' && record.promptDelivery !== 'sent') return 'wycofana po rozpoczęciu dostarczania (stale) – agent może już nad nią pracować';
  if (record.deliveryResult === 'not-delivered-in-field' && record.promptDelivery !== 'sent') {
    const why = record.promptError ? ` (${record.promptError.replace(/^[^:]*:\s*/, '').split('. ')[0]})` : '';
    // Without the recorded image of our paste `--enter-only` has nothing to compare with: only the window is left.
    if (!record.deliveryField) return `${NOT_DELIVERED}${why}; agentctl nie naciśnie już Enter – wciśnij go w oknie (attach)`;
    return `${NOT_DELIVERED}${why}; agentctl nie naciśnie już Enter sam – wciśnij go w oknie (attach) albo: agentctl send --enter-only ${record.task} (pokaże dokładny tekst i token do potwierdzenia)`;
  }
  if (record.deliveryResult === 'queued-in-agent-confirmed' && record.promptDelivery !== 'sent') {
    const ended = Date.parse(record.turnEndedAt ?? '') >= Date.parse(record.deliveryStartedAt ?? '');
    return `w kolejce agenta – potwierdzone (transkrypt enqueue); ${ended ? 'tura zakończona, ale wstrzyknięcie nadal niepotwierdzone' : 'czekam na wstrzyknięcie user/queued albo hook'}; wiadomość zostaje w TASK.md, agentctl nie naciska Enter`;
  }
  if (record.deliveryResult === 'queued-in-agent' && record.promptDelivery !== 'sent') return `wklejono; ${QUEUED_IN_AGENT} (czekam na hook lub transkrypt; wiadomość zostaje zapisana w TASK.md)`;
  return undefined;
}

/** One line for the journal: every result of a delivery, `delivered` included. */
function deliveryText(record: TaskRecord): string | undefined {
  if (record.deliveryResult === 'delivered' && record.promptDelivery === 'sent') return `dostarczono – agent przyjął wiadomość${record.deliverySource ? ` (${SOURCES[record.deliverySource] ?? record.deliverySource})` : ''}`;
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
 * The one place that presses Enter after the paste of a delivery. `last` is the capture the caller has just checked (the area of the field and the
 * state of the screen): the key follows that very capture. The count is persisted first (a crash must not double an Enter), and whether the queue sign
 * was already on the screen is recorded: then it classifies nothing later.
 */
async function pressEnterAfter(ctx: Context, record: TaskRecord, file: string, window: string, last: Capture): Promise<Awaited<ReturnType<Context['tmux']['pressEnter']>>> {
  record.deliveryEnters = (record.deliveryEnters ?? 0) + 1;
  record.deliveryQueueSign = queueSignShown(record.agent, last.stdout, last.dimInput);
  await setHeaderFields(ctx.runner, file, { delivery_enters: record.deliveryEnters, delivery_enter_at: new Date(ctx.runner.now()).toISOString(), delivery_queue_sign: record.deliveryQueueSign });
  if (record.agent === 'codex' && record.promptKind === 'followup' && record.deliveryWasBusy && ['working', 'background'].includes(classifyScreen(last.stdout, ctx.config.agents.codex)) && codexQueueKey(last.stdout) === 'Tab') return ctx.tmux.sendKey(window, 'Tab');
  return record.agent === 'kimi'
    ? ctx.runner.exec('tmux', ['send-keys', '-t', await ctx.tmux.targetFor(window), 'C-m'])
    : ctx.tmux.pressEnter(window);
}

/** Initial prompts and resume instructions are pasted once and get their Enters in that call. Later agentctl only looks (hook, transcript, screen) and never presses Enter by itself. */
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
    const attention = async (why: string, inField = false) => {
      const field = inField || record.deliveryResult === 'not-delivered-in-field';
      await setHeaderFields(ctx.runner, file, field
        ? { prompt_delivery: 'needs-attention', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: ${why}. The text is in the input of ${record.task}: attach and press Enter${record.deliveryField ? `, or run "agentctl send --enter-only ${record.task}" (it shows the exact text and a token; --confirm <token> presses Enter)` : ''}. agentctl does not paste it again and presses no Enter by itself.` }
        : { prompt_delivery: 'needs-attention', prompt_error: `Prompt delivery not confirmed: ${why}. Inspect ${record.task} with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.` });
      return 'needs-attention' as const;
    };
    const uncertain = async (why: string, result: 'queued-in-agent' | null = null) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: result, prompt_error: `${DELIVERY_WARNING}: ${why}` });
      return 'confirming' as const;
    };
    /** The paste stands in the field (or the field changed under it) and no Enter has taken it. */
    const notDelivered = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: ${why}` });
      return 'confirming' as const;
    };
    const sent = async (source: string) => {
      await setHeaderFields(ctx.runner, file, { delivery_id: record.deliveryId ?? randomUUID(), prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, delivery_result: 'delivered', delivery_source: source, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
      return 'sent' as const;
    };
    const proofOf = (screen: string) => record.agent === 'unknown' ? null : proofSource(ctx, record, screen);
    /**
     * The Enters of one delivery after its paste, and the looks that follow each of them. `before` is the screen from before our paste (or, when a
     * Kimi delivery resumes, the screen with the paste); `owned` is the field our paste left, when it is already known.
     */
    const enterLoop = async (before: Capture, owned: string[] | undefined): Promise<'sent' | 'confirming'> => {
      const agent = record.agent as AgentName, settings = ctx.config.agents[agent], text = record.pendingPrompt ?? '', profile = provider(agent).screen;
      /** The area of the field as the first capture after our paste shows it: it must be our paste, and every later Enter needs the same bytes. */
      let image = owned;
      for (let attempt = 0; attempt < PASTE_ENTERS; attempt++) {
        if (attempt > 0) await ctx.runner.sleep(400);
        let ready = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        const currentState = classifyScreen(ready.stdout, settings), field = inspectField(ready.stdout, record.agent), area = field.area;
        const source = proofOf(ready.stdout !== before.stdout ? ready.stdout : '');
        if (source) return sent(source);
        if (await keepConfirmedQueue(ctx, record)) return 'confirming';
        if (ready.code !== 0) return uncertain('the pane cannot be read');
        if (!field.readable) return notDelivered(field.reason!);
        // The screen of a working agent can look idle for a moment before the paste: what counts is the state with our paste in the field.
        if (attempt === 0 && !record.deliveryWasBusy && ['working', 'background'].includes(currentState) && record.promptKind === 'followup') {
          record.deliveryWasBusy = true;
          await setHeaderFields(ctx.runner, file, { delivery_was_busy: true });
        }
        if (area.length) {
          if (!image) {
            if (!pasteImage(area, text, record.agent)) return notDelivered('the input shows something other than our paste; no Enter was sent');
            image = area;
            record.deliveryField = areaKey(area);
            await setHeaderFields(ctx.runner, file, { delivery_field: record.deliveryField });
          } else if (areaKey(area) !== areaKey(image)) return notDelivered('the input changed since our paste; no Enter was sent');
        }
        if (!mayPressEnter(currentState, record, settings)) return notDelivered(`the agent shows ${currentState}; no Enter was sent`);
        if (profile.stablePaste) {
          if (!area.length || !image) return uncertain('no owned Kimi draft before Enter');
          // The composer and what stands above it must read the same twice in a row; the footer below it may change (kimiSettledView).
          let settled: Capture | undefined;
          for (let look = 0; look < SETTLE_LOOKS && !settled; look++) {
            await ctx.runner.sleep(SETTLE_MS);
            const next = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
            if (next.code !== 0) return uncertain('the pane cannot be read');
            const shown = inspectField(next.stdout, record.agent);
            if (shown.readable && shown.area.length && areaKey(shown.area) !== areaKey(image)) {
              // Kimi may still fold a long paste into "[paste #1 …]": before any Enter, a newer image of our own paste replaces the first one.
              if ((record.deliveryEnters ?? 0) > 0 || !pasteImage(shown.area, text, record.agent)) return notDelivered('the input changed since our paste; no Enter was sent');
              image = shown.area;
              record.deliveryField = areaKey(image);
              await setHeaderFields(ctx.runner, file, { delivery_field: record.deliveryField });
            }
            const state = classifyScreen(next.stdout, settings);
            if (!mayPressEnter(state, record, settings)) return notDelivered(`the agent shows ${state}; no Enter was sent`);
            const view = kimiSettledView(next.stdout);
            if (view !== undefined && shown.area.length && view === kimiSettledView(ready.stdout)) settled = next;
            ready = next;
          }
          if (!settled) {
            if ((record.deliveryEnters ?? 0) > 0) return notDelivered('Kimi screen is not stable before Enter');
            // No Enter has gone in for this paste: the watcher resumes it once the screen holds still (deliverOnce, the confirming branch).
            await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: null, prompt_error: `${DELIVERY_WARNING}: ${KIMI_SETTLING}` });
            return 'confirming';
          }
          ready = settled;
        }
        const pressed = await pressEnterAfter(ctx, record, file, window, ready);
        if (pressed.code !== 0) return notDelivered(`Enter failed: ${pressed.stderr}`);
        let ourDraft = false;
        for (let poll = 0; poll < 8; poll++) {
          await ctx.runner.sleep(150);
          const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          if (pane.code !== 0) return uncertain('the pane cannot be read');
          const state = classifyScreen(pane.stdout, settings), shown = fieldArea(pane.stdout, settings.footerPatterns, record.agent);
          // A quick completed turn can finish between polls; require new assistant output as its acknowledgement.
          const seen = pane.stdout !== before.stdout;
          const again = proofOf(seen ? pane.stdout : '');
          if (again) return sent(again);
          if (await keepConfirmedQueue(ctx, record)) return 'confirming';
          if (state !== 'idle' && !(record.deliveryWasBusy && ['working', 'background'].includes(state))) return uncertain(`the agent shows ${state}; no further key was sent`);
          ourDraft = shown.length > 0;
          if (shown.length) {
            if (!image) {
              if (!pasteImage(shown, text, record.agent)) return notDelivered('the input changed to another draft');
              image = shown;
              record.deliveryField = areaKey(shown);
              await setHeaderFields(ctx.runner, file, { delivery_field: record.deliveryField });
            } else if (areaKey(shown) !== areaKey(image)) return notDelivered('the input changed to another draft');
          }
        }
        // Never send another Enter into an empty input: the first submission may already have been accepted.
        if (!ourDraft) {
          const last = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          const queued = last.code === 0 ? deliveryClass(record, last.stdout, last.dimInput) : null;
          return uncertain(queued ? QUEUED_IN_AGENT : 'no hook or transcript line for this message yet', queued);
        }
      }
      return notDelivered('the pasted prompt is still in the input after Enter and two retries; agentctl presses no further Enter by itself');
    };
    if (['sending', 'confirming', 'needs-attention'].includes(record.promptDelivery ?? '')) {
      const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      const text = screen.code === 0 ? screen.stdout : '';
      const source = proofOf(text);
      if (source) return sent(source);
      if (await keepConfirmedQueue(ctx, record)) return 'confirming';
      let queued: 'queued-in-agent' | null = null;
      if (screen.code === 0 && record.agent !== 'unknown') {
        const settings = ctx.config.agents[record.agent], area = fieldArea(text, settings.footerPatterns, record.agent);
        // P92: a Kimi paste that got no Enter because the screen kept changing. Nothing was submitted, so the first Enter cannot double anything:
        // resume once the screen holds still, within delivery_confirm_s.
        const settling = provider(record.agent).screen.stablePaste && record.promptDelivery === 'confirming' && !record.deliveryResult && (record.deliveryEnters ?? 0) === 0;
        if (settling && record.deliveryField && area.length && areaKey(area) === record.deliveryField && classifyScreen(text, settings) === 'idle' && ctx.runner.now() - Date.parse(record.deliveryStartedAt ?? record.started) < ctx.config.deliveryConfirmS * 1000) {
          try { return await enterLoop(screen, area); } catch (e) { return uncertain(errorMessage(e)); }
        }
        // The text of our paste still stands in the field and nothing presses Enter for it any more: say so, with the way out.
        if (record.deliveryField && area.length && areaKey(area) === record.deliveryField) {
          return record.promptDelivery === 'needs-attention' && record.deliveryResult === 'not-delivered-in-field' ? 'needs-attention' : attention('the paste of agentctl still stands in the input and no Enter is sent for it any more', true);
        }
        if (record.deliveryResult === 'not-delivered-in-field' && area.length && record.promptDelivery !== 'needs-attention') return attention('the input changed since our paste', true);
        queued = deliveryClass(record, text, screen.dimInput);
        if (queued && record.deliveryResult !== 'queued-in-agent') await setHeaderFields(ctx.runner, file, { delivery_result: 'queued-in-agent', prompt_error: `${DELIVERY_WARNING}: ${QUEUED_IN_AGENT}` });
      }
      if (record.promptDelivery === 'needs-attention') {
        // An initial prompt that was never pasted (a start that failed before any paste; a window that became ready
        // late) can be re-armed without duplicating anything: the normal paste path serves it on the next pass.
        const neverPasted = !record.deliveryStartedAt && record.promptKind !== 'followup' && record.pendingPrompt;
        if (neverPasted && screen.code === 0 && record.agent !== 'unknown') {
          const settings = ctx.config.agents[record.agent];
          if (classifyScreen(text, settings) === 'idle' && inputVisible(text, settings) && inspectField(text, record.agent).readable) {
            await setHeaderFields(ctx.runner, file, { prompt_delivery: 'pending', prompt_error: null });
            return 'pending';
          }
        }
        return 'needs-attention';
      }
      // A message the agent still shows in its own queue is pending, not lost: a turn can run far longer than
      // delivery_confirm_s (P64: Codex held it 54 minutes). The hook or the transcript confirms when the turn takes it.
      if (queued) return uncertain(QUEUED_IN_AGENT, 'queued-in-agent');
      if (ctx.runner.now() - Date.parse(record.deliveryStartedAt ?? record.started) >= ctx.config.deliveryConfirmS * 1000) return attention('no acknowledgement (hook, transcript) before delivery_confirm_s elapsed');
      return record.deliveryResult === 'not-delivered-in-field' ? 'confirming' : uncertain('awaiting hook or transcript', record.deliveryResult === 'queued-in-agent' ? 'queued-in-agent' : null);
    }
    if (!record.pendingPrompt || record.agent === 'unknown') return 'needs-attention';
    const settings = ctx.config.agents[record.agent], text = record.pendingPrompt;
    if (record.promptDelivery === 'launching') return 'pending';
    const before = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    const beforeState = classifyScreen(before.stdout, settings);
    const busyFollowup = record.agent !== 'codex' && record.promptKind === 'followup' && settings.acceptsBusyPrompt !== false && ['working', 'background'].includes(beforeState);
    if (before.code !== 0 || !inputVisible(before.stdout, settings) || (!busyFollowup && beforeState !== 'idle')) return 'pending';

    const profile = provider(record.agent).screen;
    const draftOf = (screen: string) => record.agent === 'kimi' ? fieldText(inspectField(screen, record.agent).area) : screenMetadata(screen).draft_input;
    if (profile.stablePaste) {
      // P92: Kimi shows its composer before it has finished starting. Paste only into a whole, empty composer that read the same twice;
      // otherwise nothing is pasted and the watcher tries again on its next pass.
      await ctx.runner.sleep(SETTLE_MS);
      const again = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      const view = kimiSettledView(before.stdout);
      if (again.code !== 0 || view === undefined || kimiSettledView(again.stdout) !== view || classifyScreen(again.stdout, settings) !== beforeState) return 'pending';
    }
    if (record.promptKind === 'initial' && !inspectField(before.stdout, record.agent).readable) {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'needs-attention', prompt_error: 'Composer is not structurally ready; initial prompt was not pasted and remains in TASK.md' });
      return 'needs-attention';
    }
    record.deliveryWasBusy = busyFollowup;
    record.deliveryStartedAt = new Date(ctx.runner.now()).toISOString();
    record.deliveryOutputBaseline = outputFingerprint(before.stdout, settings.deliveryPattern);
    record.deliveryEchoBaseline = echoLines(before.stdout, markerOf(record), text, record.agent);
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sending', delivery_was_busy: busyFollowup, delivery_started_at: record.deliveryStartedAt, delivery_output_baseline: record.deliveryOutputBaseline, delivery_echo_baseline: record.deliveryEchoBaseline, delivery_enters: 0 });
    record.deliveryEnters = 0;
    if (draftOf(before.stdout)) return uncertain('the input already contains a draft; it was not overwritten');
    try {
      // tmux turns a CR into the Enter of the TUI; \r\n would make two of it. Line endings are the one thing normalised, here and in every comparison.
      await ctx.tmux.pasteText(window, eol(text));
      await ctx.runner.sleep(400);
      return await enterLoop(before, undefined);
    } catch (e) { return uncertain(errorMessage(e)); }
  });
}

export interface SubmitDraftResult {
  /**
   * `submitted`: Enter went in and the agent took the message; `pending`: Enter went in, nothing proves it yet; `not-delivered`: Enter went in
   * and the text still stands in the field; `failed`: the key could not be sent; `refused`: no key was pressed; `ready`: preview only, with the
   * exact text and the token that confirms it.
   */
  outcome: 'submitted' | 'pending' | 'not-delivered' | 'failed' | 'refused' | 'ready';
  message: string;
  /** An Enter key was sent (submitted, pending, not-delivered). */
  keySent?: boolean;
  deliveryId?: string | undefined;
  /** Preview: the exact text of the field, line by line, and the state of the screen. */
  field?: string[] | undefined;
  screenState?: ScreenState | undefined;
  /** Preview: confirm with this token; it belongs to this delivery and to exactly this text. */
  token?: string | undefined;
}

const tokenOf = (deliveryId: string, area: string[]) => createHash('sha256').update(`${deliveryId}\n${area.join('\n')}`).digest('hex').slice(0, 16);

/**
 * `send --enter-only`: press Enter for the text that our own paste left in the input field. Two steps. Without a token it only shows: the exact
 * text of the field, the state of the screen and a token that belongs to this delivery and to those bytes. With the token it captures again and
 * presses Enter only when the area is, byte for byte, what the preview showed and what was recorded right after our paste (so agentctl did paste
 * for this delivery) and the screen shows no dialog. Anything else is refused with the reason and no key.
 */
export async function submitDraft(ctx: Context, window: string, options: { preview?: boolean; token?: string } = {}): Promise<SubmitDraftResult> {
  if (ctx.runner.dryRun) return { outcome: options.token ? 'submitted' : 'ready', message: 'dry run: Enter would be pressed' };
  const done = await submitOnce(ctx, window, options);
  // Every Enter that was pressed for a delivery is written down, whether or not it changed the result.
  if (done.keySent) {
    const record = readTaskRecord(ctx.config, window);
    if (record) await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: send --enter-only – ${done.message} [dostawa ${(done.deliveryId ?? '').slice(0, 8)}]` });
  }
  return done;
}

async function submitOnce(ctx: Context, window: string, options: { preview?: boolean; token?: string }): Promise<SubmitDraftResult> {
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const refused = (message: string, record?: TaskRecord, area?: string[]): SubmitDraftResult => ({ outcome: 'refused', message, deliveryId: record?.deliveryId, ...(area?.length ? { field: fieldText(area).split('\n') } : {}) });
    const record = readTaskRecord(ctx.config, window);
    if (!record || record.agent === 'unknown') return refused('nie ma stanu zadania tego okna – nic nie zatwierdzam');
    const file = taskFile(ctx.config, window), settings = ctx.config.agents[record.agent];
    const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (screen.code !== 0) return refused(`okno ${window} nie daje się odczytać – nic nie zatwierdzam`, record);
    const field = inspectField(screen.stdout, record.agent), area = field.area;
    if (!field.readable) return refused(`${field.reason} – nie wciskam Enter; sprawdź attach`, record);
    if (!area.length) return refused('pole wpisywania jest puste – nie ma czego zatwierdzić', record);
    if (record.deliveryResult === 'queued-in-agent-confirmed') return refused('wiadomość jest już w kolejce agenta – potwierdzone; czekam na wstrzyknięcie albo hook, nie wysyłam kolejnego Enter', record, area);
    if (record.promptDelivery === 'sent' || !record.deliveryId || !record.deliveryField) return refused('agentctl nie wkleił w to pole tekstu żadnej oczekującej wiadomości (brak śladu wklejki dla tej dostawy) – nie zatwierdzam; sprawdź peek albo attach', record, area);
    if (areaKey(area) !== record.deliveryField) return refused(`pole wpisywania różni się od tego, co agentctl wkleił i zapisał po wklejce („${fieldText(area).replace(/\s+/g, ' ').slice(0, 60)}”) – nie zatwierdzam; sprawdź peek albo attach i wciśnij Enter w oknie, jeśli to ma pójść`, record, area);
    const state = classifyScreen(screen.stdout, settings);
    if (!mayPressEnter(state, { promptKind: 'followup' }, settings)) return refused(`agent pokazuje ${state} – nie wciskam Enter; odpowiedz w oknie (attach)`, record, area);
    const token = tokenOf(record.deliveryId, area);
    if (!options.token) return { outcome: 'ready', message: `w polu stoi dokładnie wklejka agentctl dla dostawy ${record.deliveryId.slice(0, 8)}; stan ekranu: ${state}; Enter zostanie wciśnięty dopiero z tokenem ${token}`, deliveryId: record.deliveryId, field: fieldText(area).split('\n'), screenState: state, token };
    if (options.token !== token) return refused(`token nie pasuje do bieżącej treści pola (podgląd był dla innego tekstu albo innej dostawy) – zrób podgląd jeszcze raz`, record, area);
    const busy = ['working', 'background'].includes(state);
    if (record.deliveryWasBusy === undefined) { record.deliveryWasBusy = busy; await setHeaderFields(ctx.runner, file, { delivery_was_busy: busy }); }
    if (provider(record.agent).screen.stablePaste) {
      await ctx.runner.sleep(200);
      const stable = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (stable.code !== 0 || stable.stdout !== screen.stdout || areaKey(inspectField(stable.stdout, record.agent).area) !== record.deliveryField) return refused('ekran Kimi zmienił się przed Enter – zrób podgląd ponownie', record);
    }
    const pressed = await pressEnterAfter(ctx, record, file, window, screen);
    const keySent = { keySent: true as const, deliveryId: record.deliveryId };
    if (pressed.code !== 0) return { outcome: 'failed', message: `Enter nie poszedł: ${pressed.stderr.trim()}`, keySent: false, deliveryId: record.deliveryId };
    for (let poll = 0; poll < 10; poll++) {
      await ctx.runner.sleep(150);
      const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (pane.code !== 0) break;
      const source = proofSource(ctx, record, pane.stdout !== screen.stdout ? pane.stdout : '');
      if (source) {
        await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, delivery_result: 'delivered', delivery_source: source, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
        return { outcome: 'submitted', message: `zatwierdzono Enter; agent przyjął wiadomość (${SOURCES[source] ?? source})`, ...keySent };
      }
      if (await keepConfirmedQueue(ctx, record)) return { outcome: 'pending', message: deliveryNote(record)!, ...keySent };
      if (areaKey(fieldArea(pane.stdout, settings.footerPatterns, record.agent)) !== record.deliveryField) break;
    }
    const after = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (after.code === 0 && areaKey(fieldArea(after.stdout, settings.footerPatterns, record.agent)) === record.deliveryField) {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: 'not-delivered-in-field', prompt_error: `${NOT_DELIVERED}: Enter was pressed and the text is still in the field` });
      return { outcome: 'not-delivered', message: `${NOT_DELIVERED}; Enter poszedł, ale tekst nadal stoi w polu – wciśnij Enter w oknie (attach)`, ...keySent };
    }
    const queued = after.code === 0 ? deliveryClass(record, after.stdout, after.dimInput) : null;
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', delivery_result: queued, prompt_error: queued ? `${DELIVERY_WARNING}: ${QUEUED_IN_AGENT}` : `${DELIVERY_WARNING}: Enter pressed by send --enter-only` });
    return { outcome: 'pending', message: queued ? `zatwierdzono Enter; ${QUEUED_IN_AGENT}` : `zatwierdzono Enter; ${DELIVERY_WARNING} (watch)`, ...keySent };
  });
}
