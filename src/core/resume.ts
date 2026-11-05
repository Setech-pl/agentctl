import { validateLaunch, launchEnvironment } from './safety.ts';
import { provider, isActive } from './providers/registry.ts';
import { withStartLock, reserveStarts, releaseStarts } from './start-lock.ts';
import { queuePrompt, deliverPendingPrompt } from './prompt-delivery.ts';
import { waitForReady } from './ready.ts';
import { attemptFields } from './report-state.ts';
import fs from 'node:fs';
import { agentCommandLine, buildResumeArgv, reportInstructions } from './agents.ts';
import { checkWindowLimit } from './checks.ts';
import type { LiveWindow } from './checks.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { planEventWiring } from './events.ts';
import type { SelfArgv } from './events.ts';
import { liveWindows } from './plan.ts';
import { matchTask } from './resolve.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { readTaskRecord, setHeaderField, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { readTaskSessions } from './usage.ts';
import { assertAgentSpawnAllowed, openAgentWindow } from './window-guard.ts';
import { AgentctlError, plural } from './util.ts';

/*
 * `agentctl resume`: after a restart of the Mac (or a killed tmux server) the tasks that were at work have a worktree and no window.
 * Resuming makes the window again and starts the agent in "resume" mode - the conversation, not the prompt - with the model, effort, flags,
 * event hooks and usage tap the task was started with. A task whose report is ready is left alone unless `--all` says otherwise.
 */

export interface ResumeCandidate {
  task: string;
  window: string;
  agent: AgentName;
  model: string;
  effort: string;
  worktree: string;
  /** A session of the task that the hooks or the usage tap recorded; absent: `--continue` / `--last` find the latest one in the worktree. */
  sessionId?: string;
  hasReport: boolean;
}

/** Active tasks with a worktree and no window. Without `all`, the ones whose report is ready are left out. */
export async function findResumable(ctx: Context, opts: { all?: boolean; rows?: StatusRow[] } = {}): Promise<ResumeCandidate[]> {
  const rows = opts.rows ?? (await collectStatus(ctx, { progress: false, archived: false }));
  const out: ResumeCandidate[] = [];
  for (const row of rows) {
    if (row.window !== 'gone' || row.closed || row.cancelled || row.archived || row.hidden || row.supersededBy) continue;
    if (row.state === 'superseded' || row.state === 'orphan') continue;
    const record = readTaskRecord(ctx.config, row.windowName);
    if (!record || record.agent === 'unknown') continue;
    const worktree = record.repos[0]?.worktree;
    if (!worktree || !fs.existsSync(worktree)) continue;
    const hasReport = row.report === 'yes';
    if (hasReport && !opts.all) continue;
    const sessions = readTaskSessions(ctx.config, record.window);
    const sessionId = (sessions[record.agent] ?? []).at(-1)?.id;
    out.push({ task: row.task, window: record.window, agent: record.agent, model: record.model, effort: record.effort, worktree, ...(sessionId ? { sessionId } : {}), hasReport });
  }
  return out;
}

export interface ResumePlan {
  items: ResumeCandidate[];
  skipped: { task: string; reason: string }[];
  summary: string[];
}

/** Which tasks would be resumed: those typed (each must be resumable), or all candidates; limits are respected. */
export async function planResume(ctx: Context, typed: string[], opts: { all?: boolean } = {}): Promise<ResumePlan> {
  const { config } = ctx;
  const candidates = await findResumable(ctx, { all: opts.all || typed.length > 0 });
  let chosen = candidates;
  if (typed.length > 0) {
    const targets = candidates.map((c) => ({ task: c.task, window: c.window, alive: false }));
    chosen = typed.map((input) => {
      const m = matchTask(input, targets);
      if (m.kind === 'one') return candidates.find((c) => c.window === m.target.window) as ResumeCandidate;
      if (m.kind === 'many') throw new AgentctlError(`"${input}" fits more than one task: ${m.matches.map((x) => x.task).join(', ')}`, 'Use the full task ID.');
      throw new AgentctlError(`${input} cannot be resumed`, candidates.length > 0 ? `Resumable: ${candidates.map((c) => c.task).join(', ')}.` : 'No active task has a worktree and no window. "agentctl status" shows the tasks.');
    });
  }
  const skipped: ResumePlan['skipped'] = [];
  const items: ResumeCandidate[] = [];
  const occupied: LiveWindow[] = await liveWindows(ctx);
  for (const c of chosen) {
    if (!isActive(config, c.agent)) { skipped.push({ task: c.task, reason: `provider ${c.agent} is not enabled` }); continue; }
    if (occupied.some(w => w.window === c.window)) { skipped.push({ task: c.task, reason: 'task is already starting or running' }); continue; }
    const problem = checkWindowLimit(c.agent, config.limits[c.agent], occupied, config.session);
    if (problem) {
      skipped.push({ task: c.task, reason: problem });
      continue;
    }
    occupied.push({ window: c.window, agent: c.agent });
    items.push(c);
  }
  const summary = [
    items.length === 0 ? 'Nothing to resume.' : `Resume ${items.length} task${items.length === 1 ? '' : 's'}:`,
    ...items.map((c) => `  ${c.task}  ${c.agent}/${c.model}/${c.effort}  ${c.sessionId ? `session ${c.sessionId.slice(0, 8)}` : provider(c.agent).resumeLabel()}  in ${c.worktree}${c.hasReport ? '  (has a report)' : ''}`),
    ...skipped.map((s) => `  skipped ${s.task}: ${s.reason}`),
  ];
  return { items, skipped, summary };
}

export interface ResumeResult {
  task: string;
  command: string;
}

/** Make the windows and start the agents in resume mode. The prompt is not pasted again. Stops at the first failure and says which tasks went. */
export async function resumeTasks(ctx: Context, plan: ResumePlan, opts: { self?: SelfArgv | undefined } = {}): Promise<ResumeResult[]> {
  if (ctx.runner.dryRun) return startResumed(ctx, plan, opts);
  const admission = await withStartLock(ctx, async () => {
    const fresh = await planResume(ctx, plan.items.map(c => c.task), { all: true });
    const wanted = new Set(plan.items.map(c => c.task));
    fresh.items = fresh.items.filter(c => wanted.has(c.task));
    return { plan: fresh, ids: await reserveStarts(ctx, fresh.items) };
  });
  try { return await startResumed(ctx, admission.plan, opts); }
  finally { await releaseStarts(ctx, admission.ids); }
}
async function startResumed(ctx: Context, plan: ResumePlan, opts: { self?: SelfArgv | undefined }): Promise<ResumeResult[]> {
  const { tmux, runner, config } = ctx;
  const results: ResumeResult[] = [];
  let sessionUp = await tmux.hasSession();
  for (const c of plan.items) {
    const record = readTaskRecord(config, c.window) as TaskRecord;
    // Before the attempt is written into the record: a refused resume leaves it as it was.
    assertAgentSpawnAllowed(ctx, { task: c.task, report: record.report, repos: record.repos, reviewOf: record.reviewOf, autoReview: record.autoReview, origin: 'resume' });
    const order = { agent: c.agent, model: c.model, effort: c.effort as import('./config.ts').Effort, task: c.task };
    validateLaunch(config, order, record.env);
    const attempt = attemptFields(record, runner.now());
    Object.assign(record, attempt);
    await withStartLock(ctx, () => setHeaderFields(runner, taskFile(config, c.window), { attempt: attempt.attempt, attempt_id: attempt.attemptId, attempt_started: attempt.attemptStarted, attempt_report_baseline: attempt.attemptReportBaseline, turn_ended_at: null, report_candidate: null, pulled: null, summary_delivered: null, report_complete_hash: null }));
    const wiring = config.notify.events && opts.self ? planEventWiring({ agent: c.agent, task: c.task, window: c.window, config, self: opts.self, env: record.env, worktree: c.worktree }) : undefined;
    for (const file of wiring?.files ?? []) await runner.writeFile(file.path, file.content);
    const started = await openAgentWindow(ctx, { task: c.task, window: c.window, cwd: c.worktree, env: launchEnvironment(config, order, record.env), report: record.report, repos: record.repos, reviewOf: record.reviewOf, autoReview: record.autoReview, origin: 'resume', sessionUp });
    if (started.code !== 0) throw new AgentctlError(`${c.task}: tmux could not make the window: ${started.stderr.trim() || `exit ${started.code}`}`, results.length > 0 ? `Resumed before it: ${results.map((r) => r.task).join(', ')}.` : undefined);
    sessionUp = true;
    const windowId = (await tmux.windows()).find((w) => w.plain === c.window)?.id;
    if (windowId) await setHeaderField(runner, taskFile(config, c.window), 'window_id', windowId);
    const command = agentCommandLine(buildResumeArgv({ agent: c.agent, model: c.model, effort: c.effort as never, task: c.task, remoteControl: record.remoteControl }, config.agents[c.agent], wiring?.args, c.sessionId));
    await runner.exec('tmux', ['set-option', '-w', '-t', windowId || tmux.target(c.window), '@agentctl-role', 'task']);
    await tmux.typeCommand(c.window, command);
    const settings = config.agents[c.agent], note = reportInstructions(attempt.attemptId, record.report);
    const ready = await waitForReady(runner, tmux, c.window, { pattern: settings.readyPattern, emptyInput: true, trustPattern: settings.trustPattern, timeoutMs: Math.min(5000, settings.readyTimeout * 1000) });
    await queuePrompt(ctx, record, note);
    if (!ready.ready || await deliverPendingPrompt(ctx, c.window) !== 'sent') ctx.info(`${c.task}: report instructions pending until idle: ${note}`);
    ctx.info(`${c.task}: window ${config.session}:${c.window} running ${command}`);
    results.push({ task: c.task, command });
  }
  return results;
}

export const resumeText = (n: number): string => `${n} ${plural(n, 'zadanie', 'zadania', 'zadań')} do wznowienia (agentctl resume)`;

