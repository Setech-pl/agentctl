import { limitedTick } from './limited.ts';
import { collectStatus } from './status.ts';
import { journalOutputs } from './outputs.ts';
import { reviewTick } from './review.ts';
import { inspectReport } from './report-state.ts';
import fs from 'node:fs';
import path from 'node:path';
import { Alerts } from './alert.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { extractQuestion, parseClaudeEvent, parseCodexEvent } from './events.ts';
import type { AgentEvent, ClaudeKind } from './events.ts';
import { classifyScreen } from './state.ts';
import type { EventKind } from './state.ts';
import { listTaskRecords, taskDir, setHeaderField, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { recordEvent } from './history.ts';
import { rememberSession, sessionOfStatusLine } from './usage-tap.ts';
import { recordJournal } from './journal.ts';
import { readVerdict } from './verdict.ts';
import { syncReport } from './report-detect.ts';
import { isObject } from './util.ts';

/** Wait for a dialog to be drawn: Claude runs the Notification hook a moment before the screen shows the options. */
const SCREEN_RETRY_MS = 500;

/** The last thing an agent reported about a task: `<state_dir>/<task>/event.json`. The state of the task is taken from it, together with the screen. */
export interface StoredEvent {
  outcome: EventKind;
  /** ISO time. */
  at: string;
  type: string;
  text: string;
}

export function eventFile(ctx: Context, window: string): string {
  return path.join(taskDir(ctx.config, window), 'event.json');
}

export function eventsLogPath(ctx: Context): string {
  return path.join(ctx.config.stateDir, 'events.log');
}

/** The stored event of a task; one from before the task (re)started does not count. */
export function readStoredEvent(config: Context['config'], record: Pick<TaskRecord, 'window' | 'started' | 'attemptStarted'>): StoredEvent | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(path.join(taskDir(config, record.window), 'event.json'), 'utf8'));
    if (!isObject(data) || typeof data.at !== 'string') return undefined;
    const outcome = data.outcome;
    if (outcome !== 'needs-input' && outcome !== 'turn-complete' && outcome !== 'limited' && outcome !== 'overloaded') return undefined;
    const startedMs = Date.parse(record.attemptStarted ?? record.started);
    if (!Number.isNaN(startedMs) && Date.parse(data.at) < startedMs) return undefined;
    return { outcome, at: data.at, type: typeof data.type === 'string' ? data.type : '', text: typeof data.text === 'string' ? data.text : '' };
  } catch {
    return undefined;
  }
}

/** "NC-42: raport gotowy – Werdykt: PASS" */
export function reportReadyText(task: string, verdict: string | undefined): string {
  return verdict ? `${task}: raport gotowy – ${verdict}` : `${task}: raport gotowy`;
}

const otherAgent = (a: string): string => (a === 'claude' ? 'codex' : a === 'codex' ? 'claude' : 'drugiego dostawcę');

export function limitText(record: { task: string; agent: string; pin?: boolean | undefined }): string {
  const base = `${record.task}: ${record.agent} wyczerpał limit użycia`;
  if (record.pin) return `${base} (zadanie przypięte – pin: true – move go nie przeniesie)`;
  return `${base} – agentctl move ${record.task} przeniesie zadanie na ${otherAgent(record.agent)}`;
}

/** The session the event came from belongs to the task: `usage` counts its tokens for it. */
async function noteSession(ctx: Context, record: TaskRecord, input: EventInput): Promise<void> {
  try {
    const data = isObject(input.payload) ? input.payload : {};
    if (input.agent === 'claude') {
      const session = sessionOfStatusLine(data);
      if (session) await rememberSession(ctx.runner, ctx.config, record.window, 'claude', session);
    } else if (typeof data['thread-id'] === 'string' && data['thread-id'] !== '') {
      await rememberSession(ctx.runner, ctx.config, record.window, 'codex', { id: data['thread-id'] });
    }
  } catch {
    // counting tokens must not break an event
  }
}

export interface EventInput {
  task: string;
  agent: AgentName;
  /** Claude: which hook (the JSON on stdin is `payload`). Codex: absent (the JSON argument is `payload`). */
  kind?: ClaudeKind | undefined;
  payload: unknown;
  /** The notify command the user had in Codex's config: run with the same JSON after ours. */
  forward?: string[] | undefined;
  /** The raw JSON text, given to the forwarded command as it came. */
  rawPayload?: string | undefined;
}

export interface EventResult {
  task: string;
  event: AgentEvent | undefined;
  /** What was announced: the state and the text; undefined when nothing was. */
  announced?: { state: string; text: string; result: 'sent' | 'duplicate' } | undefined;
  note?: string;
}

function logLine(now: number, task: string, agent: string, type: string, rest: string): string {
  return `${new Date(now).toISOString()}  ${task}  ${agent}  ${type}${rest ? `  ${rest}` : ''}\n`;
}

function findRecord(ctx: Context, task: string): TaskRecord | undefined {
  const wanted = task.toLowerCase();
  return listTaskRecords(ctx.config).find((r) => r.task.toLowerCase() === wanted || r.window === wanted);
}

/** The question on the task's screen, if a dialog is open; waits a moment once when the dialog is not drawn yet. */
async function questionOnScreen(ctx: Context, record: TaskRecord): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const screen = await ctx.tmux.capture(record.window, undefined, undefined, record.windowId);
    const question = screen.code === 0 ? extractQuestion(screen.stdout) : undefined;
    if (question) return question;
    if (attempt === 0) await ctx.runner.sleep(SCREEN_RETRY_MS);
  }
  return undefined;
}

/** The agent's own background work (shells, monitors) is running: the screen says so while the turn that just ended left it behind. */
async function backgroundOnScreen(ctx: Context, record: TaskRecord): Promise<boolean> {
  const screen = await ctx.tmux.capture(record.window, undefined, undefined, record.windowId);
  if (screen.code !== 0) return false;
  return ['working', 'background'].includes(classifyScreen(screen.stdout, ctx.config.agents[record.agent === 'unknown' ? 'claude' : record.agent]));
}

/** The full last message of the agent (Claude: last_assistant_message, Codex: last-assistant-message), for the search of the report path. */
function reportReady(ctx: Context, record: TaskRecord): boolean {
  return inspectReport(ctx.config, record, ctx.runner.now(), true).ready;
}

/**
 * `agentctl event`: an agent says something happened. Logs it to `<state_dir>/events.log`, updates the state of the task
 * (event.json) and sends the notification right away. Never throws for a bad payload or an unknown task: a hook must not break the agent.
 */
export async function handleEvent(ctx: Context, alerts: Alerts, input: EventInput): Promise<EventResult> {
  const { runner } = ctx;
  const now = runner.now();
  const event = input.agent === 'claude' ? (input.kind ? parseClaudeEvent(input.kind, input.payload) : undefined) : parseCodexEvent(input.payload);
  const record = findRecord(ctx, input.task);
  try {
    if (!event) {
      await runner.appendFile(eventsLogPath(ctx), logLine(now, input.task, input.agent, 'invalid', 'claude events need --kind notification|stop|stop-failure'));
      return { task: input.task, event, note: 'no --kind' };
    }
    if (!record) {
      await runner.appendFile(eventsLogPath(ctx), logLine(now, input.task, input.agent, event.type, 'unknown task, ignored'));
      return { task: input.task, event, note: 'unknown task' };
    }
    // Separate evidence avoids a TASK.md lock in synchronous UserPromptSubmit hooks.
    // In particular, never wait for the sender's prompt-delivery lock here.
    // Claude Code hands a collapsed paste to the hook wrapped in <pasted_content id="…">…</pasted_content id="…"> (tests/fixtures/claude-user-prompt-submit-pasted.json).
    const normalizePrompt = (text: string) => text.replace(/\r\n?/g, '\n').replace(/<pasted_content(?: id="[^"]*")?>\n?([\s\S]*?)\n?<\/pasted_content(?: id="[^"]*")?>/g, '$1').trim();
    const submitted = input.kind === 'user-prompt-submit' && isObject(input.payload) && typeof input.payload.prompt === 'string' && normalizePrompt(input.payload.prompt) === normalizePrompt(record.pendingPrompt ?? '');
    const codexInput = input.agent === 'codex' && isObject(input.payload) && Array.isArray(input.payload['input-messages']) && input.payload['input-messages'].some(text => typeof text === 'string' && normalizePrompt(text) === normalizePrompt(record.pendingPrompt ?? ''));
    if (record.deliveryId && record.deliveryStartedAt && now >= Date.parse(record.deliveryStartedAt) && (submitted || codexInput)) {
      await runner.writeFile(path.join(taskDir(ctx.config, record.window), 'delivery-evidence.json'), JSON.stringify({ deliveryId: record.deliveryId, at: new Date(now).toISOString(), type: event.type, accepted: true }));
    }
    let announced: EventResult['announced'];
    let detail = '';
    if (event.outcome !== 'ignored') {
      const stored: StoredEvent = { outcome: event.outcome === 'idle' ? 'turn-complete' : event.outcome, at: new Date(now).toISOString(), type: event.type, text: event.text };
      await runner.writeFile(eventFile(ctx, record.window), `${JSON.stringify(stored, null, 2)}\n`);
    }
    const target = { task: record.task, window: record.window };
    await noteSession(ctx, record, input);
    let state: string | undefined;
    let text = '';
    if (event.outcome === 'needs-input') {
      const question = await questionOnScreen(ctx, record);
      state = 'needs-input';
      text = question ? `${record.task}: ${question}` : event.text ? `${record.task}: ${event.text}` : `${record.task} zadaje pytanie i czeka na odpowiedź`;
    } else if (event.outcome === 'turn-complete') {
      record.turnEndedAt = new Date(now).toISOString();
      await setHeaderField(runner, taskFile(ctx.config, record.window), 'turn_ended_at', record.turnEndedAt);
      if (await backgroundOnScreen(ctx, record)) {
        // The agent ends its turn every few minutes while its shells and monitors run: that is not "waiting for you". The
        // watcher announces the report or the wait once the background work is gone.
        detail = '[not announced: background work is still running]';
      } else {
        // The agent may have written the report somewhere else than the spec says: record a configured candidate without copying it.
        await syncReport(ctx, record).catch(() => undefined);
        if (reportReady(ctx, record)) {
          state = 'report-ready';
          text = reportReadyText(record.task, readVerdict(record.report, ctx.config.notify.verdictPattern));
          await recordEvent(ctx, record, 'report');
          await journalOutputs(ctx, record);
          await reviewTick(ctx);
        } else if (ctx.config.notify.turnEnd) {
          state = 'waiting';
          text = `${record.task}: skończył turę i czeka na Ciebie${event.text ? ` – ${event.text}` : ''}`;
        }
      }
    } else if (event.outcome === 'overloaded') {
      state = 'overloaded';
      text = `${record.task}: dostawca przeciążony (overloaded)`;
    } else if (event.outcome === 'limited') {
      await limitedTick(ctx, await collectStatus(ctx, { progress: false }), { notify: async (_title, message) => {
        const result = await alerts.send(target, 'limited', message, 'event');
        announced = { state: 'limited', text: message, result };
      } });
    }
    if (state && text) {
      const result = await alerts.send(target, state, text, 'event');
      announced = { state, text, result };
      if (result === 'sent') {
        const kind = state === 'report-ready' ? 'report-ready' : state === 'needs-input' ? 'needs-input' : state === 'limited' ? 'limited' : state === 'overloaded' ? 'overloaded' : undefined;
        const verdict = state === 'report-ready' ? readVerdict(record.report, ctx.config.notify.verdictPattern) : undefined;
        if (kind) await recordJournal(ctx, { kind, task: record.task, text, ...(verdict ? { verdict } : {}) });
      }
      detail = `[${result === 'sent' ? 'notified' : 'duplicate, not notified'}: ${text}]`;
    }
    await runner.appendFile(eventsLogPath(ctx), logLine(now, record.task, input.agent, event.type, detail || (event.text ? `"${event.text}"` : '')));
    return { task: record.task, event, announced };
  } finally {
    if (input.forward && input.forward.length > 0 && input.rawPayload !== undefined) {
      const [cmd, ...args] = input.forward as [string, ...string[]];
      await runner.exec(cmd, [...args, input.rawPayload], { timeoutMs: 10_000 }).catch(() => undefined);
    }
  }
}
