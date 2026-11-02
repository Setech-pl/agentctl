import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AgentModel } from './checks.ts';
import { Alerts } from './alert.ts';
import { checkAfter, hasReport, unmetAfter, waitingText } from './depends.ts';
import { touchWarnings } from './collisions.ts';
import type { AgentName, Effort, GlobalConfig } from './config.ts';
import { AGENT_NAMES } from './config.ts';
import type { Context } from './context.ts';
import { Context as ContextClass } from './context.ts';
import type { SelfArgv } from './events.ts';
import { newTasks } from './new.ts';
import type { Notifier } from './notify.ts';
import { liveWindows, planBatch } from './plan.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { resolveSpec, splitSpecs } from './spec.ts';
import type { RawSpec, ResolvedSpec } from './spec.ts';
import { listArchivedRecords, listTaskRecords, recordFromSpec, renderTaskMd, taskDir, taskFile } from './taskstore.ts';
import type { CancelSource, TaskRecord } from './taskstore.ts';
import { AgentctlError, errorMessage, formatLocalTime, windowName } from './util.ts';

/*
 * The task queue. A queued task is a spec file in <AGENTCTL_HOME>/queue/ (one JSON file per task: the spec text and what the queue
 * knows about it). `watch` starts the next one when its provider has a free window, by the same path as `agentctl new`.
 */

export type QueueStatus = 'queued' | 'starting' | 'failed';

export interface QueueEntry {
  /** The number in the file name; the next entry gets the highest + 1. */
  seq: number;
  task: string;
  /** Sort key inside a priority class; `queue up` gives an entry a key below all the others. */
  order: number;
  priority: 'high' | 'normal';
  status: QueueStatus;
  /** ISO time of the `queue` command that added it. */
  queuedAt: string;
  /** The order as it will run (after `--agent`): what `queue list` shows. */
  agent: AgentName;
  model: string;
  effort: string;
  /** `--agent`: run the spec on this provider, translated through the equivalents table. Never set by a limit. */
  agentOverride?: AgentName;
  /** The task whose report this one reviews (`review_of`). */
  reviewOf?: string;
  /** The tasks that must have a report before this one starts. */
  after: string[];
  /** Start again over a worktree that is already there (`queue retry`). */
  reuse?: boolean;
  /** `status: starting`: ISO time the watcher began the start. */
  startingAt?: string;
  /** `status: failed`: when and why. */
  failedAt?: string;
  error?: string;
  /** The spec as text: `---`, header, `---`, prompt. */
  spec: string;
}

export function queueDir(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(path.dirname(config.path), 'queue');
}

const pausedFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(queueDir(config), 'paused');
const entryFile = (config: Pick<GlobalConfig, 'path'>, e: Pick<QueueEntry, 'seq' | 'task'>): string => path.join(queueDir(config), `${String(e.seq).padStart(4, '0')}-${e.task}.json`);
export const queueLogFile = (config: Pick<GlobalConfig, 'path'>, e: Pick<QueueEntry, 'seq' | 'task'>): string => entryFile(config, e).replace(/\.json$/, '.log');

export function isPaused(config: Pick<GlobalConfig, 'path'>): boolean {
  return fs.existsSync(pausedFile(config));
}

function parseEntry(text: string): QueueEntry | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  const d = data as Partial<QueueEntry> | null;
  if (!d || typeof d !== 'object' || typeof d.seq !== 'number' || typeof d.task !== 'string' || typeof d.spec !== 'string') return undefined;
  if (!(AGENT_NAMES as readonly unknown[]).includes(d.agent)) return undefined;
  return {
    ...(d as QueueEntry),
    order: typeof d.order === 'number' ? d.order : d.seq,
    priority: d.priority === 'high' ? 'high' : 'normal',
    status: d.status === 'starting' || d.status === 'failed' ? d.status : 'queued',
    after: Array.isArray(d.after) ? d.after.filter((x): x is string => typeof x === 'string') : [],
  };
}

/** Every entry, in the order the queue serves them: waiting ones (high priority first, then by order), the ones being started, the failed ones last. */
export function readQueue(config: Pick<GlobalConfig, 'path'>): QueueEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(queueDir(config));
  } catch {
    return [];
  }
  const entries: QueueEntry[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const entry = parseEntry(fs.readFileSync(path.join(queueDir(config), name), 'utf8'));
      if (entry) entries.push(entry);
    } catch {
      // removed between the listing and the read
    }
  }
  const rank = (e: QueueEntry): number => (e.status === 'queued' ? 0 : e.status === 'starting' ? 1 : 2);
  return entries.sort((a, b) => rank(a) - rank(b) || (a.status === 'queued' && b.status === 'queued' ? Number(b.priority === 'high') - Number(a.priority === 'high') : 0) || a.order - b.order || a.seq - b.seq);
}

/** The entries that wait for their turn, in turn order. */
export const waiting = (entries: QueueEntry[]): QueueEntry[] => entries.filter((e) => e.status === 'queued');

export function findEntry(config: Pick<GlobalConfig, 'path'>, input: string): QueueEntry {
  const entries = readQueue(config);
  const wanted = input.trim().toLowerCase();
  const exact = entries.filter((e) => e.task.toLowerCase() === wanted);
  const found = exact.length > 0 ? exact : entries.filter((e) => e.task.toLowerCase().startsWith(wanted) && wanted !== '');
  if (found.length === 1) return found[0] as QueueEntry;
  if (found.length > 1) throw new AgentctlError(`"${input}" fits more than one queued task: ${found.map((e) => e.task).join(', ')}`, 'Use the full task ID.');
  throw new AgentctlError(`${input} is not in the queue`, entries.length > 0 ? `In the queue: ${entries.map((e) => e.task).join(', ')}` : 'The queue is empty. "agentctl queue list" shows it.');
}

async function writeEntry(ctx: Context, entry: QueueEntry): Promise<void> {
  await ctx.runner.writeFile(entryFile(ctx.config, entry), `${JSON.stringify(entry, null, 2)}\n`);
}

/** The spec of one raw spec as text, so that it can be parsed again when its turn comes. */
export function renderRawSpec(raw: RawSpec): string {
  return `---\n${YAML.stringify(raw.header).trimEnd()}\n---\n${raw.prompt.trim()}\n`;
}

// ---- adding

export interface QueueAddItem {
  raw: RawSpec;
  spec: ResolvedSpec;
}

export interface QueueAddPlan {
  items: QueueAddItem[];
  /** An active task already changes files that a `touches` of the specs names (the summary shows them). */
  warnings: string[];
  /** What the human sees before the question. */
  summary: string[];
}

/**
 * Validate specs for the queue the way `new` does (review_of, pin, `--agent` mapping, codex efforts, duplicates, repositories), except that a
 * full provider is not an error: that is what the queue is for. Throws one error listing every problem; nothing is written.
 */
export async function planQueueAdd(ctx: Context, raws: RawSpec[], opts: { agent?: AgentName } = {}): Promise<QueueAddPlan> {
  const { config } = ctx;
  const resolved = raws.map((raw) => resolveSpec(raw, { config }));
  const entries = readQueue(config);
  for (const spec of resolved) {
    const inQueue = entries.find((e) => e.task === spec.task);
    if (inQueue) throw new AgentctlError(`${spec.task} is already in the queue (${inQueue.status})`, `"agentctl queue rm ${spec.task}" takes it out${inQueue.status === 'failed' ? `; "agentctl queue retry ${spec.task}" tries it again` : ''}.`);
  }
  const knownAuthors = new Map<string, AgentModel>(entries.map((e) => [e.task, { agent: e.agent, model: e.model }]));
  const specs = await planBatch(ctx, resolved, { ...(opts.agent ? { agent: opts.agent } : {}), ignoreLimits: true, skipAfter: true, knownAuthors });
  checkAfter(ctx, specs, entries);
  const items = specs.map((spec, i) => ({ raw: raws[i] as RawSpec, spec }));
  const rows = await collectStatus(ctx, { progress: false, archived: true });
  const warnings = await touchWarnings(ctx, specs);
  return { items, warnings, summary: [...describeQueueAdd(ctx, specs, entries, await liveWindows(ctx), rows), ...warnings.map((w) => `⚠ ${w}`)] };
}

/** Per spec: the order and where it will stand ("starts at once" or "waits: claude 2/2, 1 ahead"). */
export function describeQueueAdd(ctx: Context, specs: ResolvedSpec[], entries: QueueEntry[], live: { agent?: AgentName }[], rows: StatusRow[] = []): string[] {
  const { config } = ctx;
  const load: Record<AgentName, number> = { claude: 0, codex: 0 };
  for (const w of live) if (w.agent) load[w.agent]++;
  const ahead: Record<AgentName, number> = { claude: 0, codex: 0 };
  for (const e of waiting(entries)) ahead[e.agent]++;
  const lines: string[] = [];
  for (const spec of specs) {
    const limit = config.limits[spec.agent];
    const used = load[spec.agent] + ahead[spec.agent];
    const full = limit !== undefined && used >= limit;
    lines.push(`${spec.task}  ${spec.agent}/${spec.model}/${spec.effort}  priority ${spec.priority}${spec.switchedBy ? ` (ordered ${spec.requested.agent} ${spec.requested.model}/${spec.requested.effort})` : ''}`);
    lines.push(`  repos:    ${spec.repos.map((r) => r.path).join(', ')}`);
    if (spec.after.length > 0) {
      const unmet = unmetAfter(spec.after, rows);
      lines.push(`  after:    ${spec.after.join(', ')}${unmet.length === 0 ? ' (all have a report already)' : ` – ${waitingText(unmet)}`}`);
    }
    const unmetNow = unmetAfter(spec.after, rows);
    lines.push(
      `  start:    ${
        unmetNow.length > 0
          ? `when ${unmetNow.join(', ')} ${unmetNow.length === 1 ? 'has' : 'have'} a report${full ? ` and a ${spec.agent} window is free` : ''}`
          : full
          ? `waits for a free ${spec.agent} window (${load[spec.agent]} running${ahead[spec.agent] > 0 ? `, ${ahead[spec.agent]} queued ahead` : ''}, limit ${limit})`
          : 'at the next watch tick (a window is free)'
      }`,
    );
    lines.push(`  prompt:   ${spec.prompt.length} characters`);
    if (spec.reviewOf && spec.after.length === 0 && !hasReport(rows.find((r) => r.task === spec.reviewOf))) {
      lines.push(`  hint:     ${spec.task} reviews ${spec.reviewOf}, which has no report yet: add "after: ${spec.reviewOf}" to the header so the review starts when the author's report is ready`);
    }
    if (spec.pin) lines.push('  pin:      stays on this provider (it is never switched by the queue either)');
    load[spec.agent]++;
  }
  return lines;
}

/** Write the entries (one per spec). Returns them in the order they were added. */
export async function commitQueueAdd(ctx: Context, items: QueueAddItem[], opts: { agent?: AgentName } = {}): Promise<QueueEntry[]> {
  const { config, runner } = ctx;
  const existing = readQueue(config);
  let seq = existing.reduce((n, e) => Math.max(n, e.seq), 0);
  const added: QueueEntry[] = [];
  for (const { raw, spec } of items) {
    seq++;
    const entry: QueueEntry = {
      seq,
      task: spec.task,
      order: seq,
      priority: spec.priority,
      status: 'queued',
      queuedAt: new Date(runner.now()).toISOString(),
      agent: spec.agent,
      model: spec.model,
      effort: spec.effort,
      after: spec.after,
      spec: renderRawSpec(raw),
    };
    if (opts.agent) entry.agentOverride = opts.agent;
    if (spec.reviewOf) entry.reviewOf = spec.reviewOf;
    await writeEntry(ctx, entry);
    added.push(entry);
  }
  return added;
}

// ---- managing

/** The header fields that mark a task as cancelled. */
export function cancelFields(opts: { reason?: string | undefined; source?: CancelSource | undefined }, at: string): Record<string, string | boolean> {
  return { cancelled: true, cancelled_at: at, ...(opts.reason ? { cancel_reason: opts.reason } : {}), cancel_source: opts.source ?? 'cli' };
}

/** Take an entry out of the queue (its file and the log of its failed start). */
export async function dropEntry(ctx: Context, entry: QueueEntry): Promise<void> {
  fs.rmSync(entryFile(ctx.config, entry), { force: true });
  fs.rmSync(queueLogFile(ctx.config, entry), { force: true });
}

/**
 * A task that was cancelled in the queue never had a state file. It gets one now (the spec, no window, `cancelled`), so that it shows in
 * `status --all` and in its cohort, and so that the tasks that wait for it can see that it is gone (they become blocked).
 */
export async function writeCancelledRecord(ctx: Context, entry: QueueEntry, opts: { reason?: string | undefined; source?: CancelSource | undefined; at?: string | undefined }): Promise<void> {
  const { config, runner } = ctx;
  let record: TaskRecord;
  let prompt: string;
  try {
    const spec = resolveSpec(splitSpecs(entry.spec, `queue entry ${entry.task}`)[0] as RawSpec, { config });
    record = recordFromSpec(spec, config, runner.now());
    prompt = spec.prompt;
  } catch {
    // the spec no longer resolves (a repository config changed): the entry still says what task this was
    record = { task: entry.task, window: windowName(entry.task), session: config.session, agent: entry.agent, model: entry.model, effort: entry.effort as TaskRecord['effort'], repos: [], links: [], env: {}, report: '', started: '', requested: { agent: entry.agent, model: entry.model, effort: entry.effort as Effort } };
    prompt = entry.spec;
  }
  record.started = '';
  Object.assign(record, { cancelled: true, cancelledAt: opts.at ?? new Date(runner.now()).toISOString(), ...(opts.reason ? { cancelReason: opts.reason } : {}), cancelSource: opts.source ?? 'cli' });
  await runner.mkdir(taskDir(config, record.window));
  await runner.writeFile(taskFile(config, record.window), renderTaskMd(record, prompt));
}

/**
 * `queue rm`: take a waiting (or failed) entry out; the task is then `cancelled` (this is `agentctl cancel` for a queued task, without a
 * reason unless one is given). An entry that is being started cannot be removed.
 */
export async function removeFromQueue(ctx: Context, input: string, opts: { reason?: string | undefined; source?: CancelSource | undefined } = {}): Promise<QueueEntry> {
  const entry = findEntry(ctx.config, input);
  if (entry.status === 'starting') throw new AgentctlError(`${entry.task} is being started right now`, 'Wait for it to finish; it then shows as a task in "agentctl status".');
  await writeCancelledRecord(ctx, entry, opts);
  await dropEntry(ctx, entry);
  return entry;
}

/** `queue up`: first in the line of its priority class. */
export async function moveToFront(ctx: Context, input: string): Promise<QueueEntry> {
  const entry = findEntry(ctx.config, input);
  if (entry.status !== 'queued') throw new AgentctlError(`${entry.task} is ${entry.status}, not waiting`, entry.status === 'failed' ? `"agentctl queue retry ${entry.task}" puts it back in the line.` : undefined);
  const lowest = readQueue(ctx.config).reduce((n, e) => Math.min(n, e.order), entry.order);
  const moved = { ...entry, order: lowest - 1 };
  await writeEntry(ctx, moved);
  return moved;
}

/** `queue retry`: a failed entry goes to the end of the line and is tried again (over the worktree it left, if any). */
export async function retryEntry(ctx: Context, input: string): Promise<QueueEntry> {
  const entry = findEntry(ctx.config, input);
  if (entry.status !== 'failed') throw new AgentctlError(`${entry.task} is ${entry.status}, not failed`);
  const highest = readQueue(ctx.config).reduce((n, e) => Math.max(n, e.order, e.seq), 0);
  const { failedAt: _f, error: _e, startingAt: _s, ...rest } = entry;
  const again: QueueEntry = { ...rest, status: 'queued', order: highest + 1, reuse: true };
  await writeEntry(ctx, again);
  return again;
}

export async function setPaused(ctx: Context, paused: boolean): Promise<boolean> {
  const was = isPaused(ctx.config);
  if (paused === was) return false;
  if (paused) await ctx.runner.writeFile(pausedFile(ctx.config), `${new Date(ctx.runner.now()).toISOString()}\n`);
  else fs.rmSync(pausedFile(ctx.config), { force: true });
  return true;
}

// ---- what the queue waits for

export type Condition =
  | { kind: 'ready'; text: string }
  | { kind: 'after'; text: string }
  | { kind: 'slot'; text: string }
  | { kind: 'paused'; text: string }
  | { kind: 'starting'; text: string }
  | { kind: 'failed'; text: string };

export interface QueueView {
  /** 1-based place in the line of the waiting entries; null for the ones being started and the failed ones. */
  position: number | null;
  entry: QueueEntry;
  condition: Condition;
  /** ISO time since when it waits. */
  since: string;
}

/**
 * For every entry: what it waits for. Entries are walked in turn order, each one that will start in the next tick uses up a window of its
 * provider, so the answer matches what `watch` does. `inflight` are the tasks this very process is starting.
 */
export function describeQueue(config: GlobalConfig, entries: QueueEntry[], live: { agent?: AgentName }[], rows: StatusRow[] = []): QueueView[] {
  const failed = new Set(entries.filter((e) => e.status === 'failed').map((e) => e.task));
  const used: Record<AgentName, number> = { claude: 0, codex: 0 };
  for (const w of live) if (w.agent) used[w.agent]++;
  const paused = isPaused(config) || !config.queue.enabled;
  const reason = !config.queue.enabled ? 'queue.enabled is false' : 'queue paused (agentctl queue resume)';
  let position = 0;
  return entries.map((entry): QueueView => {
    if (entry.status === 'failed') return { position: null, entry, condition: { kind: 'failed', text: `failed: ${(entry.error ?? '').split('\n')[0] ?? ''}` }, since: entry.failedAt ?? entry.queuedAt };
    if (entry.status === 'starting') return { position: null, entry, condition: { kind: 'starting', text: 'starting' }, since: entry.startingAt ?? entry.queuedAt };
    position++;
    if (paused) return { position, entry, condition: { kind: 'paused', text: reason }, since: entry.queuedAt };
    const unmet = unmetAfter(entry.after, rows);
    if (unmet.length > 0) return { position, entry, condition: { kind: 'after', text: waitingText(unmet, failed) }, since: entry.queuedAt };
    const limit = config.limits[entry.agent];
    if (limit !== undefined && used[entry.agent] >= limit) {
      return { position, entry, condition: { kind: 'slot', text: `czeka na miejsce: ${entry.agent} ${used[entry.agent]}/${limit}` }, since: entry.queuedAt };
    }
    used[entry.agent]++;
    return { position, entry, condition: { kind: 'ready', text: 'wolne miejsce – start przy najbliższym ticku watch' }, since: entry.queuedAt };
  });
}

/** What `status` prints under its table: the waiting tasks and what each one waits for; nothing when the queue is empty. */
export async function queueStatusLines(ctx: Context): Promise<string[]> {
  const entries = readQueue(ctx.config);
  if (entries.length === 0) return [];
  const views = describeQueue(ctx.config, entries, await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true }));
  const open = views.filter((v) => v.entry.status !== 'failed');
  return [
    `Queue (${open.length}${views.length > open.length ? `, ${views.length - open.length} failed` : ''}): agentctl queue list`,
    ...views.map((v) => `  ${v.position ?? '-'}. ${v.entry.task}  ${v.condition.text}`),
  ];
}

/** The lines of `queue list`. */
export function renderQueueList(views: QueueView[], nowMs: number): string[] {
  if (views.length === 0) return ['The queue is empty.'];
  const age = (iso: string): string => {
    const ms = nowMs - Date.parse(iso);
    if (Number.isNaN(ms)) return '-';
    const m = Math.max(0, Math.floor(ms / 60000));
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d`;
  };
  const header = ['#', 'TASK', 'AGENT/MODEL/EFFORT', 'PRIORITY', 'START CONDITION', 'WAITING', 'QUEUED'];
  const body = views.map((v) => [
    v.position === null ? '-' : String(v.position),
    v.entry.task,
    `${v.entry.agent}/${v.entry.model}/${v.entry.effort}`,
    v.entry.priority,
    v.condition.text,
    age(v.since),
    formatLocalTime(v.entry.queuedAt),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [fmt(header), ...body.map(fmt)];
}

// ---- starting

/** What `watch` remembers about the starts it has begun. */
export class QueueMemory {
  /** Tasks being started by this process: their agent counts against the provider limit before the window exists. */
  readonly inflight = new Map<string, { agent: AgentName; promise: Promise<void> }>();

  /** Resolves when every start that was begun has finished (tests, and a clean stop of `watch`). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight.values()].map((i) => i.promise));
  }
}

export interface QueueTickOptions {
  self?: SelfArgv | undefined;
  signal?: AbortSignal | undefined;
  /** Status rows including closed and archived tasks (the watcher has them already). */
  rows?: StatusRow[];
  /** Where a start is reported to (the watch log). */
  log?: (line: string) => Promise<void> | void;
}

const firstLine = (s: string): string => s.split('\n')[0] ?? s;

/**
 * One look at the queue: start every waiting entry whose provider has a free window, in turn order. The starts run in the background
 * (a start waits for a human to answer the folder-trust dialog, and the queue must not stand still meanwhile), at most
 * `queue.parallel_starts` at a time. Returns the tasks whose start began. Never changes the provider of a task.
 */
export async function queueTick(ctx: Context, memory: QueueMemory, notifier: Notifier, opts: QueueTickOptions = {}): Promise<string[]> {
  const { config } = ctx;
  if (!config.queue.enabled || isPaused(config)) return [];
  let entries = readQueue(config);
  if (entries.length === 0) return [];
  const records = new Set([...listTaskRecords(config), ...listArchivedRecords(config)].map((r) => r.task));
  // A start that died with its watcher: the entry says "starting" and nothing here is doing it. Its task exists (the window is up,
  // the prompt may be missing) or not: either way it goes to "failed", where a human decides.
  for (const entry of entries) {
    if (entry.status !== 'starting' || memory.inflight.has(entry.task)) continue;
    if (records.has(entry.task)) {
      fs.rmSync(entryFile(config, entry), { force: true });
      fs.rmSync(queueLogFile(config, entry), { force: true });
    } else await failEntry(ctx, entry, 'the start was interrupted (the watcher stopped before it finished)', notifier, opts, false);
  }
  entries = readQueue(config);
  const live = await liveWindows(ctx);
  const rows = opts.rows ?? (await collectStatus(ctx, { progress: false, archived: true }));
  const used: Record<AgentName, number> = { claude: 0, codex: 0 };
  for (const w of live) if (w.agent) used[w.agent]++;
  // A start in progress whose window is not up yet already holds its place.
  for (const [task, i] of memory.inflight) if (!live.some((w) => w.window === task.toLowerCase())) used[i.agent]++;

  const began: string[] = [];
  for (const entry of waiting(entries)) {
    if (memory.inflight.size >= config.queue.parallelStarts) break;
    if (unmetAfter(entry.after, rows).length > 0) continue;
    const limit = config.limits[entry.agent];
    if (limit !== undefined && used[entry.agent] >= limit) continue;
    used[entry.agent]++;
    began.push(entry.task);
    await beginStart(ctx, memory, notifier, entry, opts);
  }
  return began;
}

async function beginStart(ctx: Context, memory: QueueMemory, notifier: Notifier, entry: QueueEntry, opts: QueueTickOptions): Promise<void> {
  const { config } = ctx;
  const starting: QueueEntry = { ...entry, status: 'starting', startingAt: new Date(ctx.runner.now()).toISOString() };
  await writeEntry(ctx, starting);
  const log: string[] = [];
  const startCtx = new ContextClass(ctx.runner, config, (l) => void log.push(l));
  const run = async (): Promise<void> => {
    try {
      await opts.log?.(`queue: starting ${entry.task} (${entry.agent})`);
      const raws = splitSpecs(entry.spec, `queue entry ${entry.task}`);
      const spec = resolveSpec(raws[0] as RawSpec, { config });
      await newTasks(startCtx, [spec], {
        ...(entry.agentOverride ? { agent: entry.agentOverride } : {}),
        noSwitch: true,
        skipAfter: true,
        reuse: Boolean(entry.reuse),
        waitTrust: true,
        ...(opts.self ? { self: opts.self } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      fs.rmSync(entryFile(config, starting), { force: true });
      fs.rmSync(queueLogFile(config, starting), { force: true });
      await opts.log?.(`queue: ${entry.task} started`);
      await notifyPlain(ctx, notifier, entry.task, `Uruchomiono ${entry.task} z kolejki`, opts.self);
    } catch (e) {
      await failEntry(ctx, starting, errorMessage(e), notifier, opts, !opts.signal?.aborted, log).catch(() => undefined);
    } finally {
      memory.inflight.delete(entry.task);
    }
  };
  memory.inflight.set(entry.task, { agent: entry.agent, promise: run() });
}

/** The entry goes to the end of the line as `failed`, with the log of the attempt; no retry loop: `queue retry` is a human's decision. */
async function failEntry(ctx: Context, entry: QueueEntry, error: string, notifier: Notifier, opts: QueueTickOptions, notify: boolean, log: string[] = []): Promise<void> {
  const { config } = ctx;
  const highest = readQueue(config).reduce((n, e) => Math.max(n, e.order, e.seq), 0);
  const { startingAt: _s, ...rest } = entry;
  const failed: QueueEntry = { ...rest, status: 'failed', failedAt: new Date(ctx.runner.now()).toISOString(), error, order: highest + 1 };
  await writeEntry(ctx, failed);
  await ctx.runner.writeFile(queueLogFile(config, failed), `${log.join('\n')}${log.length > 0 ? '\n' : ''}error: ${error}\n`);
  await opts.log?.(`queue: ${entry.task} failed: ${firstLine(error)}`);
  if (notify) await notifyPlain(ctx, notifier, entry.task, `${entry.task}: start z kolejki nie powiódł się – ${firstLine(error)} (agentctl queue retry ${entry.task})`, opts.self);
}

async function notifyPlain(ctx: Context, notifier: Notifier, task: string, text: string, self: SelfArgv | undefined): Promise<void> {
  const alerts = new Alerts(ctx, notifier, { self });
  const { click, text: message } = await alerts.clickFor({ task, window: task.toLowerCase() }, text);
  await notifier.notify('agentctl', message, click).catch(() => undefined);
}
