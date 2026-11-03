import { collectCapacity, capacitySnapshot, snapshotLines } from './capacity.ts';
import { collectGuide } from './guide.ts';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cancelTasks, planCancel } from './cancel.ts';
import { staleWarning, versionOf } from './mcp-processes.ts';
import { stableScript } from './mcp-install.ts';
import { closeTask } from './close.ts';
import { cohortEntries, cohortRows, findCohort, openCohortTasks, summarizeCohorts } from './cohort.ts';
import { collectOverlaps, collideText } from './collisions.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, readQueue, removeFromQueue, waiting } from './queue.ts';
import { liveWindows } from './plan.ts';
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
import { collectStatus, shownRows } from './status.ts';
import type { StatusRow } from './status.ts';
import { summarizeSpecs } from './summary.ts';
import { listArchivedRecords, listTaskRecords, readTaskPrompt } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { computeStats, markTask, parseResult, RESULTS, selectHistory } from './history.ts';
import { collectUsage } from './usage-report.ts';
import { planResume, resumeTasks } from './resume.ts';
import { planGc, renderGc } from './gc.ts';
import { collectEvents, renderEvents } from './chat-events.ts';
import { applySetLimits, collectLimits, planSetLimits, readReservations, releasePlaces, reservePlaces } from './limits.ts';
import type { LimitAssignments } from './limits.ts';
import { planLine } from './usage-report.ts';
import { openReader, readPlans } from './usage.ts';
import { AGENT_NAMES } from './config.ts';
import { AgentctlError, errorMessage, formatLocalTime } from './util.ts';

/*
 * The tools of `agentctl mcp`. This file is data and functions only: the MCP SDK front (src/mcp/server.ts) registers them.
 *
 * What the chat can reach: the status of the tasks, the last lines of a task window, the report file each task's TASK.md names,
 * and the prompt in TASK.md. Nothing takes a path from the chat. With `mcp.allow` set, the chat can also send a prompt, start tasks
 * from a spec, interrupt, close and move. Never: merge, push, rebase, delete a branch, run a shell command, read any other file.
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
async function guarded(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof AgentctlError) return fail(e.hint ? `${e.message}\nHint: ${e.hint}` : e.message);
    return fail(`internal error: ${errorMessage(e)}`);
  }
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
    agent: r.agent,
    model: r.model,
    effort: r.effort,
    state: r.state,
    window: r.window,
    started: r.started,
    startedLocal: r.startedLocal,
    duration: r.duration,
    progress: r.progress?.text ?? null,
    report: r.report,
    reportPulled: r.pulled !== null,
    lastLine: r.lastLine,
    question: r.question,
    hint: r.hint,
    cohort: r.cohort,
    collidesWith: r.collide,
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

async function runStatus(deps: McpDeps, args: { all?: boolean | undefined; cohort?: string | undefined }): Promise<ToolResult> {
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
  if (colliding.length > 0) extra.push(`Collisions: ${colliding.map((r) => `${r.task} ${collideText(r.collide)}`).join('; ')}. overlap lists the files.`);
  extra.push(awayLine(ctx));
  return ok(`${[statusLine(shown, rows.length - shown.length), ...extra].join('\n')}\n\n${JSON.stringify(shown.map(statusRowForChat), null, 2)}`);
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

async function runMark(deps: McpDeps, args: { task: string; result: string; note?: string | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'mark', { task: args.task, detail: `${args.result}${args.note ? ` – ${clipText(args.note, 80)}` : ''}` }, async (ctx) => {
    const result = parseResult(args.result);
    const marked = await markTask(ctx, args.task, result, args.note);
    return { text: `${marked.task}: marked ${marked.result}${marked.previous && marked.previous !== marked.result ? ` (was ${marked.previous})` : ''}. It is in the history (log, stats).`, executed: true, announce: `mark ${marked.task} ${marked.result}` };
  });
}

async function runAway(deps: McpDeps, args: { on: boolean }): Promise<ToolResult> {
  return writeTool(deps, 'away', { detail: args.on ? 'on' : 'off' }, async (ctx) => {
    const { state, changed } = await setAway(ctx, args.on, 'mcp');
    return { text: `${changed ? 'Away is' : 'Away was already'} ${state.on ? 'on' : 'off'}.\n${renderAway(awayReport(ctx.config)).join('\n')}`, executed: changed, announce: `away ${state.on ? 'on' : 'off'}` };
  });
}

async function runEventsSince(deps: McpDeps, args: { since?: string | undefined; cohort?: string | undefined; peek?: boolean | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const report = await collectEvents(ctx, { client: 'mcp', since: args.since, cohort: args.cohort, keep: Boolean(args.peek) });
  return ok(`${renderEvents(report).join('\n')}\n\n${JSON.stringify(report, null, 2)}`);
}

async function runGcPreview(deps: McpDeps, args: { older_than?: string | undefined; merged?: boolean | undefined; cohort?: string | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const plan = await planGc(ctx, { olderThan: args.older_than, branches: args.merged, cohort: args.cohort });
  return ok(`${renderGc(plan).join('\n')}\n\nThis is a preview only: the chat cannot clean up. The user runs "agentctl gc --apply" (or key G on the board).\n\n${JSON.stringify(plan, null, 2)}`);
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
    lines.push(`MCP server: agentctl ${deps.server.version} (${deps.server.script}, pid ${deps.server.pid}, started ${deps.server.started})${stable && stable !== deps.server.version ? ` – the stable copy on disk is ${stable}: ${staleNote}` : ''}`);
  }
  for (const w of ctx.config.mcp.warnings) lines.push(`Config warning: ${w}`);
  if (ctx.config.reloadWarning) lines.push(`Config warning: ${ctx.config.reloadWarning}`);
  return lines;
}

const staleNote = 'the user should quit the Claude app (⌘Q) and open it again to load it';

async function runVersion(deps: McpDeps): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const stableVersion = versionOf(stableScript());
  const info = {
    version: deps.server?.version ?? null,
    script: deps.server?.script ?? null,
    pid: deps.server?.pid ?? null,
    started: deps.server?.started ?? null,
    stableCopyVersion: stableVersion ?? null,
    older: deps.server !== undefined && stableVersion !== undefined && stableVersion !== deps.server.version,
    writeToolsAllowed: ctx.config.mcp.allow,
    configWarnings: [...ctx.config.mcp.warnings, ...(ctx.config.reloadWarning ? [ctx.config.reloadWarning] : [])],
  };
  const note = info.older ? `\n\nThis server runs ${info.version}, the stable copy on disk is ${stableVersion}: ${staleNote}.` : '';
  return ok(`${JSON.stringify(info, null, 2)}${note}`);
}

async function queueViews(ctx: Context): Promise<ReturnType<typeof describeQueue>> {
  const entries = readQueue(ctx.config);
  return entries.length === 0 ? [] : describeQueue(ctx.config, entries, await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true }));
}

async function runQueueList(deps: McpDeps): Promise<ToolResult> {
  const views = await queueViews(deps.context(() => {}));
  if (views.length === 0) return ok('The queue is empty.');
  const list = views.map((v) => ({
    position: v.position,
    task: v.entry.task,
    status: v.entry.status,
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
    blocked: v.condition.kind === 'blocked',
  }));
  const paused = views.some((v) => v.condition.kind === 'paused');
  return ok(`${waiting(views.map((v) => v.entry)).length} waiting in the queue${paused ? ' (the queue is paused: nothing starts)' : ''}; ${views.length - waiting(views.map((v) => v.entry)).length} starting or failed.\n\n${JSON.stringify(list, null, 2)}`);
}

async function runCohortList(deps: McpDeps): Promise<ToolResult> {
  const list = await summarizeCohorts(deps.context(() => {}));
  if (list.length === 0) return ok('No cohorts. A task joins one with "cohort: <name>" in its spec.');
  return ok(`${list.length} cohort${list.length === 1 ? '' : 's'}; cohort_show lists the tasks of one.\n\n${JSON.stringify(list, null, 2)}`);
}

async function runCohortShow(deps: McpDeps, args: { cohort: string }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const meta = findCohort(ctx.config, args.cohort);
  const rows = cohortRows(await collectStatus(ctx, { archived: true }), meta.name);
  const views = (await queueViews(ctx)).filter((v) => cohortEntries([v.entry], meta.name).length > 0);
  const queued = views.map((v) => ({ task: v.entry.task, position: v.position, startCondition: v.condition.text, blocked: v.condition.kind === 'blocked' }));
  const head = { cohort: meta.name, created: meta.created || null, note: meta.note ?? null, tasks: rows.length, queued: queued.length };
  return ok(`${JSON.stringify(head)}\n\n${JSON.stringify({ tasks: rows.map(statusRowForChat), queued }, null, 2)}`);
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
  return ok(`${result.task}: last ${result.lines.length} lines of its window (agent footer removed)\n\n${result.lines.join('\n')}`);
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
export function readReportFile(record: Pick<TaskRecord, 'task' | 'report'>): { text: string; bytes: number; truncated: boolean } {
  const file = record.report;
  if (!file) throw new AgentctlError(`${record.task} has no report path`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    throw new AgentctlError(`${record.task} has no report yet`, 'Call peek to see what the agent is doing, or wait for it to finish.');
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new AgentctlError(`the report of ${record.task} is not a regular file; refusing to read it`);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    return { text: buffer.toString('utf8'), bytes: st.size, truncated: st.size > MAX_TEXT_BYTES };
  } finally {
    fs.closeSync(fd);
  }
}

async function runGetReport(deps: McpDeps, args: { task: string }): Promise<ToolResult> {
  const record = findRecord(deps.context(() => {}), args.task);
  const r = readReportFile(record);
  const note = r.truncated ? `\n\n[cut: the first ${MAX_TEXT_BYTES / 1024} KB of ${r.bytes} bytes]` : '';
  return ok(`=== ${record.task} (${record.agent} ${record.model}/${record.effort}) ===\n${r.text.trimEnd()}${note}`);
}

async function runPullReady(deps: McpDeps, args: { cohort?: string | undefined } = {}): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const everyRow = await collectStatus(ctx);
  const rows = args.cohort === undefined ? everyRow : cohortRows(everyRow, findCohort(ctx.config, args.cohort).name);
  const chosen = selectReady(rows, false);
  if (chosen.length === 0) return ok(noReadyMessage(rows));
  // As many reports as fit under the size limit; the others stay un-pulled for the next call.
  const taken: StatusRow[] = [];
  let total = 0;
  for (const row of chosen) {
    const size = fs.statSync(row.reportPath).size;
    if (taken.length > 0 && total + size > MAX_TEXT_BYTES) continue;
    taken.push(row);
    total += size;
  }
  const left = chosen.filter((r) => !taken.includes(r));
  const { text, pulled } = joinReports(taken);
  let body = text;
  if (Buffer.byteLength(body) > MAX_TEXT_BYTES) {
    body = `${Buffer.from(body).subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n\n[cut at ${MAX_TEXT_BYTES / 1024} KB; get_report ${taken[0]?.task ?? ''} reads the file in full]`;
  }
  await markPulled(ctx, taken);
  const head = `${pulled.length} new report${pulled.length === 1 ? '' : 's'}, now marked as pulled: ${pulled.map((p) => p.task).join(', ')}`;
  const rest = left.length > 0 ? `\n${left.length} more did not fit under ${MAX_TEXT_BYTES / 1024} KB and stay new: ${left.map((r) => r.task).join(', ')}. Call pull_ready again.` : '';
  return ok(`${head}${rest}\n\n${body}`);
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
    fs.appendFileSync(file, `${line}\n`);
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
    if (result.executed) await deps.notify(`czat zlecił: ${result.announce}`).catch(() => undefined);
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
    await sendPrompts(ctx, [{ task: target.task, window: target.window, prompt: args.text }]);
    return { text: `${target.task}: prompt sent (${args.text.length} characters)\n${lines.join('\n')}`.trim(), executed: true, announce: `send ${target.task}` };
  });
}

async function runInterrupt(deps: McpDeps, args: { task: string }): Promise<ToolResult> {
  return writeTool(deps, 'interrupt', { task: args.task }, async (ctx) => {
    const target = await resolveRunningTask(ctx, args.task);
    const r = await interruptTask(ctx, target.task);
    return { text: `${r.task}: interrupted (${r.key} sent); the window stays open`, executed: true, announce: `interrupt ${r.task}` };
  });
}

async function runClose(deps: McpDeps, args: { task: string; remove_worktree?: boolean | undefined }): Promise<ToolResult> {
  return writeTool(deps, 'close', { task: args.task, detail: args.remove_worktree ? 'remove_worktree' : undefined }, async (ctx, lines) => {
    if (args.remove_worktree && !ctx.config.mcp.allowRmWorktree) {
      throw new AgentctlError('removing the worktree is not allowed for the chat', `The user can allow it with: mcp: {allow_rm_worktree: true} in ${ctx.config.path}. Without remove_worktree the window is closed and the worktree stays.`);
    }
    const targets = await listTargets(ctx);
    const match = matchTask(args.task, targets);
    if (match.kind === 'many') throw new AgentctlError(`"${args.task}" fits more than one task:\n${describeTargets(match.matches).join('\n')}`, 'Use the full task ID.');
    if (match.kind === 'none') throw new AgentctlError(`no task "${args.task}"`, 'Call status.');
    const task = match.target.task;
    await closeTask(ctx, task, { rmWorktree: Boolean(args.remove_worktree) });
    return { text: `${task}: closed${args.remove_worktree ? ', worktree removed (the branch stays)' : '; the worktree and the report stay'}\n${lines.join('\n')}`.trim(), executed: true, announce: `close ${task}` };
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

async function runNew(deps: McpDeps, args: { spec: string; confirm?: boolean | undefined }): Promise<ToolResult> {
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
    for (const raw of raws) {
      // `setup` commands run in a shell. A task the chat starts runs no shell command of the chat's choosing; setup belongs in .agentctl.yaml.
      if ('setup' in raw.header) {
        throw new AgentctlError(`${String(raw.header.task ?? 'a task')}: "setup" runs shell commands and is not accepted from the chat`, 'Put setup commands in the .agentctl.yaml of the repository, or start the task from the terminal.');
      }
    }
    const specs = raws.map((raw) => resolveSpec(raw, { config: ctx.config }));
    const cap = !args.confirm && ctx.config.capacity.snapshot ? capacitySnapshot(await collectCapacity(ctx), specs.map((s) => s.agent)) : undefined;
    const summary = summarizeSpecs(specs, cap ? snapshotLines(cap) : []).join('\n');
    if (!args.confirm) {
      return { text: `${summary}\n\nNot started yet. Show this to the user and ask; if they agree, call new again with the same spec and confirm: true.`, executed: false, announce: '' };
    }
    // The chat cannot answer a folder-trust dialog: stop at it (the error says so) instead of waiting for a person.
    const results = await newTasks(ctx, specs, { waitTrust: false, noSwitch: true, ...(deps.self ? { self: deps.self } : {}) });
    const startedCap = ctx.config.capacity.snapshot ? capacitySnapshot(await collectCapacity(ctx), results.map((r) => r.effective.agent)) : undefined;
    const started = results.map((r) => `${r.task} (window ${r.window}, ${r.effective.agent} ${r.effective.model}/${r.effective.effort})`).join('; ');
    return { text: `Started: ${started}\n${startedCap ? snapshotLines(startedCap).join('\n') + '\n' : ''}${lines.join('\n')}`.trim(), executed: true, announce: `new ${results.map((r) => r.task).join(', ')}` };
  });
}

async function runQueue(deps: McpDeps, args: { spec: string; agent?: 'claude' | 'codex' | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  let tasks = '?';
  try {
    tasks = splitSpecs(args.spec, 'mcp').map((s) => String(s.header.task ?? '?')).join(', ');
  } catch {
    // only for the audit line
  }
  return writeTool(deps, 'queue', { task: tasks, detail: `${clipText(args.spec, 120)} confirm=${Boolean(args.confirm)}` }, async (ctx) => {
    const raws = splitSpecs(args.spec, 'the spec from the chat');
    for (const raw of raws) {
      if ('setup' in raw.header) {
        throw new AgentctlError(`${String(raw.header.task ?? 'a task')}: "setup" runs shell commands and is not accepted from the chat`, 'Put setup commands in the .agentctl.yaml of the repository, or queue the task from the terminal.');
      }
    }
    const opts = args.agent ? { agent: args.agent } : {};
    const plan = await planQueueAdd(ctx, raws, opts);
    if (!args.confirm) {
      return { text: `${plan.summary.join('\n')}\n\nNot queued yet. Show this to the user and ask; if they agree, call queue again with the same spec and confirm: true.`, executed: false, announce: '' };
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

async function runCancel(deps: McpDeps, args: { task?: string | undefined; cohort?: string | undefined; reason?: string | undefined; remove_worktree?: boolean | undefined; confirm?: boolean | undefined }): Promise<ToolResult> {
  const label = args.task ?? (args.cohort !== undefined ? `cohort ${args.cohort}` : '?');
  return writeTool(deps, 'cancel', { task: label, detail: `${args.reason ? `reason=${clipText(args.reason, 80)} ` : ''}${args.remove_worktree ? 'remove_worktree ' : ''}confirm=${Boolean(args.confirm)}` }, async (ctx, lines) => {
    if ((args.task === undefined) === (args.cohort === undefined)) throw new AgentctlError('give either task or cohort', 'cancel takes one task (task) or all open tasks of a cohort (cohort), not both and not neither.');
    if (args.remove_worktree && !ctx.config.mcp.allowRmWorktree) {
      throw new AgentctlError('removing the worktree is not allowed for the chat', `The user can allow it with: mcp: {allow_rm_worktree: true} in ${ctx.config.path}. Without remove_worktree the worktree and the branch stay.`);
    }
    const cohortName = args.cohort === undefined ? undefined : findCohort(ctx.config, args.cohort).name;
    const inputs = args.task !== undefined ? [args.task] : await openCohortTasks(ctx, cohortName as string, { queued: true });
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

export const MCP_TOOLS: McpToolDef[] = [
  def({
    name: 'status',
    title: 'Status of all agent tasks',
    kind: 'read',
    description:
      'Current state of every agentctl task: agent/model/effort, state (working, background, waiting, needs-input, needs-trust, limited, report-ready, dead, orphan, superseded), ' +
      'start time (started in UTC, startedLocal in the user\'s local time: show the local one), running time, git progress, whether a report exists and was already pulled, the last line and the open question of a waiting agent. ' +
      'Use this FIRST when the user asks what is running, who waits for them, or whether something is ready, and at the start of a planning session. ' +
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
      'The chat gets no notifications, so this is how you learn what changed; the "last" marker is kept per client, so the first call looks back 24 hours. Events are recorded while "agentctl watch" runs. since: last (default), an age (30m, 2h, 1d), HH:MM or an ISO time. peek: true does not move the marker.',
    input: { since: z.string().max(40).optional().describe('last (default), an age like 30m / 2h / 1d, HH:MM today, or an ISO time.'), cohort: cohortArg.optional(), peek: z.boolean().optional().describe('true: do not move the "last" marker.') },
    annotations: readOnly('What changed since the last look'),
    run: (deps, args) => guarded(() => runEventsSince(deps, args as { since?: string; cohort?: string; peek?: boolean })),
  }),
  def({
    name: 'gc_preview',
    title: 'Preview of the clean-up',
    kind: 'read',
    description:
      'What "agentctl gc" would free now, without doing anything: git worktrees of closed, cancelled and archived tasks without uncommitted changes, old files next to the reports, state folders to archive, merged branches (merged: true), each with its size, and what is skipped and why. ' +
      'There is no tool that cleans up: tell the user to run "agentctl gc --apply" (or press G on the board for the same preview).',
    input: { older_than: z.string().max(10).optional().describe('Age of the files next to the reports before they count: 12h, 7d, 2w. Default 7d.'), merged: z.boolean().optional().describe('true: also list merged branches of finished tasks.'), cohort: cohortArg.optional() },
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
      `The report of one task (the file its spec names), up to ${MAX_TEXT_BYTES / 1024} KB. Use it when the user asks for the result of a particular task, also an older or closed one. ` +
      'It does not mark the report as pulled. Reads only that report file, never another path.',
    input: { task: taskArg },
    annotations: readOnly('Read one report'),
    run: (deps, args) => guarded(() => runGetReport(deps, args as { task: string })),
  }),
  def({
    name: 'pull_ready',
    title: 'Take all new reports',
    kind: 'read',
    description:
      'All reports that are ready and not yet pulled, each under a header with the task and agent, in one answer; they are then marked as pulled (the only thing this tool changes, in agentctl\'s own state). ' +
      'Use it at the START of discussing the results of finished tasks, instead of asking the user to paste reports. A second call returns only reports that arrived since. cohort: only the reports of that cohort (the others stay new). Cancelled tasks are never included.',
    input: { cohort: cohortArg.optional() },
    annotations: { title: 'Take all new reports', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runPullReady(deps, args as { cohort?: string })),
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
    input: {},
    annotations: readOnly('The task queue'),
    run: (deps) => guarded(() => runQueueList(deps)),
  }),
  def({
    name: 'cohort_list',
    title: 'The cohorts',
    kind: 'read',
    description:
      'The cohorts (groups of tasks the user named, for example one batch of related work): per cohort the number of tasks by state (active, queued, reports, closed, cancelled), since when, and its note. ' +
      'Use it when the user talks about a batch by name or asks how a group of tasks is doing. Tasks without a name belong to no cohort.',
    input: {},
    annotations: readOnly('The cohorts'),
    run: (deps) => guarded(() => runCohortList(deps)),
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
    run: (deps) => guarded(async () => ({ text: JSON.stringify(await collectCapacity(deps.context(() => {})), null, 2) })),
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
      '"setup" commands (shell) are not accepted from the chat.',
    input: { spec: z.string().min(1).max(100_000).describe('The spec text: ---, YAML header, ---, prompt. Several specs may follow each other.'), confirm: z.boolean().optional().describe('true only after the user agreed to the summary.') },
    annotations: { title: 'Start tasks from a spec', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runNew(deps, args as { spec: string; confirm?: boolean })),
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
      agent: z.enum(['claude', 'codex']).optional().describe('Run the specs on this provider, translated through the equivalents table. The queue never switches provider by itself.'),
      confirm: z.boolean().optional().describe('true only after the user agreed to the summary.'),
    },
    annotations: { title: 'Put tasks in the queue', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runQueue(deps, args as { spec: string; agent?: 'claude' | 'codex'; confirm?: boolean })),
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
      cohort: cohortArg.optional(),
      reason: z.string().max(500).optional().describe('Why the work is cancelled (optional).'),
      remove_worktree: z.boolean().optional().describe('Also remove the git worktree. Refused unless the user allowed it in the config.'),
      confirm: z.boolean().optional().describe('true only after the user agreed to the described cancellation.'),
    },
    annotations: { title: 'Cancel tasks', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (deps, args) => guarded(() => runCancel(deps, args as { task?: string; cohort?: string; reason?: string; remove_worktree?: boolean; confirm?: boolean })),
  }),
  def({
    name: 'mark',
    title: 'Mark how a task turned out',
    kind: 'write',
    description:
      'WRITE, off unless the user put "mark" in mcp.allow. Records the result of a task the USER judged: ok, partial or fail, with an optional note; it goes to the history that log and stats read (the last mark of a task wins). ' +
      'It changes nothing else and needs no confirmation, but record only what the user said about the result - do not judge a task yourself.',
    input: { task: taskArg, result: z.enum(RESULTS).describe('ok, partial or fail.'), note: z.string().max(500).optional().describe('Why (optional).') },
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
    input: { task: taskArg, remove_worktree: z.boolean().optional().describe('Also remove the git worktree. Refused unless the user allowed it in the config.') },
    annotations: { title: 'Close a task', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (deps, args) => guarded(() => runClose(deps, args as { task: string; remove_worktree?: boolean })),
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

/** Names of the tools, read first. */
export const MCP_TOOL_NAMES = MCP_TOOLS.map((t) => t.name);
