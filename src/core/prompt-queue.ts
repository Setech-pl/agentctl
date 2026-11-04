import { stateWriteFailure } from './atomic-file.ts';
import { withStartLock } from './start-lock.ts';
import { liveWindows } from './plan.ts';
import { checkWindowLimit } from './checks.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { readTaskRecord, taskFile } from './taskstore.ts';
import { queuePrompt, deliverPendingPrompt } from './prompt-delivery.ts';

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

export function promptQueueView(ctx: Context, window: string) {
  const record = readTaskRecord(ctx.config, window);
  const active = record?.pendingPrompt && record.promptDelivery !== 'sent' ? [{ id: record.deliveryId ?? 'legacy', text: record.pendingPrompt, state: record.promptDelivery ?? 'pending' }] : [];
  return [...active, ...readPromptQueue(ctx, window).filter(p => p.id !== record?.deliveryId).map(p => ({ ...p, state: 'queued' }))];
}
