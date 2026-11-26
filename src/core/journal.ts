import { withFileLock } from './file-lock.ts';
import { inspectReport } from './report-state.ts';
import { secretRedactor } from './secret-redaction.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { LaunchExit } from './start-failure.ts';
import type { Context } from './context.ts';
import { notifyPhone } from './phone-send.ts';
import { readTaskRecord } from './taskstore.ts';
import { isObject, windowName } from './util.ts';

/*
 * The journal of what happened to the tasks, one JSON line per event in `<AGENTCTL_HOME>/journal.jsonl`. `watch`, the queue, cancel and
 * the limits commands write it; `agentctl events` and the MCP tool `events_since` read it for a chat that gets no notifications.
 */

export const JOURNAL_KINDS = ['pulled-auto-close', 'host-unreachable', 'host-recovered','watch-resumed', 'watch-stage-restarted', 'watch-stalled', 'start-lock-recovered', 'ambiguous-verdict', 'state-write-recovered', 'consult', 'tmux-lost', 'machine-load-high', 'machine-load-recovered', 'report-outputs', 'review-added', 'review-repinned', 'gc_suggest', 'gc-freed', 'limited-resume', 'needs-attention', 'report-candidate', 'overloaded', 'overload-retry', 'queue-retry', 'launch-failed', 'launch-legacy', 'mcp-write', 'disk-warn', 'disk-critical', 'disk-ok', 'report-ready', 'task-start', 'task-ordered', 'queue-start', 'queue-held', 'queue-failed', 'setup-started', 'setup-finished', 'setup-failed', 'node-modules', 'close-cleanup', 'needs-input', 'needs-trust', 'blocked', 'cancelled', 'limited', 'dead', 'orphan', 'cohort-done', 'usage', 'limits-changed', 'report-detected', 'delivery', 'delivery-queued', 'mcp-applied', 'mcp-failed', 'unblocked', 'wall'] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalEntry {
  /** ISO time. */
  at: string;
  kind: JournalKind;
  task?: string;
  cohort?: string;
  owner?: string;
  /** Config revision shared by the limits command and watcher. */
  changeId?: string;
  /** What the notification said, or a short statement of the event. */
  text: string;
  /** One repository command, with a result code only after it exits. */
  launch?: LaunchExit;
  setup?: { repo: string; repoIndex: number; repoCount: number; command: string; commandIndex: number; commandCount: number; log: string; exitCode?: number };
  nodeModules?: { repo: string; result: 'hit' | 'miss' | 'unsupported'; bytes: number };
  cleanup?: { moved: { path: string; bytes: number }[]; bytes: number; unsupported?: string };
  /** The verdict line of a report that became ready. */
  verdict?: string;
  reportHash?: string;
  reportAttempt?: string;
  /** `report-outputs` of an automatic/manual review: the task it reviews, so its decisions are shown as the reviewer's. */
  reviewOf?: string;
  outputs_errors?: string[];
  outputs_warnings?: string[];
  decisions?: string[];
  actions?: Array<{ title: string; shell: string }>;
  gc_preview?: unknown;
  /** `usage` only: how far the plan is (`critical` is what goes to the phone). */
  level?: 'warn' | 'critical';
  /** The event went to the phone: `sent`, or `queued` when the first request failed and the watcher retries. Absent: not sent (away off, event not chosen, no phone). */
  phone?: 'sent' | 'queued';
  /** `wall` only: the message that was posted (never its body). events_since returns it to the clients subscribed to the channel. */
  wall?: { recipients?: string[]; channel: string; kind: string; subject: string; id: string; from: string };
  /** `report-outputs` only: the report's `wall_posts` that were published (ids) and the ones that were not (why; never a body). */
  wallPosts?: { posted: string[]; findings: string[] };
}

export const journalPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'journal.jsonl');

/** Append an event. A journal that cannot be written never stops the work it describes. */
export async function recordJournal(ctx: Context, entry: Omit<JournalEntry, 'at'>): Promise<void> {
  if (entry.kind === 'report-ready' && entry.task) {
    const record = readTaskRecord(ctx.config, windowName(entry.task));
    if (record) {
      const report = inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId);
      if (!report.ready || (record.attemptId && !report.sentinel && !report.structured)) return;
      const identity = record.attemptId ? `attempt:${record.attemptId}` : `started:${record.started}`;
      return withFileLock(`${journalPath(ctx.config)}.reports.lock`, async () => {
        if (readJournal(ctx.config, -1).some(e => e.kind === entry.kind && e.task === entry.task && e.reportAttempt === identity)) return;
        await appendJournal(ctx, { ...entry, reportAttempt: identity });
      });
    }
  }
  return appendJournal(ctx, entry);
}
async function prepareJournalEntry(ctx: Context, entry: Omit<JournalEntry, 'at'>): Promise<JournalEntry> {
  const record = entry.task ? readTaskRecord(ctx.config, windowName(entry.task)) : undefined;
  const cohort = entry.cohort ?? record?.cohort;
  const owner = entry.owner ?? record?.owner ?? (entry.task && ctx.config.quotas ? 'default' : undefined);
  const full: JournalEntry = secretRedactor([ctx.config, process.env, entry])({ at: new Date(ctx.runner.now()).toISOString(), ...entry, ...(cohort ? { cohort } : {}), ...(owner ? { owner } : {}) });
  // Belt and braces: a bulky payload once flooded events_since with JSON fragments for days (a gc_suggest carrying a whole
  // GC plan). Known bulky fields are replaced by a pointer past a bound; the text always stays.
  if (full.gc_preview !== undefined && Buffer.byteLength(JSON.stringify(full)) > 4000) full.gc_preview = { dropped: 'oversized payload; details via gc_preview / agentctl gc' };
  // The phone gets what was announced on the Mac (this is written once per announcement), and the entry says whether it went.
  const phone = await notifyPhone(ctx, full).catch(() => undefined);
  if (phone) full.phone = phone;
  return full;
}

async function appendJournal(ctx: Context, entry: Omit<JournalEntry, 'at'>): Promise<void> {
  const full = await prepareJournalEntry(ctx, entry);
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

type JournalIndex = { inode: bigint; device: bigint; modified: bigint; offset: number; tail: Buffer; ids: Set<string> };
const indexes = new Map<string, JournalIndex>();
const indexing = new Map<string, Promise<Set<string>>>();
const changeKey = (kind: JournalKind, id: string) => `${kind}:\0${id}`;

/** Change IDs survive restarts. Repeated reads parse only bytes appended since the last lookup. */
export function journalChangeIds(config: Pick<GlobalConfig, 'path'>): Promise<Set<string>> {
  const file = journalPath(config);
  const pending = indexing.get(file);
  if (pending) return pending;
  const scan = (async () => {
    const fd = await fs.promises.open(file, 'r').catch(() => undefined);
    if (!fd) { indexes.delete(file); return new Set<string>(); }
    try {
      const stat = await fd.stat({bigint: true});
      const size = Number(stat.size);
      let index = indexes.get(file);
      if (!index || index.inode !== stat.ino || index.device !== stat.dev || size < index.offset
        || size === index.offset && stat.mtimeNs !== index.modified) {
        index = { inode: stat.ino, device: stat.dev, modified: stat.mtimeNs, offset: 0, tail: Buffer.alloc(0), ids: new Set() };
      }
      while (index.offset < size) {
        const data = Buffer.alloc(Math.min(64 * 1024, size - index.offset));
        const {bytesRead} = await fd.read(data, 0, data.length, index.offset);
        if (!bytesRead) break;
        index.offset += bytesRead;
        const bytes = Buffer.concat([index.tail, data.subarray(0, bytesRead)]);
        const end = bytes.lastIndexOf(10);
        if (end >= 0) for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
          try {
            const event = JSON.parse(line) as JournalEntry;
            if (typeof event.changeId === 'string' && typeof event.kind === 'string') index.ids.add(changeKey(event.kind, event.changeId));
          } catch { /* torn line */ }
        }
        index.tail = bytes.subarray(end + 1);
      }
      index.modified = stat.mtimeNs;
      indexes.set(file, index);
      if (indexes.size > 32) indexes.delete(indexes.keys().next().value!);
      return index.ids;
    } finally { await fd.close(); }
  })().finally(() => indexing.delete(file));
  indexing.set(file, scan);
  return scan;
}

export const indexedJournalChange = (ids: ReadonlySet<string>, kind: JournalKind, id: string): boolean => ids.has(changeKey(kind, id));

/** One durable append and one deduplication pass for a batch of independent legacy launch events. */
export async function recordLegacyLaunches(ctx: Context, entries: (Omit<JournalEntry, 'at' | 'kind' | 'changeId'> & {changeId: string})[]): Promise<void> {
  if (!entries.length) return;
  const file = journalPath(ctx.config);
  await withFileLock(`${file}.launch-legacy.lock`, async () => {
    const ids = await journalChangeIds(ctx.config);
    const added = new Set<string>();
    const lines: string[] = [];
    for (const entry of entries) {
      if (added.has(entry.changeId) || indexedJournalChange(ids, 'launch-legacy', entry.changeId)) continue;
      added.add(entry.changeId);
      lines.push(JSON.stringify(await prepareJournalEntry(ctx, {...entry, kind: 'launch-legacy'})));
    }
    if (lines.length) await ctx.runner.appendFile(file, `${lines.join('\n')}\n`).catch(() => undefined);
  });
}

/** Record unless the last entry of this kind said the same within `withinMs` (two writers of one fact: a command and the watcher that noticed it). */
export async function recordJournalOnce(ctx: Context, entry: Omit<JournalEntry, 'at'>, withinMs = 5 * 60_000): Promise<void> {
  const now = ctx.runner.now();
  const seen = entry.changeId ? indexedJournalChange(await journalChangeIds(ctx.config), entry.kind, entry.changeId)
    : readJournal(ctx.config, now - withinMs).some(e => e.kind === entry.kind && e.text === entry.text && (e.task ?? '') === (entry.task ?? ''));
  if (!seen) await recordJournal(ctx, entry);
}
