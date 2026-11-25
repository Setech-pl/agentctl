import { channelMessages, wallAge } from './wall.ts';
import { journalOutputs } from './outputs.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
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
import { accountTasks, taskNames } from './task-accounting.ts';
import { collectStatus } from './status.ts';
import { AgentctlError, cohortKey, formatLocalTime, isObject, plural } from './util.ts';

/*
 * What changed since the last look, for a chat that gets no notifications: the journal of events (watch, the queue, cancel, the limits)
 * from a time on, and a short summary of the state now. Each client (the MCP server, the CLI) has its own marker: "last" is the time of
 * that client's previous call.
 */

export type EventClient = string;

// Process lifetime is the MCP/CLI session; durable event cursors survive restarts.
const ratingShown = new Set<string>();

/** The first call of a client looks this far back. */
export const FIRST_LOOK_MS = 24 * 3_600_000;

export const markersPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'events-seen.json');

const GC_PREVIEW_KEY = '"gc_preview":';
const GC_PREVIEW_DROPPED = { dropped: 'oversized payload; details via gc_preview / agentctl gc' };

/**
 * The write-time bound of recordJournal (journal.ts) postdates many journals: an old gc_suggest can still carry a whole GC plan and would
 * occupy page after page of JSON fragments. Summarize such a legacy entry on read (same replacement as at write time, every other field kept).
 * The returned prefix is the length of the byte-identical head of the old and the new JSON: a fragment cursor at or before it continues
 * seamlessly, a cursor past it pointed into the dropped payload and the entry counts as delivered.
 */
function summarizeLegacyGc(entry: JournalEntry): { entry: JournalEntry; prefix: number } | null {
  const oldResult = entry.kind === 'mcp-applied' && /^gc (.*?): wykonane przez watch – \{/.exec(entry.text);
  if (oldResult) {
    const target = oldResult[1]!.startsWith('cohort ') ? ` ${oldResult[1]}` : '';
    return { entry: { ...entry, text: `gc${target}: zakończono; szczegóły w historii żądania` }, prefix: 0 };
  }
  if (entry.gc_preview === undefined) return null;
  const raw = JSON.stringify(entry);
  if (Buffer.byteLength(raw) <= 4000) return null;
  const key = raw.indexOf(GC_PREVIEW_KEY);
  return { entry: { ...entry, gc_preview: GC_PREVIEW_DROPPED }, prefix: key < 0 ? 0 : key + GC_PREVIEW_KEY.length };
}

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

/** "last", an age (30m, 2h, 1d), an ISO time, or HH:MM — the most recent past occurrence within 24 h (local); returns ms. */
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
    // A time still in the future today means yesterday evening, not an empty window.
    const yesterday = d.getTime() > now;
    if (yesterday) d.setDate(d.getDate() - 1);
    return { ms: d.getTime(), label: `od ${t}${yesterday ? ' (wczoraj)' : ''}` };
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw new AgentctlError(`cannot read the time "${t}"`, 'Use last, an age (30m, 2h, 1d), HH:MM or an ISO time like 2026-11-02T10:00.');
  return { ms, label: `od ${formatLocalTime(new Date(ms).toISOString())}` };
}

export interface EventsSummary {
  /** Tasks with a window that are not finished. */
  active: number;
  activeTasks?: string[];
  unmarked?: number;
  working: number;
  workingTasks?: string[];
  /** Tasks that wait for the user: needs-input, needs-trust, waiting. */
  needYou: string[];
  queued: number;
  queuedTasks?: string[];
  /** Reports ready and not pulled yet. */
  reportsToPull: string[];
  reportCount?: number;
}

export interface EventsReport {
  client: EventClient;
  wallIdentity?: string;
  wallOpen?: { id: string; subject: string; from: string; age: string }[];
  /** ISO time the events start after. */
  since: string;
  sinceLabel: string;
  /** Why the list is empty although a time was asked for (HH:MM later today). */
  note?: string;
  cohort: string | null;
  events: JournalEntry[];
  otherChatEvents?: number;
  summary: EventsSummary;
  /** Away mode: while on, the phone gets the notifications. */
  away: AwayView;
  /** The marker of this client moved to this call. */
  markerMoved: boolean;
  has_more: boolean;
  next_cursor: string;
}

export function chatEventScope(config: GlobalConfig, chat: string) {
  const items = [...listArchivedRecords(config), ...listTaskRecords(config), ...readQueue(config)];
  const tasks = new Set(items.filter(item => item.owner === chat).map(item => item.task));
  const cohorts = new Set([
    ...Object.entries(config.quotas?.cohorts ?? {}).filter(([, owner]) => owner === chat).map(([cohort]) => cohort),
    ...items.filter(item => item.owner === chat && item.cohort).map(item => cohortKey(item.cohort!)),
  ]);
  return (item: { task?: string; cohort?: string | null; owner?: string }) =>
    item.owner === chat || Boolean(item.task && tasks.has(item.task)) || Boolean(item.cohort && cohorts.has(cohortKey(item.cohort)));
}

export async function collectEvents(ctx: Context, opts: { client: EventClient; since?: string | undefined; cohort?: string | undefined; keep?: boolean | undefined; cursor?: string; limit?: number; maxBytes?: number; chat?: string; /** WALL events only of these channels (the caller's subscriptions); undefined: every channel (the owner). */ wallIdentity?: string; wallOpenChannels?: ReadonlySet<string>; wallChannels?: ReadonlySet<string> | undefined }): Promise<EventsReport> {
  const { config, runner } = ctx;
  const now = runner.now();
  const since = parseSince(opts.since, opts.client, config, now);
  const cohort = opts.cohort === undefined ? null : findCohort(config, opts.cohort).name;
  for (const record of listTaskRecords(config)) await journalOutputs(ctx, record, { readOnly: true });
  const journal = readJournal(config, -1);
  const redacted = secretRedactor([config, process.env, journal], new Set(listTaskRecords(config).map(r => r.task)))(journal);
  const legacyGc = redacted.map(summarizeLegacyGc);
  const all = redacted.map((e, i) => legacyGc[i]?.entry ?? e);
  const key = cohort === null ? opts.client : `${opts.client}|cohort:${cohortKey(cohort)}`;
  const saved = opts.cursor ?? ((!opts.since || opts.since === 'last') ? (readMarkers(config)[key] ?? (opts.client.startsWith('mcp:') && readMarkers(config).mcp?.startsWith('e2:') ? readMarkers(config).mcp : undefined)) : undefined);
  let position = saved?.startsWith('e2:') ? decodeCursor(saved) : { index: all.findIndex(e => Date.parse(e.at) > (saved ? Date.parse(saved) : since.ms)), offset: 0 };
  if (position.index < 0) position.index = all.length;
  if (position.index > all.length) throw new AgentctlError('events cursor is beyond this journal; request an explicit since');
  const taskStart = {...position};
  const wallKey = opts.wallIdentity?.startsWith('chat:') ? `${opts.client}|wall` : undefined;
  const wallSaved = wallKey && !opts.cursor && (!opts.since || opts.since === 'last') ? readMarkers(config)[wallKey] : undefined;
  const wallStart = wallSaved?.startsWith('e2:') ? decodeCursor(wallSaved) : {...taskStart};
  if (wallStart.index < position.index || (wallStart.index === position.index && wallStart.offset < position.offset)) position = {...wallStart};
  const events: Array<JournalEntry & { fragment?: { offset: number; total: number; encoding: string } }> = [];
  const rows = await collectStatus(ctx, { progress: false, archived: false, cachedOnly: true, shallowClosed: true });
  const inScope = opts.chat ? chatEventScope(config, opts.chat) : undefined;
  const open = rows.filter((r) => !r.closed && !r.cancelled && !r.hidden && (!inScope || inScope(r)) && (cohort === null || (r.cohort !== null && cohortKey(r.cohort) === cohortKey(cohort))));
  const accounting = accountTasks(open);
  const queue = waiting(readQueue(config)).filter((e) => (!inScope || inScope(e)) && (cohort === null || (e.cohort !== undefined && cohortKey(e.cohort) === cohortKey(cohort))));
  const ratingKey = `${config.path}|${opts.client}`;
  const summary: EventsSummary = {
    active: accounting.active.length,
    activeTasks: accounting.active.slice(0, 6).map(r => r.task),
    ...(!ratingShown.has(ratingKey) ? { unmarked: foldHistory(readHistory(config)).filter(r => r.reportAt && !r.result && (!inScope || inScope(r))).length } : {}),
    working: accounting.working.length,
    workingTasks: accounting.working.slice(0, 6).map(r => r.task),
    needYou: open.filter((r) => r.state === 'limited' || r.state === 'needs-attention' || r.state === 'needs-input' || r.state === 'needs-trust' || r.state === 'waiting' || (r.reportCandidate && r.report !== 'yes')).map((r) => `${r.task} (${r.state})${r.state === 'limited' ? `: ${r.usage_hint ?? 'limit wyczerpany'}${r.usage_reset_at ? `; reset ${formatLocalTime(r.usage_reset_at)}` : ''}` : ''}${r.question ? `: ${r.question}` : r.state === 'needs-attention' || (r.reportCandidate && r.report !== 'yes') ? `: ${r.hint}` : ''}`),
    queued: queue.length,
    queuedTasks: queue.slice(0, 6).map(e => e.task),
    reportsToPull: accounting.reports.slice(0, 6).map(r => r.task),
    reportCount: accounting.reports.length,
  };
  // Bound the complete JSON and text forms before advancing the persistent cursor.
  const report: EventsReport = { client: opts.client, since: new Date(since.ms).toISOString(), sinceLabel: since.label, ...(since.note ? { note: since.note } : {}), ...(inScope ? {otherChatEvents: 0} : {}), cohort, events, summary, away: awayView(config), markerMoved: false, has_more: false, next_cursor: '' };
  if (opts.wallIdentity?.startsWith('chat:')) {
    report.wallIdentity = opts.wallIdentity;
    report.wallOpen = [...(opts.wallOpenChannels ?? opts.wallChannels ?? [])].flatMap(c => channelMessages(config, c))
      .filter(m => m.status === 'open' && (m.to === opts.wallIdentity || m.kind === 'question' || m.kind === 'decision-request'))
      .sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 10).map(m => ({ id: m.id, subject: m.subject.slice(0, 100), from: m.from, age: wallAge(m.ts, ctx.runner.now()) }));
  }
  const encode = () => `e2:${position.index}:${position.offset}`;
  const baseNeedYou = [...summary.needYou];
  const attentionTasks = new Set(rows.filter(r => !r.closed && !r.cancelled && !r.pulled).map(r => r.task));
  const updateNeedYou = () => { report.summary.needYou = [...new Set([...baseNeedYou, ...events.filter(e => !('fragment' in e) && e.kind === 'report-outputs' && attentionTasks.has(e.task ?? '')).flatMap(e => [...(e.decisions ?? []).map(text => `${e.reviewOf ? 'przegląd ' : ''}${e.task}: decision: ${text}`), ...(e.actions ?? []).map(a => `${e.reviewOf ? 'przegląd ' : ''}${e.task}: action: ${a.title} (${a.shell})`)])])]; };
  const fits = () => { updateNeedYou(); return Math.max(Buffer.byteLength(JSON.stringify(report, null, 2)), Buffer.byteLength(renderEvents(report).join('\n'))) <= (opts.maxBytes ?? 16000); };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  while (position.index < all.length && events.length < limit) {
    const event = all[position.index]!;
    const start = event.kind === 'wall' ? wallStart : taskStart;
    if (position.index < start.index) { position = {index: position.index + 1, offset: 0}; continue; }
    if (position.index === start.index) position.offset = Math.max(position.offset, start.offset);
    if (event.kind !== 'wall' && inScope && (event.task || event.cohort || event.owner?.startsWith('chat:')) && !inScope(event)) {
      report.otherChatEvents = (report.otherChatEvents ?? 0) + 1;
      position = { index: position.index + 1, offset: 0 };
      continue;
    }
    if (event.kind !== 'wall' && cohort !== null && (!event.cohort || cohortKey(event.cohort) !== cohortKey(cohort))) { position = { index: position.index + 1, offset: 0 }; continue; }
    if (event.kind === 'wall' && opts.wallChannels && !opts.wallChannels.has(event.wall?.channel ?? '') && !(opts.wallIdentity && event.wall?.recipients?.includes(opts.wallIdentity))) { position = { index: position.index + 1, offset: 0 }; continue; }
    if (event.kind === 'wall' && event.wall?.recipients && opts.wallIdentity && !event.wall.recipients.includes(opts.wallIdentity) && !event.wall.recipients.includes(event.wall.channel)) { position = { index: position.index + 1, offset: 0 }; continue; }
    const raw = JSON.stringify(event);
    const prefix = legacyGc[position.index]?.prefix;
    if (position.offset > 0 && ((prefix !== undefined && position.offset > prefix) || position.offset >= raw.length)) {
      // A mid-fragment cursor of an entry that has since shrunk (a legacy gc_preview summarized on read): the undelivered rest
      // was the dropped payload (or its shifted suffix); the entry counts as delivered, the next one is served whole.
      position = { index: position.index + 1, offset: 0 };
      continue;
    }
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
      if (wallKey) {
        const previousWall = markers[wallKey]?.startsWith('e2:') ? decodeCursor(markers[wallKey]!) : undefined;
        if (!previousWall || previousWall.index < position.index || (previousWall.index === position.index && previousWall.offset <= position.offset)) markers[wallKey] = report.next_cursor;
      }
      while (Object.keys(markers).length > 256) delete markers[Object.keys(markers).find(k => k !== key && k !== wallKey && k !== 'cli')!];
      await runner.writeFile(markersPath(config), `${JSON.stringify(markers, null, 2)}\n`);
      report.markerMoved = true;
      if (summary.unmarked) ratingShown.add(ratingKey);
    });
  }
  return report;
}

/** Behind an event that was sent to the phone (a retry in progress: "queued" is shown by the JSON field `phone`). */
const PHONE_MARK = ' 📱';
const hhmm = (iso: string): string => formatLocalTime(iso).slice(-5);
const KIND_LABEL: Record<JournalEntry['kind'], string> = {
  'host-unreachable': 'HOST NIEDOSTĘPNY',
  'host-recovered': 'HOST OSIĄGALNY',
  'watch-resumed': 'WATCH',
  'watch-stage-restarted': 'WATCH',
  'ambiguous-verdict': 'NIEJASNY WERDYKT',
  'state-write-recovered': 'ZAPIS STANU',
  'tmux-lost': 'TMUX UTRACONY',
  'machine-load-high': 'OBCIĄŻENIE',
  'machine-load-recovered': 'OBCIĄŻENIE OK',
  'report-outputs': 'WYNIKI RAPORTU',
  'review-added': 'DODANO PRZEGLĄD',
  'review-repinned': 'PRZEGLĄD PRZYPIĘTY',
  gc_suggest: 'SUGESTIA GC',
  'gc-freed': 'GC',
  'limited-resume': 'WZNOWIENIE',
  'needs-attention': 'WYMAGA UWAGI',
  'report-candidate': 'KANDYDAT',
  overloaded: 'PRZECIĄŻENIE',
  'overload-retry': 'PONOWIENIE',
  'queue-retry': 'PONOWIENIE STARTU',
  'launch-failed': 'BŁĄD STARTU',
  'mcp-write': 'MCP',
  'disk-warn': 'DYSK',
  'disk-critical': 'DYSK KRYTYCZNY',
  'disk-ok': 'DYSK OK',
  'report-ready': 'RAPORT',
  'task-start': 'START',
  'task-ordered': 'ZLECENIE',
  'queue-start': 'START',
  'queue-held': 'KOLEJKA',
  'queue-failed': 'BŁĄD STARTU',
  'setup-started': 'SETUP',
  'setup-finished': 'SETUP OK',
  'setup-failed': 'BŁĄD SETUPU',
  'node-modules': 'NODE_MODULES',
  'close-cleanup': 'KOSZ',
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
  'pulled-auto-close': 'ODEBRANE ZAMKNIĘTE',
  delivery: 'WIADOMOŚĆ',
  'delivery-queued': 'WIADOMOŚĆ W KOLEJCE',
  'mcp-applied': 'MCP WYKONANE',
  'mcp-failed': 'MCP BŁĄD',
  unblocked: 'ODBLOKOWANE',
  wall: 'WALL',
  consult: 'CONSULT',
};

export function summaryLine(s: EventsSummary): string {
  const reports = s.reportCount ?? s.reportsToPull.length;
  const parts = [`${s.active} aktywne${taskNames(s.activeTasks ?? [])}`, ...(s.working ? [`${s.working} pracuje${taskNames(s.workingTasks ?? [])}`] : []), `${s.queued} w kolejce${taskNames(s.queuedTasks ?? [])}`, reports > 0 ? `${reports} ${plural(reports, 'raport', 'raporty', 'raportów')} do pobrania${taskNames(s.reportsToPull)}` : 'brak raportów do pobrania'];
  if (s.unmarked) parts.push(`${s.unmarked} ${plural(s.unmarked, 'zadanie', 'zadania', 'zadań')} bez oceny`);
  if (s.needYou.length > 0) parts.push(`czeka na Ciebie: ${s.needYou.join(', ')}`);
  return `Teraz: ${parts.join(' · ')}.`;
}

export function renderEvents(report: EventsReport): string[] {
  const head = `Zdarzenia ${report.sinceLabel}${report.cohort ? `, kohorta ${report.cohort}` : ''}: ${report.events.length === 0 ? 'brak zmian' : String(report.events.length)}`;
  return [
    head,
    ...(report.note ? [report.note] : []),
    ...(report.wallOpen ? ['WALL do Ciebie (open)', ...report.wallOpen.map(m => `${m.id}: ${m.subject} (${m.age})${m.from === report.wallIdentity ? ' (yours)' : ''}`), ...(!report.wallOpen.length ? ['brak'] : [])] : []),
    ...report.events.map((e) => `${hhmm(e.at)}  ${KIND_LABEL[e.kind]}${e.task ? `  ${e.task}` : ''}  ${e.verdict ? `${e.verdict}` : e.text}${e.kind === 'wall' && report.wallIdentity && e.wall?.from === report.wallIdentity ? ' (yours)' : ''}${e.phone ? PHONE_MARK : ''}`),
    ...(report.otherChatEvents !== undefined ? [`inne czaty: ${report.otherChatEvents} zdarzeń`] : []),
    summaryLine(report.summary),
    `has_more: ${report.has_more}; next_cursor: ${report.next_cursor}`,
    ...(report.away.on ? ['Away włączone: telefon dostaje powiadomienia (📱 przy zdarzeniu = poszło na telefon).'] : []),
  ];
}

export function eventsMarkdown(report: EventsReport): string {
  const lines = [`**${renderEvents(report)[0]}**`, ''];
  for (const e of report.events) lines.push(`- ${hhmm(e.at)} **${KIND_LABEL[e.kind]}**${e.task ? ` ${e.task}` : ''} – ${e.verdict ?? e.text}${e.kind === 'wall' && report.wallIdentity && e.wall?.from === report.wallIdentity ? ' (yours)' : ''}${e.phone ? PHONE_MARK : ''}`);
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
