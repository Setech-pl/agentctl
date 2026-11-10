import { packageVersion } from './version.ts';
import { inspectReport } from './report-state.ts';
import fs from 'node:fs';
import path from 'node:path';
import { parseAge } from './archive.ts';
import type { Context } from './context.ts';
import type { Order } from './equivalents.ts';
import { taskProgress } from './progress.ts';
import { resolveTask } from './resolve.ts';
import { readTaskRecordById, type TaskRecord } from './taskstore.ts';
import { collectTaskUsage, openReader, allRecords, taskTokenMap } from './usage.ts';
import { homeDir } from './usage-sources.ts';
import { formatTokens } from './usage-parse.ts';
import { readVerdict } from './verdict.ts';
import { AgentctlError, cohortKey, formatDuration, formatLocalTime, isObject } from './util.ts';

/*
 * The history of the tasks: `<AGENTCTL_HOME>/history.jsonl`, one JSON object per line, appended when a report is ready, when a task is
 * closed or cancelled or moved, and when a result is marked. It is what `log` and `stats` read, to see which model and effort work for what.
 * Nothing in it is a guess: a number that was not available is null.
 */

export const RESULTS = ['ok', 'partial', 'fail'] as const;
export type Result = (typeof RESULTS)[number];
export type HistoryEvent = 'report' | 'closed' | 'cancelled' | 'moved' | 'mark';

export interface HistoryTokens {
  input: number;
  reasoning_output_tokens?: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cache writes: the number `usage` and `status` show. */
  fresh: number;
}

export interface HistoryRecord {
  v: 1;
  attempt_id?: string;
  attempt?: number;
  attempt_started?: string;
  review_of?: string;
  agentctl_version?: string;
  event: HistoryEvent;
  /** ISO time of the event. */
  at: string;
  task: string;
  cohort: string | null;
  /** The repository the task worked in (the folder name of its first repository). */
  project: string | null;
  requested: Order | null;
  effective: Order | null;
  resolved?: Order | null;
  observed?: { model: string; effort: string };
  agent_cli_version?: string;
  observation_warning?: string | null;
  self_verdict?: string | null;
  started: string | null;
  /** ISO time the report was last written; null without a report. */
  reportAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** From the start of the task to its report (else to the close or cancel). */
  durationMs: number | null;
  tokens: HistoryTokens | null;
  /** Commits over the base and changed files at the time of the event; null when git could not tell. */
  progress: { commits: number | null; files: number } | null;
  /** The first line of the verdict of the report. */
  verdict: string | null;
  /** The task this one continues, and the one it was moved to (after a limit). */
  movedFrom: string | null;
  movedTo: string | null;
  /** Set by `mark` (the last mark of a task wins). */
  result: Result | null;
  note: string | null;
}

export const historyPath = (config: { path: string }): string => path.join(homeDir(config), 'history.jsonl');

const orderOf = (agent: string, model: string, effort: string): Order | null => (agent === 'unknown' ? null : ({ agent, model, effort } as Order));

/** Watch observations sample usage/git; close, cancel and mark reuse their persisted facts without scanning worktrees. */
export async function snapshot(ctx: Context, record: TaskRecord, event: HistoryEvent, extra: Partial<HistoryRecord> = {}): Promise<HistoryRecord> {
  const { config, runner } = ctx;
  const now = runner.now();
  const started = Date.parse(record.started);
  let reportMs: number | null = null;
  try {
    const mtime = record.report ? fs.statSync(record.report).mtimeMs : NaN;
    if (inspectReport(config, record, now, !record.attemptId).ready && !Number.isNaN(mtime)) reportMs = Math.floor(mtime);
  } catch {
    reportMs = null;
  }
  const endMs = reportMs ?? (event === 'closed' && record.closedAt ? Date.parse(record.closedAt) : event === 'cancelled' && record.cancelledAt ? Date.parse(record.cancelledAt) : now);
  const cached = ['closed', 'cancelled', 'mark'].includes(event);
  const previous = cached ? readHistory(config).findLast(h => h.task === record.task && h.started === record.started && h.attempt_id === record.attemptId) : undefined;
  const tokens = cached ? undefined : taskTokenMap(config, now, allRecords(config)).get(record.task);
  let progress: HistoryRecord['progress'] = null;
  if (cached) {
    try { const p = JSON.parse(fs.readFileSync(path.join(config.stateDir, record.window, 'progress.json'), 'utf8')); if (p) progress = { commits: p.commits, files: p.files }; } catch { progress = previous?.progress ?? null; }
  } else if (record.repos.length > 0) {
    const p = await taskProgress(runner, record.repos).catch(() => null);
    if (p) progress = { commits: p.commits, files: p.files };
  }
  const usage = cached ? undefined : collectTaskUsage(config, openReader(config), allRecords(config), now).get(record.task);
  const verdict = record.report ? readVerdict(record.report, config.notify.verdictPattern, record.reviewOf != null) : undefined;
  return {
    v: 1,
    agentctl_version: packageVersion(),
    attempt_id: record.attemptId,
    attempt: record.attempt,
    attempt_started: record.attemptStarted,
    review_of: record.reviewOf,
    event,
    at: new Date(now).toISOString(),
    task: record.task,
    cohort: record.cohort ?? null,
    project: record.repos[0] ? path.basename(record.repos[0].path) : null,
    requested: record.requested,
    resolved: orderOf(record.agent, record.model, record.effort),
    observed: { model: usage?.observed?.model ?? previous?.observed?.model ?? record.observed?.model ?? 'unknown', effort: usage?.observed?.effort ?? previous?.observed?.effort ?? record.observed?.effort ?? 'unknown' },
    agent_cli_version: usage?.observed?.cliVersion && usage.observed.cliVersion !== 'unknown' ? usage.observed.cliVersion : record.agentCliVersion ?? previous?.agent_cli_version ?? 'unknown',
    observation_warning: usage?.warning ?? previous?.observation_warning ?? null,
    self_verdict: selfVerdict(record.report),
    effective: orderOf(record.agent, record.model, record.effort),
    started: Number.isNaN(started) ? null : record.started,
    reportAt: reportMs === null ? null : new Date(reportMs).toISOString(),
    closedAt: record.closedAt ?? null,
    cancelledAt: record.cancelledAt ?? null,
    cancelReason: record.cancelReason ?? null,
    durationMs: Number.isNaN(started) || Number.isNaN(endMs) ? null : Math.max(0, endMs - started),
    tokens: tokens ? { ...tokens.tokens, fresh: tokens.fresh } : previous?.tokens ?? null,
    progress,
    verdict: verdict ?? null,
    movedFrom: record.continues ?? null,
    movedTo: record.supersededBy ?? null,
    result: null,
    note: null,
    ...extra,
  };
}

export function readHistory(config: { path: string }): HistoryRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(historyPath(config), 'utf8');
  } catch {
    return [];
  }
  const out: HistoryRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o: unknown = JSON.parse(line);
      if (isObject(o) && o.v === 1 && typeof o.task === 'string' && typeof o.event === 'string' && typeof o.at === 'string') out.push(o as unknown as HistoryRecord);
    } catch {
      // a half-written line: skipped
    }
  }
  return out;
}

/**
 * Add the record of `event` for the task. Never throws (the history must not break a close or a cancel) and writes nothing in a dry run.
 * A second `report` record for the same report (the watcher and the agent's own event both see it) is not written.
 */
export async function recordEvent(ctx: Context, record: TaskRecord, event: Exclude<HistoryEvent, 'mark'>, extra: Partial<HistoryRecord> = {}): Promise<HistoryRecord | undefined> {
  if (ctx.runner.dryRun) return undefined;
  try {
    const entry = await snapshot(ctx, record, event, extra);
    if (event === 'report') {
      if (entry.reportAt === null) return undefined;
      if (readHistory(ctx.config).some((h) => h.event === 'report' && h.task === entry.task && h.reportAt === entry.reportAt)) return undefined;
    }
    await ctx.runner.appendFile(historyPath(ctx.config), `${JSON.stringify(entry)}\n`);
    return entry;
  } catch {
    return undefined;
  }
}

// ---- mark

export function parseResult(text: string): Result {
  const t = text.trim().toLowerCase();
  if ((RESULTS as readonly string[]).includes(t)) return t as Result;
  throw new AgentctlError(`"${text}" is not a result`, `Use one of: ${RESULTS.join(', ')}.`);
}

/** `agentctl mark <task> ok|partial|fail`: the outcome of a task as you judge it, for `log` and `stats`. The last mark wins. */
export async function markTask(ctx: Context, taskArg: string, result: Result, note?: string): Promise<{ task: string; result: Result; previous: Result | null }> {
  const task = await resolveTask(ctx, taskArg);
  const record = readTaskRecordById(ctx.config, task);
  if (!record) throw new AgentctlError(`${task} has no state file, so its model and effort are unknown`, 'Only tasks agentctl started can be marked.');
  const previous = [...readHistory(ctx.config)].reverse().find((h) => h.event === 'mark' && h.task === task)?.result ?? null;
  const entry = await snapshot(ctx, record, 'mark', { result, note: note && note.trim() !== '' ? note.trim() : null });
  await ctx.runner.appendFile(historyPath(ctx.config), `${JSON.stringify(entry)}\n`);
  return { task, result, previous };
}

// ---- folding: one row per task

export interface TaskHistory {
  task: string;
  cohort: string | null;
  project: string | null;
  requested: Order | null;
  effective: Order | null;
  resolved?: Order | null;
  observed?: { model: string; effort: string };
  agent_cli_version?: string;
  observation_warning?: string | null;
  self_verdict?: string | null;
  started: string | null;
  /** The newest event of the task, and what ended it. */
  at: string;
  end: 'report' | 'closed' | 'cancelled' | 'moved' | 'mark';
  reportAt: string | null;
  cancelReason: string | null;
  durationMs: number | null;
  tokens: HistoryTokens | null;
  progress: HistoryRecord['progress'];
  verdict: string | null;
  movedFrom: string | null;
  movedTo: string | null;
  result: Result | null;
  note: string | null;
  cancelled: boolean;
}

const RANK: Record<HistoryEvent, number> = { mark: 0, moved: 1, report: 2, closed: 3, cancelled: 4 };

/** The records of each task folded into one row: the newest values win, a null never wipes a value that was known; the last mark gives the result. */
export function foldHistory(records: readonly HistoryRecord[]): TaskHistory[] {
  const rows = new Map<string, TaskHistory>();
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const r of sorted) {
    const prev = rows.get(r.task);
    const pick = <T>(next: T | null | undefined, old: T | null | undefined): T | null => (next ?? old ?? null);
    const row: TaskHistory = {
      task: r.task,
      cohort: pick(r.cohort, prev?.cohort),
      project: pick(r.project, prev?.project),
      requested: pick(r.requested, prev?.requested),
      effective: pick(r.effective, prev?.effective),
      resolved: pick(r.resolved, prev?.resolved),
      observed: r.observed ?? prev?.observed ?? { model: 'unknown', effort: 'unknown' },
      observation_warning: pick(r.observation_warning, prev?.observation_warning),
      agent_cli_version: r.agent_cli_version ?? prev?.agent_cli_version ?? 'unknown',
      self_verdict: pick(r.self_verdict, prev?.self_verdict),
      started: pick(r.started, prev?.started),
      at: r.at,
      end: prev && RANK[prev.end] > RANK[r.event] ? prev.end : r.event,
      reportAt: pick(r.reportAt, prev?.reportAt),
      cancelReason: pick(r.cancelReason, prev?.cancelReason),
      durationMs: pick(r.durationMs, prev?.durationMs),
      tokens: pick(r.tokens, prev?.tokens),
      progress: pick(r.progress, prev?.progress),
      verdict: pick(r.verdict, prev?.verdict),
      movedFrom: pick(r.movedFrom, prev?.movedFrom),
      movedTo: pick(r.movedTo, prev?.movedTo),
      result: r.event === 'mark' ? r.result : (prev?.result ?? null),
      note: r.event === 'mark' ? r.note : (prev?.note ?? null),
      cancelled: Boolean(prev?.cancelled) || r.event === 'cancelled',
    };
    rows.set(r.task, row);
  }
  return [...rows.values()];
}

export interface HistoryFilter {
  since?: string | undefined;
  cohort?: string | undefined;
}

/** The folded rows in the filter, newest first. `since` is an age ("30d"): the newest event of the task is within it. */
export function selectHistory(ctx: Context, filter: HistoryFilter = {}): TaskHistory[] {
  const cutoff = filter.since === undefined ? -Infinity : ctx.runner.now() - parseAge(filter.since);
  const wanted = filter.cohort === undefined ? undefined : cohortKey(filter.cohort);
  return foldHistory(readHistory(ctx.config))
    .filter((t) => Date.parse(t.at) >= cutoff && (wanted === undefined || (t.cohort !== null && cohortKey(t.cohort) === wanted)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ---- log

const orderText = (o: Order | null): string => (o ? `${o.agent}/${o.model}/${o.effort}` : 'unknown');
const tokensText = (t: HistoryTokens | null): string => (t ? formatTokens(t.fresh) : 'n/d');
const durationText = (ms: number | null): string => (ms === null ? '-' : formatDuration(ms));
const endText = (t: TaskHistory): string => (t.cancelled ? 'cancelled' : t.end === 'mark' || t.end === 'moved' ? (t.reportAt ? 'report' : 'open') : t.end);
const progressText = (p: HistoryRecord['progress']): string => (p ? `${p.commits ?? '?'}c ${p.files}f` : '-');

function columns(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)];
}

/** The lines of `agentctl log`. */
export function renderLog(rows: readonly TaskHistory[]): string[] {
  if (rows.length === 0) return ['No history yet: a record is written when a report is ready and when a task is closed, cancelled or marked.'];
  const cohort = rows.some((r) => r.cohort !== null);
  const header = ['WHEN', 'TASK', ...(cohort ? ['COHORT'] : []), 'AGENT/MODEL/EFFORT', 'END', 'TIME', 'TOKENS', 'PROGRESS', 'RESULT', 'VERDICT'];
  const body = rows.map((t) => [
    formatLocalTime(t.at),
    t.task,
    ...(cohort ? [t.cohort ?? '-'] : []),
    orderText(t.effective),
    endText(t),
    durationText(t.durationMs),
    tokensText(t.tokens),
    progressText(t.progress),
    t.result ?? '-',
    t.cancelled ? (t.cancelReason ?? '-') : (t.verdict ?? '-'),
  ]);
  return columns(header, body);
}

export function logMarkdown(rows: readonly TaskHistory[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const lines = ['| when | task | agent/model/effort | end | time | tokens | result | verdict |', '|---|---|---|---|---|---|---|---|'];
  for (const t of rows) lines.push(`| ${formatLocalTime(t.at)} | ${t.task} | ${orderText(t.effective)} | ${endText(t)} | ${durationText(t.durationMs)} | ${tokensText(t.tokens)} | ${t.result ?? '-'} | ${cell(t.verdict ?? '-')} |`);
  return `${lines.join('\n')}\n`;
}

// ---- stats

export interface StatsGroup {
  agent: string;
  model: string;
  effort: string;
  /** Tasks that were not cancelled. */
  tasks: number;
  cancelled: number;
  medianDurationMs: number | null;
  medianTokens: number | null;
  ok: number;
  partial: number;
  fail: number;
  /** Tasks that were not marked. */
  unmarked: number;
  self_verdicts: Record<string, number>;
  reasoning_output_tokens: number;
  /** Tasks of the group that were moved to the other provider after a limit. */
  moved: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Tasks grouped by the agent, model and effort they ran on. */
export function computeStats(rows: readonly TaskHistory[]): StatsGroup[] {
  const groups = new Map<string, { group: StatsGroup; durations: number[]; tokens: number[] }>();
  for (const t of rows) {
    const o = t.effective;
    const key = o ? `${o.agent}/${o.model}/${o.effort}` : 'unknown/unknown/unknown';
    let g = groups.get(key);
    if (!g) {
      g = { group: { agent: o?.agent ?? 'unknown', model: o?.model ?? 'unknown', effort: o?.effort ?? 'unknown', tasks: 0, cancelled: 0, medianDurationMs: null, medianTokens: null, ok: 0, partial: 0, fail: 0, unmarked: 0, self_verdicts: {}, reasoning_output_tokens: 0, moved: 0 }, durations: [], tokens: [] };
      groups.set(key, g);
    }
    if (t.movedTo !== null) g.group.moved++;
    if (t.cancelled) {
      g.group.cancelled++;
      continue;
    }
    g.group.tasks++;
    const verdict = t.self_verdict ?? 'unknown';
    g.group.self_verdicts[verdict] = (g.group.self_verdicts[verdict] ?? 0) + 1;
    g.group.reasoning_output_tokens += t.tokens?.reasoning_output_tokens ?? 0;
    if (t.durationMs !== null) g.durations.push(t.durationMs);
    if (t.tokens !== null) g.tokens.push(t.tokens.fresh);
    if (t.result) g.group[t.result]++;
    else g.group.unmarked++;
  }
  return [...groups.values()]
    .map(({ group, durations, tokens }) => ({ ...group, medianDurationMs: median(durations), medianTokens: median(tokens) }))
    .sort((a, b) => b.tasks + b.cancelled - (a.tasks + a.cancelled) || `${a.agent}/${a.model}/${a.effort}`.localeCompare(`${b.agent}/${b.model}/${b.effort}`));
}

const pct = (n: number, of: number): string => (of === 0 ? '-' : `${Math.round((100 * n) / of)}%`);

/** The lines of `agentctl stats`: the share of ok, partial and fail is of the tasks that were marked. */
export function renderStats(groups: readonly StatsGroup[]): string[] {
  if (groups.length === 0) return ['No history yet: a record is written when a report is ready and when a task is closed, cancelled or marked.'];
  const header = ['AGENT/MODEL/EFFORT', 'TASKS', 'MEDIAN TIME', 'MEDIAN TOKENS', 'OK', 'PARTIAL', 'FAIL', 'UNMARKED', 'CANCELLED', 'MOVED', 'SELF_VERDICTS', 'REASONING_OUT'];
  const body = groups.map((g) => {
    const marked = g.ok + g.partial + g.fail;
    return [`${g.agent}/${g.model}/${g.effort}`, String(g.tasks), durationText(g.medianDurationMs), g.medianTokens === null ? 'n/d' : formatTokens(g.medianTokens), pct(g.ok, marked), pct(g.partial, marked), pct(g.fail, marked), String(g.unmarked), String(g.cancelled), String(g.moved), JSON.stringify(g.self_verdicts), String(g.reasoning_output_tokens)];
  });
  return [...columns(header, body), 'OK, PARTIAL and FAIL are shares of the marked tasks (agentctl mark); MOVED: tasks handed to the other provider after a usage limit.'];
}

export function statsMarkdown(groups: readonly StatsGroup[]): string {
  const lines = ['| agent/model/effort | tasks | median time | median tokens | ok | partial | fail | unmarked | cancelled | moved | self_verdicts | reasoning_output_tokens |', '|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const g of groups) {
    const marked = g.ok + g.partial + g.fail;
    lines.push(`| ${g.agent}/${g.model}/${g.effort} | ${g.tasks} | ${durationText(g.medianDurationMs)} | ${g.medianTokens === null ? 'n/d' : formatTokens(g.medianTokens)} | ${pct(g.ok, marked)} | ${pct(g.partial, marked)} | ${pct(g.fail, marked)} | ${g.unmarked} | ${g.cancelled} | ${g.moved} | ${JSON.stringify(g.self_verdicts)} | ${g.reasoning_output_tokens} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** The lines of the board's log view: one task per line, newest first. */
export function logLines(ctx: Context, filter: HistoryFilter = {}): string[] {
  return renderLog(selectHistory(ctx, filter));
}

/** Agent's self assessment is separate from the human mark. Only the first nonempty line qualifies. */
export function selfVerdict(file: string): string | null {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n').find(l => l.trim());
    return /^Werdykt:\s*([\w-]+)/i.exec(first?.trim() ?? '')?.[1]?.toUpperCase() ?? null;
  } catch { return null; }
}
