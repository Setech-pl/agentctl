import { parseAge } from './archive.ts';
import { AGENT_NAMES } from './config.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { allRecords, collectTaskUsage, formatReset, hhmm, openReader, readPlans } from './usage.ts';
import type { PlanState, TaskUsage } from './usage.ts';
import type { UsageReader } from './usage-sources.ts';
import { addTokens, formatTokens, freshTokens, localDay, sumBuckets, zeroTokens } from './usage-parse.ts';
import type { PlanWindow, Tokens } from './usage-parse.ts';
import { cohortKey } from './util.ts';

const fresh = (t: Tokens): string => formatTokens(freshTokens(t));

// ---- the report

export interface ProviderUsage {
  provider: AgentName;
  today: Tokens;
  /** Since the cut-off (`--since`, default 7d). */
  window: Tokens;
  byModel: Record<string, Tokens>;
  byDay: Record<string, Tokens>;
}

export interface TaskUsageRow {
  task: string;
  agent: string;
  model: string;
  cohort: string | null;
  state: string;
  active: boolean;
  sessions: number;
  tokens: Tokens;
  /** In the window of the report; `tokens` are in it too. */
  fresh: number;
  /** null: no session log found. */
  known: boolean;
}

export interface CohortUsage {
  cohort: string;
  tasks: number;
  tokens: Tokens;
  fresh: number;
}

export interface UsageReport {
  now: number;
  /** The cut-off as asked ("7d"), and the first day counted. */
  since: string;
  sinceDay: string;
  today: string;
  plans: Record<AgentName, PlanState>;
  providers: Record<AgentName, ProviderUsage>;
  tasks: TaskUsageRow[];
  cohorts: CohortUsage[];
}

const ACTIVE = new Set(['overloaded', 'report-candidate', 'working', 'background', 'waiting', 'needs-input', 'needs-trust', 'limited', 'report-ready']);

export interface UsageOptions {
  cohort?: string | undefined;
  /** "7d", "12h", "2w": tokens of the days since then (whole local days). */
  since?: string | undefined;
  reader?: UsageReader | undefined;
  rows?: StatusRow[] | undefined;
}

export async function collectUsage(ctx: Context, opts: UsageOptions = {}): Promise<UsageReport> {
  const { config } = ctx;
  const now = ctx.runner.now();
  const since = opts.since ?? '7d';
  const sinceDay = localDay(now - parseAge(since));
  const today = localDay(now);
  const reader = opts.reader ?? openReader(config);
  const records = allRecords(config);
  const usage = collectTaskUsage(config, reader, records, now);
  const rows = new Map((opts.rows ?? (await collectStatus(ctx, { progress: false, archived: true }))).map((r) => [r.task, r] as const));
  const plans = readPlans(config, reader, now);
  reader.save();

  const providers = {} as Record<AgentName, ProviderUsage>;
  for (const p of AGENT_NAMES) providers[p] = { provider: p, today: zeroTokens(), window: zeroTokens(), byModel: {}, byDay: {} };
  const wanted = opts.cohort === undefined ? undefined : cohortKey(opts.cohort);
  const tasks: TaskUsageRow[] = [];
  const cohorts = new Map<string, CohortUsage>();
  for (const record of records) {
    if (wanted !== undefined && (record.cohort === undefined || cohortKey(record.cohort) !== wanted)) continue;
    const u = usage.get(record.task) as TaskUsage;
    const inWindow = sumBuckets(u.buckets, { sinceDay });
    const row = rows.get(record.task);
    const provider = record.agent === 'unknown' ? undefined : providers[record.agent];
    if (provider) {
      for (const [key, t] of Object.entries(u.buckets)) {
        const [day = '', model = ''] = key.split('|');
        if (day < sinceDay) continue;
        provider.window = addTokens(provider.window, t);
        provider.byModel[model] = addTokens(provider.byModel[model] ?? zeroTokens(), t);
        provider.byDay[day] = addTokens(provider.byDay[day] ?? zeroTokens(), t);
        if (day === today) provider.today = addTokens(provider.today, t);
      }
    }
    const state = row?.state ?? 'unknown';
    const known = u.sessions > 0;
    // A task that neither worked in the window nor holds a window of its own is not listed.
    const active = row ? ACTIVE.has(row.state) && !row.closed && !row.cancelled && row.window === 'alive' : false;
    if (known && freshTokens(inWindow) === 0 && !active) continue;
    tasks.push({ task: record.task, agent: record.agent, model: record.model, cohort: record.cohort ?? null, state, active, sessions: u.sessions, tokens: inWindow, fresh: freshTokens(inWindow), known });
    if (record.cohort !== undefined && known) {
      const c = cohorts.get(cohortKey(record.cohort)) ?? { cohort: record.cohort, tasks: 0, tokens: zeroTokens(), fresh: 0 };
      c.tasks++;
      c.tokens = addTokens(c.tokens, inWindow);
      c.fresh = freshTokens(c.tokens);
      cohorts.set(cohortKey(record.cohort), c);
    }
  }
  tasks.sort((a, b) => Number(b.active) - Number(a.active) || b.fresh - a.fresh || a.task.localeCompare(b.task));
  return { now, since, sinceDay, today, plans, providers, tasks, cohorts: [...cohorts.values()].sort((a, b) => b.fresh - a.fresh || a.cohort.localeCompare(b.cohort)) };
}

// ---- text


/** "62% ↻ 14:30", or "n/d". */
export function windowText(state: PlanState, kind: PlanWindow['kind'], now: number): string {
  const w = state.windows.find((x) => x.kind === kind);
  if (!w) return 'n/d';
  return `${Math.round(w.usedPercent)}%${w.resetsAt === null ? '' : ` ↻ ${formatReset(w.resetsAt, now)}`}`;
}

/** "5h 62% ↻ 14:30 · week 41% ↻ Sun 18:00", or "n/d (why)". */
export function planLine(state: PlanState, now: number): string {
  if (!state.available) return `n/d${state.note ? ` (${state.note})` : ''}`;
  const parts = state.windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%${w.resetsAt === null ? '' : ` ↻ ${formatReset(w.resetsAt, now)}`}`);
  return `${parts.join(' · ')}${state.stale && state.readAt !== null ? ` (read ${hhmm(state.readAt)})` : ''}`;
}

/** Columns of a table, left-aligned with two spaces between. */
export function table(header: string[], body: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)];
}

/** The lines of `agentctl usage`. */
export function renderUsage(report: UsageReport): string[] {
  const lines: string[] = [];
  const n = report.now;
  const hasWeek = AGENT_NAMES.some((p) => report.plans[p].windows.some((w) => w.kind === 'week'));
  const header = ['PROVIDER', '5H LIMIT', ...(hasWeek ? ['WEEK LIMIT'] : []), 'TODAY', report.since.toUpperCase()];
  const body = AGENT_NAMES.map((p) => [p, windowText(report.plans[p], 'session', n), ...(hasWeek ? [windowText(report.plans[p], 'week', n)] : []), fresh(report.providers[p].today), fresh(report.providers[p].window)]);
  lines.push(...table(header, body));
  for (const p of AGENT_NAMES) {
    const s = report.plans[p];
    const others = s.windows.filter((w) => w.kind === 'other');
    if (others.length > 0) lines.push(`${p}: ${others.map((w) => `${w.label} ${Math.round(w.usedPercent)}%${w.resetsAt === null ? '' : ` ↻ ${formatReset(w.resetsAt, n)}`}`).join(' · ')}`);
    if (!s.available) lines.push(`${p}: limit n/d – ${s.note}`);
    else if (s.stale && s.readAt !== null) lines.push(`${p}: plan read ${hhmm(s.readAt)} – may be out of date`);
  }
  lines.push('Tokens = input + output + cache writes of the tasks agentctl started (cache reads are not counted; see "agentctl usage --json").');

  const active = report.tasks.filter((t) => t.active);
  if (active.length > 0) {
    lines.push('', 'Active tasks:');
    lines.push(...table(['TASK', 'AGENT/MODEL', 'STATE', 'TOKENS', 'SINCE'], active.map((t) => [t.task, `${t.agent}/${t.model}`, t.state, t.known ? formatTokens(t.fresh) : 'n/d', report.since])));
  }
  const rest = report.tasks.filter((t) => !t.active);
  if (rest.length > 0) {
    lines.push('', `Other tasks with tokens since ${report.sinceDay}:`);
    lines.push(...table(['TASK', 'AGENT/MODEL', 'STATE', 'TOKENS'], rest.map((t) => [t.task, `${t.agent}/${t.model}`, t.state, t.known ? formatTokens(t.fresh) : 'n/d'])));
  }
  if (report.cohorts.length > 0) {
    lines.push('', 'Cohorts:');
    lines.push(...table(['COHORT', 'TASKS', 'TOKENS'], report.cohorts.map((c) => [c.cohort, String(c.tasks), formatTokens(c.fresh)])));
  }
  const models = AGENT_NAMES.flatMap((p) => Object.entries(report.providers[p].byModel).map(([m, t]) => [p, m, formatTokens(freshTokens(t)), formatTokens(t.cacheRead)]));
  if (models.length > 0) {
    lines.push('', 'By model:');
    lines.push(...table(['PROVIDER', 'MODEL', 'TOKENS', 'CACHE READ'], models));
  }
  return lines;
}

/** Markdown for `usage --clip`. */
export function usageMarkdown(report: UsageReport): string {
  const lines = ['| provider | 5h limit | week limit | today | ' + report.since + ' |', '|---|---|---|---|---|'];
  for (const p of AGENT_NAMES) lines.push(`| ${p} | ${windowText(report.plans[p], 'session', report.now)} | ${windowText(report.plans[p], 'week', report.now)} | ${fresh(report.providers[p].today)} | ${fresh(report.providers[p].window)} |`);
  if (report.tasks.length > 0) {
    lines.push('', '| task | agent/model | state | tokens |', '|---|---|---|---|');
    for (const t of report.tasks) lines.push(`| ${t.task} | ${t.agent}/${t.model} | ${t.state} | ${t.known ? formatTokens(t.fresh) : 'n/d'} |`);
  }
  if (report.cohorts.length > 0) {
    lines.push('', '| cohort | tasks | tokens |', '|---|---|---|');
    for (const c of report.cohorts) lines.push(`| ${c.cohort} | ${c.tasks} | ${formatTokens(c.fresh)} |`);
  }
  return `${lines.join('\n')}\n`;
}

/** "C 62% · X 18%" for the tmux status line: the highest window of each provider, a provider with no reading left out. */
export function planStatusLine(plans: Record<AgentName, PlanState>): string {
  const letter: Record<AgentName, string> = { claude: 'C', codex: 'X' };
  return AGENT_NAMES.filter((p) => plans[p].available && plans[p].maxPercent !== null).map((p) => `${letter[p]} ${Math.round(plans[p].maxPercent as number)}%`).join(' · ');
}
