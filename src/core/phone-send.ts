import fs from 'node:fs';
import path from 'node:path';
import { phoneActive } from './away.ts';
import type { GlobalConfig, PhoneEvent } from './config.ts';
import type { Context } from './context.ts';
import type { JournalEntry } from './journal.ts';
import { HINTED_EVENTS, phoneMessage, sendNtfy } from './phone.ts';
import { managerPhoneHint, rcAnswerHint } from './remote-control.ts';
import { readTaskRecord } from './taskstore.ts';
import { MANAGER_WINDOW } from './windows.ts';
import { windowName } from './util.ts';
import type { PhoneMessage } from './phone.ts';
import { isObject } from './util.ts';

/*
 * Sending to the phone. Every event the journal records goes through here once (the journal is written after the desktop notification was
 * de-duplicated, so the phone gets what the Mac got, no more). A request that fails is queued: the watcher tries again, three times with a
 * growing pause, and then gives up with a line in phone.log. A network error never stops the watcher.
 */

/** Pauses before the 1st, 2nd and 3rd retry. */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
/** The warning about an unreachable server is shown at most this often. */
export const WARN_EVERY_MS = 3_600_000;

export const phoneLogPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'phone.log');
export const phoneQueuePath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'phone-queue.json');

/** The phone event of a journal entry; undefined for entries that never go to the phone. */
export function phoneEventOf(entry: Pick<JournalEntry, 'kind' | 'level'>): PhoneEvent | undefined {
  switch (entry.kind) {
    case 'needs-input':
    case 'needs-trust':
    case 'limited':
    case 'blocked':
    case 'report-ready':
    case 'cohort-done':
    case 'queue-failed':
    case 'orphan':
    case 'dead':
      return entry.kind;
    case 'usage':
      return entry.level === 'critical' ? 'usage-critical' : undefined;
    default:
      return undefined;
  }
}

interface QueuedItem {
  event: PhoneEvent;
  message: PhoneMessage;
  /** Requests made so far. */
  attempts: number;
  /** ms timestamp of the next try. */
  next: number;
  /** ms timestamp of the event. */
  at: number;
}

interface PhoneQueue {
  /** ms timestamp of the last warning shown. */
  warnedAt?: number;
  /** A warning waiting for the watcher to show it. */
  warning?: string;
  items: QueuedItem[];
}

function readQueue(config: Pick<GlobalConfig, 'path'>): PhoneQueue {
  try {
    const d: unknown = JSON.parse(fs.readFileSync(phoneQueuePath(config), 'utf8'));
    if (isObject(d) && Array.isArray(d.items)) {
      return { ...(typeof d.warnedAt === 'number' ? { warnedAt: d.warnedAt } : {}), ...(typeof d.warning === 'string' ? { warning: d.warning } : {}), items: d.items.filter((i): i is QueuedItem => isObject(i) && isObject(i.message) && typeof i.attempts === 'number' && typeof i.next === 'number') };
    }
  } catch {
    // no queue yet
  }
  return { items: [] };
}

async function writeQueue(ctx: Context, queue: PhoneQueue): Promise<void> {
  const file = phoneQueuePath(ctx.config);
  if (queue.items.length === 0 && queue.warnedAt === undefined && queue.warning === undefined) {
    if (fs.existsSync(file)) await ctx.runner.remove(file);
    return;
  }
  await ctx.runner.writeFile(file, `${JSON.stringify(queue, null, 2)}\n`);
}

async function phoneLog(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.runner.appendFile(phoneLogPath(ctx.config), `${new Date(ctx.runner.now()).toISOString()}  ${text}\n`);
  } catch {
    // a log that cannot be written is not worth a failed notification
  }
}

/** Records a failure; the warning for the watcher is set at most once an hour. */
async function failed(ctx: Context, queue: PhoneQueue, event: PhoneEvent, error: string, what: string): Promise<void> {
  const now = ctx.runner.now();
  await phoneLog(ctx, `${event}  ${what}: ${error}`);
  if (queue.warnedAt === undefined || now - queue.warnedAt >= WARN_EVERY_MS) {
    queue.warnedAt = now;
    queue.warning = `phone: ${ctx.config.notify.ntfy?.server ?? 'ntfy'} did not take the notification (${error}); it is tried again, see ${phoneLogPath(ctx.config)}`;
  }
}

/**
 * The last line of the notification: a question of a task that runs with Remote Control is answered in the Claude app, in the session named
 * after the task; the other events that wait for a human point to the manager session, when it runs. Nothing else is added - no link, no path.
 */
export async function phoneHint(ctx: Context, event: PhoneEvent, task: string | undefined): Promise<string | undefined> {
  if (!HINTED_EVENTS.includes(event)) return undefined;
  if (event === 'needs-input' && task && readTaskRecord(ctx.config, windowName(task))?.remoteControl === true) return rcAnswerHint(task);
  const windows = await ctx.tmux.listWindows().catch(() => [] as string[]);
  return windows.includes(MANAGER_WINDOW) ? managerPhoneHint(ctx.config.manager.name) : undefined;
}

/**
 * Send the event to the phone if the phone is on duty: a topic, away on (or `notify.ntfy.always`) and the event in `notify.ntfy.events`.
 * Returns `sent`, `queued` (the first request failed; the watcher retries), or undefined when nothing was sent.
 */
export async function notifyPhone(ctx: Context, entry: Pick<JournalEntry, 'kind' | 'level' | 'task' | 'cohort' | 'verdict' | 'text'>): Promise<'sent' | 'queued' | undefined> {
  const ntfy = ctx.config.notify.ntfy;
  const event = phoneEventOf(entry);
  if (!ntfy || !event || !phoneActive(ctx.config) || !ntfy.events.includes(event)) return undefined;
  const message = phoneMessage(event, { task: entry.task, cohort: entry.cohort, verdict: entry.verdict, usage: entry.text, hint: await phoneHint(ctx, event, entry.task) }, ntfy);
  if (!message) return undefined;
  const r = await sendNtfy(ctx.fetch, ntfy, message, () => ctx.runner.now());
  if (r.ok) return 'sent';
  const queue = readQueue(ctx.config);
  queue.items.push({ event, message, attempts: 1, next: ctx.runner.now() + (RETRY_BACKOFF_MS[0] as number), at: ctx.runner.now() });
  await failed(ctx, queue, event, r.error ?? 'failed', 'first try failed, queued');
  await writeQueue(ctx, queue);
  return 'queued';
}

/**
 * The watcher's turn for the phone: tries the queued requests that are due, shows the warning that is waiting. A request is made at most
 * 1 + 3 times; then it is dropped with a line in phone.log. Returns the lines for the watch log.
 */
export async function phoneTick(ctx: Context): Promise<string[]> {
  const ntfy = ctx.config.notify.ntfy;
  const queue = readQueue(ctx.config);
  const lines: string[] = [];
  if (queue.items.length === 0 && queue.warning === undefined) return lines;
  const now = ctx.runner.now();
  const keep: QueuedItem[] = [];
  for (const item of queue.items) {
    if (item.next > now) {
      keep.push(item);
      continue;
    }
    if (!ntfy?.topic) {
      await phoneLog(ctx, `${item.event}  dropped: notify.ntfy.topic is no longer set`);
      continue;
    }
    const r = await sendNtfy(ctx.fetch, ntfy, item.message, () => ctx.runner.now());
    if (r.ok) {
      await phoneLog(ctx, `${item.event}  sent after ${item.attempts + 1} tries`);
      continue;
    }
    item.attempts++;
    if (item.attempts > RETRY_BACKOFF_MS.length) {
      await phoneLog(ctx, `${item.event}  dropped after ${item.attempts} tries: ${r.error ?? 'failed'}`);
      lines.push(`phone: ${item.message.title.replace(/^agentctl · /, '')} was not delivered after ${item.attempts} tries (${r.error ?? 'failed'}), dropped`);
      await failed(ctx, queue, item.event, r.error ?? 'failed', 'dropped');
      continue;
    }
    item.next = now + (RETRY_BACKOFF_MS[item.attempts - 1] as number);
    await failed(ctx, queue, item.event, r.error ?? 'failed', `try ${item.attempts} failed`);
    keep.push(item);
  }
  if (queue.warning) {
    lines.unshift(queue.warning);
    delete queue.warning;
  }
  queue.items = keep;
  await writeQueue(ctx, queue);
  return lines;
}

/** Items waiting for a retry (for doctor and tests). */
export const queuedForPhone = (config: Pick<GlobalConfig, 'path'>): number => readQueue(config).items.length;
