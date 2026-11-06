import { journalOutputs } from './outputs.ts';
import { listTaskRecords } from './taskstore.ts';
import { withFileLock } from './file-lock.ts';
import fs from 'node:fs';
import { foldHistory, readHistory } from './history.ts';
import path from 'node:path';
import { parseAge } from './archive.ts';
import { findCohort } from './cohort.ts';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { awayView } from './away.ts';
import type { AwayView } from './away.ts';
import { secretRedactor } from './secret-redaction.ts';
import { readJournal } from './journal.ts';
import type { JournalEntry } from './journal.ts';
import { readQueue, waiting } from './queue.ts';
import { selectReady } from './pull.ts';
import { collectStatus } from './status.ts';
import { AgentctlError, cohortKey, formatLocalTime, isObject, plural } from './util.ts';

/*
 * What changed since the last look, for a chat that gets no notifications: the journal of events (watch, the queue, cancel, the limits)
 * from a time on, and a short summary of the state now. Each client (the MCP server, the CLI) has its own marker: "last" is the time of
 * that client's previous call.
 */

export type EventClient = string;

/** The first call of a client looks this far back. */
export const FIRST_LOOK_MS = 24 * 3_600_000;

export const markersPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'events-seen.json');

export function readMarkers(config: Pick<GlobalConfig, 'path'>): Partial<Record<EventClient, string>> {
  try {
    const d: unknown = JSON.parse(fs.readFileSync(markersPath(config), 'utf8'));
    const out: Partial<Record<EventClient, string>> = {};
    if (isObject(d)) for (const [c, v] of Object.entries(d)) if (typeof v === 'string') out[c] = v;
    return out;
  } catch {
    return {};
  }
}

/** "last", an age (30m, 2h, 1d), an ISO time, or HH:MM today (local); returns ms. */
export function parseSince(text: string | undefined, client: EventClient, config: Pick<GlobalConfig, 'path'>, now: number): { ms: number; label: string; note?: string } {
  const t = (text ?? 'last').trim();
  if (t === '' || t === 'last') {
    const marker = readMarkers(config)[client];
    const legacy = client.startsWith('mcp:') ? readMarkers(config).mcp : undefined;
    const ms = marker && !marker.startsWith('e2:') ? Date.parse(marker) : legacy && !legacy.startsWith('e2:') ? Date.parse(legacy) : now - FIRST_LOOK_MS;
    return { ms, label: marker ? `od ostatniego wywołania (${client}, ${formatLocalTime(marker)})` : `z ostatnich 24 h (pierwsze wywołanie ${client})` };
  }
  if (/^\d+[mhdw]$/.test(t)) return { ms: now - parseAge(t), label: `z ostatnich ${t}` };
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    // HH:MM is today, local time. A moment that has not come yet has no events: never a fallback to the last 24 hours.
    const future = d.getTime() > now;
    return { ms: d.getTime(), label: `od ${t}`, ...(future ? { note: `${t} jest dziś w przyszłości (teraz ${formatLocalTime(new Date(now).toISOString()).slice(11)}): brak zdarzeń. Podaj wiek (np. 30m) albo pełny czas ISO, by sięgnąć do wczoraj.` } : {}) };
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new AgentctlError(`cannot read the time "${t}"`, 'Use last, an age (30m, 2h, 1d), HH:MM or an ISO time like 2026-11-02T10:00.');
  return { ms, label: `od ${formatLocalTime(new Date(ms).toISOString())}` };
}

export interface EventsSummary {
  /** Tasks with a window that are not finished. */
  active: number;
  unmarked?: number;
  working: number;
  /** Tasks that wait for the user: needs-input, needs-trust, waiting. */
  needYou: string[];
  queued: number;
  /** Reports ready and not pulled yet. */
  reportsToPull: string[];
}

export interface EventsReport {
  client: EventClient;
  /** ISO time the events start after. */
  since: string;
  sinceLabel: string;
  /** Why the list is empty although a time was asked for (HH:MM later today). */
  note?: string;
  cohort: string | null;
  events: JournalEntry[];
  summary: EventsSummary;
  /** Away mode: while on, the phone gets the notifications. */
  away: AwayView;
  /** The marker of this client moved to this call. */
  markerMoved: boolean;
  has_more: boolean;
  next_cursor: string;
}

export async function collectEvents(ctx: Context, opts: { client: EventClient; since?: string | undefined; cohort?: string | undefined; keep?: boolean | undefined; cursor?: string; limit?: number; maxBytes?: number }): Promise<EventsReport> {
  const { config, runner } = ctx;
  const now = runner.now();
  const since = parseSince(opts.since, opts.client, config, now);
  const cohort = opts.cohort === undefined ? null : findCohort(config, opts.cohort).name;
  for (const record of listTaskRecords(config)) await journalOutputs(ctx, record);
  const journal = readJournal(config, -1);
  const all = secretRedactor([config, process.env, journal], new Set(listTaskRecords(config).map(r => r.task)))(journal);
  const key = cohort === null ? opts.client : `${opts.client}|cohort:${cohortKey(cohort)}`;
  const saved = opts.cursor ?? ((!opts.since || opts.since === 'last') ? (readMarkers(config)[key] ?? (opts.client.startsWith('mcp:') && readMarkers(config).mcp?.startsWith('e2:') ? readMarkers(config).mcp : undefined)) : undefined);
  let position = saved?.startsWith('e2:') ? decodeCursor(saved) : { index: all.findIndex(e => Date.parse(e.at) > (saved ? Date.parse(saved) : since.ms)), offset: 0 };
  if (position.index < 0) position.index = all.length;
  if (position.index > all.length) throw new AgentctlError('events cursor is beyond this journal; request an explicit since');
  const events: Array<JournalEntry & { fragment?: { offset: number; total: number; encoding: string } }> = [];
  const rows = await collectStatus(ctx, { progress: false, archived: false });
  const open = rows.filter((r) => !r.closed && !r.cancelled && !r.hidden && (cohort === null || (r.cohort !== null && cohortKey(r.cohort) === cohortKey(cohort))));
  const alive = open.filter((r) => r.window === 'alive' && !r.finished);
  const queue = waiting(readQueue(config)).filter((e) => cohort === null || (e.cohort !== undefined && cohortKey(e.cohort) === cohortKey(cohort)));
  const summary: EventsSummary = {
    active: alive.length,
    unmarked: foldHistory(readHistory(config)).filter(r => r.reportAt && !r.result).length,
    working: alive.filter((r) => r.state === 'working' || r.state === 'background').length,
    needYou: open.filter((r) => r.state === 'needs-attention' || r.state === 'needs-input' || r.state === 'needs-trust' || r.state === 'waiting' || (r.reportCandidate && r.report !== 'yes')).map((r) => `${r.task} (${r.state})${r.question ? `: ${r.question}` : r.state === 'needs-attention' || (r.reportCandidate && r.report !== 'yes') ? `: ${r.hint}` : ''}`),
    queued: queue.length,
    reportsToPull: selectReady(open, false).map((r) => r.task).slice(0, 10),
  };
  // Bound the complete JSON and text forms before advancing the persistent cursor.
  const report: EventsReport = { client: opts.client, since: new Date(since.ms).toISOString(), sinceLabel: since.label, ...(since.note ? { note: since.note } : {}), cohort, events, summary, away: awayView(config), markerMoved: false, has_more: false, next_cursor: '' };
  const encode = () => `e2:${position.index}:${position.offset}`;
  const baseNeedYou = [...summary.needYou];
  const updateNeedYou = () => { report.summary.needYou = [...baseNeedYou, ...events.filter(e => !('fragment' in e) && e.kind === 'report-outputs').flatMap(e => [...(e.decisions ?? []).map(text => `${e.reviewOf ? 'przegląd ' : ''}${e.task}: decision: ${text}`), ...(e.actions ?? []).map(a => `${e.reviewOf ? 'przegląd ' : ''}${e.task}: action: ${a.title} (${a.shell})`)])]; };
  const fits = () => { updateNeedYou(); return Math.max(Buffer.byteLength(JSON.stringify(report, null, 2)), Buffer.byteLength(renderEvents(report).join('\n'))) <= (opts.maxBytes ?? 16000); };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  while (position.index < all.length && events.length < limit) {
    const event = all[position.index]!;
    if (cohort !== null && (!event.cohort || cohortKey(event.cohort) !== cohortKey(cohort))) { position = { index: position.index + 1, offset: 0 }; continue; }
    const raw = JSON.stringify(event);
    const previous = { ...position };
    if (position.offset === 0) {
      events.push(event); position.index++;
      report.has_more = position.index < all.length; report.next_cursor = encode();
      if (fits()) continue;
      events.pop(); position = previous;
      if (events.length) break;
    }
    // Oversized single events are transported as numbered JSON fragments. Never skip an undelivered suffix.
    let count = Math.min(2000, raw.length - position.offset);
    for (;;) {
      const chunk = { at: event.at, kind: event.kind, text: raw.slice(position.offset, position.offset + count), fragment: { offset: position.offset, total: raw.length, encoding: 'json' } };
      events.push(chunk);
      report.has_more = true; report.next_cursor = encode();
      if (fits()) break;
      events.pop(); count = Math.floor(count / 2);
      if (!count) throw new AgentctlError('event response metadata exceeds the response budget');
    }
    position.offset += count;
    if (position.offset >= raw.length) position = { index: position.index + 1, offset: 0 };
    break;
  }
  updateNeedYou();
  report.has_more = position.index < all.length;
  report.next_cursor = encode();
  if (!opts.keep && !runner.dryRun) {
    await withFileLock(`${markersPath(config)}.lock`, async () => {
      const markers = readMarkers(config);
      // Migrate once into a stable client key. New clients then start at the normal bounded first look.
      if (opts.client.startsWith('mcp:')) delete markers.mcp;
      for (const old of Object.keys(markers)) if (/^mcp:.*:\d+:[0-9a-f-]{36}$/.test(old)) delete markers[old];
      const previous = markers[key]?.startsWith('e2:') ? decodeCursor(markers[key]!) : null;
      const next = !previous || previous.index < position.index || (previous.index === position.index && previous.offset <= position.offset) ? report.next_cursor : markers[key]!;
      delete markers[key]; markers[key] = next;
      while (Object.keys(markers).length > 256) delete markers[Object.keys(markers).find(k => k !== key && k !== 'cli')!];
      await runner.writeFile(markersPath(config), `${JSON.stringify(markers, null, 2)}\n`);
      report.markerMoved = true;
    });
  }
  return report;
}

/** Behind an event that was sent to the phone (a retry in progress: "queued" is shown by the JSON field `phone`). */
const PHONE_MARK = ' 📱';
const hhmm = (iso: string): string => formatLocalTime(iso).slice(-5);
const KIND_LABEL: Record<JournalEntry['kind'], string> = {
  'tmux-lost': 'TMUX UTRACONY',
  'report-outputs': 'WYNIKI RAPORTU',
  'review-added': 'DODANO PRZEGLĄD',
  'review-repinned': 'PRZEGLĄD PRZYPIĘTY',
  gc_suggest: 'SUGESTIA GC',
  'limited-resume': 'WZNOWIENIE',
  'needs-attention': 'WYMAGA UWAGI',
  'report-candidate': 'KANDYDAT',
  overloaded: 'PRZECIĄŻENIE',
  'overload-retry': 'PONOWIENIE',
  'queue-retry': 'PONOWIENIE STARTU',
  'mcp-write': 'MCP',
  'disk-warn': 'DYSK',
  'disk-critical': 'DYSK KRYTYCZNY',
  'disk-ok': 'DYSK OK',
  'report-ready': 'RAPORT',
  'queue-start': 'START',
  'queue-failed': 'BŁĄD STARTU',
  'setup-started': 'SETUP',
  'setup-finished': 'SETUP OK',
  'setup-failed': 'BŁĄD SETUPU',
  'needs-input': 'PYTANIE',
  'needs-trust': 'ZAUFANIE',
  blocked: 'ZABLOKOWANE',
  cancelled: 'ANULOWANE',
  limited: 'LIMIT',
  dead: 'OKNO ZNIKNĘŁO',
  orphan: 'OKNO BEZ STANU',
  'cohort-done': 'KOHORTA',
  usage: 'UŻYCIE',
  'limits-changed': 'LIMITY',
  'report-detected': 'RAPORT WYKRYTY',
  delivery: 'WIADOMOŚĆ',
};

export function summaryLine(s: EventsSummary): string {
  const parts = [`${s.active} aktywne${s.working > 0 ? ` (${s.working} pracuje)` : ''}`, `${s.queued} w kolejce`, s.reportsToPull.length > 0 ? `${s.reportsToPull.length} ${plural(s.reportsToPull.length, 'raport', 'raporty', 'raportów')} do pobrania (${s.reportsToPull.join(', ')})` : 'brak raportów do pobrania'];
  if (s.unmarked) parts.push(`${s.unmarked} ${plural(s.unmarked, 'zadanie', 'zadania', 'zadań')} bez oceny`);
  if (s.needYou.length > 0) parts.push(`czeka na Ciebie: ${s.needYou.join(', ')}`);
  return `Teraz: ${parts.join(' · ')}.`;
}

export function renderEvents(report: EventsReport): string[] {
  const head = `Zdarzenia ${report.sinceLabel}${report.cohort ? `, kohorta ${report.cohort}` : ''}: ${report.events.length === 0 ? 'brak zmian' : String(report.events.length)}`;
  return [
    head,
    ...(report.note ? [report.note] : []),
    ...report.events.map((e) => `${hhmm(e.at)}  ${KIND_LABEL[e.kind]}${e.task ? `  ${e.task}` : ''}  ${e.verdict ? `${e.verdict}` : e.text}${e.phone ? PHONE_MARK : ''}`),
    summaryLine(report.summary),
    `has_more: ${report.has_more}; next_cursor: ${report.next_cursor}`,
    ...(report.away.on ? ['Away włączone: telefon dostaje powiadomienia (📱 przy zdarzeniu = poszło na telefon).'] : []),
  ];
}

export function eventsMarkdown(report: EventsReport): string {
  const lines = [`**${renderEvents(report)[0]}**`, ''];
  for (const e of report.events) lines.push(`- ${hhmm(e.at)} **${KIND_LABEL[e.kind]}**${e.task ? ` ${e.task}` : ''} – ${e.verdict ?? e.text}${e.phone ? PHONE_MARK : ''}`);
  if (report.events.length > 0) lines.push('');
  lines.push(summaryLine(report.summary));
  if (report.away.on) lines.push('', 'Away włączone: telefon dostaje powiadomienia.');
  return `${lines.join('\n')}\n`;
}

function decodeCursor(value: string): { index: number; offset: number } {
  const match = /^e2:(\d+):(\d+)$/.exec(value);
  if (!match) throw new AgentctlError('invalid events cursor');
  const index = Number(match[1]), offset = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(offset)) throw new AgentctlError('invalid events cursor');
  return { index, offset };
}
