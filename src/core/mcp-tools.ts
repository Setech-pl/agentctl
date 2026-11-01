import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { closeTask } from './close.ts';
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
import { AgentctlError, errorMessage } from './util.ts';

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
    duration: r.duration,
    progress: r.progress?.text ?? null,
    report: r.report,
    reportPulled: r.pulled !== null,
    lastLine: r.lastLine,
    question: r.question,
    hint: r.hint,
    finished: r.finished,
    hidden: r.hidden && !r.closed,
    closed: r.closed,
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

async function runStatus(deps: McpDeps, args: { all?: boolean | undefined }): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const all = Boolean(args.all);
  const rows = await collectStatus(ctx, { archived: all });
  const shown = shownRows(rows, all);
  return ok(`${statusLine(shown, rows.length - shown.length)}\n\n${JSON.stringify(shown.map(statusRowForChat), null, 2)}`);
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
    return { task: r.task, state: r.state, pulled: r.pulled !== null, bytes, modified };
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

async function runPullReady(deps: McpDeps): Promise<ToolResult> {
  const ctx = deps.context(() => {});
  const rows = await collectStatus(ctx);
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
    started: record.started,
    pulled: record.pulled ?? null,
    review_of: record.reviewOf ?? null,
    continues: record.continues ?? null,
    superseded_by: record.supersededBy ?? null,
    pin: record.pin === true,
    closed: record.closed === true,
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
    const summary = summarizeSpecs(specs).join('\n');
    if (!args.confirm) {
      return { text: `${summary}\n\nNot started yet. Show this to the user and ask; if they agree, call new again with the same spec and confirm: true.`, executed: false, announce: '' };
    }
    // The chat cannot answer a folder-trust dialog: stop at it (the error says so) instead of waiting for a person.
    const results = await newTasks(ctx, specs, { waitTrust: false, noSwitch: true, ...(deps.self ? { self: deps.self } : {}) });
    const started = results.map((r) => `${r.task} (window ${r.window}, ${r.effective.agent} ${r.effective.model}/${r.effective.effort})`).join('; ');
    return { text: `Started: ${started}\n${lines.join('\n')}`.trim(), executed: true, announce: `new ${results.map((r) => r.task).join(', ')}` };
  });
}

// ---- the registry

const taskArg = z.string().min(1).max(60).describe('Task ID such as NC-42; case does not matter and a unique prefix is enough.');
const allArg = z.boolean().optional().describe('true: also hidden and closed (and archived) tasks. Default false.');

const readOnly = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

export const MCP_TOOLS: McpToolDef[] = [
  def({
    name: 'status',
    title: 'Status of all agent tasks',
    kind: 'read',
    description:
      'Current state of every agentctl task: agent/model/effort, state (working, background, waiting, needs-input, needs-trust, limited, report-ready, dead, orphan, superseded), ' +
      'running time, git progress, whether a report exists and was already pulled, the last line and the open question of a waiting agent. ' +
      'Use this FIRST when the user asks what is running, who waits for them, or whether something is ready, and at the start of a planning session. ' +
      'Hidden and closed tasks are left out unless all is true.',
    input: { all: allArg },
    annotations: readOnly('Status of all agent tasks'),
    run: (deps, args) => guarded(() => runStatus(deps, args as { all?: boolean })),
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
      'Use it at the START of discussing the results of finished tasks, instead of asking the user to paste reports. A second call returns only reports that arrived since.',
    input: {},
    annotations: { title: 'Take all new reports', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (deps) => guarded(() => runPullReady(deps)),
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
