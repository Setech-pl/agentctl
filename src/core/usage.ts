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
export function claudePlanFile(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(homeDir(config), 'usage', 'claude-plan.json');
}

export function readClaudeSnapshot(config: Pick<GlobalConfig, 'path'>): PlanSnapshot | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(claudePlanFile(config), 'utf8'));
    if (!isObject(data) || typeof data.at !== 'number' || !Array.isArray(data.windows)) return undefined;
    const windows: PlanWindow[] = [];
    for (const w of data.windows) {
      if (!isObject(w) || typeof w.usedPercent !== 'number') continue;
      const minutes = typeof w.minutes === 'number' ? w.minutes : null;
      windows.push({ kind: windowKind(minutes), minutes, usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null });
    }
    return windows.length > 0 ? { at: data.at, planType: null, windows } : undefined;
  } catch {
    return undefined;
  }
}

/** Both plans. Reads one file for Claude and the tail of the newest Codex logs. */
export function readPlans(config: GlobalConfig, reader: UsageReader, now: number): Record<AgentName, PlanState> {
  const homes = agentHomes(config);
  const plans = {
    claude: planState(
      'claude',
      readClaudeSnapshot(config),
      now,
      config.usage.claudeTap ? 'no reading yet: Claude Code reports its limits only to a statusLine, which starts with the next task window (see "agentctl usage --help")' : 'usage.claude_tap is off: Claude Code gives its limits only to a statusLine',
    ),
    codex: planState('codex', newestCodexSnapshot(config, reader.codexPlan(homes.codex, now)), now, `no Codex session log with rate limits in ${path.join(homes.codex, 'sessions')} for the last 3 days`),
  };
  plans.claude.source = 'claude-statusline';
  const refreshed = readCodexSnapshot(config);
  plans.codex.source = refreshed?.at === plans.codex.readAt ? 'codex-app-server:account/rateLimits/read' : 'codex-session-log';
  for (const p of [plans.claude, plans.codex]) p.stale = p.readAt !== null && now - p.readAt > config.capacity.staleMinutes * 60_000;
  const totals = { claude: 0, codex: 0 };
  for (const u of collectTaskUsage(config, reader, allRecords(config), now).values()) if (u.agent === 'claude' || u.agent === 'codex') totals[u.agent] += freshTokens(u.total);
  recordSamples(config, plans, totals, now);
  return plans;
}

export const codexPlanFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(homeDir(config), 'usage', 'codex-plan.json');
function readCodexSnapshot(config: GlobalConfig): PlanSnapshot | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(codexPlanFile(config), 'utf8')) as PlanSnapshot;
    return Number.isFinite(s.at) && Array.isArray(s.windows) ? s : undefined;
  } catch { return undefined; }
}
function newestCodexSnapshot(config: GlobalConfig, log: PlanSnapshot | undefined): PlanSnapshot | undefined {
  const rpc = readCodexSnapshot(config);
  return rpc && (!log || rpc.at > log.at) ? rpc : log;
}

// ---- tokens per task

/** `<state_dir>/<task>/sessions.json`: the sessions the agent's own events named (transcript paths of Claude, thread ids of Codex). */
export interface TaskSessions {
  claude: { id: string; transcript?: string }[];
  codex: { id: string }[];
}

export const sessionsFile = (config: Pick<GlobalConfig, 'stateDir'>, window: string): string => path.join(config.stateDir, window, 'sessions.json');

export function readTaskSessions(config: Pick<GlobalConfig, 'stateDir'>, window: string): TaskSessions {
  const out: TaskSessions = { claude: [], codex: [] };
  try {
    const data: unknown = JSON.parse(fs.readFileSync(sessionsFile(config, window), 'utf8'));
    if (!isObject(data)) return out;
    for (const c of Array.isArray(data.claude) ? data.claude : []) if (isObject(c) && typeof c.id === 'string') out.claude.push({ id: c.id, ...(typeof c.transcript === 'string' ? { transcript: c.transcript } : {}) });
    for (const c of Array.isArray(data.codex) ? data.codex : []) if (isObject(c) && typeof c.id === 'string') out.codex.push({ id: c.id });
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
  const homes = {
    claude: record.env.CLAUDE_CONFIG_DIR ? path.resolve(record.env.CLAUDE_CONFIG_DIR) : agentHomes(config).claude,
    codex: record.env.CODEX_HOME ? path.resolve(record.env.CODEX_HOME) : agentHomes(config).codex,
  };
  const out: Candidate[] = [];
  const sessions = readTaskSessions(config, record.window);
  const worktrees = record.repos.map((r) => r.worktree);
  if (record.agent !== 'codex') {
    for (const w of worktrees) {
      for (const file of reader.claudeSessions(homes.claude, w)) {
        const meta = reader.meta(file, 'claude');
        if (meta?.cwd && within(meta.cwd, w)) out.push({ file, provider: 'claude', firstAt: meta.firstAt, explicit: false });
      }
    }
    for (const s of sessions.claude) {
      const file = s.transcript ?? '';
      if (file !== '' && fs.existsSync(file)) out.push({ file, provider: 'claude', firstAt: reader.meta(file, 'claude')?.firstAt ?? null, explicit: true });
    }
  }
  if (record.agent !== 'claude') {
    const since = Date.parse(record.started);
    const scanKey = `${homes.codex}|${localDay(Number.isNaN(since) ? now : since)}`;
    let files = codexScan.get(scanKey);
    if (!files) {
      files = reader.codexSessions(homes.codex, Number.isNaN(since) ? now : since - 86_400_000, now);
      codexScan.set(scanKey, files);
    }
    const ids = new Set(sessions.codex.map((s) => s.id));
    for (const file of files) {
      const meta = reader.meta(file, 'codex');
      if (!meta) continue;
      const explicit = meta.id !== null && ids.has(meta.id);
      if (explicit || (meta.cwd && worktrees.some((w) => within(meta.cwd as string, w)))) out.push({ file, provider: 'codex', firstAt: meta.firstAt, explicit });
    }
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
    const files = [candidate.file, ...(candidate.provider === 'claude' ? reader.claudeSubagents(candidate.file) : [])];
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
