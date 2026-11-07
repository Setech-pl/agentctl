import { stateWriteFailure } from './atomic-file.ts';
import { withStartLock } from './start-lock.ts';
import { liveWindows } from './plan.ts';
import { checkWindowLimit } from './checks.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import { queuePrompt, deliverPendingPrompt } from './prompt-delivery.ts';
import { recordJournal } from './journal.ts';
import { AgentctlError } from './util.ts';

export interface QueuedPrompt { id: string; text: string; queuedAt: string }
export const queueFile = (ctx: Context, window: string) => path.join(ctx.config.stateDir, window, 'prompt-queue.json');
export function readPromptQueue(ctx: Context, window: string): QueuedPrompt[] {
  try { const data: unknown = JSON.parse(fs.readFileSync(queueFile(ctx, window), 'utf8')); return Array.isArray(data) ? data.filter((p): p is QueuedPrompt => p && typeof p.id === 'string' && typeof p.text === 'string' && typeof p.queuedAt === 'string') : []; } catch { return []; }
}
export async function enqueuePrompt(ctx: Context, window: string, text: string): Promise<QueuedPrompt> {
  return withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    const item = { id: randomUUID(), text, queuedAt: new Date(ctx.runner.now()).toISOString() };
    await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify([...readPromptQueue(ctx, window), item]));
    await ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up queued ${item.queuedAt} (${item.id})\n\n${text.trim()}\n`);
    return item;
  });
}

/** Durable FIFO. An uncertain active delivery keeps later messages queued, never discarded or repasted. */
export async function drainPromptQueue(ctx: Context, window: string): Promise<void> {
  if (ctx.runner.dryRun) return;
  await withStartLock(ctx, () => withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    let record = readTaskRecord(ctx.config, window);
    if (!record || record.closed || record.cancelled || stateWriteFailure(taskFile(ctx.config, window))) return;
    if (record.pendingPrompt && record.promptDelivery !== 'sent') {
      if (record.promptDelivery === 'launching' || await deliverPendingPrompt(ctx, window) !== 'sent') return;
    }
    let queue = readPromptQueue(ctx, window);
    while (queue.length) {
      record = readTaskRecord(ctx.config, window)!;
      if (record.agent !== 'unknown') {
        const live = await liveWindows(ctx);
        if (live.some(w => w.window === window && w.counted === false) && checkWindowLimit(record.agent, ctx.config.limits[record.agent], live, ctx.config.session)) return;
      }
      const item = queue[0]!;
      if (record.deliveryId !== item.id) await queuePrompt(ctx, record, item.text, 'pending', { kind: 'followup', id: item.id });
      // Transfer persisted before the item leaves the FIFO. Recovery sees the same delivery ID.
      queue = queue.slice(1);
      await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue));
      const result = await deliverPendingPrompt(ctx, window);
      const fresh = readTaskRecord(ctx.config, window)!;
      if (fresh.deliveryStartedAt) await ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up ${result === 'sent' ? 'sent' : 'pasted, unconfirmed'} ${fresh.deliveryStartedAt} (${item.id})\n`);
      if (result !== 'sent') return;
    }
  }));
}

export function promptQueueView(ctx: Context, window: string, record?: ReturnType<typeof readTaskRecord>) {
  const known = record ?? readTaskRecord(ctx.config, window);
  const active = known?.pendingPrompt && known.promptDelivery !== 'sent' ? [{ id: known.deliveryId ?? 'legacy', text: known.pendingPrompt, state: known.deliveryResult === 'stale' ? 'stale' : (known.promptDelivery ?? 'pending') }] : [];
  return [...active, ...readPromptQueue(ctx, window).filter(p => p.id !== known?.deliveryId).map(p => ({ ...p, state: 'queued' }))];
}

export interface WithdrawResult {
  /** withdrawn: the message left the queue before its delivery began; stale: the delivery already began, the agent may already work on it. */
  outcome: 'withdrawn' | 'stale';
  id: string;
  message: string;
}

/**
 * `agentctl send --withdraw` / MCP `send` with `withdraw`: take a waiting message back, by id or a unique prefix of it
 * (peek/status list them in prompt_queue). A FIFO entry simply leaves the queue. The active pending prompt leaves only before
 * its delivery began; once agentctl started delivering it, the agent may already work on it, so the message is marked stale
 * instead: the delivery machinery finishes its confirmation, and status, peek and the journal say the user withdrew it.
 */
export async function withdrawPrompt(ctx: Context, window: string, idPrefix: string): Promise<WithdrawResult> {
  return withStartLock(ctx, () => withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) throw new AgentctlError(`no task state for window ${window}`);
    const now = new Date(ctx.runner.now()).toISOString();
    const note = (text: string) => ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up withdrawn ${now} (${text})\n`);
    // The active pending prompt first.
    if (record.pendingPrompt && record.promptDelivery !== 'sent' && record.deliveryId && (record.deliveryId === idPrefix || record.deliveryId.startsWith(idPrefix))) {
      const id = record.deliveryId;
      if (record.deliveryStartedAt) {
        await setHeaderFields(ctx.runner, taskFile(ctx.config, window), { delivery_result: 'stale', prompt_error: `wiadomość wycofana (${now}) po rozpoczęciu dostarczania – agent może już nad nią pracować` });
        await note(`${id}, stale`);
        await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano wiadomość po rozpoczęciu dostarczania (stale); agent może już nad nią pracować [dostawa ${id.slice(0, 8)}]` });
        return { outcome: 'stale', id, message: `${record.task}: dostarczanie już się zaczęło – wiadomość oznaczona jako wycofana (stale), agent może już nad nią pracować; nic nie jest wycofywane z okna` };
      }
      await setHeaderFields(ctx.runner, taskFile(ctx.config, window), { pending_prompt: null, prompt_delivery: null, prompt_error: null, delivery_id: null, delivery_result: null });
      await note(id);
      await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano oczekującą wiadomość przed rozpoczęciem dostarczania [dostawa ${id.slice(0, 8)}]` });
      return { outcome: 'withdrawn', id, message: `${record.task}: wycofano oczekującą wiadomość (${id.slice(0, 8)}) – nie zostanie wysłana` };
    }
    if (record.deliveryId === idPrefix && record.promptDelivery === 'sent') throw new AgentctlError(`${record.task}: the message ${idPrefix} is already delivered`, 'Only a waiting message can be withdrawn; prompt_queue in peek/status lists them.');
    // A FIFO entry.
    const queue = readPromptQueue(ctx, window);
    const matches = queue.filter((p) => p.id === idPrefix || p.id.startsWith(idPrefix));
    if (matches.length > 1) throw new AgentctlError(`${record.task}: ${idPrefix} matches ${matches.length} queued messages`, `Choose one: ${matches.map((p) => p.id.slice(0, 8)).join(', ')}.`);
    const entry = matches[0];
    if (!entry) throw new AgentctlError(`${record.task}: no waiting message ${idPrefix}`, 'prompt_queue in peek/status lists the waiting messages with their ids.');
    await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue.filter((p) => p !== entry)));
    await note(entry.id);
    await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano wiadomość z kolejki (${entry.id.slice(0, 8)})` });
    return { outcome: 'withdrawn', id: entry.id, message: `${record.task}: wycofano wiadomość z kolejki (${entry.id.slice(0, 8)}) – nie zostanie wysłana` };
  }));
}
