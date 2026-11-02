import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { hasReport } from './depends.ts';
import type { Notifier } from './notify.ts';
import { readQueue, renderRawSpec, saveEntry } from './queue.ts';
import type { QueueEntry } from './queue.ts';
import { splitSpecs } from './spec.ts';
import type { RawSpec } from './spec.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { listArchivedRecords, listTaskRecords, setHeaderField, taskFile } from './taskstore.ts';
import type { GlobalConfig } from './config.ts';
import { AgentctlError, cohortKey, cohortNameProblem, isObject } from './util.ts';

/*
 * Cohorts: tasks grouped under a name the human chose. A task belongs to a cohort only when its spec says `cohort: <name>` (or `--cohort`,
 * or `cohort add`); there is no default cohort and none is ever made up. The cohort of a task lives in its TASK.md (`cohort:`) and, while it
 * waits, in its queue entry. What agentctl knows about the cohort itself is `<config dir>/cohorts/<name>.json`: when it was created and an
 * optional note. Names are compared without regard to case and shown the way they were written when the cohort was first used.
 */

export interface CohortMeta {
  /** The name as it was written the first time it was used. */
  name: string;
  /** ISO time of the first use. */
  created: string;
  note?: string;
  /** The tasks that were all done (had a report) when "all reports ready" was announced; announced again only when a task joins. */
  announced?: string[];
}

export function cohortsDir(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(path.dirname(config.path), 'cohorts');
}

const metaFile = (config: Pick<GlobalConfig, 'path'>, name: string): string => path.join(cohortsDir(config), `${cohortKey(name)}.json`);

function parseMeta(text: string): CohortMeta | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(data) || typeof data.name !== 'string' || typeof data.created !== 'string') return undefined;
  const meta: CohortMeta = { name: data.name, created: data.created };
  if (typeof data.note === 'string' && data.note !== '') meta.note = data.note;
  if (Array.isArray(data.announced)) meta.announced = data.announced.filter((x): x is string => typeof x === 'string');
  return meta;
}

export function readCohort(config: Pick<GlobalConfig, 'path'>, name: string): CohortMeta | undefined {
  try {
    return parseMeta(fs.readFileSync(metaFile(config, name), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Every cohort that has a metadata file, by name. */
export function listCohorts(config: Pick<GlobalConfig, 'path'>): CohortMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(cohortsDir(config));
  } catch {
    return [];
  }
  const metas: CohortMeta[] = [];
  for (const file of names.sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const meta = parseMeta(fs.readFileSync(path.join(cohortsDir(config), file), 'utf8'));
      if (meta) metas.push(meta);
    } catch {
      // removed between the listing and the read
    }
  }
  return metas.sort((a, b) => cohortKey(a.name).localeCompare(cohortKey(b.name)));
}

async function saveCohort(ctx: Context, meta: CohortMeta): Promise<void> {
  await ctx.runner.writeFile(metaFile(ctx.config, meta.name), `${JSON.stringify(meta, null, 2)}\n`);
}

/** The cohort for a name that is about to be used: made when it is new (that is the only way a cohort comes to be), else the one that exists, with its own spelling. */
export async function touchCohort(ctx: Context, name: string): Promise<CohortMeta> {
  const problem = cohortNameProblem(name);
  if (problem) throw new AgentctlError(problem);
  const known = readCohort(ctx.config, name);
  if (known) return known;
  const meta: CohortMeta = { name: name.normalize('NFC'), created: new Date(ctx.runner.now()).toISOString() };
  await saveCohort(ctx, meta);
  return meta;
}

/**
 * The cohort a person means by a name (any case): an error naming the known ones when there is none. A name that is used by a task but has no
 * file (the file was deleted) still counts, spelled the way the task has it.
 */
export function findCohort(config: GlobalConfig, input: string): CohortMeta {
  const problem = cohortNameProblem(input);
  if (problem) throw new AgentctlError(problem);
  const known = readCohort(config, input);
  if (known) return known;
  const used = [...listTaskRecords(config), ...listArchivedRecords(config)].find((r) => r.cohort && cohortKey(r.cohort) === cohortKey(input));
  if (used?.cohort) return { name: used.cohort, created: '' };
  const names = listCohorts(config).map((c) => c.name);
  throw new AgentctlError(`no cohort "${input}"`, names.length > 0 ? `Cohorts: ${names.join(', ')}. "agentctl cohort list" shows them.` : 'There are no cohorts yet: a task joins one with "cohort: <name>" in its spec or --cohort <name>.');
}

export const inCohort = (cohort: string | null | undefined, key: string): boolean => cohort !== null && cohort !== undefined && cohortKey(cohort) === key;

/** The status rows of a cohort (every state, closed and cancelled ones too). */
export const cohortRows = (rows: readonly StatusRow[], name: string): StatusRow[] => rows.filter((r) => inCohort(r.cohort, cohortKey(name)));

/** The queue entries of a cohort. */
export const cohortEntries = (entries: readonly QueueEntry[], name: string): QueueEntry[] => entries.filter((e) => inCohort(e.cohort, cohortKey(name)));

/**
 * The tasks of a cohort that `close --cohort` and `cancel --cohort` act on: the ones that are not closed or cancelled yet. `queued`
 * adds the tasks that wait in the queue (cancel takes them out; close has no window to close).
 */
export async function openCohortTasks(ctx: Context, name: string, opts: { queued: boolean }): Promise<string[]> {
  const rows = await collectStatus(ctx, { progress: false });
  const live = cohortRows(rows, name).filter((r) => !r.closed && !r.cancelled);
  const queued = opts.queued ? cohortEntries(readQueue(ctx.config), name).filter((e) => !live.some((r) => r.task === e.task)) : [];
  return [...live.map((r) => r.task), ...queued.map((e) => e.task)];
}

// ---- counting

export interface CohortCounts {
  /** Work in progress: a window that is not done, or no window and no report. */
  active: number;
  /** Waiting in the queue (blocked and failed ones too). */
  queued: number;
  /** Reports ready. */
  reports: number;
  closed: number;
  cancelled: number;
  total: number;
}

export function countCohort(rows: readonly StatusRow[], entries: readonly QueueEntry[]): CohortCounts {
  const c: CohortCounts = { active: 0, queued: entries.length, reports: 0, closed: 0, cancelled: 0, total: rows.length + entries.length };
  for (const r of rows) {
    if (r.cancelled) c.cancelled++;
    else if (r.closed) c.closed++;
    else if (r.state === 'report-ready') c.reports++;
    else c.active++;
  }
  return c;
}

export interface CohortSummary extends CohortCounts {
  name: string;
  /** ISO time of the first use; '' when unknown. */
  created: string;
  note: string | null;
}

/** Every cohort with the counts of its tasks. A cohort that tasks use but that has no file is listed too. */
export async function summarizeCohorts(ctx: Context): Promise<CohortSummary[]> {
  const rows = await collectStatus(ctx, { progress: false, archived: true });
  const entries = readQueue(ctx.config);
  const metas = new Map(listCohorts(ctx.config).map((m) => [cohortKey(m.name), m] as const));
  for (const name of [...rows.map((r) => r.cohort), ...entries.map((e) => e.cohort)]) {
    if (name && !metas.has(cohortKey(name))) metas.set(cohortKey(name), { name, created: '' });
  }
  return [...metas.values()]
    .sort((a, b) => cohortKey(a.name).localeCompare(cohortKey(b.name)))
    .map((m) => ({ name: m.name, created: m.created, note: m.note ?? null, ...countCohort(cohortRows(rows, m.name), cohortEntries(entries, m.name)) }));
}

// ---- changing the membership of existing tasks

export interface MembershipChange {
  task: string;
  /** The cohort it was in before; null when none. */
  was: string | null;
}

/** Put existing tasks (running, finished or queued) into a cohort, or (`cohort` undefined) take them out of theirs. */
export async function setCohortOf(ctx: Context, inputs: string[], cohort: CohortMeta | undefined): Promise<MembershipChange[]> {
  const { config, runner } = ctx;
  const records = listTaskRecords(config);
  const entries = readQueue(config);
  const known = [...new Map([...records.map((r) => [r.task, r.task] as const), ...entries.map((e) => [e.task, e.task] as const)]).values()];
  const changes: MembershipChange[] = [];
  const problems: string[] = [];
  const found: string[] = [];
  for (const input of inputs) {
    const wanted = input.trim().toLowerCase();
    const exact = known.filter((t) => t.toLowerCase() === wanted);
    const hits = exact.length > 0 ? exact : known.filter((t) => wanted !== '' && t.toLowerCase().startsWith(wanted));
    if (hits.length === 1) found.push(hits[0] as string);
    else if (hits.length > 1) problems.push(`"${input}" fits more than one task: ${hits.join(', ')}`);
    else if (listArchivedRecords(config).some((r) => r.task.toLowerCase() === wanted)) problems.push(`${input} is archived: its state is out of reach of agentctl`);
    else problems.push(`no task "${input}"`);
  }
  if (problems.length > 0) throw new AgentctlError(`Cannot change the cohort:\n${problems.map((p) => `  - ${p}`).join('\n')}`, 'See "agentctl status --all" and "agentctl queue list".');
  for (const task of [...new Set(found)]) {
    const record = records.find((r) => r.task === task);
    const entry = entries.find((e) => e.task === task);
    const was = record?.cohort ?? entry?.cohort ?? null;
    if (record) await setHeaderField(runner, taskFile(config, record.window), 'cohort', cohort ? cohort.name : null);
    if (entry) {
      const { cohort: _drop, ...rest } = entry;
      const raw = splitSpecs(entry.spec, `queue entry ${entry.task}`)[0] as RawSpec;
      if (cohort) raw.header.cohort = cohort.name;
      else delete raw.header.cohort;
      await saveEntry(ctx, { ...rest, ...(cohort ? { cohort: cohort.name } : {}), spec: renderRawSpec(raw) });
    }
    changes.push({ task, was });
  }
  return changes;
}

export async function setNote(ctx: Context, name: string, note: string): Promise<CohortMeta> {
  const meta = findCohort(ctx.config, name);
  const { note: _old, ...rest } = meta;
  const updated: CohortMeta = { ...rest, created: meta.created || new Date(ctx.runner.now()).toISOString(), ...(note.trim() !== '' ? { note: note.trim() } : {}) };
  await saveCohort(ctx, updated);
  return updated;
}

// ---- rendering

export function renderCohortList(list: readonly CohortSummary[]): string[] {
  if (list.length === 0) return ['No cohorts. A task joins one with "cohort: <name>" in its spec, or --cohort <name>.'];
  const header = ['COHORT', 'ACTIVE', 'QUEUED', 'REPORTS', 'CLOSED', 'CANCELLED', 'SINCE'];
  const body = list.map((c) => [c.name, String(c.active), String(c.queued), String(c.reports), String(c.closed), String(c.cancelled), c.created ? c.created.slice(0, 16).replace('T', ' ') : '-']);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt), ...list.filter((c) => c.note).map((c) => `${c.name}: ${c.note}`)];
}

/** "2⚙ 1✓ 1⧗" for the header of a group on the board: tasks per state, queued ones last. */
export function countsLine(rows: readonly StatusRow[], queued: number, icons: Record<string, string>): string {
  const order = ['working', 'background', 'waiting', 'needs-input', 'needs-trust', 'limited', 'report-ready', 'superseded', 'orphan', 'dead'];
  const counts = new Map<string, number>();
  for (const r of rows) if (!r.closed && !r.cancelled) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const parts = order.filter((s) => counts.has(s)).map((s) => `${counts.get(s)}${icons[s] ?? s}`);
  if (queued > 0) parts.push(`${queued}⧗`);
  return parts.join(' ');
}

// ---- watch: all reports ready

/** The task IDs that count for "all reports ready": everything in the cohort that is not cancelled, and not an old window replaced by a move. */
function counted(rows: readonly StatusRow[], entries: readonly QueueEntry[], name: string): { done: string[]; open: string[] } {
  const mine = cohortRows(rows, name).filter((r) => !r.cancelled && r.state !== 'superseded');
  return {
    done: mine.filter((r) => hasReport(r)).map((r) => r.task),
    open: [...mine.filter((r) => !hasReport(r)).map((r) => r.task), ...cohortEntries(entries, name).map((e) => e.task)],
  };
}

export const cohortDoneText = (name: string, n: number): string => `kohorta ${name}: wszystkie raporty gotowe (${n})`;

/**
 * Once per cohort: when every task of the cohort that was not cancelled has a report, "kohorta <nazwa>: wszystkie raporty gotowe (N)".
 * The cohort file remembers which tasks that covered; it speaks again only when a task joined since. Returns the texts announced.
 */
export async function cohortTick(ctx: Context, notifier: Notifier, rows: readonly StatusRow[], log?: (line: string) => Promise<void> | void): Promise<string[]> {
  const entries = readQueue(ctx.config);
  const said: string[] = [];
  for (const meta of listCohorts(ctx.config)) {
    const { done, open } = counted(rows, entries, meta.name);
    if (done.length === 0 || open.length > 0) continue;
    const announced = new Set(meta.announced ?? []);
    if (done.every((t) => announced.has(t))) continue;
    const text = cohortDoneText(meta.name, done.length);
    await saveCohort(ctx, { ...meta, announced: [...done].sort() });
    await log?.(`cohort: ${text}`);
    await notifier.notify('agentctl', text, { group: `agentctl-cohort-${cohortKey(meta.name)}` }).catch(() => undefined);
    said.push(text);
  }
  return said;
}
