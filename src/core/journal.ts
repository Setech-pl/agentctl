import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { notifyPhone } from './phone-send.ts';
import { readTaskRecord } from './taskstore.ts';
import { isObject, windowName } from './util.ts';

/*
 * The journal of what happened to the tasks, one JSON line per event in `<AGENTCTL_HOME>/journal.jsonl`. `watch`, the queue, cancel and
 * the limits commands write it; `agentctl events` and the MCP tool `events_since` read it for a chat that gets no notifications.
 */

export const JOURNAL_KINDS = ['report-outputs', 'review-added', 'gc_suggest', 'limited-resume', 'needs-attention', 'report-candidate', 'overloaded', 'overload-retry', 'queue-retry', 'mcp-write', 'disk-warn', 'disk-critical', 'disk-ok', 'report-ready', 'queue-start', 'queue-failed', 'needs-input', 'needs-trust', 'blocked', 'cancelled', 'limited', 'dead', 'orphan', 'cohort-done', 'usage', 'limits-changed', 'report-detected'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalEntry {
  /** ISO time. */
  at: string;
  kind: JournalKind;
  task?: string;
  cohort?: string;
  /** What the notification said, or a short statement of the event. */
  text: string;
  /** The verdict line of a report that became ready. */
  verdict?: string;
  reportHash?: string;
  decisions?: string[];
  actions?: Array<{ title: string; shell: string }>;
  gc_preview?: unknown;
  /** `usage` only: how far the plan is (`critical` is what goes to the phone). */
  level?: 'warn' | 'critical';
  /** The event went to the phone: `sent`, or `queued` when the first request failed and the watcher retries. Absent: not sent (away off, event not chosen, no phone). */
  phone?: 'sent' | 'queued';
}

export const journalPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'journal.jsonl');

/** Append an event. A journal that cannot be written never stops the work it describes. */
export async function recordJournal(ctx: Context, entry: Omit<JournalEntry, 'at'>): Promise<void> {
  const cohort = entry.cohort ?? (entry.task ? readTaskRecord(ctx.config, windowName(entry.task))?.cohort : undefined);
  const full: JournalEntry = { at: new Date(ctx.runner.now()).toISOString(), ...entry, ...(cohort ? { cohort } : {}) };
  // The phone gets what was announced on the Mac (this is written once per announcement), and the entry says whether it went.
  const phone = await notifyPhone(ctx, full).catch(() => undefined);
  if (phone) full.phone = phone;
  try {
    await ctx.runner.appendFile(journalPath(ctx.config), `${JSON.stringify(full)}\n`);
  } catch {
    // the event is lost; the state of the tasks is not
  }
}

/** The entries from `sinceMs` on (exclusive), oldest first. */
export function readJournal(config: Pick<GlobalConfig, 'path'>, sinceMs: number = 0): JournalEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(journalPath(config), 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const d: unknown = JSON.parse(line);
      if (!isObject(d) || typeof d.at !== 'string' || typeof d.kind !== 'string' || typeof d.text !== 'string') continue;
      if (!(JOURNAL_KINDS as readonly string[]).includes(d.kind)) continue;
      if (Date.parse(d.at) <= sinceMs) continue;
      out.push(d as unknown as JournalEntry);
    } catch {
      // a torn line
    }
  }
  return out;
}

/** Record unless the last entry of this kind said the same within `withinMs` (two writers of one fact: a command and the watcher that noticed it). */
export async function recordJournalOnce(ctx: Context, entry: Omit<JournalEntry, 'at'>, withinMs = 5 * 60_000): Promise<void> {
  const now = ctx.runner.now();
  const last = readJournal(ctx.config, now - withinMs).filter((e) => e.kind === entry.kind && e.text === entry.text && (e.task ?? '') === (entry.task ?? ''));
  if (last.length === 0) await recordJournal(ctx, entry);
}
