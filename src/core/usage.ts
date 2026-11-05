import type { ProviderValues } from './providers/registry.ts';
import { provider as adapter, activeProviders, perProvider, PROVIDER_IDS } from './providers/registry.ts';
import { DEFAULT_PROVIDERS } from './providers/types.ts';
import fs from 'node:fs';
import { recordSamples } from './usage-samples.ts';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { agentHomes, cachePath, homeDir, UsageReader } from './usage-sources.ts';
import { addTokens, formatTokens, freshTokens, localDay, sumBuckets, windowKind, zeroTokens } from './usage-parse.ts';
import type { PlanSnapshot, PlanWindow, Tokens } from './usage-parse.ts';
import { isObject } from './util.ts';

/*
 * Token usage per task, provider, model, cohort and day, and the state of the plans.
 *
 * Tokens: a task owns the sessions of its agent that ran in its worktree between its start and its end (the start of the task that
 * continues it after `move`, the close, the cancel). `<state_dir>/<task>/sessions.json` adds the sessions the agent's own events named.
 * Plans: Codex writes the plan's `rate_limits` into every session log, so the newest log says; Claude Code only hands them to a
 * statusLine command, which `agentctl usage-tap` is in the windows that `new` starts. Anything that is not known is "n/d", never a guess.
 */

/** A session may start a minute before the task's record says (clocks, rounding). */
const START_SLACK_MS = 60_000;
/** A reading of the plan older than this is shown with its age; the percentage may have moved since. */
export const PLAN_STALE_MS = 30 * 60_000;

// ---- the plan

export interface PlanWindowView {
  kind: PlanWindow['kind'];
  minutes: number | null;
  /** "5h", "week", or "<n> min". */
  label: string;
  usedPercent: number;
  /** ms; null when the log did not say. */
  resetsAt: number | null;
}

export interface PlanState {
  provider: AgentName;
  /** At least one window is known and not reset yet. */
  available: boolean;
  /** ms of the reading; null when there is none. */
  readAt: number | null;
  planType: string | null;
  /** The windows that are still running (a window past its reset is dropped: its percentage is not known any more). */
  windows: PlanWindowView[];
  /** The highest percentage among the windows; null when none is known. */
  maxPercent: number | null;
  /** Why it is n/d (or what is odd about it); empty when all is well. */
  note: string;
  /** Older than PLAN_STALE_MS. */
  stale: boolean;
  source?: string;
}

function windowLabel(w: Pick<PlanWindow, 'kind' | 'minutes'>): string {
  if (w.kind === 'session') return '5h';
  if (w.kind === 'week') return 'week';
  return w.minutes === null ? 'limit' : w.minutes % 60 === 0 ? `${w.minutes / 60}h` : `${w.minutes} min`;
}

/** The plan as the log said it, minus the windows that have been reset since. */
export function planState(provider: AgentName, snapshot: PlanSnapshot | undefined, now: number, missing: string): PlanState {
  const none = (note: string): PlanState => ({ provider, available: false, readAt: snapshot?.at ?? null, planType: snapshot?.planType ?? null, windows: [], maxPercent: null, note, stale: false });
  if (!snapshot) return none(missing);
  const windows: PlanWindowView[] = snapshot.windows
    .filter((w) => w.resetsAt === null || w.resetsAt * 1000 > now)
    .map((w) => ({ kind: w.kind, minutes: w.minutes, label: windowLabel(w), usedPercent: w.usedPercent, resetsAt: w.resetsAt === null ? null : w.resetsAt * 1000 }));
  if (windows.length === 0) return none(`the windows read at ${hhmm(snapshot.at)} have been reset since; no newer reading`);
  const stale = now - snapshot.at > PLAN_STALE_MS;
  return { provider, available: true, readAt: snapshot.at, planType: snapshot.planType, windows, maxPercent: Math.max(...windows.map((w) => w.usedPercent)), note: stale ? `read ${hhmm(snapshot.at)}: may be out of date` : '', stale };
}

const two = (n: number): string => String(n).padStart(2, '0');
export const hhmm = (ms: number): string => `${two(new Date(ms).getHours())}:${two(new Date(ms).getMinutes())}`;

/** "14:30" for today, "Sun 18:00" for a later day. */
export function formatReset(ms: number, now: number): string {
  const same = localDay(ms) === localDay(now);
  return same ? hhmm(ms) : `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(ms)}`;
}

/** The file `usage-tap` writes in the windows of Claude: the plan windows of the newest statusLine call. */
export { claudePlanFile, readClaudeSnapshot } from './providers/claude-usage.ts';

/** Both plans. Reads one file for Claude and the tail of the newest Codex logs. */
export function readPlans(config: GlobalConfig, reader: UsageReader, now: number): ProviderValues<PlanState> {
  const ids = activeProviders(config);
  const plans = perProvider(ids, id => adapter(id).usage.readPlan(config, reader, now));
  for (const id of ids) { const p = plans[id]; p.stale = p.readAt !== null && now - p.readAt > config.capacity.staleMinutes * 60_000; }
  const totals = perProvider(ids, () => 0);
  for (const u of collectTaskUsage(config, reader, allRecords(config), now).values()) if ((ids as string[]).includes(u.agent)) totals[u.agent as AgentName] += freshTokens(u.total);
  recordSamples(config, plans, totals, now);
  return plans;
}

export { codexPlanFile } from './providers/codex-usage.ts';

// ---- tokens per task

/** `<state_dir>/<task>/sessions.json`: the sessions the agent's own events named (transcript paths of Claude, thread ids of Codex). */
export type TaskSessions = Record<'claude' | 'codex', { id: string; transcript?: string }[]> & { kimi?: { id: string; transcript?: string }[] };

export const sessionsFile = (config: Pick<GlobalConfig, 'stateDir'>, window: string): string => path.join(config.stateDir, window, 'sessions.json');

export function readTaskSessions(config: Pick<GlobalConfig, 'stateDir'>, window: string): TaskSessions {
  const out: TaskSessions = perProvider(DEFAULT_PROVIDERS, () => []);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(sessionsFile(config, window), 'utf8'));
    if (!isObject(data)) return out;
    if (Array.isArray(data.kimi)) out.kimi = [];
    for (const id of PROVIDER_IDS) {
      for (const c of Array.isArray(data[id]) ? data[id] : []) if (isObject(c) && typeof c.id === 'string') (out[id] ??= []).push({ id: c.id, ...(adapter(id).capabilities.statusLineTap && typeof c.transcript === 'string' ? { transcript: c.transcript } : {}) });
    }
  } catch {
    // none recorded
  }
  return out;
}

export interface TaskUsage {
  observed?: { model: string; effort: string; cliVersion: string };
  warning?: string;
  task: string;
  window: string;
  agent: string;
  model: string;
  cohort: string | null;
  /** Session logs that belong to the task (subagents of Claude not counted separately). */
  sessions: number;
  /** `<local day>|<model>` -> tokens. */
  buckets: Record<string, Tokens>;
  /** All the tokens of the task, and ms of the first and last line. */
  total: Tokens;
  firstAt: number | null;
  lastAt: number | null;
}

const within = (cwd: string, dir: string): boolean => {
  const a = path.resolve(cwd);
  const b = path.resolve(dir);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

/** When a task stops owning sessions: the start of the task that continues it, its close or its cancel. */
function endOf(record: TaskRecord, all: readonly TaskRecord[]): number {
  const ends = [record.closedAt, record.cancelledAt, ...all.filter((r) => r.continues === record.task).map((r) => r.started)].map((t) => (t ? Date.parse(t) : NaN)).filter((n) => !Number.isNaN(n));
  return ends.length > 0 ? Math.min(...ends) + START_SLACK_MS : Infinity;
}

interface Candidate {
  file: string;
  provider: AgentName;
  firstAt: number | null;
  /** The transcript names it explicitly (events): the time window does not apply. */
  explicit: boolean;
}

/** The session logs that could belong to a task, with the evidence for each. */
function candidates(config: GlobalConfig, reader: UsageReader, record: TaskRecord, now: number, codexScan: Map<string, string[]>): Candidate[] {
  const out: Candidate[] = [];
  const sessions = readTaskSessions(config, record.window);
  const worktrees = record.repos.map(r => r.worktree);
  const ids = record.agent === 'unknown' ? activeProviders(config) : [record.agent];
  for (const id of ids) {
    const usage = adapter(id).usage;
    const override = usage.homeEnv ? record.env[usage.homeEnv] : undefined;
    const home = usage.taskHome ? usage.taskHome(config, { ...process.env, ...record.env }) : override ? path.resolve(override) : usage.home(config);
    for (const candidate of usage.sessions(reader, home, record, worktrees, sessions[id] ?? [], now)) out.push({ ...candidate, provider: id });
  }
  return out;
}

/**
 * Tokens per task. A session goes to one task: of those that could own it (same provider, same worktree), the one that started last
 * before the session did - and only when the session began before that task ended.
 */
export function collectTaskUsage(config: GlobalConfig, reader: UsageReader, records: readonly TaskRecord[], now: number): Map<string, TaskUsage> {
  const codexScan = new Map<string, string[]>();
  const claimed = new Map<string, { record: TaskRecord; candidate: Candidate }>();
  for (const record of records) {
    const started = Date.parse(record.started);
    const end = endOf(record, records);
    for (const c of candidates(config, reader, record, now, codexScan)) {
      if (!c.explicit) {
        if (Number.isNaN(started) || c.firstAt === null || c.firstAt < started - START_SLACK_MS || c.firstAt >= end) continue;
      }
      const key = `${c.provider}|${c.file}`;
      const held = claimed.get(key);
      const better = !held || (c.explicit && !held.candidate.explicit) || (c.explicit === held.candidate.explicit && Date.parse(record.started) > Date.parse(held.record.started));
      if (better) claimed.set(key, { record, candidate: c });
    }
  }
  const usage = new Map<string, TaskUsage>();
  for (const record of records) {
    usage.set(record.task, { task: record.task, window: record.window, agent: record.agent, model: record.model, cohort: record.cohort ?? null, sessions: 0, buckets: {}, total: zeroTokens(), firstAt: null, lastAt: null });
  }
  for (const { record, candidate } of claimed.values()) {
    const u = usage.get(record.task) as TaskUsage;
    const files = [candidate.file, ...(adapter(candidate.provider).usage.related?.(reader, candidate.file) ?? [])];
    let counted = false;
    for (const file of files) {
      const stats = reader.stats(file, candidate.provider);
      if (!stats) continue;
      counted = true;
      if (file === candidate.file && stats.observed) {
        u.observed = stats.observed;
        if ((stats.observed.model !== 'unknown' && record.requested.model !== 'default' && stats.observed.model !== record.requested.model) || (stats.observed.effort !== 'unknown' && stats.observed.effort !== record.requested.effort)) u.warning = 'observed differs from requested';
      }
      for (const [key, t] of Object.entries(stats.buckets)) u.buckets[key] = addTokens(u.buckets[key] ?? zeroTokens(), t);
      u.total = addTokens(u.total, sumBuckets(stats.buckets));
      if (stats.firstAt !== null) u.firstAt = u.firstAt === null ? stats.firstAt : Math.min(u.firstAt, stats.firstAt);
      if (stats.lastAt !== null) u.lastAt = u.lastAt === null ? stats.lastAt : Math.max(u.lastAt, stats.lastAt);
    }
    if (counted) u.sessions++;
  }
  return usage;
}

/** Every record agentctl has, the archived ones too. */
export const allRecords = (config: GlobalConfig): TaskRecord[] => [...listTaskRecords(config), ...listArchivedRecords(config)];

/** A reader on the cache of this agentctl home. */
export const openReader = (config: GlobalConfig): UsageReader => new UsageReader(cachePath(config));

export interface TaskTokens {
  observed?: TaskUsage['observed'];
  /** input + output + cache writes: the number shown as TOKENS. */
  fresh: number;
  tokens: Tokens;
  sessions: number;
}

/** Tokens of each task that has a session log; tasks without one are not in the map (shown as n/d). */
export function taskTokenMap(config: GlobalConfig, now: number, records: readonly TaskRecord[] = allRecords(config), reader: UsageReader = openReader(config)): Map<string, TaskTokens> {
  const out = new Map<string, TaskTokens>();
  for (const [task, u] of collectTaskUsage(config, reader, records, now)) if (u.sessions > 0) out.set(task, { fresh: freshTokens(u.total), tokens: u.total, sessions: u.sessions, ...(u.observed ? { observed: u.observed } : {}) });
  reader.save();
  return out;
}

export { formatTokens };

const fresh = (t: Tokens): string => formatTokens(freshTokens(t));
