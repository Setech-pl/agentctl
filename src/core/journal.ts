import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { isObject } from './util.ts';

/*
 * The journal of what happened to the tasks, one JSON line per event in `<AGENTCTL_HOME>/journal.jsonl`. `watch`, the queue, cancel and
 * the limits commands write it; `agentctl events` and the MCP tool `events_since` read it for a chat that gets no notifications.
 */

export const JOURNAL_KINDS = ['report-ready', 'queue-start', 'queue-failed', 'needs-input', 'needs-trust', 'blocked', 'cancelled', 'limited', 'dead', 'cohort-done', 'usage', 'limits-changed'] as const;
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
}

export const journalPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'journal.jsonl');

/** Append an event. A journal that cannot be written never stops the work it describes. */
export async function recordJournal(ctx: Context, entry: Omit<JournalEntry, 'at'>): Promise<void> {
  const full: JournalEntry = { at: new Date(ctx.runner.now()).toISOString(), ...entry };
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
