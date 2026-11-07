import { heavyBudget, heavyPreviewUsed, heavyWait, isHeavy } from './heavy.ts';
import { secretRedactor } from './secret-redaction.ts';
import { activeProviders, perProvider, isActive } from './providers/registry.ts';
import { withStartLock } from './start-lock.ts';
import { authorCheckoutBusy, authorTerminal, authorWaitReason, effectiveAfter, findAuthorRecord, repinReview, syncReviewLedger } from './review-gate.ts';
import { queueFile as promptQueueFile } from './prompt-queue.ts';
import { expectedCloseFile } from './tmux-loss.ts';
import { withFileLock } from './file-lock.ts';
import { reportPathWarnings } from './report-path.ts';
import { missingLinkTargets, checkLinkTargets } from './links.ts';
import type { OutputVerdict } from './outputs.ts';
import { redactQueue } from './mcp-redact.ts';
import { checkRetryWorktrees } from './git.ts';
import { collectCapacity, capacitySnapshot, snapshotLines } from './capacity.ts';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import { overProviderLimit } from './checks.ts';
import type { AgentModel } from './checks.ts';
import { Alerts } from './alert.ts';
import { recordJournal } from './journal.ts';
import { cancelledTasks, checkAfter, findBlocked, blockedText, hasReport, unmetAfter, waitingText } from './depends.ts';
import type { Blockers } from './depends.ts';
import { touchWarnings } from './collisions.ts';
import { touchCohort } from './cohort.ts';
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
import type { RawSpec, ResolvedSpec, AutoReviewSource } from './spec.ts';
import { findRecordAnywhere, listArchivedRecords, listTaskRecords, readTaskRecord, recordFromSpec, renderTaskMd, taskDir, taskFile } from './taskstore.ts';
import type { CancelSource, TaskRecord } from './taskstore.ts';
import { queueHolds, usageSummaryLines } from './usage-limits.ts';
import { AgentctlError, cohortKey, errorMessage, formatLocalTime, plural, windowName } from './util.ts';
import { clearSetupProgress, readSetupProgress, startProgressText } from './setup-progress.ts';

/*
 * The task queue. A queued task is a spec file in <AGENTCTL_HOME>/queue/ (one JSON file per task: the spec text and what the queue
 * knows about it). `watch` starts the next one when its provider has a free window, by the same path as `agentctl new`.
 */

export type QueueStatus = 'queued' | 'starting' | 'failed';

export interface QueueEntry {
  autoReview?: AutoReviewSource;
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
  afterVerdicts?: Record<string, OutputVerdict[]>;
  /** The cohort of the task (display name); absent: none. */
  cohort?: string;
  /** Start again over a worktree that is already there (`queue retry`). */
  reuse?: boolean;
  /**
   * An explicit start (the MCP `new` with setup): the chat does not wait for the checkout and the setup, the watcher does them. Unlike a queued
   * task it does not wait for `after`, for a paused queue or for `usage.queue_hold`; it still waits for a free window of its provider.
   */
  direct?: boolean;
  /** Author admitted alongside this direct start (or already registered): its TASK.md must exist before reviewer revalidation. */
  directAuthor?: string;
  /** Accepted effective author order, used only for no-agent preparation (which deliberately creates no TASK.md). */
  directAuthorOrder?: AgentModel;
  authorPrepared?: boolean;
  /** `direct` with `no_agent`: stop after the worktree, the setup and the links. */
  noAgent?: boolean;
  /** `status: starting`: ISO time the watcher began the start. */
  startingAt?: string;
  startingPid?: number;
  /** The cancelled authors of `after` that the watcher has announced as "blocked" already (once per author). */
  blockedNotified?: string[];
  /** `status: failed`: when and why. */
  failedAt?: string;
  error?: string;
  retryAt?: string;
  attempts?: { at: string; error: string; transient: boolean }[];
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

/** Write an entry back after a change (its cohort, its `after`). */
export const saveEntry = writeEntry;

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
  capacity?: ReturnType<typeof capacitySnapshot>;
}

/**
 * Validate specs for the queue the way `new` does (review_of, pin, `--agent` mapping, codex efforts, duplicates, repositories), except that a
 * full provider is not an error: that is what the queue is for. Throws one error listing every problem; nothing is written.
 */
export async function planQueueAdd(ctx: Context, raws: RawSpec[], opts: { agent?: AgentName; diskBudgetMs?: number } = {}): Promise<QueueAddPlan> {
  const { config } = ctx;
  const resolved = raws.map((raw) => resolveSpec(raw, { config }));
  const entries = readQueue(config);
  for (const spec of resolved) {
    const inQueue = entries.find((e) => e.task === spec.task);
    if (inQueue) throw new AgentctlError(`${spec.task} is already in the queue (${inQueue.status})`, `"agentctl queue rm ${spec.task}" takes it out${inQueue.status === 'failed' ? `; "agentctl queue retry ${spec.task}" tries it again` : ''}.`);
  }
  const knownAuthors = new Map<string, AgentModel>(entries.map((e) => [e.task, { agent: e.agent, model: e.model }]));
  const specs = await planBatch(ctx, resolved, { ...(opts.agent ? { agent: opts.agent } : {}), ignoreLimits: true, skipAfter: true, deferBases: true, knownAuthors });
  checkAfter(ctx, specs, entries);
  const items = specs.map((spec, i) => ({ raw: raws[i] as RawSpec, spec }));
  const rows = await collectStatus(ctx, { progress: false, archived: true });
  const warnings = [...await touchWarnings(ctx, specs), ...specs.flatMap(s => reportPathWarnings(ctx.config, s).map(w => `${s.task}: ${w}`)), ...specs.flatMap(s => [...(s.linkWarnings ?? []), ...missingLinkTargets(s.links, s.repos[0]?.worktree)].map(w => `${s.task}: ${w}`))];
  const capacity = config.capacity.snapshot && !ctx.runner.dryRun ? capacitySnapshot(await collectCapacity(ctx, opts.diskBudgetMs === undefined ? {} : { diskBudgetMs: opts.diskBudgetMs }), specs.map((s) => s.agent)) : undefined;
  return { items, warnings, ...(capacity ? { capacity } : {}), summary: [...describeQueueAdd(ctx, specs, entries, await liveWindows(ctx), rows), ...usageSummaryLines(config, specs, ctx.runner.now()), ...(capacity ? snapshotLines(capacity) : []), ...warnings.map((w) => `⚠ ${w}`)] };
}

/** Per spec: the order and where it will stand ("starts at once" or "waits: claude 2/2, 1 ahead"). */
export function describeQueueAdd(ctx: Context, specs: ResolvedSpec[], entries: QueueEntry[], live: { window?: string; agent?: AgentName; counted?: boolean }[], rows: StatusRow[] = []): string[] {
  const { config } = ctx;
  const load: Record<AgentName, number> = perProvider(activeProviders(config), () => 0);
  for (const w of live) if (w.agent && w.counted !== false) load[w.agent]++;
  const ahead: Record<AgentName, number> = perProvider(activeProviders(config), () => 0);
  for (const e of waiting(entries)) ahead[e.agent]++;
  const readyCount = rows.filter(r => r.state === 'report-ready' && r.window === 'alive').length;
  const lines: string[] = readyCount ? [`${readyCount} ${plural(readyCount, 'okno', 'okna', 'okien')} report-ready – close zwolni okna`] : [];
  let heavyUsed = heavyPreviewUsed(config, entries, live);
  for (const spec of specs) {
    const heavyReason = heavyWait(config, spec.weight === 'heavy', heavyUsed);
    if (spec.weight === 'heavy') heavyUsed++;
    const limit = config.limits[spec.agent];
    const used = load[spec.agent] + ahead[spec.agent];
    const full = overProviderLimit(limit, used);
    lines.push(`${spec.task}  ${spec.agent}/${spec.model}/${spec.effort}  priority ${spec.priority}${spec.switchedBy ? ` (ordered ${spec.requested.agent} ${spec.requested.model}/${spec.requested.effort})` : ''}`);
    lines.push(`  repos:    ${spec.repos.map((r) => r.path).join(', ')}`);
    if (spec.after.length > 0) {
      const unmet = unmetAfter(spec.after, rows, spec.afterVerdicts);
      lines.push(`  after:    ${spec.after.join(', ')}${unmet.length === 0 ? ' (all have a report already)' : ` – ${waitingText(unmet)}`}`);
    }
    const unmetNow = unmetAfter(spec.after, rows, spec.afterVerdicts);
    lines.push(
      `  start:    ${
        isPaused(config) ? 'queue paused; starts after queue_resume (agentctl queue resume)' : !config.queue.enabled ? 'queue.enabled is false; enable the queue first' : limit === 'off' ? `${spec.agent} is disabled (limits.${spec.agent}: off); no windows start` : heavyReason ? heavyReason : unmetNow.length > 0
          ? `when ${unmetNow.join(', ')} ${unmetNow.length === 1 ? 'has' : 'have'} a report${full ? ` and a ${spec.agent} window is free` : ''}`
          : full
          ? `waits for a free ${spec.agent} window (${load[spec.agent]} running${ahead[spec.agent] > 0 ? `, ${ahead[spec.agent]} queued ahead` : ''}, limit ${limit})`
          : 'at the next watch tick (a window is free)'
      }`,
    );
    if (spec.review) lines.push(`  review:   auto -> ${spec.task}-REV after the confirmed author report; another provider, else another configured model; rerun=${Boolean(spec.review.rerun)}`);
    lines.push(`  prompt:   ${spec.prompt.length} characters`);
    if (spec.reviewOf && spec.after.length === 0 && !hasReport(rows.find((r) => r.task === spec.reviewOf))) {
      lines.push(`  hint:     ${spec.task} reviews ${spec.reviewOf}, which has no report yet: add "after: ${spec.reviewOf}" to the header so the review starts when the author's report is ready`);
    }
    if (spec.remoteControl) lines.push('  remote:   Remote Control on: the session is named after the task in the Claude app');
    if (spec.pin) lines.push('  pin:      stays on this provider (it is never switched by the queue either)');
    load[spec.agent]++;
  }
  return lines;
}

/** Write the entries (one per spec). Returns them in the order they were added. */
export async function commitQueueAdd(ctx: Context, items: QueueAddItem[], opts: { agent?: AgentName; reuse?: boolean; autoReview?: AutoReviewSource; direct?: { noAgent: boolean } } = {}): Promise<QueueEntry[]> {
  const { config, runner } = ctx;
  // A link into the task's own worktree cannot exist before the start made it (the same exception `new` makes).
  for (const { spec } of items) checkLinkTargets(opts.direct ? spec.links.filter((l) => !spec.repos.some((r) => l.to === r.worktree || l.to.startsWith(`${r.worktree}/`))) : spec.links, spec.task);
  const existing = readQueue(config);
  let seq = existing.reduce((n, e) => Math.max(n, e.seq), 0);
  const added: QueueEntry[] = [];
  for (const { raw, spec } of items) {
    seq++;
    const author = spec.reviewOf ? items.find(i => i.spec.task === spec.reviewOf)?.spec ?? existing.find(e => e.direct && e.task === spec.reviewOf) : undefined;
    const entry: QueueEntry = {
      seq,
      task: spec.task,
      ...(opts.reuse ? { reuse: true } : {}),
      ...(opts.autoReview ? { autoReview: opts.autoReview } : {}),
      ...(opts.direct ? { direct: true, ...(opts.direct.noAgent ? { noAgent: true } : {}) } : {}),
      ...(opts.direct && author ? { directAuthor: author.task, directAuthorOrder: { agent: author.agent, model: author.model } } : {}),
      order: seq,
      priority: opts.direct ? 'high' : spec.priority,
      status: 'queued',
      queuedAt: new Date(runner.now()).toISOString(),
      agent: spec.agent,
      model: spec.model,
      effort: spec.effort,
      after: spec.after,
      ...(spec.afterVerdicts ? { afterVerdicts: spec.afterVerdicts } : {}),
      spec: renderRawSpec(raw),
    };
    if (opts.agent) entry.agentOverride = opts.agent;
    if (spec.reviewOf) entry.reviewOf = spec.reviewOf;
    if (spec.cohort) entry.cohort = (await touchCohort(ctx, spec.cohort)).name;
    // A removed entry may have left a cancellation record and delivery/session sidecars.
    // Keep that attempt as history, then install a fresh, never-launched record before publishing the queue entry.
    const previous = readTaskRecord(config, spec.window);
    if (previous?.cancelled) {
      const history = path.join(config.stateDir, '.history');
      await runner.mkdir(history);
      await runner.rename(taskDir(config, spec.window), path.join(history, `${spec.window}-${randomUUID()}`));
      const fresh = recordFromSpec(spec, config, runner.now());
      fresh.started = '';
      fresh.promptDelivery = 'launching';
      await runner.mkdir(taskDir(config, spec.window));
      await runner.writeFile(taskFile(config, spec.window), renderTaskMd(fresh, spec.prompt));
    }
    await writeEntry(ctx, entry);
    added.push(entry);
  }
  return added;
}

// ---- explicit starts handed to the watcher

const workerFile = (config: Pick<GlobalConfig, 'stateDir'>): string => path.join(config.stateDir, 'queue-worker.json');

/** Every tick of the watcher says it is there: the MCP `new` only hands a start over to a watcher that is alive. */
async function touchWorker(ctx: Context): Promise<void> {
  if (ctx.runner.dryRun) return;
  try { await ctx.runner.writeFile(workerFile(ctx.config), JSON.stringify({ pid: process.pid, at: ctx.runner.now(), interval: ctx.config.watch.interval })); } catch { /* the heartbeat is not worth a failed tick */ }
}

/** The watcher (its queue tick) has run recently and its process is alive. */
export function watchAlive(config: Pick<GlobalConfig, 'stateDir' | 'watch' | 'queue'>, nowMs: number): boolean {
  if (!config.queue.enabled) return false;
  try {
    const beat = JSON.parse(fs.readFileSync(workerFile(config), 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof beat.pid !== 'number' || typeof beat.at !== 'number' || nowMs - beat.at > Math.max(180_000, config.watch.interval * 8000)) return false;
    process.kill(beat.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The start of `task` that is already handed to the watcher (any state), if there is one. */
export function findDirectStart(config: Pick<GlobalConfig, 'path'>, task: string): QueueEntry | undefined {
  return readQueue(config).find((e) => e.direct && e.task.toLowerCase() === task.toLowerCase());
}

/** Only legacy command/error text and its environment assignments supply diagnostic secrets, never task metadata or prompts. */
export function queueDiagnosticSources(entries: QueueEntry[]): string[] {
  return entries.flatMap(entry => {
    const sources = entry.error ? [entry.error] : [];
    try {
      for (const { header } of splitSpecs(entry.spec, 'queue diagnostic redaction')) {
        if (header.env && typeof header.env === 'object') {
          for (const [key, value] of Object.entries(header.env)) if (typeof value === 'string') sources.push(`${key}=${JSON.stringify(value)}`);
        }
        const commands = [header.setup, ...(Array.isArray(header.repos) ? header.repos.map(repo => repo && typeof repo === 'object' ? repo.setup : undefined) : [])];
        for (const setup of commands) if (Array.isArray(setup)) for (const command of setup) if (typeof command === 'string') sources.push(command);
      }
    } catch { /* Malformed legacy specs cannot supply structured setup commands; error text still can. */ }
    return sources;
  });
}

/** What a repeated `new` of the same task is told: where the start stands, and that nothing was started a second time. */
export function directStartText(config: Pick<GlobalConfig, 'path' | 'stateDir'>, entry: QueueEntry, nowMs: number): string {
  const entries = readQueue(config);
  const redact = secretRedactor([config, process.env, ...queueDiagnosticSources([...entries, entry])]);
  if (entry.status === 'failed') {
    return `${entry.task}: the start failed – ${firstLine(redact(entry.error ?? 'n/d'))}. The worktrees were kept. Read queue_list, fix the cause, then queue_retry ${entry.task} (new is refused for a task that is in the queue). Nothing was started again.`;
  }
  return `${entry.task}: ${startProgressText(entry.status === 'starting' ? readSetupProgress(config, entry.task, queueDiagnosticSources(entries)) : undefined, nowMs).replace(/^uruchamiane – /, 'already being started – ')}. Nothing was started a second time. Follow it with events_since (SETUP / START / BŁĄD STARTU) and status or queue_list.`;
}

/**
 * The MCP `new` for a task with setup: write the start as an entry the watcher picks up at its next tick, and return. The checkout, the setup
 * commands and the window are the watcher's (the same path as a queued task), so they outlive the chat and its MCP server. Under the start lock,
 * so two calls for the same task make one entry.
 */
export async function registerDirectStart(ctx: Context, items: QueueAddItem[], opts: { agent?: AgentName; reuse?: boolean; noAgent?: boolean } = {}): Promise<{ added: QueueEntry[]; existing: QueueEntry[] }> {
  return withStartLock(ctx, async () => {
    const existing = items.map(({ spec }) => findDirectStart(ctx.config, spec.task)).filter((e): e is QueueEntry => e !== undefined);
    if (existing.length > 0) {
      if (existing.length !== items.length) throw new AgentctlError(`Mixed new batch: already registered tasks: ${existing.map(e => e.task).join(', ')}`, 'Nothing was added. Preview only the new tasks separately.');
      return { added: [], existing };
    }
    const added = await commitQueueAdd(ctx, items, { ...(opts.agent ? { agent: opts.agent } : {}), ...(opts.reuse ? { reuse: true } : {}), direct: { noAgent: Boolean(opts.noAgent) } });
    return { added, existing: [] };
  });
}

/** Registration preserves the author relationship, but only the eventual TASK.md can validate the effective provider/model. */
function directAuthorState(config: GlobalConfig, entry: QueueEntry, entries: QueueEntry[]): { waiting?: string; failed?: string } {
  if (!entry.directAuthor) return {};
  const author = entries.find(e => e.task === entry.directAuthor);
  if (author?.status === 'failed') return { failed: `author ${author.task} start failed: ${author.error ?? 'unknown reason'}. Fix and retry the author, then queue_retry ${entry.task}.` };
  if (findRecordAnywhere(config, entry.directAuthor)) return {};
  if (entry.noAgent && entry.authorPrepared && entry.directAuthorOrder) return {};
  if (author) return { waiting: `waiting for author ${entry.directAuthor}: setup in progress` };
  return { failed: `author ${entry.directAuthor} has no task record and its registered start was removed. Restore the author, then queue_retry ${entry.task}.` };
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
  // A leftover live window of the cancelled task (a start that failed before the agent became ready) would mask the
  // cancelled state in status — an idle prompt reads as "waiting". It is the cancelled task's window: it goes too.
  const record = readTaskRecord(ctx.config, windowName(entry.task));
  if (record && (await ctx.tmux.windows()).some((w) => w.plain === record.window)) {
    if ((await ctx.tmux.killWindow(record.window)).code === 0) {
      await recordJournal(ctx, { kind: 'cancelled', task: entry.task, text: `${entry.task}: removed from the queue (cancelled); the leftover window of the start was closed`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
    }
  }
  await dropEntry(ctx, entry);
  return entry;
}

/** `agentctl unblock`: the entry's `after` loses the cancelled (or blocked) tasks, or just `dropAfter`; it waits for the rest, or starts. */
export async function unblockEntry(ctx: Context, input: string, opts: { dropAfter?: string | undefined; preview?: boolean } = {}): Promise<{ entry: QueueEntry; dropped: string[] }> {
  const entry = findEntry(ctx.config, input);
  const rows = await collectStatus(ctx, { progress: false, archived: true });
  const blocked = findBlocked(readQueue(ctx.config), rows).get(entry.task);
  let dropped: string[];
  if (opts.dropAfter !== undefined) {
    const wanted = opts.dropAfter.trim().toLowerCase();
    dropped = entry.after.filter((t) => t.toLowerCase() === wanted);
    if (dropped.length === 0) throw new AgentctlError(`${entry.task} does not wait for ${opts.dropAfter}`, entry.after.length > 0 ? `Its after: ${entry.after.join(', ')}` : `${entry.task} has no after.`);
  } else {
    if (!blocked) throw new AgentctlError(`${entry.task} is not blocked`, entry.after.length > 0 ? `It waits for ${entry.after.join(', ')}; "agentctl unblock ${entry.task} --drop-after <task>" removes one of them.` : undefined);
    dropped = [...blocked.cancelled, ...blocked.blocked, ...(blocked.verdicts ?? []).map(v => v.task)];
  }
  const after = entry.after.filter((t) => !dropped.includes(t));
  const raw = splitSpecs(entry.spec, `queue entry ${entry.task}`)[0] as RawSpec;
  const afterVerdicts = Object.fromEntries(Object.entries(entry.afterVerdicts ?? {}).filter(([t]) => after.includes(t)));
  if (after.length > 0) raw.header.after = after.map(t => afterVerdicts[t] ? { task: t, verdict: afterVerdicts[t] } : t);
  else delete raw.header.after;
  const updated: QueueEntry = { ...entry, after, afterVerdicts, spec: renderRawSpec(raw) };
  if (entry.blockedNotified) updated.blockedNotified = entry.blockedNotified.filter((t) => after.includes(t));
  if (updated.blockedNotified?.length === 0) delete updated.blockedNotified;
  if (!opts.preview) await writeEntry(ctx, updated);
  return { entry: updated, dropped };
}

/**
 * Once per cancelled author: "NC-3 zablokowane – NC-1 anulowane". The entries remember what was announced, so a restart of the watcher
 * says nothing twice. Returns the announcements made.
 */
export async function announceBlocked(ctx: Context, notifier: Notifier, rows: readonly StatusRow[], opts: { self?: SelfArgv | undefined; log?: (line: string) => Promise<void> | void } = {}): Promise<string[]> {
  const entries = readQueue(ctx.config);
  const blocked = findBlocked(entries.map((e) => ({ ...e, after: effectiveAfter(ctx.config, e, rows, ctx.runner.now()) })), rows);
  const said: string[] = [];
  for (const entry of entries) {
    const b = blocked.get(entry.task);
    const reasons = b ? [...b.cancelled.map(task => ({ key: task, text: `${task} anulowane` })), ...(b.verdicts ?? []).map(v => ({ key: `${v.task}:${v.reason}`, text: `${v.task}: ${v.reason}` }))] : [];
    const fresh = reasons.filter(r => !(entry.blockedNotified ?? []).includes(r.key));
    if (!b || fresh.length === 0) continue;
    await writeEntry(ctx, { ...entry, blockedNotified: [...(entry.blockedNotified ?? []), ...fresh.map(r => r.key)] });
    for (const reason of fresh) {
      const text = `${entry.task} zablokowane – ${reason.text}`;
      await opts.log?.(`queue: ${text}`);
      await notifyPlain(ctx, notifier, entry.task, text, opts.self);
      await recordJournal(ctx, { kind: 'blocked', task: entry.task, text, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
      said.push(text);
    }
  }
  return said;
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
  return withStartLock(ctx, () => retryEntryLocked(ctx, input));
}
async function retryEntryLocked(ctx: Context, input: string): Promise<QueueEntry> {
  const original = findEntry(ctx.config, input);
  let entry = original;
  if (entry.status !== 'failed') throw new AgentctlError(`${entry.task} is ${entry.status}, not failed`);
  // An old-format automatic review is rebuilt BEFORE any residue check: the residue it complains about is the author's checkout it must not use.
  if (entry.autoReview) entry = await rebuildAutoReview(ctx, entry, { write: false });
  const spec = resolveSpec(splitSpecs(entry.spec, `queue entry ${entry.task}`)[0] as RawSpec, { config: ctx.config });
  await checkRetryWorktrees(ctx.runner, spec.repos);
  const highest = readQueue(ctx.config).reduce((n, e) => Math.max(n, e.order, e.seq), 0);
  const { failedAt: _f, error: _e, startingAt: _s, ...rest } = entry;
  const again: QueueEntry = { ...rest, status: 'queued', order: highest + 1, ...(entry !== original && !entry.reuse ? {} : { reuse: true }) };
  if (entry !== original && entry.autoReview) await syncReviewLedger(ctx, entry.autoReview.author, entry.task, entry.autoReview.heads);
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
  | { kind: 'blocked'; text: string; blockers: Blockers }
  | { kind: 'slot'; text: string }
  | { kind: 'hold'; text: string }
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
export function describeQueue(config: GlobalConfig, entries: QueueEntry[], live: { window?: string; agent?: AgentName; counted?: boolean }[], rows: StatusRow[] = [], nowMs: number = Date.now()): QueueView[] {
  const redact = secretRedactor([config, process.env, ...queueDiagnosticSources(entries)]);
  const failed = new Set(entries.filter((e) => e.status === 'failed').map((e) => e.task));
  const used: Record<AgentName, number> = perProvider(activeProviders(config), () => 0);
  for (const w of live) if (w.agent && w.counted !== false) used[w.agent]++;
  const paused = isPaused(config) || !config.queue.enabled;
  const reason = !config.queue.enabled ? 'queue.enabled is false' : 'queue paused (agentctl queue resume)';
  const blocked = findBlocked(entries.map((e) => ({ ...e, after: effectiveAfter(config, e, rows, nowMs) })), rows);
  const cancelled = cancelledTasks(rows);
  // `usage.queue_hold`: a provider whose plan is above the limit starts nothing (off by default).
  const holds = queueHolds(config, nowMs);
  const heavy = heavyBudget(config, entries, live);
  let position = 0;
  return entries.map((entry): QueueView => {
    if (entry.status === 'failed') return { position: null, entry, condition: { kind: 'failed', text: `failed: ${(entry.error ?? '').split('\n')[0] ?? ''}` }, since: entry.failedAt ?? entry.queuedAt };
    if (entry.status === 'starting') return { position: null, entry, condition: { kind: 'starting', text: entry.direct || readSetupProgress(config, entry.task, queueDiagnosticSources(entries)) ? startProgressText(readSetupProgress(config, entry.task, queueDiagnosticSources(entries)), nowMs) : 'starting' }, since: entry.startingAt ?? entry.queuedAt };
    position++;
    const heavyReason = heavyWait(config, isHeavy(entry), heavy.size);
    if (heavyReason) {
      // A waiting heavy also stands in line for a heavy slot: the next heavy must see it in the count.
      heavy.add(entry.task);
      return { position, entry, condition: { kind: 'slot', text: heavyReason }, since: entry.queuedAt };
    }
    const author = directAuthorState(config, entry, entries);
    if (author.waiting || author.failed) return { position, entry, condition: { kind: 'after', text: author.waiting ?? author.failed! }, since: entry.queuedAt };
    if (entry.direct && !(entry.retryAt && Date.parse(entry.retryAt) > nowMs) && !overProviderLimit(config.limits[entry.agent], used[entry.agent])) {
      used[entry.agent]++;
      if (isHeavy(entry)) heavy.add(entry.task);
      return { position, entry, condition: { kind: 'ready', text: config.queue.enabled ? 'uruchamiane – czeka na najbliższy tick watch' : 'queue.enabled is false; the watcher does not start it' }, since: entry.queuedAt };
    }
    const stuck = blocked.get(entry.task);
    if (stuck) return { position, entry, condition: { kind: 'blocked', text: blockedText(stuck), blockers: stuck }, since: entry.queuedAt };
    if (paused) return { position, entry, condition: { kind: 'paused', text: reason }, since: entry.queuedAt };
    if (entry.retryAt && Date.parse(entry.retryAt) > nowMs) return { position, entry, condition: { kind: 'hold', text: `retry at ${entry.retryAt}: ${entry.error ?? ''}` }, since: entry.queuedAt };
    const unmet = unmetAfter(effectiveAfter(config, entry, rows, nowMs), rows, entry.afterVerdicts);
    if (unmet.length > 0) return { position, entry, condition: { kind: 'after', text: waitingText(unmet, failed, cancelled) }, since: entry.queuedAt };
    const waitsFor = authorWaitReason(config, entry.autoReview, rows, nowMs);
    if (waitsFor) return { position, entry, condition: { kind: 'after', text: waitsFor }, since: entry.queuedAt };
    const held = holds[entry.agent];
    if (held) return { position, entry, condition: { kind: 'hold', text: held }, since: entry.queuedAt };
    const limit = config.limits[entry.agent];
    if (overProviderLimit(limit, used[entry.agent])) {
      const text = limit === 'off' ? `${entry.agent} jest wyłączony (limits.${entry.agent}: off)` : `czeka na miejsce: ${entry.agent} ${used[entry.agent]}/${limit}`;
      return { position, entry, condition: { kind: 'slot', text }, since: entry.queuedAt };
    }
    used[entry.agent]++;
    if (isHeavy(entry)) heavy.add(entry.task);
    return { position, entry, condition: { kind: 'ready', text: 'wolne miejsce – start przy najbliższym ticku watch' }, since: entry.queuedAt };
  }).map(view => ({ ...view, condition: { ...view.condition, text: redact(view.condition.text) } }));
}

/** What `status` prints under its table: the waiting tasks and what each one waits for; nothing when the queue is empty. */
export async function queueStatusLines(ctx: Context, cohort?: string): Promise<string[]> {
  const entries = readQueue(ctx.config);
  if (entries.length === 0) return [];
  const all = describeQueue(ctx.config, entries, await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true }));
  // The places in line are those of the whole queue, whatever is shown.
  const views = cohort ? all.filter((v) => v.entry.cohort !== undefined && cohortKey(v.entry.cohort) === cohortKey(cohort)) : all;
  if (views.length === 0) return [];
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
  /** Tasks the plan holds back (`usage.queue_hold`) and the reason last said, so that the log says it once. */
  readonly held = new Map<string, string>();

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

/** Once a live task is pending trust or a startup dialog, delivering, or sent, watch owns it; a failed queue entry must not offer a second start. */
async function liveStartedRecord(ctx: Context, task: string): Promise<TaskRecord | undefined> {
  const record = readTaskRecord(ctx.config, windowName(task));
  if (!record || !['pending', 'sending', 'confirming', 'sent', 'needs-input'].includes(record.promptDelivery ?? '')) return undefined;
  return (await ctx.tmux.windows()).some(w => w.plain === record.window) ? record : undefined;
}

/**
 * A start that died before the agent showed its input (readiness timeout, a startup dialog, the watcher stopped mid-wait) leaves a window
 * nobody watches and a prompt that was never pasted. Close that window — it is untrusted state — so it cannot hold a provider slot; the
 * record keeps its worktree, so the task lands in "to resume". A window waiting for a human (folder trust, prompt_delivery: pending;
 * a startup dialog, prompt_delivery: needs-input) is kept: a human may be answering it and the next watch serves it.
 */
async function closeNeverReadyWindow(ctx: Context, task: string): Promise<boolean> {
  const record = readTaskRecord(ctx.config, windowName(task));
  if (!record || (record.promptDelivery !== 'needs-attention' && record.promptDelivery !== 'launching') || record.deliveryStartedAt) return false;
  if (!(await ctx.tmux.windows()).some((w) => w.plain === record.window)) return false;
  // Record the intentional closure first: the missing window must not surface as a false tmux loss (tmux-loss.ts).
  if (!ctx.runner.dryRun) await ctx.runner.writeFile(expectedCloseFile(ctx.config, record.window), JSON.stringify({ identity: `${record.attemptId ?? record.started}:${record.windowId ?? ''}`, at: new Date(ctx.runner.now()).toISOString() }));
  return (await ctx.tmux.killWindow(record.window)).code === 0;
}

/**
 * One look at the queue: start every waiting entry whose provider has a free window, in turn order. The starts run in the background
 * (a start waits for a human to answer the folder-trust dialog, and the queue must not stand still meanwhile), at most
 * `queue.parallel_starts` at a time. Returns the tasks whose start began. Never changes the provider of a task.
 */
export async function queueTick(ctx: Context, memory: QueueMemory, notifier: Notifier, opts: QueueTickOptions = {}): Promise<string[]> {
  const { config } = ctx;
  await touchWorker(ctx);
  if (!config.queue.enabled) return [];
  // A paused queue starts nothing that waits in line; an explicit start (`direct`) is not in the line.
  const paused = isPaused(config);
  let entries = readQueue(config);
  if (entries.length === 0) return [];
  // Recover the same live-task/failed-entry disagreement left by older watcher versions, even while starts are paused.
  for (const entry of entries) {
    if (entry.status !== 'failed' || !await liveStartedRecord(ctx, entry.task)) continue;
    await dropEntry(ctx, entry);
    await recordJournal(ctx, { kind: 'queue-start', task: entry.task, text: `${entry.task}: usunięto nieaktualny błąd startu z kolejki; okno zadania działa, watch obsługuje oczekujący prompt`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
  }
  entries = readQueue(config);
  const records = new Set([...listTaskRecords(config), ...listArchivedRecords(config)].map((r) => r.task));
  // A start that died with its watcher: the entry says "starting" and nothing here is doing it. Its task exists (the window is up,
  // the prompt may be missing) or not: either way it goes to "failed", where a human decides.
  for (const entry of entries) {
    if (entry.status !== 'starting' || memory.inflight.has(entry.task)) continue;
    if (entry.startingPid) { try { process.kill(entry.startingPid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; } }
    if (records.has(entry.task)) {
      // The record and the queue must not disagree: the entry goes away with the record in place, a leftover never-ready
      // window is closed, and the task (worktree kept) lands in "to resume" like its siblings.
      const closed = await closeNeverReadyWindow(ctx, entry.task).catch(() => false);
      fs.rmSync(entryFile(config, entry), { force: true });
      fs.rmSync(queueLogFile(config, entry), { force: true });
      await recordJournal(ctx, { kind: 'queue-failed', task: entry.task, text: `${entry.task}: the start was interrupted (the watcher stopped before it finished); ${closed ? 'the never-ready window was closed, t' : 't'}he worktree stays – to resume: agentctl resume ${entry.task}`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
    } else await failEntry(ctx, entry, 'the start was interrupted (the watcher stopped before it finished)', notifier, opts, false);
  }
  entries = readQueue(config);
  if (paused && !entries.some(e => e.direct)) return [];
  const live = await liveWindows(ctx);
  const rows = opts.rows ?? (await collectStatus(ctx, { progress: false, archived: true }));
  const used: Record<AgentName, number> = perProvider(activeProviders(config), () => 0);
  for (const w of live) if (w.agent && w.counted !== false) used[w.agent]++;
  // A start in progress whose window is not up yet already holds its place.
  for (const [task, i] of memory.inflight) if (!live.some((w) => w.window === task.toLowerCase())) used[i.agent]++;

  const began: string[] = [];
  const holds = queueHolds(config, ctx.runner.now());
  const stillHeld = new Set<string>();
  for (let entry of waiting(entries)) {
    if (paused && !entry.direct) continue;
    if (entry.retryAt && Date.parse(entry.retryAt) > ctx.runner.now()) continue;
    const author = directAuthorState(config, entry, readQueue(config));
    if (author.failed) { await failEntry(ctx, entry, author.failed, notifier, opts, true); continue; }
    if (author.waiting) continue;
    if (memory.inflight.size >= config.queue.parallelStarts) break;
    if (entry.direct) {
      const room = config.limits[entry.agent];
      if (overProviderLimit(room, used[entry.agent])) continue;
      // A claim that did not begin consumes no provider slot: a heavy-blocked or raced entry must not starve its provider for this tick.
      // Starts run in the background, so a broken setup can fail several entries of one tick — bounded by queue.parallel_starts, each failed once.
      if (await beginStart(ctx, memory, notifier, entry, opts)) { used[entry.agent]++; began.push(entry.task); }
      continue;
    }
    if (entry.autoReview) {
      // A review of an author who was closed or cancelled without a finished report cannot happen by itself: a terminal state, not an endless wait.
      const terminal = authorTerminal(config, entry.autoReview, rows, ctx.runner.now());
      if (terminal) {
        await failEntry(ctx, entry, terminal.text, notifier, opts, true);
        continue;
      }
    }
    if (unmetAfter(effectiveAfter(config, entry, rows, ctx.runner.now()), rows, entry.afterVerdicts).length > 0) continue;
    // An automatic review waits until its author's turn is over (the claim in beginStart checks it again, on fresh state, under the lock).
    const waitsFor = entry.autoReview ? await reviewWaitReason(ctx, entry, rows) : undefined;
    if (waitsFor) {
      stillHeld.add(entry.task);
      if (memory.held.get(entry.task) !== waitsFor) { memory.held.set(entry.task, waitsFor); await opts.log?.(`queue: ${entry.task} ${waitsFor}`); }
      continue;
    }
    const held = holds[entry.agent];
    if (held) {
      stillHeld.add(entry.task);
      if (memory.held.get(entry.task) !== held) {
        memory.held.set(entry.task, held);
        await opts.log?.(`queue: ${entry.task} ${held}`);
      }
      continue;
    }
    const limit = config.limits[entry.agent];
    if (overProviderLimit(limit, used[entry.agent])) continue;
    if (await beginStart(ctx, memory, notifier, entry, opts)) { used[entry.agent]++; began.push(entry.task); }
  }
  for (const task of [...memory.held.keys()]) if (!stillHeld.has(task)) memory.held.delete(task);
  return began;
}

/** Why the review of `entry` has to wait for its author now: its turn is not over, or a git process works in its checkout. */
async function reviewWaitReason(ctx: Context, entry: QueueEntry, rows: StatusRow[]): Promise<string | undefined> {
  const waits = authorWaitReason(ctx.config, entry.autoReview, rows, ctx.runner.now());
  if (waits) return waits;
  const busy = await authorCheckoutBusy(ctx, entry.autoReview!.author);
  return busy ? `czeka na autora ${entry.autoReview!.author}: ${busy}` : undefined;
}

/**
 * The spec of an automatic review is rebuilt from the author's record with the same code that made it (own detached worktree at the author's
 * commits, own report, delta and prompt) when the author committed again or the entry is in the old format. Idempotent; throws when the data
 * to do it safely is not there.
 */
export async function rebuildAutoReview(ctx: Context, entry: QueueEntry, opts: { write: boolean; log?: QueueTickOptions['log'] }): Promise<QueueEntry> {
  if (!entry.autoReview) return entry;
  const head = async (repoPath: string, branch: string): Promise<string | undefined> => {
    const r = await ctx.runner.exec('git', ['-C', repoPath, 'rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], { readOnly: true });
    return r.code === 0 && /^[a-f0-9]{40}$/i.test(r.stdout.trim()) ? r.stdout.trim() : undefined;
  };
  const result = await repinReview(ctx, splitSpecs(entry.spec, `queue entry ${entry.task}`)[0] as RawSpec, entry.autoReview, Boolean(entry.reuse), head);
  if (!result) return entry;
  const { reuse: _drop, ...rest } = entry;
  const updated: QueueEntry = { ...rest, spec: renderRawSpec(result.raw), autoReview: result.autoReview, ...(result.reuse ? { reuse: true } : {}) };
  if (opts.write) {
    await writeEntry(ctx, updated);
    await syncReviewLedger(ctx, result.autoReview.author, entry.task, result.autoReview.heads);
    await recordJournal(ctx, { kind: 'review-repinned', task: entry.task, text: `${entry.task}: ${result.reason}; ${result.autoReview.delta}`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
    await opts.log?.(`queue: ${entry.task} ${result.reason}`);
  }
  return updated;
}

async function beginStart(ctx: Context, memory: QueueMemory, notifier: Notifier, initial: QueueEntry, opts: QueueTickOptions): Promise<boolean> {
  const { config } = ctx;
  let entry = initial;
  const claim = async (fresh: QueueEntry): Promise<boolean> => {
    if (heavyWait(config, isHeavy(fresh), heavyBudget(config, readQueue(config), await liveWindows(ctx)).size)) return false;
    await writeEntry(ctx, { ...fresh, status: 'starting', startingPid: process.pid, startingAt: new Date(ctx.runner.now()).toISOString() });
    entry = fresh;
    return true;
  };
  const claimed = await withStartLock(ctx, async () => {
    const fresh = readQueue(config).find(e => e.seq === entry.seq && e.task === entry.task);
    if (!fresh || fresh.status !== 'queued') return false;
    const author = directAuthorState(config, fresh, readQueue(config));
    if (author.failed) { await failEntry(ctx, fresh, author.failed, notifier, opts, true); return false; }
    if (author.waiting) return false;
    if (!fresh.autoReview) return claim(fresh);
    // The review starts on the author's state as it is NOW: under the lock that send/enqueuePrompt takes, a follow-up cannot slip in between the check and the claim.
    const authorWindow = findAuthorRecord(config, fresh.autoReview.author)?.window ?? windowName(fresh.autoReview.author);
    return withFileLock(`${promptQueueFile(ctx, authorWindow)}.lock`, async () => {
      try {
        // The last read before the claim is the status: whatever the checks below took time for, the decision is on the state as it is now.
        const busy = await authorCheckoutBusy(ctx, fresh.autoReview!.author);
        const rows = await collectStatus(ctx, { progress: false, archived: true });
        const terminal = authorTerminal(config, fresh.autoReview, rows, ctx.runner.now());
        if (terminal) { await failEntry(ctx, fresh, terminal.text, notifier, opts, true); return false; }
        if (unmetAfter(effectiveAfter(config, fresh, rows, ctx.runner.now()), rows, fresh.afterVerdicts).length > 0) return false;
        const waits = authorWaitReason(config, fresh.autoReview, rows, ctx.runner.now()) ?? (busy ? `czeka na autora ${fresh.autoReview!.author}: ${busy}` : undefined);
        if (waits) { await opts.log?.(`queue: ${fresh.task} ${waits}`); return false; }
        return claim(await rebuildAutoReview(ctx, fresh, { write: true, ...(opts.log ? { log: opts.log } : {}) }));
      } catch (e) {
        await failEntry(ctx, fresh, e instanceof AgentctlError && e.hint ? `${e.message}\nHint: ${e.hint}` : errorMessage(e), notifier, opts, false);
        return false;
      }
    });
  });
  if (!claimed) return false;
  const starting: QueueEntry = { ...entry, status: 'starting', startingAt: new Date(ctx.runner.now()).toISOString() };
  const log: string[] = [];
  const startCtx = new ContextClass(ctx.runner, config, (l) => void log.push(l));
  const run = async (): Promise<void> => {
    try {
      await opts.log?.(`queue: starting ${entry.task} (${entry.agent})`);
      const raws = splitSpecs(entry.spec, `queue entry ${entry.task}`);
      const spec = resolveSpec(raws[0] as RawSpec, { config });
      // The review invariant (own report, own checkout) is checked by the door every agent window goes through (window-guard).
      if (entry.autoReview) spec.autoReview = entry.autoReview;
      if (entry.reuse) {
        if ((await ctx.tmux.windows()).some(w => w.plain === spec.window)) throw new AgentctlError(`${entry.task}: task window already exists; inspect it instead of retrying`);
        await checkRetryWorktrees(ctx.runner, spec.repos);
      }
      await newTasks(startCtx, [spec], {
        ...(entry.agentOverride ? { agent: entry.agentOverride } : {}),
        noSwitch: true,
        skipAfter: true,
        reuse: Boolean(entry.reuse),
        ...(entry.noAgent ? { noAgent: true, knownAuthors: entry.directAuthor && entry.directAuthorOrder ? new Map([[entry.directAuthor, entry.directAuthorOrder]]) : new Map<string, AgentModel>() } : {}),
        trackStart: true,
        waitTrust: true,
        ...(opts.self ? { self: opts.self } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // no_agent intentionally writes no TASK.md. Commit its successful preparation and dependent metadata under the admission lock.
      await withStartLock(ctx, async () => {
        if (entry.noAgent) for (const dependent of readQueue(config)) {
          if (dependent.noAgent && dependent.directAuthor === entry.task) await writeEntry(ctx, { ...dependent, authorPrepared: true });
        }
        fs.rmSync(entryFile(config, starting), { force: true });
      });
      fs.rmSync(queueLogFile(config, starting), { force: true });
      await opts.log?.(`queue: ${entry.task} started`);
      const done = entry.noAgent ? `Przygotowano ${entry.task} (worktree, setup i linki, bez agenta)` : entry.direct ? `Uruchomiono ${entry.task} (MCP new, setup zakończony)` : `Uruchomiono ${entry.task} z kolejki`;
      await notifyPlain(ctx, notifier, entry.task, done, opts.self);
      await recordJournal(ctx, { kind: 'queue-start', task: entry.task, text: `${done} (${entry.agent})`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
    } catch (e) {
      if (/window limit for .* reached/.test(errorMessage(e))) { await writeEntry(ctx, { ...entry, status: 'queued' }); return; }
      // A never-ready window is untrusted state nobody watches: close it so it cannot hold a slot (the record and its worktree stay).
      const closedLeftover = await closeNeverReadyWindow(ctx, entry.task).catch(() => false);
      if (await liveStartedRecord(ctx, entry.task)) {
        // A trust timeout leaves a live pending task, not a failed start. The ordinary watch delivery path continues it.
        await dropEntry(ctx, starting);
        const text = `${entry.task}: okno zadania działa; watch obsługuje oczekujący prompt po potwierdzeniu dialogu i gotowości agenta`;
        await opts.log?.(`queue: ${text}`);
        await recordJournal(ctx, { kind: 'queue-start', task: entry.task, text, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
        return;
      }
      if (opts.signal?.aborted && readTaskRecord(config, windowName(entry.task))) {
        // The watcher itself stopped mid-wait: not a failure of the task. Record and queue must agree — drop the entry;
        // with its window closed the task lands in "to resume", a window waiting for trust is served by the next watch.
        fs.rmSync(entryFile(config, starting), { force: true });
        fs.rmSync(queueLogFile(config, starting), { force: true });
        await opts.log?.(`queue: ${entry.task} start interrupted (the watcher stopped) – the task is to resume`);
        await recordJournal(ctx, { kind: 'queue-failed', task: entry.task, text: `${entry.task}: the start was interrupted (the watcher stopped before it finished); ${closedLeftover ? 'the never-ready window was closed, t' : 't'}he worktree stays – to resume: agentctl resume ${entry.task}`, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
        return;
      }
      await failEntry(ctx, starting, `${e instanceof AgentctlError && e.hint ? `${e.message}\nHint: ${e.hint}` : errorMessage(e)}${closedLeftover ? '\nThe window that never became ready was closed; the worktree stays. queue_retry starts a fresh window over it.' : ''}`, notifier, opts, !opts.signal?.aborted, log).catch(() => undefined);
    } finally {
      clearSetupProgress(config, entry.task);
      memory.inflight.delete(entry.task);
    }
  };
  memory.inflight.set(entry.task, { agent: entry.agent, promise: run() });
  return true;
}

/** The entry goes to the end of the line as `failed`, with the log of the attempt; no retry loop: `queue retry` is a human's decision. */
async function failEntry(ctx: Context, entry: QueueEntry, error: string, notifier: Notifier, opts: QueueTickOptions, notify: boolean, log: string[] = []): Promise<void> {
  const { config } = ctx;
  const highest = readQueue(config).reduce((n, e) => Math.max(n, e.order, e.seq), 0);
  const { startingAt: _s, retryAt: _r, ...rest } = entry;
  const attempts = [...(entry.attempts ?? []), { at: new Date(ctx.runner.now()).toISOString(), error, transient: transientStartError(error) || (Boolean(entry.autoReview) && /unsafe start residue/.test(error)) }];
  // A review never owns the author's checkout, so a "residue" refusal there is a passing state of the author, not a broken start.
  const passing = Boolean(entry.autoReview) && /unsafe start residue/.test(error);
  const retry = (transientStartError(error) || passing) && attempts.length <= 3 && notify;
  const failed: QueueEntry = { ...rest, attempts, ...(retry ? { retryAt: new Date(ctx.runner.now() + [60_000, 300_000, 900_000][attempts.length - 1]!).toISOString(), reuse: true } : {}), status: retry ? 'queued' : 'failed', failedAt: new Date(ctx.runner.now()).toISOString(), error, order: highest + 1 };
  await writeEntry(ctx, failed);
  await ctx.runner.writeFile(queueLogFile(config, failed), `${log.join('\n')}${log.length > 0 ? '\n' : ''}error: ${error}\n`);
  const safeError = (redactQueue({ ...entry, error }, config) as QueueEntry).error ?? 'n/d';
  const text = retry ? `${entry.task}: start z kolejki – ${firstLine(safeError)}; ponowienie ${attempts.length}/3 o ${failed.retryAt}` : `${entry.task}: start z kolejki nie powiódł się – ${firstLine(safeError)}`;
  await opts.log?.(`queue: ${text}`);
  await recordJournal(ctx, { kind: retry ? 'queue-retry' : 'queue-failed', task: entry.task, text, ...(entry.cohort ? { cohort: entry.cohort } : {}) });
  if (notify) await notifyPlain(ctx, notifier, entry.task, retry ? text : `${text} (agentctl queue retry ${entry.task})`, opts.self);
}

async function notifyPlain(ctx: Context, notifier: Notifier, task: string, text: string, self: SelfArgv | undefined): Promise<void> {
  const alerts = new Alerts(ctx, notifier, { self });
  const { click, text: message } = await alerts.clickFor({ task, window: task.toLowerCase() }, text);
  await notifier.notify('agentctl', message, click).catch(() => undefined);
}

/** Explicit OS/network failures only; spec/path/branch failures are permanent by default. */
export function transientStartError(error: string): boolean {
  if (/ENOENT|not (?:exist|found)|invalid spec|branch.*(?:exists|conflict)|already checked out/i.test(error)) return false;
  return /\b(?:ETIMEDOUT|EAGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN)\b|lock.*(?:busy|temporar)|timed out waiting for .*lock|network.*(?:timeout|temporar)/i.test(error);
}
