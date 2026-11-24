import { chatQuotaWait } from './chat-quotas.ts';
import { checkHostLimit } from './host-limits.ts';
import { installRemoteHooks } from './host-task.ts';
import { writeLaunchScript } from './launch-script.ts';
import { launchExitText, storeLaunchExit, trackLaunch } from './start-failure.ts';
import { validateLaunch, launchEnvironment } from './safety.ts';
import { assertCheckoutNotBorrowed, readonlyReviewEnvironment } from './readonly-review.ts';
import { provider, isActive, providerCommand } from './providers/registry.ts';
import { withStartLock, reserveStarts, releaseStarts } from './start-lock.ts';
import { queuePrompt, deliverPendingPrompt } from './prompt-delivery.ts';
import { waitForReady } from './ready.ts';
import { attemptFields } from './report-state.ts';
import fs from 'node:fs';
import { buildAgentArgv, buildResumeArgv, promptWithHeader, reportInstructions } from './agents.ts';
import { checkWindowLimit } from './checks.ts';
import type { LiveWindow } from './checks.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { planEventWiring } from './events.ts';
import type { SelfArgv } from './events.ts';
import { liveWindows } from './plan.ts';
import { matchKnownTask } from './resolve.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { readTaskPrompt, readTaskRecord, setHeaderFields, taskDir, taskFile } from './taskstore.ts';
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
  owner?: string;
  host?: string;
  task: string;
  window: string;
  agent: AgentName;
  model: string;
  effort: string;
  worktree: string;
  /** A session of the task that the hooks or the usage tap recorded; absent: `--continue` / `--last` find the latest one in the worktree. */
  sessionId?: string;
  originalPrompt?: boolean;
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
    if (!worktree) continue;
    if (record.host) {
      if (!record.remoteDir || !record.remoteReport || ctx.hosts.connection(record.host).unreachable) continue;
      if (!opts.rows && (await ctx.hosts.forHost(record.host).exec('test', ['-d', worktree], {readOnly: true})).code !== 0) continue;
    } else if (!record.repos.every(repo => fs.existsSync(repo.worktree))) continue;
    const hasReport = row.report === 'yes';
    if (hasReport && !opts.all) continue;
    const sessions = readTaskSessions(ctx.config, record.window);
    const sessionId = (sessions[record.agent] ?? []).at(-1)?.id;
    const originalPrompt = !sessionId && (Boolean(row.launchExit) || record.promptDelivery === 'launching' || Boolean(record.launchAt && record.pendingPrompt && record.promptKind !== 'followup'));
    out.push({ owner: record.owner, host: record.host, task: row.task, window: record.window, agent: record.agent, model: record.model, effort: record.effort, worktree, ...(sessionId ? { sessionId } : {}), ...(originalPrompt ? {originalPrompt} : {}), hasReport });
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
      const m = matchKnownTask(config, input, targets);
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
    const problem = checkHostLimit(config, c, occupied) ?? checkWindowLimit(c.agent, config.limits[c.agent], occupied, config.session) ?? chatQuotaWait(config, c, occupied);
    if (problem) {
      skipped.push({ task: c.task, reason: problem });
      continue;
    }
    occupied.push({ window: c.window, agent: c.agent, host: c.host, owner: c.owner });
    items.push(c);
  }
  const summary = [
    items.length === 0 ? 'Nothing to resume.' : `Resume ${items.length} task${items.length === 1 ? '' : 's'}:`,
    ...items.map((c) => `  ${c.task}  ${c.agent}/${c.model}/${c.effort}  ${c.sessionId ? `session ${c.sessionId.slice(0, 8)}` : c.originalPrompt ? 'original prompt' : provider(c.agent).resumeLabel()}  in ${c.worktree}${c.hasReport ? '  (has a report)' : ''}`),
    ...skipped.map((s) => `  skipped ${s.task}: ${s.reason}`),
  ];
  return { items, skipped, summary };
}

export interface ResumeResult {
  task: string;
  command: string;
}

/** Reopen saved sessions or send the original task when a dead launch left no session. */
export async function resumeTasks(ctx: Context, plan: ResumePlan, opts: { self?: SelfArgv | undefined; launchRetry?: boolean } = {}): Promise<ResumeResult[]> {
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
async function startResumed(ctx: Context, plan: ResumePlan, opts: { self?: SelfArgv | undefined; launchRetry?: boolean }): Promise<ResumeResult[]> {
  const { runner, config } = ctx;
  const results: ResumeResult[] = [];
  let sessionUp = await ctx.localTmux.hasSession();
  for (const c of plan.items) {
    const record = readTaskRecord(config, c.window) as TaskRecord;
    const tmux = c.host ? ctx.hosts.tmux(c.host) : ctx.localTmux;
    const execution = c.host ? ctx.hosts.forHost(c.host) : runner;
    // Before the attempt is written into the record: a refused resume leaves it as it was.
    const request = { task: c.task, report: record.report, reportAlt: record.reportAlt, host: c.host, repos: record.repos, reviewOf: record.reviewOf, reviewMode: record.reviewMode, autoReview: record.autoReview, origin: 'resume' as const };
    assertAgentSpawnAllowed(ctx, request);
    if (!c.host && !record.reviewMode) await assertCheckoutNotBorrowed(ctx, c.task);
    const order = { agent: c.agent, model: c.model, effort: c.effort as import('./config.ts').Effort, task: c.task };
    validateLaunch(config, order, record.env);
    const previousAttempt = record.attemptId;
    const prompt = c.originalPrompt ? readTaskPrompt(config, c.window) : undefined;
    if (c.originalPrompt && !prompt && !record.pendingPrompt) throw new AgentctlError(`${c.task}: original prompt is unavailable`);
    const pending = record.promptKind !== 'followup' && (c.originalPrompt || (c.sessionId && !record.deliveryStartedAt)) ? record.pendingPrompt : undefined;
    const attempt = attemptFields(record, runner.now());
    Object.assign(record, attempt);
    await withStartLock(ctx, () => setHeaderFields(runner, taskFile(config, c.window), { attempt: attempt.attempt, attempt_id: attempt.attemptId, attempt_started: attempt.attemptStarted, attempt_report_baseline: attempt.attemptReportBaseline, observed: null, observed_warning: null, turn_ended_at: null, report_candidate: null, pulled: null, summary_delivered: null, report_complete_hash: null, launch_at: null, launch_retried: opts.launchRetry ? true : null }));
    const wiring = !c.host && config.notify.events && opts.self ? planEventWiring({ attempt: record.attemptId, agent: c.agent, task: c.task, window: c.window, config, self: opts.self, env: record.env, worktree: c.worktree }) : undefined;
    for (const file of wiring?.files ?? []) {
      await runner.writeFile(file.path, file.content);
      if (file.path.endsWith('.sh')) {
        const protectedFile = await runner.exec('chmod', ['0700', file.path]);
        if (protectedFile.code !== 0) throw new Error(`Cannot protect event script: ${file.path}`);
      }
    }
    const remoteArgs = c.host ? await installRemoteHooks(ctx, { host: c.host, remoteDir: record.remoteDir, agent: c.agent, task: c.task }, record) : undefined;
    let launchEnv = launchEnvironment(config, order, record.env);
    if (record.reviewMode) launchEnv = await readonlyReviewEnvironment(ctx, record, launchEnv);
    const launch = { ...order, remoteControl: record.remoteControl, command: providerCommand(config, c.agent) };
    const settings = config.agents[c.agent], hooks = remoteArgs ?? wiring?.args;
    const argv = c.originalPrompt ? buildAgentArgv(launch, settings, hooks) : buildResumeArgv(launch, settings, hooks, c.sessionId);
    const command = await writeLaunchScript(execution, record.remoteDir ?? taskDir(config, c.window), argv, launchEnv, !c.host);
    const report = record.remoteReport ?? record.report;
    const note = pending && previousAttempt ? pending.replaceAll(previousAttempt, attempt.attemptId)
      : c.originalPrompt ? promptWithHeader({ model: c.model, effort: order.effort, prompt: prompt ?? pending!, report, reviewOf: record.reviewOf }, attempt.attemptId)
      : reportInstructions(attempt.attemptId, report, record.reviewOf != null);
    await queuePrompt(ctx, record, note, 'launching');
    const started = await openAgentWindow(ctx, { ...request, window: c.window, cwd: c.worktree, env: {}, sessionUp: c.host ? await tmux.hasSession() : sessionUp });
    if (started.code !== 0) throw new AgentctlError(`${c.task}: tmux could not make the window: ${started.stderr.trim() || `exit ${started.code}`}`, results.length > 0 ? `Resumed before it: ${results.map((r) => r.task).join(', ')}.` : undefined);
    if (!c.host) sessionUp = true;
    const windowId = (await tmux.windows()).find((w) => w.plain === c.window)?.id;
    await trackLaunch(ctx, tmux, record, windowId, opts.launchRetry);

    await execution.exec('tmux', ['set-option', '-w', '-t', windowId || tmux.target(c.window), '@agentctl-role', c.host ? c.window : 'task']);
    await tmux.typeCommand(c.window, command);
    const ready = await waitForReady(execution, tmux, c.window, { pattern: settings.readyPattern, emptyInput: true, trustPattern: settings.trustPattern, timeoutMs: Math.min(5000, settings.readyTimeout * 1000), trackExit: Boolean(windowId) });
    if (ready.exitCode !== undefined) {
      const fresh = readTaskRecord(config, c.window) ?? record;
      const cause = await storeLaunchExit(ctx, fresh, ready.exitCode, ready.screen, 'okno zakończyło pracę po wznowieniu', true);
      ctx.info(`${c.task}: ${launchExitText(cause)}`);
    } else {
      await setHeaderFields(runner, taskFile(config, c.window), {prompt_delivery: 'pending'});
      if (!ready.ready || await deliverPendingPrompt(ctx, c.window) !== 'sent') ctx.info(`${c.task}: prompt pending until idle`);
    }
    ctx.info(`${c.task}: window ${config.session}:${c.window} running ${c.agent} (model ${c.model}, effort ${c.effort}) via ${command}`);
    results.push({ task: c.task, command });
  }
  return results;
}

export const resumeText = (n: number): string => `${n} ${plural(n, 'zadanie', 'zadania', 'zadań')} do wznowienia (agentctl resume)`;

