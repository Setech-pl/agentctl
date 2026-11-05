import { withStartLock } from './start-lock.ts';
import { liveWindows } from './plan.ts';
import { checkWindowLimit } from './checks.ts';
import fs from 'node:fs';
import type { Context } from './context.ts';
import { enqueuePrompt, drainPromptQueue, readPromptQueue } from './prompt-queue.ts';
import { deliveryNote, submitDraft } from './prompt-delivery.ts';
import type { SubmitDraftResult } from './prompt-delivery.ts';
import { classifyScreen } from './state.ts';
import { collapsedQuestion, extractQuestion } from './events.ts';
import { sessionQuestion } from './codex-question.ts';
import { readTaskRecord, renderFollowUp, taskFile } from './taskstore.ts';
import { AgentctlError, Problems } from './util.ts';

export interface SendItem {
  task: string;
  window: string;
  prompt: string;
}

/** Paste a follow-up prompt into existing windows and log it in TASK.md. */
export async function sendPrompts(ctx: Context, items: SendItem[]): Promise<{ task: string; message: string; warning?: string }[]> {
  if (ctx.runner.dryRun) return sendPromptsUnlocked(ctx, items);
  return withStartLock(ctx, () => sendPromptsUnlocked(ctx, items));
}

async function sendPromptsUnlocked(ctx: Context, items: SendItem[]): Promise<{ task: string; message: string; warning?: string }[]> {
  const { runner, tmux, config } = ctx;
  if (!runner.dryRun) {
    const tool = await runner.exec('tmux', ['-V'], { readOnly: true });
    if (tool.code !== 0) throw new AgentctlError('tmux not found or not working', 'Install tmux: "brew install tmux" (macOS) or "sudo apt install tmux".');
    const windows = await tmux.listWindows();
    const p = new Problems();
    for (const item of items) {
      if (!windows.includes(item.window)) {
        p.add(`${item.task}: no tmux window "${item.window}" in session "${config.session}"`);
      }
    }
    p.throwIfAny('Cannot send:', 'Start the task with "agentctl new", or list running tasks with "agentctl status".');
  }

  const results: { task: string; message: string; warning?: string }[] = [];
  for (const item of items) {
    const record = readTaskRecord(config, item.window);
    let message = 'wklejono (prompt sent)';
    let warning: string | undefined;
    if (record && record.agent !== 'unknown' && !runner.dryRun) {
      const live = await liveWindows(ctx);
      if (live.some(w => w.window === item.window && w.counted === false)) {
        const full = checkWindowLimit(record.agent, config.limits[record.agent], live, config.session);
        if (full) {
          warning = `${full} report-ready follow-up not sent; close a working window or raise the limit first.`;
          results.push({ task: item.task, message: warning, warning }); ctx.info(warning); continue;
        }
      }
      const queued = await enqueuePrompt(ctx, item.window, item.prompt);
      await drainPromptQueue(ctx, item.window);
      const fresh = readTaskRecord(config, item.window);
      const waiting = readPromptQueue(ctx, item.window);
      const position = waiting.findIndex(p => p.id === queued.id);
      if (position >= 0 || (fresh?.deliveryId === queued.id && fresh.promptDelivery === 'pending')) {
        const n = position >= 0 ? position + 1 + (fresh?.pendingPrompt ? 1 : 0) : 1;
        const question = await openQuestion(ctx, item.window, record);
        message = warning = question
          ? `w kolejce ${n}; ${question} – wiadomość nie jest wklejana w pole pytania (to nie byłaby odpowiedź); odpowiedz w oknie (attach), watch wyśle ją po pytaniu`
          : `w kolejce ${n}; watch wysyła FIFO po bezczynności lub potwierdzeniu poprzedniej wiadomości`;
      } else if (fresh?.deliveryId === queued.id) {
        // The journal entry for the result is written where the result is decided (prompt-delivery.ts).
        const note = deliveryNote(fresh);
        if (fresh.promptDelivery !== 'sent') message = warning = note ?? 'wklejono; dostarczenie niepotwierdzone – sprawdzam (watch)';
        else if (note) message = note;
      }
    } else {
      await tmux.submitPrompt(item.window, item.prompt);
      const file = taskFile(config, item.window);
      if (fs.existsSync(file)) await runner.appendFile(file, renderFollowUp(item.prompt, new Date(runner.now()).toISOString()));
    }
    results.push({ task: item.task, message, ...(warning ? { warning } : {}) });
    ctx.info(`${item.task}: ${message}`);
  }
  return results;
}

/** The question of a collapsed Codex question on the screen: "? Which colour: red or blue?" above its options (not the "? 1 question" marker). */
function collapsedQuestionText(screen: string): string | undefined {
  const lines = screen.split('\n');
  const marker = lines.findLastIndex(l => /^\s*\?\s+\d+ questions?\b/i.test(l));
  for (let i = (marker < 0 ? lines.length : marker) - 1; i >= Math.max(0, marker - 12); i--) {
    const text = /^\s*\?\s+(?!\d+ questions?\b)(.+\S)\s*$/i.exec(lines[i]!)?.[1];
    if (text) return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  return undefined;
}

/** The agent has a dialog or a question open that a pasted message would land in: what it asks and how many, in a few words; undefined when there is none. */
async function openQuestion(ctx: Context, window: string, record: NonNullable<ReturnType<typeof readTaskRecord>>): Promise<string | undefined> {
  const agent = record.agent;
  if (agent !== 'claude' && agent !== 'codex') return undefined;
  const screen = await ctx.tmux.capture(window, undefined, undefined, undefined, true);
  if (screen.code !== 0 || classifyScreen(screen.stdout, ctx.config.agents[agent]) !== 'needs-input') return undefined;
  const collapsed = collapsedQuestion(screen.stdout);
  if (collapsed) {
    const text = sessionQuestion(ctx.config, record) ?? collapsedQuestionText(screen.stdout);
    return `${agent === 'codex' ? 'Codex' : 'agent'} ma otwarte pytanie${text ? ` „${text}”` : ''} (zwinięte, ${collapsed.count})`;
  }
  const asked = extractQuestion(screen.stdout);
  return asked ? `agent ma otwarte pytanie lub okno dialogowe: ${asked}` : 'agent ma otwarte pytanie lub okno dialogowe';
}

export interface DraftResult { task: string; message: string; outcome: SubmitDraftResult['outcome']; keySent: boolean; deliveryId?: string | undefined; field?: string[] | undefined; screenState?: SubmitDraftResult['screenState']; token?: string | undefined; warning?: string; refused?: boolean }

/**
 * `send --enter-only TASK`: press Enter for the text our own paste left in the input field. Without a token it only shows the exact text of the
 * field, the state of the screen and a token; with that token it presses Enter if the field is still exactly that text. Refuses anything else.
 */
export async function submitDrafts(ctx: Context, items: { task: string; window: string }[], options: { token?: string } = {}): Promise<DraftResult[]> {
  const results: DraftResult[] = [];
  for (const item of items) {
    const done = ctx.runner.dryRun ? await submitDraft(ctx, item.window, options) : await withStartLock(ctx, () => submitDraft(ctx, item.window, options));
    if (done.outcome !== 'refused') ctx.info(`${item.task}: ${done.message}`);
    results.push({ task: item.task, message: done.message, outcome: done.outcome, keySent: done.keySent === true, deliveryId: done.deliveryId, field: done.field, screenState: done.screenState, token: done.token, ...(done.outcome === 'submitted' || done.outcome === 'ready' ? {} : { warning: done.message }), ...(done.outcome === 'refused' ? { refused: true } : {}) });
  }
  return results;
}
