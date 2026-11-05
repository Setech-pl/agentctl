import { checkReportPath, readReportText, reportPathWarnings } from './report-path.ts';
import { atomicAppendFile } from './atomic-file.ts';
import { missingLinkTargets, checkLinkTargets } from './links.ts';
import { inspectReport } from './report-state.ts';
import { findBlocked } from './depends.ts';
import { mcpWriteNotice } from './mcp-notify.ts';
import { planMark, markTasks } from './mark.ts';
import type { MarkSelection } from './mark.ts';
import { readOutputs, aggregateOutputs } from './outputs.ts';
import { developmentEnvironment } from './installation.ts';
import { withFileLock as withReportLock } from './file-lock.ts';
import { redactQueue } from './mcp-redact.ts';
import { reportFingerprint } from './report-state.ts';
import { findMcpProcesses, staleProcesses } from './mcp-processes.ts';
import { EXAMPLE_SPEC } from './example.ts';
import { checkRetryWorktrees } from './git.ts';
import { createHash } from 'node:crypto';
import { collectDisk as collectDiskFull, diskLine } from './disk.ts';
import type { DiskReport } from './disk.ts';
import { retryEntry, moveToFront, setPaused, unblockEntry, findEntry, rebuildAutoReview } from './queue.ts';
import { touchCohort, setCohortOf, setNote, planCohortArchive, applyCohortArchive } from './cohort.ts';
import { setHidden } from './hide.ts';
import { archiveClosed, applyArchive, parseAge } from './archive.ts';
import { adoptTask } from './adopt.ts';
import { reportInfo } from './report-detect.ts';
import { managerView, startManager, stopManager } from './manager.ts';
import { runDoctor } from './doctor.ts';
import { sendPhoneTest } from './phone.ts';
import { recordJournal } from './journal.ts';
import type { GcPlan } from './gc.ts';
import { applyGc } from './gc.ts';
import { collectCapacity as collectCapacityFull, capacitySnapshot, snapshotLines } from './capacity.ts';
import { collectGuide } from './guide.ts';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cancelTasks, planCancel } from './cancel.ts';
import { staleWarning, versionOf } from './mcp-processes.ts';
import { stableScript } from './mcp-install.ts';
import { closeTask, closeTasks, planClose } from './close.ts';
import { cohortEntries, cohortRows, findCohort, openCohortTasks, summarizeCohorts } from './cohort.ts';
import { collectOverlaps, collideText } from './collisions.ts';
import { commitQueueAdd, describeQueue, directStartText, findDirectStart, planQueueAdd, readQueue, registerDirectStart, removeFromQueue, waiting, watchAlive } from './queue.ts';
import { readSetupProgress } from './setup-progress.ts';
import { liveWindows, planBatch } from './plan.ts';
import { awayReport, renderAway, setAway } from './away.ts';
import { MCP_WRITE_TOOLS } from './config.ts';
import type { GlobalConfig, McpWriteTool } from './config.ts';
import type { Context } from './context.ts';
import type { SelfArgv } from './events.ts';
import { describeMove, moveTask, planMove } from './move.ts';
import { interruptTask } from './interrupt.ts';
import { newTasks } from './new.ts';
import { peekTask } from './peek.ts';
import { joinReports, markPulled, noReadyMessage, selectReady } from './pull.ts';
import { describeTargets, listTargets, matchTask, resolveRunningTask } from './resolve.ts';
import { sendPrompts } from './send.ts';
import { resolveSpec, splitSpecs } from './spec.ts';
import type { RawSpec } from './spec.ts';
import { collectStatus, shownRows } from './status.ts';
import type { StatusRow } from './status.ts';
import { summarizeSpecs } from './summary.ts';
import { listArchivedRecords, listTaskRecords, readTaskPrompt, setHeaderField, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { computeStats, markTask, parseResult, RESULTS, selectHistory } from './history.ts';
import { collectUsage } from './usage-report.ts';
import { planResume, resumeTasks } from './resume.ts';
import { planGc, renderGc, gcView } from './gc.ts';
import { collectEvents, renderEvents } from './chat-events.ts';
import { applySetLimits, collectLimits, planSetLimits, readReservations, releasePlaces, reservePlaces } from './limits.ts';
import type { LimitAssignments } from './limits.ts';
import { planLine } from './usage-report.ts';
import { openReader, readPlans } from './usage.ts';
import { AGENT_NAMES } from './config.ts';
import { AgentctlError, cohortKey, errorMessage, formatLocalTime, plural, resolvePath } from './util.ts';

/*
 * The tools of `agentctl mcp`. This file is data and functions only: the MCP SDK front (src/mcp/server.ts) registers them.
 *
 * What the chat can reach: the status of the tasks, the last lines of a task window, the report file each task's TASK.md names,
 * and the prompt in TASK.md. Only explicit report/adoption tools accept user-supplied paths. With `mcp.allow` set, the chat can also send a prompt, start tasks
 * from a spec, interrupt, close and move. Never: merge, push, rebase or run a shell command. gc uses only the shared protected plan; report_from/adopt accept explicit user paths.
 */

/** Longest report or prompt that a tool returns (bytes); the chat gets a note when it is cut. */
export const MAX_TEXT_BYTES = 200 * 1024;
/** Longest prompt the chat may send to a window. */
export const MAX_SEND_CHARS = 20_000;
/** Most lines `peek` returns. */
export const MAX_PEEK_LINES = 200;

export interface ToolResult {
  text: string;
  isError?: boolean;
  delivered?: number;
  data?: unknown;
  onDelivered?: () => Promise<void>;
}

export interface McpDeps {
  /** A fresh Context on every call: the config is read again, so a change of `mcp.allow` works at once, without restarting the app. */
  context(out: (line: string) => void): Context;
  /** The desktop notification "czat zlecił: …"; a failure never fails the tool. */
  notify(message: string): Promise<void>;
  /** This very agentctl as a command line, for the hooks of a task started through `new`. */
  self?: SelfArgv | undefined;
  /** What this server process is: the version it loaded, its script, its pid and when it started. Shown by `version` and `status`. */
  server?: ServerInfo | undefined;
  clientId?: string;
  /** Each initialized transport snapshots the client's high-water marks, then consumes independently. */
  eventsSession?: { initialSince: string; markers: Partial<Record<string, string>>; cursors: Partial<Record<string, string>> };
}

export interface ServerInfo {
  version: string;
  script: string;
  pid: number;
  /** ISO time the process started. */
  started: string;
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface McpToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  /** Read tools always work; a write tool works when `mcp.allow` lists it. */
  kind: 'read' | 'write';
  description: string;
  input: S;
  annotations: ToolAnnotations;
  run(deps: McpDeps, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

function def<S extends z.ZodRawShape>(d: McpToolDef<S>): McpToolDef {
  return d as unknown as McpToolDef;
}

const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, isError: true });

/** Run a tool body; an error of agentctl (unknown task, no window …) becomes a tool error with its hint, anything else too. */
/**
 * How long a tool of the chat may wait for the size of the worktrees. The walk of dozens of worktrees with node_modules takes minutes, and no read
 * may wait for it: it runs in the background and the answer carries the last reading (or n/d and "measuring").
 */
const DISK_BUDGET_MS = 1000;
const collectDisk = (ctx: Context, statfs?: undefined, opts: { detail?: boolean; offset?: number; limit?: number } = {}): Promise<DiskReport> => collectDiskFull(ctx, statfs, { ...opts, budgetMs: DISK_BUDGET_MS });
const collectCapacity = (ctx: Context) => collectCapacityFull(ctx, { diskBudgetMs: DISK_BUDGET_MS });

async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof AgentctlError) return fail(e.hint ? `${e.message}\nHint: ${e.hint}` : e.message);
    return fail(`internal error: ${errorMessage(e)}`);
  }
}

export function markdownHeadings(text: string): Array<{ line: number; level: number; title: string }> {
  let fence: { char: string; size: number } | null = null;
  const out: Array<{ line: number; level: number; title: string }> = [];
  for (const [line, raw] of text.split('\n').entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (marker) { if (!fence) fence = { char: marker[0]!, size: marker.length }; else if (marker[0] === fence.char && marker.length >= fence.size) fence = null; continue; }
    if (fence) continue;
    const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) out.push({ line, level: h[1]!.length, title: h[2]!.trim() });
  }
  return out;
}
export function reportSection(text: string, heading: string): string {
  const headings = markdownHeadings(text);
  const start = headings.find(h => h.title.toLowerCase() === heading.trim().toLowerCase());
  if (!start) throw new AgentctlError(`No Markdown section "${heading}"`);
  const end = headings.find(h => h.line > start.line && h.level <= start.level)?.line;
  return text.split('\n').slice(start.line, end).join('\n');
}

export function reportSummary(text: string): string {
  const heading = markdownHeadings(text).find(h => /^(Streszczenie|Summary|Decyzje)$/i.test(h.title))?.title;
  return (heading ? reportSection(text, heading) : text.split('\n').slice(0, 40).join('\n')).slice(0, 1500);
}

function compactStatus(r: StatusRow): string {
  return `${r.task} ${r.agent}/${r.model}/${r.effort} ${r.state} ${r.duration} cohort=${r.cohort ?? 'n/d'} report=${r.report === 'yes' ? 'yes' : r.reportCandidate ? 'candidate' : 'no'} decisions=${r.outputs_pending ? 'oczekuje' : r.decisionsCount ?? 0} actions=${r.outputs_pending ? 'oczekuje' : r.actionsCount ?? 0}${r.reviewOf ? ` review_of=${r.reviewOf} (decyzje i akcje: przegląd ${r.reviewOf})` : ''}${r.promptQueue?.length ? ` messages=${r.promptQueue.length} (${r.promptDelivery ?? 'queued'})` : ''}${r.collide.length ? ` ⚠${r.collide.length}` : ''}${r.question ? ` ? ${r.question}` : ''}${r.state === 'needs-attention' ? `; ${r.hint}` : ''}${!r.reportConfirmed && r.reportSource && path.normalize(r.reportSource) !== path.normalize(r.reportPath) ? `; raport pochodzi z kopii ${r.reportSource} – sprawdź` : ''}`;
}

async function pullSummaries(ctx: Context, rows: StatusRow[], ack = false): Promise<ToolResult> {
  if (!rows.length) return ok('No new reports.');
  const taken: StatusRow[] = [];
  const parts: string[] = [];
  const response = () => {
    const omitted = rows.filter(r => !taken.includes(r)).map(r => r.task);
    return `${taken.length} report summar${taken.length === 1 ? 'y' : 'ies'} delivered (full reports ${ack ? 'explicitly acknowledged' : 'not marked as pulled'}): ${taken.map(r => r.task).join(', ')}. Omitted (remain new): ${omitted.length ? `${omitted.length}: ${omitted.slice(0, 10).join(', ')}${omitted.length > 10 ? ', …' : ''}` : 'none'}.\n\n${parts.join('\n\n')}`;
  };
  for (const row of rows) {
    const r = readReportFile(findRecord(ctx, row.task), { config: ctx.config });
    const reportText = readReportText(ctx.config, findRecord(ctx, row.task), row.reportPath);
    const cut = (text: string, bytes: number) => Buffer.byteLength(text) > bytes ? Buffer.from(text).subarray(0, bytes).toString('utf8') + ' [cut]' : text;
    const first = cut((reportText.split('\n').find(l => l.trim()) ?? 'n/d'), 500);
    const refs = cut(reportText.split('\n').filter(l => /(?:\b(?:SHA|branch|commit)\b|gałąź)/i.test(l)).slice(0, 8).map(l => l.slice(0, 300)).join('\n'), 1000);
    const factSection = (pattern: RegExp) => { const h = markdownHeadings(reportText).find(h => pattern.test(h.title)); return h ? cut(reportSection(reportText, h.title), 600) : 'n/d'; };
    const blockers = cut([factSection(/blok|block|question|pytani|error|błęd/i), ...reportText.split('\n').filter(l => /^(?:[-*]\s*)?(?:BLOKER|BLOCKER|BLOCKED|ERROR|BŁĄD|PYTANIE|QUESTION)\s*[:—-]/i.test(l.trim())).slice(0, 10)].join('\n'), 700);
    const decisions = factSection(/decyzj|decision/i);
    const sha = /`([0-9a-f]{7,40})`/i.exec(reportText)?.[1] ?? /\b(?:SHA|commit)\s*[:=]?\s*`?([0-9a-f]{7,40})\b/i.exec(reportText)?.[1] ?? 'n/d';
    const complete = Buffer.byteLength(reportText) <= 1500;
    const excerpt = reportSummary(reportText).split('\n').filter((line, i) => i > 0 || line.trim() !== first.trim()).join('\n');
    const outputData = { outputs: row.outputs ?? null, outputs_valid: row.outputs_valid ?? false, outputs_partial: row.outputs_partial ?? false, outputs_errors: row.outputs_errors ?? [], ...(row.outputs_pending ? { outputs_pending: true } : {}) };
    const part = `=== ${row.task} ===\nattempt: ${row.attemptId ?? row.attempt ?? 'n/d (legacy)'}\npath: ${row.reportPath}\nbytes: ${r.bytes}\n${JSON.stringify(outputData)}\nsha: ${sha}\ntruncated: ${!complete}\n${complete ? reportText : `verdict: ${first}\nblockers: ${blockers}\ndecisions: ${decisions}\n${refs}\n${cut(excerpt, 3000)}\n[excerpt; get_report section/offset/limit reads more]`}`;
    parts.push(part); taken.push(row);
    if (responseWireBytes(ok(response())) > ctx.config.mcp.maxResponseKb * 1024 - 512) { if (taken.length > 1) { parts.pop(); taken.pop(); } break; }
  }
  for (const row of taken) await setHeaderField(ctx.runner, taskFile(ctx.config, row.windowName), 'summary_delivered', new Date(ctx.runner.now()).toISOString());
  if (ack) await markPulled(ctx, taken);
  return { ...ok(response()), delivered: taken.length };
}

// ---- finding a task

/** A task with a state file, also a closed or archived one: exact ID (any case) or a unique prefix. */
function findRecord(ctx: Context, arg: string): TaskRecord {
  const live = [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
  const seen = new Set<string>();
  const unique = live.filter((r) => (seen.has(r.window) ? false : (seen.add(r.window), true)));
  const targets = unique.map((r) => ({ task: r.task, window: r.window, alive: false }));
  const match = matchTask(arg, targets);
  if (match.kind === 'many') throw new AgentctlError(`"${arg}" fits more than one task:\n${describeTargets(match.matches).join('\n')}`, 'Use the full task ID.');
  if (match.kind === 'none') throw new AgentctlError(`no task "${arg}"`, 'Call status (all: true lists closed and hidden tasks too).');
  return unique.find((r) => r.window === match.target.window) as TaskRecord;
}

// ---- reading

function statusRowForChat(r: StatusRow): Record<string, unknown> {
  return {
    task: r.task,
    attempt: r.attempt ?? null,
    attempt_id: r.attemptId ?? null,
    summary_delivered: r.summaryDelivered ?? null,
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    state: r.state,
    window: r.window,
    started: r.started,
    startedLocal: r.startedLocal,
    duration: r.duration,
    progress: r.progress?.text ?? null,
    report: r.report === 'yes' ? 'yes' : r.reportCandidate ? 'candidate' : 'no',
    prompt_delivery: r.promptDelivery ?? null,
    prompt_queue: r.promptQueue ?? [],
    decisions: r.decisionsCount ?? 0,
    actions: r.actionsCount ?? 0,
    outputs_valid: r.outputs_valid ?? null,
    outputs_pending: r.outputs_pending ?? false,
    review_of: r.reviewOf ?? null,
    outputs_partial: r.outputs_partial ?? false,
    outputs_errors: r.outputs_errors ?? [],
    reportCandidate: r.reportCandidate ?? null,
    reportSource: r.reportSource ?? null,
    reportConfirmed: r.reportConfirmed ?? null,
    reportPath: r.reportPath,
    reportPulled: r.pulled !== null,
    lastLine: r.lastLine,
    question: r.question,
    hint: r.hint,
    cohort: r.cohort,
    collisions: r.collide.length,
    collidesWith: r.collide,
    usage_hint: r.usage_hint ?? null,
    draft_input: r.draft_input ?? null,
    finished: r.finished,
    hidden: r.hidden && !r.closed,
    closed: r.closed,
    cancelled: r.cancelled,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    archived: r.archived,
  };
}

/** "3 tasks: 1 working, 1 report-ready, 1 waiting" and what is not shown. */
export function statusLine(shown: StatusRow[], hiddenCount: number): string {
  const counts = new Map<string, number>();
  for (const r of shown) counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
  const parts = [...counts].map(([state, n]) => `${n} ${state}`);
  const base = shown.length === 0 ? 'No tasks' : `${shown.length} task${shown.length === 1 ? '' : 's'}: ${parts.join(', ')}`;
  return hiddenCount > 0 ? `${base} (${hiddenCount} hidden or closed not shown; all: true lists them)` : base;
}

async function runStatus(deps: McpDeps, args: { all?: boolean | undefined; cohort?: string | undefined; detail?: boolean; offset?: number; limit?: number }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const all = Boolean(args.all);
  const cohort = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
  const everyRow = await collectStatus(ctx, { archived: all });
  const rows = cohort === undefined ? everyRow : cohortRows(everyRow, cohort);
  const shown = shownRows(rows, all);
  // The queue and the collisions come as short lines before the rows (queue_list and overlap have the detail).
  const extra: string[] = [];
  if (cohort !== undefined) extra.push(`Cohort ${cohort}: only its tasks are listed.`);
  const views = (await queueViews(ctx)).filter((v) => cohort === undefined || cohortEntries([v.entry], cohort).length > 0);
  if (views.length > 0) {
    extra.push(`Queue (${views.length}): ${views.map((v) => `${v.entry.task} – ${v.condition.text}`).join('; ')}. queue_list has the detail.`);
  }
  extra.push(...serverLines(deps, ctx));
  extra.push(planSummary(ctx));
  const colliding = shown.filter((r) => r.collide.length > 0);
  if (colliding.length > 0) extra.push(`⚠${colliding.length} tasks overlap; overlap has details.`);
  extra.push(awayLine(ctx));
  extra.push(diskLine(await collectDisk(ctx)));
  return { text: [statusLine(shown, rows.length - shown.length), ...extra, ...shown.map(compactStatus)].join('\n'), data: { disk: await collectDisk(ctx, undefined, args), tasks: shown.map(statusRowForChat) } };
}

/** "Away: on since …; the phone gets the notifications" - what the chat should know about the phone. */
function awayLine(ctx: Context): string {
  const r = awayReport(ctx.config);
  const state = r.on ? `ON${r.since ? ` since ${r.since}` : ''} (set by ${r.by})` : 'off';
  const phone = !r.phoneConfigured ? 'no phone is set up' : r.phoneActive ? 'the phone gets the notifications' : 'the phone is quiet';
  return `Away: ${state}; ${phone}${r.always ? ' (notify.ntfy.always)' : ''}. The "away" tool switches it when allowed.`;
}

/** "Plans: claude 5h 62% ↻ 14:30 | codex n/d (…)": the limits of both providers; what is not known says n/d. usage has the detail. */
function planSummary(ctx: Context): string {
  const reader = openReader(ctx.config);
  const now = ctx.runner.now();
  const plans = readPlans(ctx.config, reader, now);
  reader.save();
  return `Plans: ${AGENT_NAMES.map((p) => `${p} ${planLine(plans[p], now)}`).join(' | ')}. usage has the tokens.`;
}

async function runUsage(deps: McpDeps, args: { cohort?: string | undefined; since?: string | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const cohort = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
  const report = await collectUsage(ctx, { cohort, since: args.since });
  const limits = AGENT_NAMES.map((p) => `${p}: ${planLine(report.plans[p], report.now)}`).join('; ');
  return ok(`Plan limits - ${limits}. Tokens = input + output + cache writes of the tasks agentctl started (cache reads are listed apart); period: days since ${report.sinceDay}.\n\n${JSON.stringify(report, null, 2)}`);
}

async function runLog(deps: McpDeps, args: { cohort?: string | undefined; since?: string | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const cohort = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
  const rows = selectHistory(ctx, { since: args.since, cohort });
  if (rows.length === 0) return ok('The history is empty for this filter: a record is written when a report is ready and when a task is closed, cancelled, moved or marked.');
  return ok(`${rows.length} task${rows.length === 1 ? '' : 's'}, newest first. result is what the user marked (null: not marked); tokens null means n/d.\n\n${JSON.stringify(rows, null, 2)}`);
}

async function runStats(deps: McpDeps, args: { cohort?: string | undefined; since?: string | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const cohort = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
  const groups = computeStats(selectHistory(ctx, { since: args.since, cohort }));
  if (groups.length === 0) return ok('The history is empty for this filter.');
  return ok(`Per agent/model/effort. ok, partial and fail count the tasks the user marked; unmarked the rest; moved the tasks handed to the other provider after a limit.\n\n${JSON.stringify(groups, null, 2)}`);
}

async function runMark(deps: McpDeps, args: MarkSelection & { result: string; note?: string }): Promise<ToolResult> {
  return writeTool(deps, 'mark', { task: args.task, detail: args.result }, async (ctx) => {
    const tasks = planMark(ctx, args);
    const marked = await markTasks(ctx, tasks, parseResult(args.result), args.note);
    return { text: marked.map(r => `${r.task}: marked ${r.result}${r.previous && r.previous !== r.result ? ` (was ${r.previous})` : ''}. It is in the history (log, stats).`).join('\n'), executed: true, announce: `mark ${tasks.join(', ')} ${args.result}` };
  });
}

async function runAway(deps: McpDeps, args: { on: boolean }): Promise<ToolResult> {
  return writeTool(deps, 'away', { detail: args.on ? 'on' : 'off' }, async (ctx) => {
    const { state, changed } = await setAway(ctx, args.on, 'mcp');
    return { text: `${changed ? 'Away is' : 'Away was already'} ${state.on ? 'on' : 'off'}.\n${renderAway(awayReport(ctx.config)).join('\n')}`, executed: changed, announce: `away ${state.on ? 'on' : 'off'}` };
  });
}

async function runEventsSince(deps: McpDeps, args: { since?: string | undefined; cohort?: string | undefined; peek?: boolean | undefined; client?: string; cursor?: string; limit?: number }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const shared = args.client ?? ctx.config.mcp.client;
  const client = `mcp:${deps.clientId ?? 'unknown'}:${shared ?? 'default'}`;
  const session = shared === undefined ? deps.eventsSession : undefined;
  const key = args.cohort === undefined ? client : `${client}|cohort:${cohortKey(args.cohort)}`;
  const sessionCursor = session ? (session.cursors[key] ?? session.markers[key] ?? session.markers.mcp ?? session.initialSince) : undefined;
  const report = await collectEvents(ctx, { client, cursor: args.cursor ?? ((!args.since || args.since === 'last') ? sessionCursor : undefined), limit: args.limit, since: args.since, cohort: args.cohort, keep: Boolean(args.peek) });
  if (session && !args.peek) session.cursors[key] = report.next_cursor;
  return { text: renderEvents(report).join('\n'), data: report };
}

async function runGcPreview(deps: McpDeps, args: { older_than?: string | undefined; merged?: boolean | undefined; cohort?: string | undefined; detail?: boolean; offset?: number; limit?: number }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const plan = await planGc(ctx, { olderThan: args.older_than, branches: args.merged, cohort: args.cohort });
  return ok(JSON.stringify({ ...gcView(plan, args), preview: true, execution: ctx.config.mcp.allow.includes('gc') ? 'gc preview then confirm' : 'requires gc in mcp.allow or CLI --apply' }));
}

async function runResume(deps: McpDeps, args: { tasks?: string[] | undefined; all?: boolean | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'resume', { task: args.tasks?.join(', ') ?? 'all', detail: `${args.all ? 'all ' : ''}confirm=${Boolean(args.confirm)}` }, async (ctx, lines) => {
    const plan = await planResume(ctx, args.tasks ?? [], { all: Boolean(args.all) });
    if (plan.items.length === 0) return { text: plan.summary.join('\n'), executed: false, announce: '' };
    if (!args.confirm) return { text: `${plan.summary.join('\n')}\n\nNot resumed yet. Show this to the user and ask; if they agree, call resume again with the same arguments and confirm: true.`, executed: false, announce: '' };
    const results = await resumeTasks(ctx, plan, { self: deps.self });
    return { text: `Resumed: ${results.map((r) => r.task).join(', ')}\n${lines.join('\n')}`.trim(), executed: true, announce: `resume ${results.map((r) => r.task).join(', ')}` };
  });
}

async function runLimits(deps: McpDeps): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const report = collectLimits(ctx.config, await liveWindows(ctx));
  const reserved = readReservations(ctx.config);
  return ok(
    `Limits of simultaneous agents per provider. used = windows of agentctl + reserved places + external sessions (counted only if countExternal is true); free = limit - used; queued = tasks waiting for a place of that provider.\n\n${JSON.stringify({ ...report, reservations: reserved }, null, 2)}`,
  );
}

const limitArg = z.number().int().min(0).max(50).optional();

async function runSetLimits(deps: McpDeps, args: { claude?: number | undefined; codex?: number | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'set_limits', { detail: `claude=${args.claude ?? '-'} codex=${args.codex ?? '-'} confirm=${Boolean(args.confirm)}` }, async (ctx) => {
    const assignments: LimitAssignments = {};
    for (const agent of AGENT_NAMES) if (args[agent] !== undefined) assignments[agent] = args[agent] === 0 ? null : (args[agent] as number);
    if (Object.keys(assignments).length === 0) throw new AgentctlError('give claude and/or codex', '0 removes a limit.');
    const plan = planSetLimits(ctx.config, assignments);
    if (!args.confirm) return { text: `${plan.summary.join('\n')}\n\nNot changed yet. Show this to the user and ask; if they agree, call set_limits again with the same numbers and confirm: true.`, executed: false, announce: '' };
    await applySetLimits(ctx, plan);
    return { text: `Limits changed (${plan.changes.map((c) => `${c.agent} ${c.from ?? '-'} -> ${c.to ?? '-'}`).join(', ')}). They are in force now: a running watch picks the file up and starts waiting tasks at its next tick.`, executed: true, announce: `limity ${plan.changes.map((c) => `${c.agent}=${c.to ?? 'brak'}`).join(' ')}` };
  });
}

async function runReserve(deps: McpDeps, args: { claude?: number | undefined; codex?: number | undefined; note?: string | undefined; release?: boolean | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'reserve', { detail: `${args.release ? 'release ' : ''}claude=${args.claude ?? '-'} codex=${args.codex ?? '-'} confirm=${Boolean(args.confirm)}` }, async (ctx) => {
    const counts: Partial<Record<(typeof AGENT_NAMES)[number], number | undefined>> = {};
    for (const agent of AGENT_NAMES) if (args[agent] !== undefined && args[agent] !== 0) counts[agent] = args[agent];
    if (Object.keys(counts).length === 0) throw new AgentctlError('give claude and/or codex (a number from 1)');
    const what = Object.entries(counts).map(([a, n]) => `${a} ${n}`).join(', ');
    if (!args.confirm) {
      const have = Object.entries(readReservations(ctx.config)).map(([a, r]) => `${a} ${r.count}${r.note ? ` (${r.note})` : ''}`).join(', ') || 'nothing';
      return { text: `${args.release ? 'Release' : 'Reserve'} places: ${what}${args.note ? ` – ${args.note}` : ''}. Reserved now: ${have}. A reserved place counts against the limit, so the queue leaves room for an agent the user starts by hand.\n\nNot done yet. Ask the user, then call reserve again with confirm: true.`, executed: false, announce: '' };
    }
    if (args.release) await releasePlaces(ctx, counts);
    else await reservePlaces(ctx, counts, args.note);
    return { text: `${args.release ? 'Released' : 'Reserved'}: ${what}.`, executed: true, announce: `${args.release ? 'zwolnienie' : 'rezerwacja'} ${what}` };
  });
}

/** The version this server runs and what is wrong with its config: a chat sees both in `status`. */
function serverLines(deps: McpDeps, ctx: Context): string[] {
  const lines: string[] = [];
  if (deps.server) {
    const stable = versionOf(stableScript());
    const dev = developmentEnvironment(ctx.config.path, deps.server.script, stableScript());
    lines.push(`MCP server: agentctl ${deps.server.version} (${deps.server.script}, pid ${deps.server.pid}, started ${deps.server.started})${dev ? ' – środowisko dev' : stable && stable !== deps.server.version ? ` – the stable copy on disk is ${stable}: ${staleNote}` : ''}`);
  }
  for (const w of ctx.config.mcp.warnings) lines.push(`Config warning: ${w}`);
  if (ctx.config.reloadWarning) lines.push(`Config warning: ${ctx.config.reloadWarning}`);
  return lines;
}

const staleNote = 'the user should quit the Claude app (⌘Q) and open it again to load it';

async function runVersion(deps: McpDeps): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const stableVersion = versionOf(stableScript());
  const dev = developmentEnvironment(ctx.config.path, deps.server?.script, stableScript());
  const info = {
    environment: dev ? 'środowisko dev' : 'stable',
    version: deps.server?.version ?? null,
    script: deps.server?.script ?? null,
    pid: deps.server?.pid ?? null,
    started: deps.server?.started ?? null,
    stableCopyVersion: stableVersion ?? null,
    older: !dev && deps.server !== undefined && stableVersion !== undefined && stableVersion !== deps.server.version,
    writeToolsAllowed: ctx.config.mcp.allow,
    configWarnings: [...ctx.config.mcp.warnings, ...(ctx.config.reloadWarning ? [ctx.config.reloadWarning] : [])],
  };
  const note = info.older ? `\n\nThis server runs ${info.version}, the stable copy on disk is ${stableVersion}: ${staleNote}.` : '';
  return ok(`${JSON.stringify(info, null, 2)}${note}`);
}

async function queueViews(ctx: Context): Promise<ReturnType<typeof describeQueue>> {
  const entries = readQueue(ctx.config);
  return entries.length === 0 ? [] : describeQueue(ctx.config, entries, await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true })).map(view => {
    const safe = redactQueue(view.entry, ctx.config) as typeof view.entry;
    const condition = redactQueue({ ...view.entry, error: view.condition.text }, ctx.config) as typeof view.entry;
    return { ...view, entry: { ...view.entry, ...safe }, condition: { ...view.condition, text: condition.error ?? 'n/d' } };
  });
}

async function runQueueList(deps: McpDeps, args: { cohort?: string | undefined } = {}): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const cohort = args.cohort ? findCohort(ctx.config, args.cohort).name : undefined;
  const views = (await queueViews(ctx)).filter((v) => !cohort || cohortEntries([v.entry], cohort).length > 0);
  if (views.length === 0) return ok('The queue is empty.\n\n[]');
  const list = views.map((v) => ({
    position: v.position,
    task: v.entry.task,
    status: v.entry.status,
    retryAt: v.entry.retryAt ?? null,
    attempts: v.entry.attempts ?? [],
    agent: v.entry.agent,
    model: v.entry.model,
    effort: v.entry.effort,
    priority: v.entry.priority,
    after: v.entry.after,
    startCondition: v.condition.text,
    queued: v.entry.queuedAt,
    queuedLocal: formatLocalTime(v.entry.queuedAt),
    error: v.entry.error ?? null,
    cohort: v.entry.cohort ?? null,
    direct: v.entry.direct ?? false,
    setup: v.entry.status === 'starting' ? readSetupProgress(ctx.config, v.entry.task) ?? null : null,
    retryHint: v.entry.status === 'failed' ? `Read error, inspect residue, then queue_retry task=${v.entry.task}` : null,
    blocked: v.condition.kind === 'blocked',
  }));
  const paused = views.some((v) => v.condition.kind === 'paused');
  return ok(`${waiting(views.map((v) => v.entry)).length} waiting in the queue${paused ? ' (the queue is paused: nothing starts)' : ''}; ${views.length - waiting(views.map((v) => v.entry)).length} starting or failed.\n\n${JSON.stringify(list, null, 2)}`);
}

/** `cohort_archive` / `cohort archive`: names, or an age; one of the two. */
async function cohortArchivePlan(ctx: Context, a: { cohorts?: string[] | undefined; older_than?: string | undefined }) {
  if (!a.cohorts?.length && !a.older_than) throw new AgentctlError('name the cohorts to archive, or give older_than (for example 7d)');
  return planCohortArchive(ctx, { ...(a.cohorts?.length ? { names: a.cohorts } : {}), ...(a.older_than ? { olderThanMs: parseAge(a.older_than) } : {}) });
}

async function runCohortList(deps: McpDeps, args: { all?: boolean | undefined } = {}): Promise<ToolResult> {
  const list = (await summarizeCohorts(deps.context(() => {}))).filter((c) => args.all || !c.archived);
  if (list.length === 0) return ok('No cohorts. A task joins one with "cohort: <name>" in its spec.');
  return ok(`${list.length} cohort${list.length === 1 ? '' : 's'}; cohort_show lists the tasks of one.\n\n${JSON.stringify(list, null, 2)}`);
}

async function runCohortShow(deps: McpDeps, args: { cohort: string }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const meta = findCohort(ctx.config, args.cohort);
  const rows = cohortRows(await collectStatus(ctx, { archived: true }), meta.name);
  const views = (await queueViews(ctx)).filter((v) => cohortEntries([v.entry], meta.name).length > 0);
  const queued = views.map((v) => ({ task: v.entry.task, position: v.position, startCondition: v.condition.text, blocked: v.condition.kind === 'blocked' }));
  const outputs = aggregateOutputs(rows.filter(r => r.report === 'yes').map(r => ({ task: r.task, reviewOf: r.reviewOf, data: { outputs: r.outputs ?? null, outputs_valid: r.outputs_valid ?? false, outputs_partial: r.outputs_partial ?? false, outputs_errors: r.outputs_errors ?? [], ...(r.outputs_pending ? { outputs_pending: true } : {}) } })));
  const head = { cohort: meta.name, created: meta.created || null, note: meta.note ?? null, tasks: rows.length, queued: queued.length };
  return ok(`${JSON.stringify(head)}\n\n${JSON.stringify({ ...head, tasks: rows.map(statusRowForChat), queued, ...outputs }, null, 2)}`);
}

async function runOverlap(deps: McpDeps, args: { task?: string | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const task = args.task ? findRecord(ctx, args.task).task : undefined;
  const overlaps = await collectOverlaps(ctx, task);
  if (overlaps.length === 0) return ok('No two active tasks change the same files.');
  return ok(`${overlaps.length} colliding pair${overlaps.length === 1 ? '' : 's'}; files changed by both tasks, computed from git now.\n\n${JSON.stringify(overlaps, null, 2)}`);
}

async function runPeek(deps: McpDeps, args: { task: string; lines?: number | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const result = await peekTask(ctx, args.task, args.lines ?? 40);
  return ok(`${result.task}: last ${result.lines.length} lines of its window (agent footer removed)\n\n${result.lines.join('\n')}\nusage_hint: ${result.usage_hint ?? 'n/d'}\ndraft_input: ${result.draft_input ?? 'n/d'}\nprompt_delivery: ${result.promptDelivery ?? 'n/d'}\nprompt_queue: ${JSON.stringify(result.promptQueue ?? [])}`);
}

async function runListReports(deps: McpDeps, args: { all?: boolean | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const all = Boolean(args.all);
  const shown = shownRows(await collectStatus(ctx, { progress: false, archived: all }), all).filter((r) => r.report === 'yes');
  if (shown.length === 0) return ok('No reports.');
  const list = shown.map((r) => {
    let bytes = 0;
    let modified = '';
    try {
      const st = fs.statSync(r.reportPath);
      bytes = st.size;
      modified = st.mtime.toISOString();
    } catch {
      // gone between the listing and now
    }
    return { task: r.task, state: r.state, pulled: r.pulled !== null, bytes, modified, modifiedLocal: formatLocalTime(modified), source: r.reportSource ?? null };
  });
  return ok(`${list.length} report${list.length === 1 ? '' : 's'}; get_report reads one, pull_ready takes the new ones.\n\n${JSON.stringify(list, null, 2)}`);
}

/**
 * The text of the report file that the task's TASK.md names. The path comes from agentctl's own state folder, never from the chat, and a
 * report that is a symbolic link (an agent could have made one) is refused instead of followed.
 */
export interface ReportPage { text: string; bytes: number; truncated: boolean; total_lines: number; offset: number; byte_offset: number; next_offset: number | null; next_byte_offset: number; has_more: boolean; returned_bytes: number; start_byte: number; end_byte: number; signature: string }
export function readReportFile(record: Pick<TaskRecord, 'task' | 'report'> & Partial<Pick<TaskRecord, 'repos'>>, opts: { config?: Pick<GlobalConfig, 'cache'>; section?: string; offset?: number; limit?: number; byte_offset?: number; maxBytes?: number } = {}): ReportPage {
  if (!record.report) throw new AgentctlError(`${record.task} has no report path`);
  let st: fs.Stats;
  try { st = fs.lstatSync(record.report); } catch { throw new AgentctlError(`${record.task} has no report yet`, 'Call peek or wait for it to finish.'); }
  if (!st.isFile() || st.isSymbolicLink()) throw new AgentctlError(`the report of ${record.task} is not a regular file; refusing to read it`);
  const full = opts.config ? readReportText(opts.config, { repos: record.repos ?? [] }, record.report) : fs.readFileSync(record.report, 'utf8');
  const section = opts.section ? reportSection(full, opts.section) : full;
  const lines = section.split('\n');
  const offset = opts.offset ?? 0, byteOffset = opts.byte_offset ?? 0;
  if (offset > lines.length) throw new AgentctlError('report offset is beyond end');
  const original = Buffer.from(section);
  const startByte = Math.min(original.length, opts.byte_offset !== undefined ? byteOffset : Buffer.byteLength(lines.slice(0, offset).join('\n')) + (offset > 0 ? 1 : 0));
  if (byteOffset > original.length) throw new AgentctlError('report byte_offset is beyond end');
  const startLine = opts.byte_offset !== undefined ? (original.subarray(0, startByte).toString('utf8').match(/\n/g) ?? []).length : offset;
  const desiredEnd = Math.min(lines.length, startLine + (opts.limit ?? lines.length));
  const targetEnd = Math.min(original.length, Buffer.byteLength(lines.slice(0, desiredEnd).join('\n')) + (desiredEnd < lines.length ? 1 : 0));
  let end = Math.min(targetEnd, startByte + (opts.maxBytes ?? MAX_TEXT_BYTES - 4096));
  if (end < targetEnd) {
    const boundary = original.lastIndexOf(10, end - 1);
    if (boundary >= startByte) end = boundary + 1;
    else while (end > startByte && (original[end]! & 0xc0) === 0x80) end--;
  }
  const text = original.subarray(startByte, end).toString('utf8');
  const before = original.subarray(0, end).toString('utf8');
  const nextOffset = (before.match(/\n/g) ?? []).length;
  const hasMore = end < original.length;
  return { text, bytes: Buffer.byteLength(full), truncated: hasMore, total_lines: lines.length, offset, byte_offset: byteOffset, next_offset: hasMore ? nextOffset : null, next_byte_offset: end, has_more: hasMore, returned_bytes: end - startByte, start_byte: startByte, end_byte: end, signature: createHash('sha256').update(full).digest('hex') };
}

async function runGetReport(deps: McpDeps, args: { task: string; section?: string; offset?: number; limit?: number; byte_offset?: number }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const record = findRecord(ctx, args.task);
  const row = (await collectStatus(ctx, { progress: false, archived: true })).find(r => r.task === record.task);
  if (row?.report !== 'yes') {
    const state = inspectReport(ctx.config, record, ctx.runner.now(), !record.attemptId);
    throw new AgentctlError(state.reason === 'not a regular report' ? `the report of ${record.task} is not a regular file; refusing to read it` : `${record.task} has no report yet: ${state.reason}`, 'Use report to inspect candidates or wait for completion.');
  }
  const outputs = await readOutputs(ctx, record);
  const render = (r: ReportPage, pulled: boolean): ToolResult => {
    const { text, signature: _signature, ...page } = r;
    return ok(`=== ${record.task} (${record.agent} ${record.model}/${record.effort}) ===\n${text}\n--- page ---\n${JSON.stringify({ ...page, pulled, ...outputs })}`);
  };
  let maxBytes = Math.max(4, Math.floor(ctx.config.mcp.maxResponseKb * 1024) - 800);
  let r = readReportFile(record, { ...args, maxBytes, config: ctx.config });
  while (responseWireBytes(render(r, false)) > ctx.config.mcp.maxResponseKb * 1024 && maxBytes > 4) {
    maxBytes = Math.max(4, Math.floor(maxBytes / 2)); r = readReportFile(record, { ...args, maxBytes, config: ctx.config });
  }
  let pulled = false;
  if (!args.section) {
    const file = path.join(path.dirname(ctx.config.path), 'report-read-progress.json');
    await withReportLock(`${file}.lock`, async () => {
      let reads: Record<string, number> = {};
      try { const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) reads = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v >= 0)); } catch { /* first read */ }
      const key = `${deps.clientId ?? 'direct'}:${record.task}:${record.attemptId ?? record.started}:${r.signature}`;
      const covered = reads[key] ?? 0;
      if (r.start_byte <= covered) reads[key] = Math.max(covered, r.end_byte);
      const current = (await collectStatus(ctx, { archived: true })).find(row => row.task === record.task);
      if (!r.has_more && (reads[key] ?? 0) >= r.bytes && current?.report === 'yes' && current.reportSignature === r.signature) {
        await setHeaderField(ctx.runner, taskFile(ctx.config, record.window), 'pulled', new Date(Math.max(ctx.runner.now(), Math.ceil(fs.statSync(record.report).mtimeMs))).toISOString()); pulled = true;
      }
      const entries = Object.entries(reads).slice(-256);
      await ctx.runner.writeFile(file, JSON.stringify(Object.fromEntries(entries)));
    });
  }
  return render(r, pulled);
}

async function runPullReady(deps: McpDeps, args: { cohort?: string | undefined; all?: boolean | undefined; mode?: string; offset?: number; limit?: number; ack?: boolean; cursor?: string } = {}): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const everyRow = await collectStatus(ctx);
  const rows = args.cohort === undefined ? everyRow : cohortRows(everyRow, findCohort(ctx.config, args.cohort).name);
  const scope = `${args.cohort ?? ''}:${Boolean(args.all)}:${args.mode ?? 'summary'}`;
  let snapshots = reportSelections.get(deps); if (!snapshots) { snapshots = new Map(); reportSelections.set(deps, snapshots); }
  let selection = snapshots.get(scope);
  if (snapshots.size > 64) snapshots.delete(snapshots.keys().next().value!);
  if (!selection || (!args.cursor && !(args.offset ?? 0))) { selection = { id: crypto.randomUUID(), rows: selectReady(rows, Boolean(args.all)) }; snapshots.set(scope, selection); }
  let offset = args.offset ?? 0;
  if (args.cursor) { const [id, index] = args.cursor.split(':'); if (id !== selection.id || !/^\d+$/.test(index ?? '')) throw new AgentctlError('expired or invalid report selection cursor; restart from offset 0'); offset = Number(index); }
  const chosen = selection.rows.slice(offset, offset + (args.limit ?? 100));
  if (chosen.length === 0) return ok(noReadyMessage(rows));
  if (chosen.some(row => { const current = rows.find(r => r.task === row.task); return !current || current.report !== 'yes' || current.attemptId !== row.attemptId; })) throw new AgentctlError('report selection changed; restart at offset 0 before acknowledging');
  if (args.mode !== 'full') { const result = await pullSummaries(ctx, chosen, args.ack); return ok(`${result.text}\nnext_cursor: ${selection.id}:${offset + (result.delivered ?? 0)}; has_more: ${offset + (result.delivered ?? 0) < selection.rows.length}`); }
  if (chosen.length === 0) return ok(noReadyMessage(rows));
  const { text, pulled } = joinReports(chosen, ctx);
  const head = `${pulled.length} new report${pulled.length === 1 ? '' : 's'}; marked as pulled after complete delivery: ${pulled.map(p => p.task).join(', ')}`;
  return { text: `${head}\n\n${text}\nnext_cursor: ${selection.id}:${offset + chosen.length}; has_more: ${offset + chosen.length < selection.rows.length}`, onDelivered: () => markPulled(ctx, chosen) };

}

async function runTaskSpec(deps: McpDeps, args: { task: string }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const record = findRecord(ctx, args.task);
  const prompt = readTaskPrompt(ctx.config, record.window) ?? '(the prompt could not be read)';
  const header = {
    task: record.task,
    agent: record.agent,
    model: record.model,
    effort: record.effort,
    requested: record.requested,
    repos: record.repos.map((r) => ({ path: r.path, worktree: r.worktree, branch: r.branch ?? null, base: r.base ?? null })),
    report: record.report,
    report_source: record.reportSource ?? null,
    started: record.started,
    startedLocal: formatLocalTime(record.started),
    pulled: record.pulled ?? null,
    pulledLocal: record.pulled ? formatLocalTime(record.pulled) : null,
    review_of: record.reviewOf ?? null,
    continues: record.continues ?? null,
    superseded_by: record.supersededBy ?? null,
    pin: record.pin === true,
    closed: record.closed === true,
    cohort: record.cohort ?? null,
    cancelled: record.cancelled === true,
    cancelled_at: record.cancelledAt ?? null,
    cancel_reason: record.cancelReason ?? null,
    // Names only: the values of env may hold secrets.
    env_names: Object.keys(record.env),
  };
  const cut = Buffer.byteLength(prompt) > MAX_TEXT_BYTES;
  const body = cut ? `${Buffer.from(prompt).subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n\n[cut at ${MAX_TEXT_BYTES / 1024} KB]` : prompt;
  return ok(`${JSON.stringify(header, null, 2)}\n\n--- prompt ---\n${body}`);
}

// ---- writing

/** `<config dir>/mcp-audit.log`: one JSON line per write the chat asked for, whether it was done or refused. */
export function auditPath(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(path.dirname(config.path), 'mcp-audit.log');
}

export interface AuditEntry {
  tool: string;
  task?: string | undefined;
  outcome: 'requested' | 'done' | 'error' | 'denied' | 'preview';
  detail?: string | undefined;
}

/** Append to the audit log. A log that cannot be written stops the write: nothing the chat does goes unrecorded. */
function audit(ctx: Context, entry: AuditEntry): void {
  const line = JSON.stringify({ at: new Date(ctx.runner.now()).toISOString(), ...entry });
  try {
    const file = auditPath(ctx.config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicAppendFile(file, `${line}\n`);
  } catch (e) {
    throw new AgentctlError(`cannot write the audit log ${auditPath(ctx.config)}: ${errorMessage(e)}`, 'Nothing was done: writes by the chat are only allowed while they can be recorded.');
  }
}

const clipText = (s: string, n = 200): string => (s.length <= n ? s : `${s.slice(0, n)}… (${s.length} characters)`);

/**
 * The common frame of every write: refused unless `mcp.allow` lists the tool (read again from the config on this call), recorded in
 * the audit log before and after, and announced on the desktop once it was done.
 */
async function writeTool(
  deps: McpDeps,
  tool: McpWriteTool,
  label: { task?: string | undefined; detail?: string | undefined },
  body: (ctx: Context, lines: string[]) => Promise<{ text: string; executed: boolean; announce: string }>,
): Promise<ToolResult> {
  const lines: string[] = [];
  const ctx = deps.context((l) => lines.push(l));
  if (!ctx.config.mcp.allow.includes(tool)) {
    audit(ctx, { tool, task: label.task, outcome: 'denied', detail: 'not in mcp.allow' });
    return fail(
      `Writing is off for "${tool}": it is not in mcp.allow. Nothing was done. ` +
        `The user can allow it in ${ctx.config.path} with: mcp: {allow: [${tool}]} (allowed names: ${MCP_WRITE_TOOLS.join(', ')}).`,
    );
  }
  audit(ctx, { tool, task: label.task, outcome: 'requested', detail: label.detail });
  try {
    const result = await body(ctx, lines);
    audit(ctx, { tool, task: label.task, outcome: result.executed ? 'done' : 'preview' });
    if (result.executed) {
      lastPreviewMutation.set(deps, tool);
      await recordJournal(ctx, { kind: 'mcp-write', text: `${tool}: ${result.announce}` });
      await mcpWriteNotice(ctx, deps.notify.bind(deps), result.announce);
    }
    return ok(result.text);
  } catch (e) {
    audit(ctx, { tool, task: label.task, outcome: 'error', detail: errorMessage(e).split('\n')[0] });
    throw e;
  }
}

async function runSend(deps: McpDeps, args: { task: string; text: string }): Promise<ToolResult> {
  return writeTool(deps, 'send', { task: args.task, detail: clipText(args.text) }, async (ctx, lines) => {
    if (args.text.trim() === '') throw new AgentctlError('the text is empty');
    if (args.text.length > MAX_SEND_CHARS) throw new AgentctlError(`the text is ${args.text.length} characters; the limit is ${MAX_SEND_CHARS}`);
    const target = await resolveRunningTask(ctx, args.task);
    const sent = await sendPrompts(ctx, [{ task: target.task, window: target.window, prompt: args.text }]);
    // sendPrompts reports the same result through ctx.info; the first line already says it.
    const message = `${target.task}: ${sent[0]?.message ?? 'wklejono'}`;
    return { text: `${message} (${args.text.length} characters)\n${lines.filter(l => l !== message).join('\n')}`.trim(), executed: true, announce: `send ${target.task}` };
  });
}

async function runInterrupt(deps: McpDeps, args: { task: string }): Promise<ToolResult> {
  return writeTool(deps, 'interrupt', { task: args.task }, async (ctx) => {
    const target = await resolveRunningTask(ctx, args.task);
    const r = await interruptTask(ctx, target.task);
    return { text: `${r.task}: interrupted (${r.key} sent); the window stays open`, executed: true, announce: `interrupt ${r.task}` };
  });
}

interface CloseMcpArgs { task?: string | undefined; tasks?: string[] | undefined; cohort?: string | undefined; remove_worktree?: boolean | undefined }
async function closeInputs(ctx: Context, args: CloseMcpArgs): Promise<string[]> {
  if (!args.task && !args.tasks?.length && !args.cohort) throw new AgentctlError('give task, tasks or cohort');
  const inputs = args.tasks ?? (args.task ? [args.task] : await openCohortTasks(ctx, findCohort(ctx.config, args.cohort!).name, { queued: false }));
  const targets = await listTargets(ctx);
  const selected = inputs.map((input) => {
    const match = matchTask(input, targets);
    if (match.kind !== 'one') throw new AgentctlError(`no task "${input}" or ambiguous task`);
    return match.target.task;
  });
  if (args.cohort) {
    const cohort = findCohort(ctx.config, args.cohort).name;
    for (const task of selected) if (!cohortRows(await collectStatus(ctx, { archived: true }), cohort).some((r) => r.task === task)) throw new AgentctlError(`${task} does not belong to ${cohort}`);
  }
  return selected;
}
async function runClose(deps: McpDeps, args: CloseMcpArgs): Promise<ToolResult> {
  return writeTool(deps, 'close', { task: args.task ?? args.tasks?.join(', ') ?? args.cohort }, async (ctx, lines) => {
    if (args.remove_worktree && !ctx.config.mcp.allowRmWorktree) throw new AgentctlError('removing the worktree is not allowed for the chat');
    const tasks = await closeInputs(ctx, args);
    await closeTasks(ctx, tasks, { rmWorktree: Boolean(args.remove_worktree) });
    return { text: `${tasks.join(', ')}: closed${args.remove_worktree ? ', worktree removed (the branch stays)' : '; the worktree and the report stay'}\n${lines.join('\n')}`.trim(), executed: true, announce: `close ${tasks.join(', ')}` };
  });
}

async function runMove(deps: McpDeps, args: { task: string; agent?: 'claude' | 'codex' | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'move', { task: args.task, detail: `agent=${args.agent ?? 'other'} confirm=${Boolean(args.confirm)}` }, async (ctx, lines) => {
    const plan = await planMove(ctx, args.task, { agent: args.agent });
    if (!args.confirm) {
      return { text: `${describeMove(plan).join('\n')}\n\nNot moved yet. Ask the user, then call move again with confirm: true.`, executed: false, announce: '' };
    }
    const moved = await moveTask(ctx, args.task, { agent: args.agent, yes: true, self: deps.self });
    return { text: `${lines.join('\n')}`.trim() || `${plan.from.task} moved to ${plan.task}`, executed: moved !== undefined, announce: `move ${plan.from.task} -> ${plan.task}` };
  });
}

/** `setup` runs shell commands: neither the top-level key nor `repos[].setup` is accepted from the chat (a repository's .agentctl.yaml setup still runs). */
const chatSetup = (header: Record<string, unknown>): boolean => 'setup' in header || (Array.isArray(header.repos) && header.repos.some((r) => typeof r === 'object' && r !== null && 'setup' in r));

interface NewMcpArgs { spec: string; confirm?: boolean | undefined; agent?: 'claude' | 'codex' | undefined; reuse?: boolean | undefined; no_agent?: boolean | undefined; cohort?: string | undefined; wait_trust?: boolean | undefined }
async function runNew(deps: McpDeps, args: NewMcpArgs): Promise<ToolResult> {
  const probe = (): { tasks: string } => {
    // Only for the audit line: the task IDs named in the spec, without resolving anything.
    try {
      return { tasks: splitSpecs(args.spec, 'mcp').map((s) => String(s.header.task ?? '?')).join(', ') };
    } catch {
      return { tasks: '?' };
    }
  };
  return writeTool(deps, 'new', { task: probe().tasks, detail: `${clipText(args.spec, 120)} confirm=${Boolean(args.confirm)}` }, async (ctx, lines) => {
    const raws = splitSpecs(args.spec, 'the spec from the chat');
    if (args.cohort) for (const raw of raws) raw.header.cohort = args.cohort;
    for (const raw of raws) {
      // `setup` commands run in a shell. A task the chat starts runs no shell command of the chat's choosing; setup belongs in .agentctl.yaml.
      if (chatSetup(raw.header)) {
        throw new AgentctlError(`${String(raw.header.task ?? 'a task')}: "setup" runs shell commands and is not accepted from the chat`, 'Put setup commands in the .agentctl.yaml of the repository, or start the task from the terminal.');
      }
    }
    const specs = await planBatch(ctx, raws.map((raw) => resolveSpec(raw, { config: ctx.config })), { noSwitch: true, reuse: Boolean(args.reuse), ...(args.agent ? { agent: args.agent } : {}) });
    const cap = !args.confirm && ctx.config.capacity.snapshot ? capacitySnapshot(await collectCapacity(ctx), specs.map((s) => s.agent)) : undefined;
    const disk = await collectDisk(ctx);
    const readyCount = (await liveWindows(ctx)).filter(w => w.reportReady).length;
    // A start with setup commands (an install per repository takes minutes) is not done inside this call: the watcher does it, see below.
    const setupRepos = specs.flatMap((s) => s.repos.filter((r) => (r.setup?.length ?? 0) > 0).map((r) => `${s.task}/${path.basename(r.path)}`));
    const handOver = setupRepos.length > 0;
    const watching = !handOver || watchAlive(ctx.config, ctx.runner.now());
    const summary = summarizeSpecs(specs, [
      ...(!cap && readyCount ? [`${readyCount} ${plural(readyCount, 'okno', 'okna', 'okien')} report-ready – close zwolni okna`] : []),
      ...(cap ? snapshotLines(cap) : []),
      ...(disk.level === 'critical' ? [`WARNING: ${diskLine(disk)}`] : []),
      ...(handOver && watching ? [`Start: asynchronous – confirm returns at once; the watcher does the checkout and the setup of ${setupRepos.join(', ')} within about ${ctx.config.watch.interval} s and the task then shows in status/queue_list as "uruchamiane – setup w toku". Follow it with events_since.`] : []),
      ...(handOver && !watching ? [`WARNING: the setup of ${setupRepos.join(', ')} would take minutes and the watcher is not running (or the queue is disabled): confirm will be refused. Start it with "agentctl watch --tmux".`] : []),
    ]).join('\n');
    if (!args.confirm) {
      return { text: `${summary}\n\nNot started yet. Show this to the user and ask; if they agree, call new again with the same spec and confirm: true.`, executed: false, announce: '' };
    }
    if (handOver) {
      if (!watching) {
        throw new AgentctlError(
          `${specs.map((s) => s.task).join(', ')}: the setup of ${setupRepos.join(', ')} takes minutes and the watcher that would run it is not running`,
          'Nothing was started. Start the watcher ("agentctl watch --tmux" in a terminal, or from the board), then call new again with a fresh preview. A start from the terminal ("agentctl new") runs the setup in place.',
        );
      }
      const { added, existing } = await registerDirectStart(ctx, specs.map((spec, i) => ({ raw: raws[i] as RawSpec, spec })), { reuse: Boolean(args.reuse), noAgent: Boolean(args.no_agent), ...(args.agent ? { agent: args.agent } : {}) });
      if (existing.length > 0) return { text: existing.map((e) => directStartText(ctx.config, e, ctx.runner.now())).join('\n'), executed: false, announce: '' };
      return {
        text: `Registered: ${added.map((e) => `${e.task} (${e.agent} ${e.model}/${e.effort})`).join('; ')}. The ${args.no_agent ? 'worktrees are prepared' : 'task starts'} in the watcher, not in this call: checkout and setup of ${setupRepos.join(', ')} run there and survive a restart of this server or of the app. ` +
          `Follow it with events_since (SETUP, START, BŁĄD STARTU) and status/queue_list ("uruchamiane – setup w toku (repo 1/2 …)"). A failed setup leaves the task failed with its reason and the worktrees; queue_retry tries again. Calling new again for the same task does not start it twice.`,
        executed: true,
        announce: `new ${added.map((e) => e.task).join(', ')}`,
      };
    }
    // The chat cannot answer a folder-trust dialog: stop at it (the error says so) instead of waiting for a person.
    const results = await newTasks(ctx, specs, { waitTrust: args.wait_trust ?? false, noSwitch: true, reuse: Boolean(args.reuse), noAgent: Boolean(args.no_agent), ...(args.agent ? { agent: args.agent } : {}), ...(deps.self ? { self: deps.self } : {}) });
    const startedCap = ctx.config.capacity.snapshot ? capacitySnapshot(await collectCapacity(ctx), results.map((r) => r.effective.agent)) : undefined;
    const started = results.map((r) => r.agentStarted ? `${r.task} (window ${r.window}, ${r.effective.agent} ${r.effective.model}/${r.effective.effort})${r.warning ? '; ' + r.warning : ''}` : `${r.task} (worktrees prepared, no agent started)`).join('; ');
    return { text: `${args.no_agent ? 'Prepared' : 'Started'}: ${started}\n${startedCap ? snapshotLines(startedCap).join('\n') + '\n' : ''}${lines.join('\n')}`.trim(), executed: true, announce: `new ${results.map((r) => r.task).join(', ')}` };
  });
}

async function runQueue(deps: McpDeps, args: { spec: string; agent?: 'claude' | 'codex' | undefined; cohort?: string | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  let tasks = '?';
  try {
    tasks = splitSpecs(args.spec, 'mcp').map((s) => String(s.header.task ?? '?')).join(', ');
  } catch {
    // only for the audit line
  }
  return writeTool(deps, 'queue', { task: tasks, detail: `${clipText(args.spec, 120)} confirm=${Boolean(args.confirm)}` }, async (ctx) => {
    const raws = splitSpecs(args.spec, 'the spec from the chat');
    if (args.cohort) for (const raw of raws) raw.header.cohort = args.cohort;
    for (const raw of raws) {
      if (chatSetup(raw.header)) {
        throw new AgentctlError(`${String(raw.header.task ?? 'a task')}: "setup" runs shell commands and is not accepted from the chat`, 'Put setup commands in the .agentctl.yaml of the repository, or queue the task from the terminal.');
      }
    }
    const opts = args.agent ? { agent: args.agent } : {};
    const plan = await planQueueAdd(ctx, raws, { ...opts, diskBudgetMs: DISK_BUDGET_MS });
    if (!args.confirm) {
      return { text: `${plan.summary.join('\n')}\n${diskLine(await collectDisk(ctx))}\n\nNot queued yet. Show this to the user and ask; if they agree, call queue again with the same spec and confirm: true.`, executed: false, announce: '' };
    }
    const added = await commitQueueAdd(ctx, plan.items, opts);
    const capacity = ctx.config.capacity.snapshot ? snapshotLines(capacitySnapshot(await collectCapacity(ctx), added.map((e) => e.agent))).join('\n') : '';
    return { text: `Queued: ${added.map((e) => e.task).join(', ')}. They start by themselves while "agentctl watch" runs, when a window of their provider is free (queue_list shows the line).${capacity ? `\n${capacity}` : ''}`, executed: true, announce: `queue ${added.map((e) => e.task).join(', ')}` };
  });
}

async function runQueueRm(deps: McpDeps, args: { task: string }): Promise<ToolResult> {
  return writeTool(deps, 'queue_rm', { task: args.task }, async (ctx) => {
    const entry = await removeFromQueue(ctx, args.task, { source: 'mcp' });
    return { text: `${entry.task}: removed from the queue (cancelled)`, executed: true, announce: `queue_rm ${entry.task}` };
  });
}

async function runCancel(deps: McpDeps, args: { tasks?: string[] | undefined; task?: string | undefined; cohort?: string | undefined; reason?: string | undefined; remove_worktree?: boolean | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  const label = args.task ?? args.tasks?.join(', ') ?? (args.cohort !== undefined ? `cohort ${args.cohort}` : '?');
  return writeTool(deps, 'cancel', { task: label, detail: `${args.reason ? `reason=${clipText(args.reason, 80)} ` : ''}${args.remove_worktree ? 'remove_worktree ' : ''}confirm=${Boolean(args.confirm)}` }, async (ctx, lines) => {
    if ([args.task !== undefined, args.tasks !== undefined, args.cohort !== undefined].filter(Boolean).length !== 1) throw new AgentctlError('give either task or cohort', 'cancel takes one task (task) or all open tasks of a cohort (cohort), not both and not neither.');
    if (args.remove_worktree && !ctx.config.mcp.allowRmWorktree) {
      throw new AgentctlError('removing the worktree is not allowed for the chat', `The user can allow it with: mcp: {allow_rm_worktree: true} in ${ctx.config.path}. Without remove_worktree the worktree and the branch stay.`);
    }
    const cohortName = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
    const inputs = args.tasks ?? (args.task !== undefined ? [args.task] : await openCohortTasks(ctx, cohortName as string, { queued: true }));
    if (inputs.length === 0) throw new AgentctlError(`cohort ${cohortName} has no open tasks`, 'Call cohort_show.');
    const opts = { reason: args.reason?.trim() || undefined, rmWorktree: Boolean(args.remove_worktree), source: 'mcp' as const };
    const plan = await planCancel(ctx, inputs, opts);
    if (!args.confirm) {
      return { text: `${plan.summary.join('\n')}\n\nNot cancelled yet. Show this to the user and ask; if they agree, call cancel again with the same arguments and confirm: true.`, executed: false, announce: '' };
    }
    const results = await cancelTasks(ctx, plan, opts);
    const tasks = results.map((r) => r.task).join(', ');
    return { text: `Cancelled: ${tasks}\n${lines.join('\n')}`.trim(), executed: true, announce: `cancel ${tasks}${opts.reason ? ` (${clipText(opts.reason, 80)})` : ''}` };
  });
}

// ---- the registry

const taskArg = z.string().min(1).max(60).describe('Task ID such as NC-42; case does not matter and a unique prefix is enough.');
const cohortArg = z.string().min(1).max(60).describe('Cohort name; case does not matter.');
const allArg = z.boolean().optional().describe('true: also hidden and closed (and archived) tasks. Default false.');

const readOnly = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

const reportSelections = new WeakMap<McpDeps, Map<string, { id: string; rows: StatusRow[] }>>();

export const MCP_TOOLS: McpToolDef[] = [
  def({
    name: 'status',
    title: 'Status of all agent tasks',
    kind: 'read',
    description:
      'Current state of every agentctl task: agent/model/effort, state (working, background, waiting, needs-input, needs-trust, limited, report-ready, dead, orphan, superseded), ' +
      'start time (started in UTC, startedLocal in the user\'s local time: show the local one), running time, git progress, whether a report exists and was already pulled, the last line and the open question of a waiting agent. ' +
      'Use events_since FIRST; status gives task detail when the user asks what is running, who waits for them, or whether something is ready, and at the start of a planning session. ' +
      'Hidden, closed and cancelled tasks are left out unless all is true. cohort limits it to the tasks of one cohort (a group the user named). Every row has its cohort (null: none).',
    input: { all: allArg, cohort: cohortArg.optional() },
    annotations: readOnly('Status of all agent tasks'),
    run: (deps, args) => guarded(() => runStatus(deps, args as { all?: boolean; cohort?: string })),
  }),
  def({
    name: 'events_since',
    title: 'What changed since the last look',
    kind: 'read',
    description:
      'Call this at the start of EVERY answer that concerns the work of the agents. It returns what happened since your previous call (or since a given time): reports that became ready (with the verdict), tasks started from the queue, questions and folder-trust waits, blocked, cancelled and limited tasks, finished cohorts, plan thresholds crossed and changed limits - then one line with the state now (active, queued, reports to pull). ' +
      'The chat gets no notifications, so this is how you learn what changed; the "last" marker is independent per initialized session. New sessions inherit the saved high-water mark per client (first-ever look: 24 hours); explicit client intentionally shares a cursor. Responses are bounded and provide has_more/next_cursor. Events are recorded while "agentctl watch" runs. since: last (default), an age (30m, 2h, 1d), HH:MM or an ISO time. peek: true does not move the marker.',
    input: { cursor: z.string().max(2048).optional(), limit: z.number().int().min(1).max(200).optional(), client: z.string().min(1).max(200).optional().describe('Intentionally share a stable cursor between sessions of this client; omit for independent session cursors.'), since: z.string().max(40).optional().describe('last (default), an age like 30m / 2h / 1d, HH:MM today, or an ISO time.'), cohort: cohortArg.optional(), peek: z.boolean().optional().describe('true: do not move the "last" marker.') },
    annotations: readOnly('What changed since the last look'),
    run: (deps, args) => guarded(() => runEventsSince(deps, args as { since?: string; cohort?: string; peek?: boolean })),
  }),
  def({
    name: 'gc_preview',
    title: 'Preview of the clean-up',
    kind: 'read',
    description:
      'What "agentctl gc" would free now, without doing anything: git worktrees of closed, cancelled and archived tasks without uncommitted changes, old files next to the reports, state folders to archive, merged branches (merged: true), each with its size, and what is skipped and why. ' +
      'Use the separately allowed gc tool to apply this protected plan with preview and confirm: true (branches default false).',
    input: { detail: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), older_than: z.string().max(10).optional().describe('Age of the files next to the reports before they count: 12h, 7d, 2w. Default 7d.'), merged: z.boolean().optional().describe('true: also list merged branches of finished tasks.'), cohort: cohortArg.optional() },
    annotations: readOnly('Preview of the clean-up'),
    run: (deps, args) => guarded(() => runGcPreview(deps, args as { older_than?: string; merged?: boolean; cohort?: string })),
  }),
  def({
    name: 'limits',
    title: 'Limits of simultaneous agents',
    kind: 'read',
    description:
      'The limit of simultaneous agents per provider (claude, codex), what uses it up (windows of agentctl, places the user reserved for agents started by hand, external sessions if counted) and how many places are free; also the tasks waiting in the queue per provider. ' +
      'Use it before proposing to start or queue tasks, and when the user says they changed the parity.',
    input: {},
    annotations: readOnly('Limits of simultaneous agents'),
    run: (deps) => guarded(() => runLimits(deps)),
  }),
  def({
    name: 'set_limits',
    title: 'Change the limits',
    kind: 'write',
    description:
      'WRITE, off unless the user put "set_limits" in mcp.allow. Sets the most simultaneous agents per provider in config.yaml (0 removes a limit); comments in the file stay, a copy is kept as config.yaml.bak. It takes effect at once, without restarting watch. ' +
      'The FIRST call (confirm omitted) only describes the change; show it to the user, then call again with confirm: true.',
    input: { claude: limitArg.describe('New limit for Claude; 0 = no limit. Omit to leave it.'), codex: limitArg.describe('New limit for Codex; 0 = no limit. Omit to leave it.'), confirm: z.boolean().optional().describe('true only after the user agreed to the described change.') },
    annotations: { title: 'Change the limits', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runSetLimits(deps, args as { claude?: number; codex?: number; confirm?: boolean })),
  }),
  def({
    name: 'reserve',
    title: 'Reserve places for agents started by hand',
    kind: 'write',
    description:
      'WRITE, off unless the user put "reserve" in mcp.allow. Holds places of a provider for agents the user starts by hand (they count against the limit, so the queue leaves room); release: true gives places back. Numbers are how many places. ' +
      'The FIRST call (confirm omitted) only describes it; ask the user, then call again with confirm: true.',
    input: { claude: limitArg.describe('Places of Claude.'), codex: limitArg.describe('Places of Codex.'), note: z.string().max(100).optional().describe('What the place is for (shown by limits).'), release: z.boolean().optional().describe('true: give the places back instead of reserving.'), confirm: z.boolean().optional().describe('true only after the user agreed.') },
    annotations: { title: 'Reserve places for agents started by hand', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runReserve(deps, args as { claude?: number; codex?: number; note?: string; release?: boolean; confirm?: boolean })),
  }),
  def({
    name: 'version',
    title: 'Version of this server',
    kind: 'read',
    description:
      'The version of agentctl this MCP server process runs, its script and pid, when it started, the version of the stable copy on disk, which write tools the user allowed and any warning about the MCP part of the config. ' +
      'Use it when a tool seems to be missing or behaves differently than described: after an update the app may still run the old server until the user quits it (⌘Q) and opens it again.',
    input: {},
    annotations: readOnly('Version of this server'),
    run: (deps) => guarded(() => runVersion(deps)),
  }),
  def({
    name: 'peek',
    title: 'Look into a task window',
    kind: 'read',
    description:
      'The last lines of what an agent window shows, without its footer, to read along without attaching. Use it when the user asks what a task is doing right now, why it waits, or what the agent asked. ' +
      'Works only for a task that still has a tmux window; a task that is finished has a report instead (get_report).',
    input: { task: taskArg, lines: z.number().int().min(1).max(MAX_PEEK_LINES).optional().describe(`How many lines, 1 to ${MAX_PEEK_LINES}. Default 40.`) },
    annotations: readOnly('Look into a task window'),
    run: (deps, args) => guarded(() => runPeek(deps, args as { task: string; lines?: number })),
  }),
  def({
    name: 'list_reports',
    title: 'List the reports',
    kind: 'read',
    description: 'Which tasks have a report file, how big it is, when it was written and whether it was already pulled. Use it to see what there is to read before calling get_report. all: true includes hidden and closed tasks.',
    input: { all: allArg },
    annotations: readOnly('List the reports'),
    run: (deps, args) => guarded(() => runListReports(deps, args as { all?: boolean })),
  }),
  def({
    name: 'get_report',
    title: 'Read one report',
    kind: 'read',
    description:
      `The report of one task (the file its spec names), paginated within mcp.max_response_kb. Use it when the user asks for the result of a particular task, also an older or closed one. ` +
      'section selects a Markdown heading; offset and limit paginate lines (zero-based offset), capped by mcp.max_response_kb. byte_offset is absolute within the selected whole report or section; next_byte_offset equals end_byte. Contiguous whole-file delivery marks pulled at EOF; sections do not. Page metadata includes total_lines, returned_bytes, has_more, next_offset and next_byte_offset. Reads only that report file, never another path.',
    input: { task: taskArg, section: z.string().optional(), byte_offset: z.number().int().min(0).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(10000).optional() },
    annotations: { ...readOnly('Read one report'), readOnlyHint: false },
    run: (deps, args) => guarded(() => runGetReport(deps, args as { task: string })),
  }),
  def({
    name: 'pull_ready',
    title: 'Take all new reports',
    kind: 'read',
    description:
      'Default: summary receipt only (not pulled); ack: true attests full read elsewhere. Summary excerpts (small reports delivered whole; larger excerpts up to 1500 characters each, bounded by mcp.max_response_kb) with task, path, size, first-line verdict and SHA/branch when present. mode: full returns complete report bodies through bounded response_page fragments; offset/limit paginate report selection. Pulled is recorded only after contiguous complete delivery. All reports that are ready and not yet pulled, each under a header with the task and agent, in one answer; they are then marked as pulled (the only thing this tool changes, in agentctl\'s own state). ' +
      'Use it at the START of discussing the results of finished tasks, instead of asking the user to paste reports. A second call returns only reports that arrived since. cohort: only the reports of that cohort (the others stay new). Cancelled tasks are never included.',
    input: { cohort: cohortArg.optional(), all: z.boolean().optional(), mode: z.enum(['summary', 'full']).optional(), ack: z.boolean().optional().describe('Explicitly attest that the full reports were read elsewhere; independent of mark.'), cursor: z.string().max(200).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    annotations: { title: 'Take all new reports', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runPullReady(deps, args as { cohort?: string; all?: boolean })),
  }),
  def({
    name: 'task_spec',
    title: 'Header and prompt of a task',
    kind: 'read',
    description: 'What a task was ordered to do: its header (agent, model, effort, repositories and worktrees, report path, start time, links to a task it continues or was moved to) and the prompt text from TASK.md. Use it to review or continue a task. Environment values are not shown.',
    input: { task: taskArg },
    annotations: readOnly('Header and prompt of a task'),
    run: (deps, args) => guarded(() => runTaskSpec(deps, args as { task: string })),
  }),
  def({
    name: 'queue_list',
    title: 'The task queue',
    kind: 'read',
    description:
      'The queue of tasks that wait for a free window of their provider (or for another task\'s report, `after`): position, agent/model/effort, priority, what each waits for (startCondition), since when, and the error of a start that failed. ' +
      'Use it when the user asks what is queued, why something has not started, or what runs next.',
    input: { cohort: cohortArg.optional() },
    annotations: readOnly('The task queue'),
    run: (deps, args) => guarded(() => runQueueList(deps, args as { cohort?: string })),
  }),
  def({
    name: 'cohort_list',
    title: 'The cohorts',
    kind: 'read',
    description:
      'The cohorts (groups of tasks the user named, for example one batch of related work): per cohort the number of tasks by state (active, queued, reports, closed, cancelled), since when, and its note. ' +
      'Use it when the user talks about a batch by name or asks how a group of tasks is doing. Tasks without a name belong to no cohort.',
    input: { all: z.boolean().optional().describe('Include archived cohorts (hidden by default).') },
    annotations: readOnly('The cohorts'),
    run: (deps, args) => guarded(() => runCohortList(deps, args as { all?: boolean })),
  }),
  def({
    name: 'cohort_show',
    title: 'The tasks of a cohort',
    kind: 'read',
    description: 'One cohort: its note and every task in it as status shows it (closed and cancelled ones too), and its queued tasks with what each waits for. Use it to review a batch of work.',
    input: { cohort: cohortArg },
    annotations: readOnly('The tasks of a cohort'),
    run: (deps, args) => guarded(() => runCohortShow(deps, args as { cohort: string })),
  }),
  def({
    name: 'guide', title: 'Dispatcher guide', kind: 'read',
    description: 'Read the shared dispatcher instructions before ordering work. Optionally append the project guide from .agentctl.yaml. Missing overlay warns. No mcp.allow entry needed.',
    input: { project: z.string().min(1).optional(), lang: z.enum(['en', 'pl']).optional() },
    annotations: readOnly('Dispatcher guide'),
    run: (deps, args) => guarded(async () => ({ text: collectGuide(deps.context(() => {} ).config, args as { project?: string; lang?: 'en' | 'pl' }).text })),
  }),
  def({
    name: 'capacity', title: 'Current capacity', kind: 'read',
    description: 'Fresh read of provider windows, age, stale, consumption pace, reset, slots, queue, models/efforts, seven-day stats and explicitly labeled token estimates. null = n/d. Includes usage outside agentctl. Facts only; choose the order yourself. No mcp.allow entry needed.',
    input: {}, annotations: readOnly('Current capacity'),
    run: (deps, args) => guarded(async () => { const ctx = deps.context(() => {}); const report = await collectCapacity(ctx); return { text: JSON.stringify({ ...report, disk: await collectDisk(ctx, undefined, args as { detail?: boolean; offset?: number; limit?: number }) }, null, 2) }; }),
  }),
  def({
    name: 'usage',
    title: 'Token usage and plan limits',
    kind: 'read',
    description:
      'How many tokens the tasks used and how close the plans are to their limits. Per provider (claude, codex): the 5 hour and the weekly window with the percentage used and when it resets (windows: [] and available: false means n/d - the provider did not say; never guess a number), the tokens today and in the period; ' +
      'per task (the active ones first) and per cohort the tokens; per model and per day. Use it BEFORE the user orders more tasks ("do we have room?"), when they ask what a task cost, or which provider has room. since: how far back the token columns go (12h, 7d, 2w; default 7d); cohort limits it to one cohort.',
    input: { cohort: cohortArg.optional(), since: z.string().min(2).max(10).optional().describe('Age such as 12h, 7d, 2w. Default 7d.') },
    annotations: readOnly('Token usage and plan limits'),
    run: (deps, args) => guarded(() => runUsage(deps, args as { cohort?: string; since?: string })),
  }),
  def({
    name: 'log',
    title: 'History of the tasks',
    kind: 'read',
    description:
      'The history of the tasks, newest first: agent/model/effort as ordered and as run, start and report time, duration, tokens (null: n/d), commits and files, the verdict line of the report, whether it was cancelled (with the reason) or moved to the other provider, and the result the user marked (ok, partial, fail). ' +
      'Use it to choose a model and effort for a new task from what worked before. since (12h, 7d, 2w) and cohort filter it.',
    input: { cohort: cohortArg.optional(), since: z.string().min(2).max(10).optional().describe('Age such as 12h, 7d, 2w. Default: all.') },
    annotations: readOnly('History of the tasks'),
    run: (deps, args) => guarded(() => runLog(deps, args as { cohort?: string; since?: string })),
  }),
  def({
    name: 'stats',
    title: 'Statistics per model and effort',
    kind: 'read',
    description:
      'The history grouped by agent/model/effort: number of tasks, median time and tokens, how many were marked ok, partial or fail (and how many were not marked), cancelled tasks and tasks that had to be moved to the other provider after a usage limit. ' +
      'Use it when the user asks which model or effort pays off. since (30d, 2w) and cohort filter it.',
    input: { cohort: cohortArg.optional(), since: z.string().min(2).max(10).optional().describe('Age such as 30d, 2w. Default: all.') },
    annotations: readOnly('Statistics per model and effort'),
    run: (deps, args) => guarded(() => runStats(deps, args as { cohort?: string; since?: string })),
  }),
  def({
    name: 'overlap',
    title: 'Tasks that change the same files',
    kind: 'read',
    description:
      'Pairs of active tasks of one repository that changed the same files (commits over the base plus uncommitted files, from git right now), with the file list. ' +
      'Use it when the user asks whether tasks collide or before merging, or when status shows collidesWith. task limits it to the pairs with that task.',
    input: { task: taskArg.optional() },
    annotations: readOnly('Tasks that change the same files'),
    run: (deps, args) => guarded(() => runOverlap(deps, args as { task?: string })),
  }),
  def({
    name: 'resume',
    title: 'Resume tasks after a restart',
    kind: 'write',
    description:
      'WRITE, off unless the user put "resume" in mcp.allow. After a restart of the Mac or of tmux, active tasks that have a worktree and no window get their window back and the agent is started in resume mode (the conversation continues, the prompt is not pasted again), with the same model and effort. ' +
      'Tasks whose report is ready are left alone unless all is true. The FIRST call (confirm omitted) only lists what would be resumed; ask the user, then call again with confirm: true.',
    input: { tasks: z.array(taskArg).max(20).optional().describe('Task IDs to resume; omit for every task that can be resumed.'), all: z.boolean().optional().describe('true: also tasks that already have a report.'), confirm: z.boolean().optional().describe('true only after the user agreed to the listed tasks.') },
    annotations: { title: 'Resume tasks after a restart', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runResume(deps, args as { tasks?: string[]; all?: boolean; confirm?: boolean })),
  }),
  def({
    name: 'send',
    title: 'Send a prompt to a running task',
    kind: 'write',
    description:
      `WRITE, off unless the user put "send" in mcp.allow. Pastes a follow-up prompt (up to ${MAX_SEND_CHARS} characters) into the window of a running task, as if the user typed it, and presses Enter. ` +
      'Use it only when the user asked you to instruct an agent; say what you will send first. The user gets a desktop notification.',
    input: { task: taskArg, text: z.string().min(1).max(MAX_SEND_CHARS).describe('The prompt for the agent.') },
    annotations: { title: 'Send a prompt to a running task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runSend(deps, args as { task: string; text: string })),
  }),
  def({
    name: 'new',
    title: 'Start tasks from a spec',
    kind: 'write',
    description:
      'WRITE, off unless the user put "new" in mcp.allow. Starts agent tasks from a spec: a YAML header between --- lines (task, agent, model, effort, repos …) followed by the prompt, the same format as the agentctl CLI. ' +
      'The FIRST call (confirm omitted) validates the spec and returns a summary of what would start; show it to the user. Only when they agree, call again with the same spec and confirm: true. ' +
      '"setup" commands (shell) are not accepted from the chat. A repository whose .agentctl.yaml has setup (an install takes minutes) is not set up inside this call: confirm registers the start and returns at once, and the watcher (it must be running, else the confirm is refused) does the checkout, the setup and the window; follow it with events_since (SETUP, START, BŁĄD STARTU) and status or queue_list ("uruchamiane – setup w toku (repo 1/2 …)"). new again for a task that is being started returns its state and starts nothing twice; a failed setup leaves the task failed with its reason and the worktrees, and queue_retry tries again.',
    input: { spec: z.string().min(1).max(100_000).describe('The spec text: ---, YAML header, ---, prompt. Several specs may follow each other.'), agent: z.enum(AGENT_NAMES).optional(), reuse: z.boolean().optional(), no_agent: z.boolean().optional(), cohort: cohortArg.optional(), wait_trust: z.boolean().optional(), confirm: z.boolean().optional().describe('true only after the user agreed to the summary.') },
    annotations: { title: 'Start tasks from a spec', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runNew(deps, args as NewMcpArgs)),
  }),
  def({
    name: 'queue',
    title: 'Put tasks in the queue',
    kind: 'write',
    description:
      'WRITE, off unless the user put "queue" in mcp.allow. Puts the tasks of a spec in the queue (same spec format as new, plus priority: high|normal, after: <TASK or list>, touches: [globs]): each starts by itself when a window of its provider is free and its `after` tasks have a report. ' +
      'The FIRST call (confirm omitted) validates the spec and returns a summary (where each task will stand, hints, touches warnings); show it to the user. Only when they agree, call again with the same spec and confirm: true. "setup" is not accepted from the chat.',
    input: {
      spec: z.string().min(1).max(100_000).describe('The spec text: ---, YAML header, ---, prompt. Several specs may follow each other.'),
      cohort: cohortArg.optional(),
      agent: z.enum(['claude', 'codex']).optional().describe('Run the specs on this provider, translated through the equivalents table. The queue never switches provider by itself.'),
      confirm: z.boolean().optional().describe('true only after the user agreed to the summary.'),
    },
    annotations: { title: 'Put tasks in the queue', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runQueue(deps, args as { spec: string; agent?: 'claude' | 'codex'; cohort?: string; confirm?: boolean })),
  }),
  def({
    name: 'queue_rm',
    title: 'Take a task out of the queue',
    kind: 'write',
    description: 'WRITE, off unless the user put "queue_rm" in mcp.allow. Removes a waiting (or failed) task from the queue; the task becomes cancelled (the same as cancel for a queued task, without a reason) and tasks that wait for it become blocked. Nothing that already runs is touched. Ask the user first.',
    input: { task: taskArg },
    annotations: { title: 'Take a task out of the queue', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runQueueRm(deps, args as { task: string })),
  }),
  def({
    name: 'cancel',
    title: 'Cancel tasks',
    kind: 'write',
    description:
      'WRITE, off unless the user put "cancel" in mcp.allow. Abandons a task: one at work is interrupted, given a few seconds to stop and its window closed; one in the queue is taken out of it. It becomes cancelled (not closed) and leaves status; ' +
      'the worktree and the branch stay, a written report stays readable. Tasks that wait for it (after) become blocked. A task that was moved to the other provider is cancelled together with its other half. ' +
      'Give task, or cohort for all open tasks of a cohort. reason is kept with the task. remove_worktree: true (git worktree remove, never forced) works only if the user also set mcp.allow_rm_worktree. ' +
      'The FIRST call (confirm omitted) only describes what would be cancelled; show it to the user and ask, then call again with confirm: true. The user gets a desktop notification.',
    input: {
      task: taskArg.optional(),
      tasks: z.array(taskArg).min(1).max(100).optional(),
      cohort: cohortArg.optional(),
      reason: z.string().max(500).optional().describe('Why the work is cancelled (optional).'),
      remove_worktree: z.boolean().optional().describe('Also remove the git worktree. Refused unless the user allowed it in the config.'),
      confirm: z.boolean().optional().describe('true only after the user agreed to the described cancellation.'),
    },
    annotations: { title: 'Cancel tasks', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runCancel(deps, args as { tasks?: string[]; task?: string; cohort?: string; reason?: string; remove_worktree?: boolean; confirm?: boolean })),
  }),
  def({
    name: 'mark',
    title: 'Mark how a task turned out',
    kind: 'write',
    description:
      'WRITE, off unless the user put "mark" in mcp.allow. Records the result of a task the USER judged: ok, partial or fail, with an optional note; it goes to the history that log and stats read (the last mark of a task wins). ' +
      'A single task needs no confirmation; multiple tasks require preview and confirmation. Record only what the user said about the result - do not judge a task yourself.',
    input: { task: taskArg.optional(), tasks: z.array(taskArg).min(1).max(100).optional(), cohort: cohortArg.optional(), result: z.enum(RESULTS).describe('ok, partial or fail.'), note: z.string().max(500).optional().describe('Why (optional).') },
    annotations: { title: 'Mark how a task turned out', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runMark(deps, args as { task: string; result: string; note?: string })),
  }),
  def({
    name: 'away',
    title: 'Switch away mode (the phone)',
    kind: 'write',
    description:
      'WRITE, off unless the user put "away" in mcp.allow. on: true makes agentctl send its notifications to the user\'s phone (ntfy) as well, on: false stops that. The notifications on the Mac do not depend on it. ' +
      'It costs nothing and needs no confirmation (it is recorded in the audit log), but switch it only when the user says they are leaving or are back. status and events_since say whether away is on.',
    input: { on: z.boolean().describe('true: away, the phone gets the notifications. false: back at the Mac.') },
    annotations: { title: 'Switch away mode (the phone)', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runAway(deps, args as { on: boolean })),
  }),
  def({
    name: 'interrupt',
    title: 'Interrupt the current turn of a task',
    kind: 'write',
    description: 'WRITE, off unless the user put "interrupt" in mcp.allow. Sends the agent its interrupt key (Escape) to stop the turn it is in; the window stays open and nothing is lost. Use it when the user asks to stop an agent that goes the wrong way.',
    input: { task: taskArg },
    annotations: { title: 'Interrupt the current turn of a task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runInterrupt(deps, args as { task: string })),
  }),
  def({
    name: 'close',
    title: 'Close a task',
    kind: 'write',
    description:
      'WRITE, off unless the user put "close" in mcp.allow. Closes the tmux window of a task (the agent ends) and marks the task closed: it leaves status and the board; its report and state stay. The worktree and the branch are NOT removed; ' +
      'remove_worktree: true (git worktree remove, never forced) works only if the user also set mcp.allow_rm_worktree. Closing ends a running agent: ask the user first.',
    input: { task: taskArg.optional(), tasks: z.array(taskArg).min(1).max(100).optional(), cohort: cohortArg.optional(), remove_worktree: z.boolean().optional().describe('Also remove the git worktree. Refused unless the user allowed it in the config.') },
    annotations: { title: 'Close a task', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runClose(deps, args as CloseMcpArgs)),
  }),
  def({
    name: 'move',
    title: 'Move a task to the other provider',
    kind: 'write',
    description:
      'WRITE, off unless the user put "move" in mcp.allow. Hands a task that hit its usage limit to the other provider (Claude <-> Codex): a new window in the same worktree with the original prompt and a note to continue. ' +
      'The FIRST call (confirm omitted) only describes the move; ask the user, then call again with confirm: true.',
    input: {
      task: taskArg,
      agent: z.enum(['claude', 'codex']).optional().describe('Target provider; default: the other one.'),
      confirm: z.boolean().optional().describe('true only after the user agreed to the described move.'),
    },
    annotations: { title: 'Move a task to the other provider', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runMove(deps, args as { task: string; agent?: 'claude' | 'codex'; confirm?: boolean })),
  }),
];


const optionalText = z.string().min(1).max(4096).optional();
const confirmArg = z.boolean().optional().describe('First call previews. true executes only the unchanged preview in this server session.');
function extraRead(name: string, cli: string, use: string, input: z.ZodRawShape, read: (ctx: Context, args: Record<string, unknown>) => Promise<unknown>): McpToolDef {
  return def({ name, title: use, kind: 'read', description: `${use}. CLI: agentctl ${cli}. Use when you need these facts; no mcp.allow required.`, input, annotations: readOnly(use), run: (deps, args) => guarded(async () => ok(JSON.stringify(await read(deps.context(() => {}), args), null, 2))) });
}
function extraWrite<S extends z.ZodRawShape>(name: McpWriteTool, cli: string, use: string, input: S, action: (ctx: Context, args: z.infer<z.ZodObject<S>>, deps: McpDeps) => Promise<unknown>): McpToolDef {
  return def({ name, title: use, kind: 'write', description: `WRITE, off unless the user put "${name}" in mcp.allow. ${use}. CLI: agentctl ${cli}. Use only for work the user requested. Requires ${name} in mcp.allow; preview then confirm: true with identical arguments. Every execution is audited and journaled; desktop notices follow notify.mcp_writes.`, input: { ...input, confirm: confirmArg }, annotations: { title: use, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }, run: (deps, args) => guarded(() => writeTool(deps, name, {}, async (ctx) => ({ text: JSON.stringify(await action(ctx, args as z.infer<z.ZodObject<S>>, deps), null, 2), executed: true, announce: name }))) });
}
MCP_TOOLS.push(
  extraRead('queue_show', 'queue show <TASK>', 'Read full queued spec, error and attempt history', { task: taskArg }, async (ctx, a) => redactQueue(findEntry(ctx.config, a.task as string), ctx.config)),
  extraRead('mcp_check', 'mcp check', 'Inspect stale MCP server processes without stopping them', {}, async (ctx) => ({ stale: staleProcesses(await findMcpProcesses(ctx.runner), stableScript()) })),
  extraRead('spec_example', 'spec example', 'Read an example spec before writing a new order', {}, async () => EXAMPLE_SPEC),
  extraRead('doctor', 'doctor', 'Diagnose the installation, permissions and disk', { project: optionalText }, async (ctx, a) => runDoctor(ctx.runner, () => ctx.config, a.project as string ?? null)),
  extraRead('equivalents', 'capacity', 'Read the Claude/Codex equivalents table', {}, async (ctx) => ctx.config.equivalents),
  extraRead('config_show', 'doctor', 'Read effective configuration with secrets masked', {}, async (ctx) => redactConfig(ctx.config)),
  extraRead('manager_status', 'manager --url', 'Inspect the manager session', {}, async (ctx) => managerView(ctx)),
  extraRead('away_status', 'away status', 'Inspect away mode', {}, async (ctx) => awayReport(ctx.config)),
  extraRead('report', 'report <TASK>', 'Inspect report location and candidates', { task: taskArg }, async (ctx, a) => reportInfo(ctx, a.task as string)),
  extraWrite('queue_retry', 'queue retry <TASK>', 'Retry a failed queue start after reading its error and checking residue', { task: taskArg }, async (ctx, a) => retryEntry(ctx, a.task)),
  extraWrite('queue_up', 'queue up <TASK>', 'Move a waiting task to the front of its priority class', { task: taskArg }, async (ctx, a) => moveToFront(ctx, a.task)),
  extraWrite('queue_pause', 'queue pause', 'Pause automatic queue starts', {}, async (ctx) => ({ changed: await setPaused(ctx, true) })),
  extraWrite('queue_resume', 'queue resume', 'Resume automatic queue starts', {}, async (ctx) => ({ changed: await setPaused(ctx, false) })),
  extraWrite('unblock', 'unblock <TASK> [--drop-after <TASK>]', 'Remove blocked dependencies, allowing a task to start', { task: taskArg, drop_after: optionalText }, async (ctx, a) => unblockEntry(ctx, a.task, { dropAfter: a.drop_after })),
  extraWrite('cohort_add', 'cohort add <NAME> <TASKS...>', 'Put existing tasks in a cohort', { cohort: cohortArg, tasks: z.array(taskArg).min(1).max(100) }, async (ctx, a) => setCohortOf(ctx, a.tasks, await touchCohort(ctx, a.cohort))),
  extraWrite('cohort_remove', 'cohort remove <TASKS...>', 'Remove cohort membership', { tasks: z.array(taskArg).min(1).max(100) }, async (ctx, a) => setCohortOf(ctx, a.tasks, undefined)),
  extraWrite('cohort_archive', 'cohort archive <NAMES...> | --older-than <AGE>', 'Hide finished cohorts from the board choice and the default cohort list; tasks, reports and history stay. Cohorts with active or queued work are never archived', { cohorts: z.array(cohortArg).max(50).optional(), older_than: optionalText }, async (ctx, a) => {
    const plan = await cohortArchivePlan(ctx, a);
    return { plan, archived: await applyCohortArchive(ctx, plan) };
  }),
  extraWrite('cohort_note', 'cohort note <NAME> <TEXT>', 'Change the note of a cohort', { cohort: cohortArg, text: z.string().max(20000) }, async (ctx, a) => setNote(ctx, a.cohort, a.text)),
  ...(['hide', 'unhide'] as const).map((name) => extraWrite(name, `${name} <TASKS...>`, `${name} tasks on the board`, { tasks: z.array(taskArg).min(1).max(100) }, async (ctx, a) => setHidden(ctx, a.tasks, name === 'hide'))),
  extraWrite('archive', 'archive [--older-than <AGE>]', 'Archive the state of closed tasks', { older_than: optionalText, cohort: cohortArg.optional() }, async (ctx, a) => archiveClosed(ctx, { cohort: a.cohort, olderThanMs: a.older_than ? parseAge(a.older_than) : undefined })),
  extraWrite('adopt', 'adopt <TASK> --report <PATH>', 'Restore missing task metadata from facts supplied by the user', { task: taskArg, report: z.string().min(1), window: optionalText, worktree: optionalText, agent: z.enum(AGENT_NAMES).optional(), model: optionalText, effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }, async (ctx, a) => { await adoptTask(ctx, a.task, a); return { task: a.task, adopted: true }; }),
  extraWrite('report_from', 'report <TASK> --from <FILE> [--force]', 'Copy a regular report from task worktrees or cache to its canonical location; force only overwrites, never permits outside or symlink sources', { task: taskArg, from: z.string().min(1), force: z.boolean().optional() }, async (ctx, a) => { const info = await reportInfo(ctx, a.task, { from: a.from, force: a.force, sourcePolicy: 'mcp' }); if (info.result?.action === 'kept' || (info.result?.action === 'none' && info.result.note)) throw new AgentctlError(info.result.note ?? 'report was not copied', 'Preview again with force: true only if replacing the canonical file is intended.'); return info; }),
  extraWrite('limits_release', 'limits release [claude=N codex=N]', 'Release reserved provider places', { claude: limitArg, codex: limitArg }, async (ctx, a) => releasePlaces(ctx, { ...(a.claude !== undefined ? { claude: a.claude } : {}), ...(a.codex !== undefined ? { codex: a.codex } : {}) })),
  extraWrite('manager_start', 'manager', 'Start the supervising manager session', { project: optionalText, name: optionalText, model: optionalText, effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional() }, async (ctx, a, deps) => { if (!deps.self) throw new AgentctlError('this server has no self command for the manager'); return startManager(ctx, { ...a, self: deps.self, noWait: true }); }),
  extraWrite('manager_stop', 'manager stop', 'Stop the manager session', {}, async (ctx) => ({ state: await stopManager(ctx) })),
  extraWrite('notify_test', 'notify-test [--phone]', 'Test desktop notifications; phone true explicitly sends to ntfy', { phone: z.boolean().optional() }, async (ctx, a, deps) => { if (a.phone) return sendPhoneTest(ctx); await deps.notify('agentctl notification test'); return { local: true }; }),
  extraWrite('gc', 'gc --apply [--cohort <NAME>] [--older-than <AGE>] [--branches]', 'Reclaim disk space from finished tasks using the same protected plan as gc_preview', { detail: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(), cohort: cohortArg.optional(), older_than: optionalText, branches: z.boolean().optional() }, async (ctx, a) => { const plan = await planGc(ctx, { cohort: a.cohort, olderThan: a.older_than, branches: a.branches ?? false }); return { plan, result: await applyGc(ctx, plan) }; }),
);

/** Do not expose environment values or credential-bearing ntfy URLs as well as token/topic. */
function redactConfig(config: GlobalConfig): unknown {
  const copy = JSON.parse(JSON.stringify(config));
  copy.env = Object.fromEntries(Object.keys(copy.env ?? {}).map((key) => [key, '[masked]']));
  if (copy.notify.ntfy) {
    for (const key of ['token', 'topic', 'clickUrl']) if (copy.notify.ntfy[key]) copy.notify.ntfy[key] = '[masked]';
    try { const url = new URL(copy.notify.ntfy.server); url.username = ''; url.password = ''; url.search = ''; copy.notify.ntfy.server = url.toString(); } catch { copy.notify.ntfy.server = '[masked]'; }
  }
  return copy;
}

const confirmedTools = new Set(['mark', 'new', 'queue', 'cancel', 'resume', 'move', 'interrupt', 'close', 'queue_rm', ...MCP_TOOLS.filter((t) => t.kind === 'write' && !['send', 'mark', 'away', 'set_limits', 'reserve'].includes(t.name)).map((t) => t.name)]);
const previews = new WeakMap<McpDeps, Map<string, { key: string; arguments: Record<string, unknown>; scope: string; at: number; ttlS: number }>>();
const lastPreviewMutation = new WeakMap<McpDeps, string>();
const previewSessions = new WeakMap<McpDeps, string>();
const issuedPreviewTokens = new Map<string, { session: string; state: string }>();
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function previewArguments(input: Record<string, unknown>): Record<string, unknown> {
  return canonical({ ...input, ...(typeof input.spec === 'string' ? { spec: splitSpecs(input.spec, 'preview arguments').map(s => ({ header: s.header, prompt: s.prompt.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim() })) } : {}) }) as Record<string, unknown>;
}

/** Guard target identities, excluding receipt timestamps written by read tools. */
function confirmationTargets(name: string, scope: unknown): unknown {
  if (name === 'new' || name === 'queue') return null;
  if (name === 'gc') return (scope as GcPlan).items.map(({ kind, task, target, repo, branch }) => ({ kind, task, target, repo, branch }));
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if (typeof obj.window === 'string' && typeof obj.started === 'string' && Array.isArray(obj.repos)) {
      return Object.fromEntries(['task', 'window', 'windowId', 'started', 'agent', 'model', 'effort', 'attemptId', 'report', 'repos', 'closed', 'cancelled', 'hidden', 'cohort', 'supersededBy'].filter(k => obj[k] !== undefined).map(k => [k, obj[k]]));
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, project(v)]));
  };
  return project(scope);
}
/** Exact arguments and observed task/queue/window identities bind confirmation to this session. No scope can silently grow. */
async function confirmationScope(ctx: Context, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'queue_up' || name === 'queue_rm') {
    const entry = findEntry(ctx.config, args.task as string);
    if (name === 'queue_up' && entry.status !== 'queued') throw new AgentctlError(`${entry.task} is ${entry.status}, not waiting`);
    return { tasks: [], queue: [entry] };
  }
  if (name === 'interrupt') { const target = await resolveRunningTask(ctx, args.task as string); return { tasks: [target] }; }
  if (name === 'hide' || name === 'unhide') return { tasks: await setHidden(ctx, args.tasks as string[], name === 'hide', true) };
  if (name === 'cohort_add' || name === 'cohort_remove') {
    const target = name === 'cohort_add' ? { name: args.cohort as string, created: '' } : undefined;
    return { tasks: await setCohortOf(ctx, args.tasks as string[], target, true), cohort: target?.name ?? null };
  }
  if (name === 'cohort_archive') return cohortArchivePlan(ctx, args as { cohorts?: string[]; older_than?: string });
  if (name === 'cohort_note') return { cohort: findCohort(ctx.config, args.cohort as string), note: args.text };
  if (name === 'adopt') return { task: await adoptTask(ctx, args.task as string, args as unknown as Parameters<typeof adoptTask>[2], true) };
  if (name === 'notify_test') {
    if (args.phone && !ctx.config.notify.ntfy?.topic) throw new AgentctlError('no phone topic configured');
    return { channels: args.phone ? ['ntfy'] : ['desktop'], notify: (redactConfig(ctx.config) as { notify: unknown }).notify };
  }
  if (name === 'unblock') {
    const before = findEntry(ctx.config, args.task as string);
    const rows = await collectStatus(ctx, { progress: false, archived: true });
    return { tasks: [{ task: before.task, state: findBlocked(readQueue(ctx.config), rows).has(before.task) ? 'blocked' : before.status, blockers: findBlocked(readQueue(ctx.config), rows).get(before.task), after: before.after }], change: await unblockEntry(ctx, before.task, { dropAfter: args.drop_after as string | undefined, preview: true }) };
  }
  if (name === 'mark') return { tasks: planMark(ctx, args as MarkSelection).map(task => findRecord(ctx, task)), result: args.result, note: args.note };
  if (name === 'close') { const ids = await closeInputs(ctx, args as CloseMcpArgs); return { tasks: await planClose(ctx, ids, { rmWorktree: Boolean(args.remove_worktree) }), records: listTaskRecords(ctx.config).filter(r => ids.includes(r.task)) }; }
  if (name === 'gc') {
    const plan = await planGc(ctx, { cohort: args.cohort as string | undefined, olderThan: args.older_than as string | undefined, branches: Boolean(args.branches) });
    return plan;
  }
  if (name === 'new' || name === 'queue') {
    const rawSpecs = splitSpecs(args.spec as string, 'MCP preview');
    if (args.cohort) for (const raw of rawSpecs) raw.header.cohort = args.cohort;
    for (const raw of rawSpecs) if (chatSetup(raw.header)) throw new AgentctlError(`${String(raw.header.task ?? 'a task')}: \"setup\" runs shell commands and is not accepted from the chat`);
    const specs = await planBatch(ctx, rawSpecs.map(raw => resolveSpec(raw, { config: ctx.config })), { noSwitch: true, reuse: Boolean(args.reuse), ...(args.agent ? { agent: args.agent as 'claude' | 'codex' } : {}), ignoreLimits: name === 'queue', deferBases: name === 'queue', skipAfter: name === 'queue' });
    for (const spec of specs) { const warnings = reportPathWarnings(ctx.config, spec); if (warnings.length) throw new AgentctlError(`${spec.task}: ${warnings.join('; ')}`); }
    return { specs };
  }
  if (name === 'queue_retry') {
    let entry = findEntry(ctx.config, args.task as string);
    if (entry.status !== 'failed') throw new AgentctlError(`${entry.task} is ${entry.status}, not failed`);
    if (entry.autoReview) entry = await rebuildAutoReview(ctx, entry, { write: false });
    const spec = resolveSpec(splitSpecs(entry.spec, 'queue retry')[0]!, { config: ctx.config });
    await checkRetryWorktrees(ctx.runner, spec.repos);
  }
  if (name === 'manager_start' || name === 'manager_stop') return { manager: await managerView(ctx) };
  if (name === 'report_from') {
    const record = findRecord(ctx, args.task as string);
    const source = resolvePath(args.from as string, record.repos[0]?.worktree);
    checkReportPath(ctx.config, record, source, { existing: fs.existsSync(source) });
    checkReportPath(ctx.config, record, record.report);
    const signature = (file: string) => { try { const st = fs.statSync(file); return { size: st.size, mtime: st.mtimeMs, ino: st.ino, hash: createHash('sha256').update(readReportText(ctx.config, record, file)).digest('hex') }; } catch { return null; } };
    return { record, source, sourceSignature: signature(source), destinationSignature: signature(record.report) };
  }
  if (name === 'archive') return archiveClosed(ctx, { cohort: args.cohort as string | undefined, olderThanMs: args.older_than ? parseAge(args.older_than as string) : undefined, preview: true });
  const tasks = [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
  const queue = readQueue(ctx.config);
  const windows = await ctx.tmux.windows();
  const selected = [...(Array.isArray(args.tasks) ? args.tasks as string[] : []), ...(typeof args.task === 'string' ? [args.task] : [])];
  const fits = (r: { task: string; cohort?: string }) => args.cohort ? cohortKey(r.cohort ?? '') === cohortKey(args.cohort as string) : selected.length ? selected.some(id => r.task.toLowerCase().startsWith(id.toLowerCase())) : true;
  const targetTasks = tasks.filter(fits), targetQueue = queue.filter(fits);
  const names = new Set([...targetTasks.map(r => r.window), ...targetQueue.map(r => r.task.toLowerCase())]);
  return { tasks: targetTasks, queue: targetQueue, windows: windows.filter(w => names.has(w.plain)).map(({ id, plain }) => ({ id, plain })) };
}
/** Display only the operation's targets; the private fingerprint still guards the full observed scope. */
async function previewScope(ctx: Context, name: string, args: Record<string, unknown>, scope: unknown): Promise<unknown> {
  if (name === 'mark') { const plan = scope as { tasks: TaskRecord[]; result: unknown; note: unknown }; return { ...plan, tasks: plan.tasks.map(r => ({ task: r.task, cohort: r.cohort ?? null, agent: r.agent, model: r.model, effort: r.effort, report: r.report })) }; }
  if (name === 'queue_up' || name === 'queue_rm') { const plan = scope as { queue: ReturnType<typeof readQueue> }; return { tasks: [], queue: plan.queue.map(e => ({ task: e.task, status: e.status, after: e.after, afterVerdicts: e.afterVerdicts })) }; }
  if (['archive', 'interrupt', 'hide', 'unhide', 'cohort_add', 'cohort_remove', 'cohort_note', 'cohort_archive', 'adopt', 'notify_test', 'unblock'].includes(name)) return scope;
  if (name === 'close') return { tasks: (scope as { tasks: unknown[] }).tasks, omitted: 0 };
  if (name === 'report_from') {
    const plan = scope as { record: TaskRecord; source: string; sourceSignature: { size: number } | null; destinationSignature: unknown };
    return { tasks: [{ task: plan.record.task }], source: plan.source, source_exists: plan.sourceSignature !== null, source_bytes: plan.sourceSignature?.size ?? null, canonical: plan.record.report, canonical_exists: plan.destinationSignature !== null, would_overwrite: plan.destinationSignature !== null, requires_force: plan.destinationSignature !== null && !args.force, execution_blocked: [...(plan.sourceSignature === null ? ['source file does not exist'] : []), ...(plan.destinationSignature !== null && !args.force ? ['force is required to overwrite the canonical report'] : [])] };
  }
  const records = listTaskRecords(ctx.config).filter(r => !r.closed && !r.cancelled);
  const queue = readQueue(ctx.config);
  const selected = new Set<string>([...(Array.isArray(args.tasks) ? args.tasks as string[] : []), ...(typeof args.task === 'string' ? [args.task] : [])]);
  const known = [...records.map(r => r.task), ...queue.map(e => e.task)];
  const targets = new Set([...selected].flatMap(id => { const exact = known.filter(task => task.toLowerCase() === id.toLowerCase()); return exact.length ? exact : known.filter(task => task.toLowerCase().startsWith(id.toLowerCase())); }));
  const fits = (task: string) => targets.has(task);
  if (name === 'queue_pause' || name === 'queue_resume') return { queued: queue.length, tasks: queue.slice(0, 5).map(e => ({ task: e.task, status: e.status })), omitted: Math.max(0, queue.length - 5), more: 'queue_list' };
  return { tasks: records.filter(r => fits(r.task)).map(r => ({ task: r.task, window: r.window, report: r.report, repos: r.repos })), queue: queue.filter(e => fits(e.task)).map(e => ({ task: e.task, status: e.status })), ...(name === 'manager_stop' || name === 'manager_start' ? { manager: await managerView(ctx) } : {}) };
}
for (const tool of MCP_TOOLS) {
  const cli = ({ queue_list: 'queue list', queue_rm: 'queue rm', queue_retry: 'queue retry', queue_up: 'queue up', queue_pause: 'queue pause', queue_resume: 'queue resume', cohort_list: 'cohort list', cohort_show: 'cohort show', list_reports: 'status', get_report: 'pull <TASK>', pull_ready: 'pull --ready', task_spec: 'peek <TASK>', gc_preview: 'gc', events_since: 'events', set_limits: 'limits set', reserve: 'limits reserve' } as Record<string, string>)[tool.name] ?? tool.name.replaceAll('_', ' ');
  if (!tool.description.includes('CLI:')) tool.description += ` Use when the user needs this operation. CLI: agentctl ${cli}.`;
  if (!confirmedTools.has(tool.name)) continue;
  tool.input = { ...tool.input, confirm: confirmArg, preview_token: z.string().optional().describe('Token returned by this preview. Independent previews can be confirmed in any order if their scope is unchanged.') };
  tool.description += ' Two steps are mandatory: preview, then confirm: true with identical arguments. A changed scope requires a new preview.';
  const original = tool.run;
  tool.run = (deps, args) => guarded(async () => {
    const ctx = deps.context(() => {});
    if (!ctx.config.mcp.allow.includes(tool.name as McpWriteTool)) return writeTool(deps, tool.name as McpWriteTool, {}, async () => { throw new Error('unreachable'); });
    if (tool.name === 'mark' && planMark(ctx, args as MarkSelection).length === 1) return original(deps, args);
    if (tool.name === 'new') {
      // A task that was handed to the watcher is being started (or failed to): a second preview or confirm, with or without a token, reports that state and starts nothing.
      let known: ReturnType<typeof findDirectStart>[] = [];
      try { known = splitSpecs(String(args.spec), 'the spec from the chat').map((raw) => findDirectStart(ctx.config, String(raw.header.task ?? ''))).filter((e) => e !== undefined); } catch { /* the normal path reports a bad spec */ }
      if (known.length > 0) return writeTool(deps, 'new', { task: known.map((e) => e!.task).join(', '), detail: 'repeated new for a start in progress' }, async () => ({ text: known.map((e) => directStartText(ctx.config, e!, ctx.runner.now())).join('\n'), executed: false, announce: '' }));
    }
    const { confirm, preview_token, ...input } = args;
    const { detail: _detail, offset: _offset, limit: _limit, ...identityInput } = input;
    const arguments_ = previewArguments(tool.name === 'gc' ? identityInput : input);
    const key = `${tool.name}:${createHash('sha256').update(JSON.stringify(arguments_)).digest('hex')}`;
    if (input.remove_worktree && !ctx.config.mcp.allowRmWorktree) {
      audit(ctx, { tool: tool.name, outcome: 'denied', detail: 'worktree removal not allowed' });
      return fail('removing the worktree is not allowed for the chat');
    }
    let session = previewSessions.get(deps);
    if (!session) { session = crypto.randomUUID(); previewSessions.set(deps, session); }
    let pending = previews.get(deps);
    if (!pending) { pending = new Map(); previews.set(deps, pending); }
    const token = typeof preview_token === 'string' ? preview_token : ([...pending].reverse().find(([, entry]) => entry.key === key) ?? [...pending].reverse().find(([, entry]) => entry.key.startsWith(`${tool.name}:`)))?.[0];
    const preview = token ? pending.get(token) : undefined;
    const deny = (reason: string) => { audit(ctx, { tool: tool.name, outcome: 'denied', detail: reason }); return fail(`Confirmation refused: ${reason}. Call again without confirm to recalculate the scope. Nothing was done.`); };
    if (confirm) {
      if (!preview) {
        const issued = token ? issuedPreviewTokens.get(token) : undefined;
        return deny(issued ? issued.session !== session ? 'different session' : `invalidated by ${issued.state}` : 'missing preview in this session (unknown token or restarted session)');
      }
      if (preview.key !== key) {
        const fields = [...new Set([...Object.keys(preview.arguments), ...Object.keys(arguments_)])].filter(k => JSON.stringify(preview.arguments[k]) !== JSON.stringify(arguments_[k]));
        return deny(`different argument hash: ${fields.join(', ') || 'operation'}`);
      }
      if (ctx.runner.now() - preview.at > preview.ttlS * 1000) return deny(`TTL expired (${preview.ttlS}s since preview)`);
    }
    let scope: unknown;
    try { scope = await confirmationScope(ctx, tool.name, input); }
    catch (e) { audit(ctx, { tool: tool.name, outcome: 'error', detail: errorMessage(e) }); throw e; }
    // Argument identity is independent of mutable runtime facts. Destructive scopes are checked separately.
    const scopeIdentity = JSON.stringify(canonical(confirmationTargets(tool.name, scope)));
    if (!confirm) {
      let result: ToolResult;
      if (['new', 'queue', 'cancel', 'resume', 'move'].includes(tool.name)) result = await original(deps, args);
      else result = await writeTool(deps, tool.name as McpWriteTool, {}, async () => {
        const detail = tool.name === 'gc' ? renderGc(await planGc(ctx, { cohort: input.cohort as string | undefined, olderThan: input.older_than as string | undefined, branches: Boolean(input.branches) }), { detail: Boolean(input.detail), offset: input.offset as number | undefined, limit: input.limit as number | undefined }).join('\n') : JSON.stringify({ operation: tool.name, arguments: input, scope: await previewScope(ctx, tool.name, input, scope) }, null, 2);
        return { text: `${detail}\nNot executed. Review, then call with identical arguments and confirm: true.`, executed: false, announce: '' };
      });
      if (!result.isError) {
        const token = crypto.randomUUID();
        if (pending.size >= 100) { const evicted = pending.keys().next().value!; pending.delete(evicted); issuedPreviewTokens.set(evicted, { session, state: 'preview capacity eviction' }); }
        pending.set(token, { key, arguments: arguments_, scope: scopeIdentity, at: ctx.runner.now(), ttlS: ctx.config.preview.ttlS });
        issuedPreviewTokens.set(token, { session, state: 'pending' });
        if (issuedPreviewTokens.size > 10000) issuedPreviewTokens.delete(issuedPreviewTokens.keys().next().value!);
        result.text += `\npreview_ttl_s: ${ctx.config.preview.ttlS}; expires_at: ${new Date(ctx.runner.now() + ctx.config.preview.ttlS * 1000).toISOString()}\npreview_token: ${token}`;
      }
      return result;
    }
    if (preview!.scope !== scopeIdentity) return deny(`changed preview: invalidated by ${lastPreviewMutation.get(deps) ?? 'external operation'} (${tool.name} target scope changed)`);
    if (token) { pending.delete(token); issuedPreviewTokens.set(token, { session, state: `${tool.name} confirmation already consumed` }); }
    if (tool.name === 'archive') return writeTool(deps, 'archive', {}, async (fresh) => {
      await applyArchive(fresh, scope as Awaited<ReturnType<typeof archiveClosed>>);
      return { text: JSON.stringify(scope, null, 2), executed: true, announce: 'archive closed task state' };
    });
    if (tool.name === 'gc') return writeTool(deps, 'gc', {}, async (fresh) => {
      const plan = scope as GcPlan;
      const result = await applyGc(fresh, plan);
      return { text: JSON.stringify(result, null, 2), executed: true, announce: `gc: ${result.done.length} items, ${result.freedBytes} bytes` };
    });
    return original(deps, args);
  });
}

for (const tool of MCP_TOOLS.filter(t => ['status', 'events_since', 'queue_list', 'cohort_show', 'limits', 'capacity'].includes(t.name))) {
  tool.input = { ...tool.input, format: z.enum(['text', 'json']).optional(), detail: z.boolean().optional(), ...(['status', 'capacity'].includes(tool.name) ? { offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() } : {}) };
  tool.description += ' Default: concise text only. format: "json" or detail: true returns full data.';
  const run = tool.run;
  tool.run = async (deps, args) => {
    const result = await run(deps, args);
    if (result.isError) return result;
    if (result.data !== undefined) return ok(args.format === 'json' || args.detail === true ? JSON.stringify(result.data, null, 2) : result.text);
    const at = result.text.search(/\n\n(?=[{[])/);
    const raw = at >= 0 ? result.text.slice(at + 2) : result.text;
    if (args.format === 'json' || args.detail === true) return ok(raw);
    if (tool.name === 'status' || tool.name === 'events_since') return ok(at >= 0 ? result.text.slice(0, at) : result.text);
    try {
      const data = JSON.parse(raw);
      if (tool.name === 'cohort_show') return ok([data.cohort, ...data.tasks.map((r: Record<string, unknown>) => `${r.task} ${r.agent}/${r.model}/${r.effort} ${r.state} ${r.duration} cohort=${r.cohort ?? 'n/d'} report=${r.report} decisions=${r.decisions ?? 0} actions=${r.actions ?? 0}`), `outputs: ${JSON.stringify({ integrate: data.integrate, decisions: data.decisions, actions: data.actions, checks: data.checks, warnings: data.warnings })}`, ...data.queued.map((r: Record<string, unknown>) => `${r.task}: ${r.startCondition}`)].join('\n'));
      if (tool.name === 'capacity') return ok([diskLine(data.disk), ...snapshotLines(capacitySnapshot(data))].join('\n'));
      if (tool.name === 'limits') return ok(data.providers.map((p: Record<string, unknown>) => `${p.agent}: used=${p.used} limit=${p.limit ?? 'n/d'} free=${p.free ?? 'n/d'} reserved=${p.reserved} queued=${p.queued}`).join('\n'));
      if (Array.isArray(data)) return ok(data.map(r => `${r.task} ${r.agent}/${r.model}/${r.effort}: ${r.startCondition}`).join('\n') || 'The queue is empty.');
      return ok(compactFacts(data));
    } catch { return ok(at >= 0 ? result.text.slice(0, at) : result.text); }
  };
}

function compactFacts(value: unknown, prefix = ''): string {
  if (value === null || value === undefined) return `${prefix}=n/d`;
  if (Array.isArray(value)) return value.map((v, i) => compactFacts(v, `${prefix}[${i}]`)).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => compactFacts(v, prefix ? `${prefix}.${k}` : k)).join('\n');
  return `${prefix}=${value}`;
}

/** Session-local snapshots: continuing a response never repeats a write or consumes another event page. */
const responses = new WeakMap<McpDeps, Map<string, { tool: string; text: string; isError?: boolean; onDelivered?: () => Promise<void>; covered?: number }>>();
MCP_TOOLS.push(def({ name: 'response_page', title: 'Continue a bounded response', kind: 'read', description: 'Retrieve a cached response fragment without repeating the original operation. CLI: no equivalent (MCP response transport).', input: { response_id: z.string().max(100), response_offset: z.number().int().min(0) }, annotations: readOnly('Continue a bounded response'), run: async () => fail('response_id is required') }));
export function responseWireBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text: result.text }], ...(result.isError ? { isError: true } : {}) }));
}
for (const tool of MCP_TOOLS) {
  const run = tool.run;
  tool.description += ' Every response is bounded by mcp.max_response_kb (default 8 KiB). A truncated JSON envelope gives response_id and next_response_offset; call response_page with only those continuation fields to retrieve the next fragment without executing again. Concatenate fragment values to recover the original text/JSON.';
  tool.run = (deps, args) => guarded(async () => {
    const budget = Math.floor(deps.context(() => {}).config.mcp.maxResponseKb * 1024);
    const { response_id, response_offset, ...input } = args;
    let cache = responses.get(deps);
    if (!cache) { cache = new Map(); responses.set(deps, cache); }
    let id = response_id as string | undefined;
    let saved: { tool: string; text: string; isError?: boolean; onDelivered?: () => Promise<void>; covered?: number };
    if (id) {
      const found = cache.get(id);
      if (!found || (tool.name !== 'response_page' && found.tool !== tool.name)) return fail('Response expired or belongs to another tool. Repeat the original read/preview; do not repeat a confirmed write.');
      saved = found;
    } else {
      if (response_offset !== undefined) return fail('response_offset requires response_id');
      const result = await guarded(() => run(deps, input));
      if (responseWireBytes(result) <= budget && Buffer.byteLength(JSON.stringify(result)) <= budget) { await result.onDelivered?.(); const { onDelivered: _callback, ...delivered } = result; return delivered; }
      saved = { tool: tool.name, text: result.text, onDelivered: result.onDelivered, covered: 0, ...(result.isError ? { isError: true } : {}) };
      id = crypto.randomUUID();
      while (cache.size >= 16 || [...cache.values()].reduce((n, r) => n + Buffer.byteLength(r.text), 0) > 8 * 1024 * 1024) cache.delete(cache.keys().next().value!);
      cache.set(id, saved);
    }
    const offset = Number(response_offset ?? 0);
    if (offset > saved.text.length) return fail('response_offset is beyond end');
    const page = (end: number): ToolResult => ({ text: JSON.stringify({ truncated: true, response_id: id, response_offset: offset, next_response_offset: end, has_more: end < saved.text.length, total_bytes: Buffer.byteLength(saved.text), fragment: saved.text.slice(offset, end), continuation: 'Call response_page with response_id and response_offset=next_response_offset only; concatenate fragments. No operation is repeated.' }), ...(saved.isError ? { isError: true } : {}) });
    let lo = offset, hi = saved.text.length;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); const result = page(mid); if (responseWireBytes(result) <= budget && Buffer.byteLength(JSON.stringify(result)) <= budget) lo = mid; else hi = mid - 1; }
    if (lo > offset && /[\uD800-\uDBFF]/.test(saved.text[lo - 1]!)) lo--;
    if (offset <= (saved.covered ?? 0)) saved.covered = Math.max(saved.covered ?? 0, lo);
    if (saved.covered === saved.text.length && saved.onDelivered) { await saved.onDelivered(); delete saved.onDelivered; }
    return page(lo);
  });
}

/** Names of the tools, read first. */
export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name);
