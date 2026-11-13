import { tmuxLoss } from './tmux-loss.ts';
import { provider, matchesProviderCommand, isProviderLauncher } from './providers/registry.ts';
import { atomicWriteFile, stateWriteFailure } from './atomic-file.ts';
import { cachedRequest } from './response-budget.ts';
import { tryFileLock } from './file-lock.ts';
import { promptQueueView } from './prompt-queue.ts';
import { readOutputs, dependencyVerdict, outputsPending, reviewVerdict, reviewVerdictAsOutput } from './outputs.ts';
import type { OutputData, OutputVerdict } from './outputs.ts';
import path from 'node:path';
import { inspectReport } from './report-state.ts';
import { sessionQuestion } from './codex-question.ts';
import { menuOptionLines } from './answer.ts';
import { findCandidates, shortPath } from './report-detect.ts';
import fs from 'node:fs';
import type { Context } from './context.ts';
import { formatModelEffort } from './equivalents.ts';
import { syncMirror } from './mirror.ts';
import type { MirrorResult } from './mirror.ts';
import { classifyScreen, taskState } from './state.ts';
import { deliveryEvidence, deliveryNote } from './prompt-delivery.ts';
import { readStoredEvent } from './event-command.ts';
import { extractQuestion } from './events.ts';
import type { TaskState } from './state.ts';
import { taskProgress } from './progress.ts';
import type { Progress } from './progress.ts';
import { screenMetadata, lastContentLine } from './tmux.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { attachCollisions } from './collisions.ts';
import type { Collide } from './collisions.ts';
import { BOARD_WINDOW, MANAGER_WINDOW } from './windows.ts';
import { WATCH_WINDOW } from './watch.ts';
import { formatDuration, formatLocalTime, shellQuote } from './util.ts';
import type { AgentName } from './config.ts';
import { taskTokenMap } from './usage.ts';
import type { TaskTokens } from './usage.ts';
import type { UsageReader } from './usage-sources.ts';
import { openReader } from './usage.ts';
import { formatTokens } from './usage-parse.ts';

export interface StatusRow {
  task: string;
  outputs?: OutputData['outputs'];
  outputs_valid?: boolean;
  outputs_partial?: boolean;
  outputs_pending?: boolean;
  outputs_errors?: string[];
  verdict?: OutputVerdict;
  decisionsCount?: number;
  actionsCount?: number;
  promptQueue?: ReturnType<typeof promptQueueView>;
  promptDelivery?: string;
  /** How the last message reached the agent: delivered / queued-in-agent / not-delivered-in-field. */
  deliveryResult?: string;

  attempt?: number;
  attemptId?: string;
  summaryDelivered?: string | null;
  /** Effective agent, model and effort: what is actually running. */
  agent: string;
  model: string;
  effort: string;
  /** "agent model/effort" as ordered in the spec, and as it runs. They differ after --agent or a limit switch. */
  requested: string;
  observed?: TaskRecord['observed'];
  observedWarning?: string;
  effective: string;
  switchedBy: 'flag' | 'limit' | null;
  state: TaskState;
  /** A launched tmux window disappeared before completion; recovery is in hint. */
  tmuxLost?: boolean;
  window: 'alive' | 'gone';
  /** The tmux window name of the task without any state icon, and tmux's ID of the window while it exists. */
  windowName: string;
  windowId: string | null;
  /** UTC, `YYYY-MM-DD HH:MM` (unchanged; this is what `status --json` and the mirror carry). */
  started: string;
  /** The same moment in local time, for the table. */
  startedLocal: string;
  /** Running time for live windows; for closed ones, time until the report was last written; "-" if unknown. */
  duration: string;
  /** The report file exists. */
  report: 'yes' | 'missing';
  reportPath: string;
  reportSignature?: string;
  /** Where the agent wrote the report when that was not the `report:` path (the file at `reportPath` is a copy). */
  reportSource?: string;
  reportConfirmed?: string;
  /** ISO time of the last pull that took the current report; null when never pulled or the report changed since. */
  pulled: string | null;
  lastLine: string;
  usage_hint?: string | null;
  draft_input?: string | null;
  reportCandidate?: string;
  /** Commits over the base and changed files per worktree ("2c 7f"); null when the task has no readable worktree. */
  progress: Progress | null;
  /** Active tasks of the same repository that changed some of the same files (needs the progress of both): task and number of shared files. */
  collide: Collide[];
  /** What to do about this row (orphans: the adopt command, limited tasks: the move command); null otherwise. */
  hint: string | null;
  /** The question the agent waits on (state needs-input), from the screen or from its event; null otherwise. */
  question: string | null;
  /** The numbered options of the menu a needs-input/needs-trust frame shows ("1. Approve once", …); absent otherwise. */
  menuOptions?: string[];
  /** `pin: true` in the spec: the task is never moved to the other provider. */
  pin: boolean;
  /** The task has no tmux window any more (or was moved to the other provider): it is done, whatever it left behind. Shown under "Finished" on the board. */
  finished: boolean;
  /** Hidden from board and status: by `agentctl hide`, or by itself (`auto`: no window and the report was pulled). The task and its worktree are untouched. */
  hidden: boolean;
  /** `closed`: `agentctl close` ran and the window is gone, or the state folder is in the archive. */
  hiddenBy: 'user' | 'auto' | 'closed' | 'cancelled' | null;
  /** The task was closed (`agentctl close`) and has no window: state `closed`, listed only by `status --all`. */
  closed: boolean;
  /** ISO time of the `close`; null when not closed (or an archived folder that does not say). */
  closedAt: string | null;
  /** The state folder sits in the archive (`agentctl archive`, or moved there by hand). */
  archived: boolean;
  /** `agentctl cancel` ran and the window is gone: state `cancelled`, listed only by `status --all`. Its report, if one was written, stays. */
  cancelled: boolean;
  /** ISO time of the `cancel` and the reason that was given; null when not cancelled (or none given). */
  cancelledAt: string | null;
  cancelReason: string | null;
  /** The cohort of the task (as first written); null when it has none. */
  cohort: string | null;
  /** The task that took over after `agentctl move` (this one is then `superseded`), and the task this one continues. */
  supersededBy: string | null;
  continues: string | null;
  /** The task whose work this one reviews (its decisions and actions are the reviewer's, not the author's). */
  reviewOf?: string | null;
  /** Tokens of the sessions of the task (input + output + cache writes), when asked for (`CollectOptions.tokens`) and a session log was found; null otherwise (n/d). */
  tokens?: TaskTokens | null;
}

/** The rows `status` and the board show: without the hidden ones unless `all`. */
export function shownRows<T extends Pick<StatusRow, 'hidden'>>(rows: T[], all: boolean): T[] {
  return all ? rows : rows.filter((r) => !r.hidden);
}

/** For a task whose agent is unknown: guess it from the screen (Codex draws "›" prompts and "OpenAI Codex"). */
export function guessAgent(screen: string): AgentName {
  if (/Welcome to Kimi Code!|Kimi Code updated|^\s*│\s*>/m.test(screen)) return 'kimi';
  return /OpenAI Codex|^\s*›/m.test(screen) ? 'codex' : 'claude';
}

export interface CollectOptions {
  /** Ask git for the progress of each worktree (default). The watcher and the close plan have no use for it. */
  progress?: boolean;
  /** Read paths use persisted facts and never discover files or ask git to scan a worktree. */
  cachedOnly?: boolean;
  /** Also the tasks whose state folder was moved to the archive (`status --all`, the board). */
  archived?: boolean;
  /** Add the tokens of each task (reads the session logs of the agents, incrementally). */
  tokens?: boolean;
  /** Records the caller already scanned (snapshotRecords): collectStatus does not scan the stores again. */
  records?: { current: TaskRecord[]; archived: TaskRecord[] };
  /** The usage reader for the tokens (default: a fresh one for this call). */
  reader?: UsageReader;
  /**
   * Cheap rows for closed/cancelled/archived tasks: skip the prompt queue, the outputs of a ready report and the token
   * collection for them (the board shows only their count unless the section is expanded). Their state and report stay exact.
   */
  shallowClosed?: boolean;
  /** false: no rows for windows without a state file. A caller that passes a subset of `records` wants those records only: every other task's window would look like an orphan and be captured (P93b). */
  orphans?: boolean;
}

const idleObservations = new Map<string, { working: boolean; idle: number; attempt: string; observedWork: boolean; workStopAt?: string }>();

/** The per-record loop yields to the event loop every this many records, so board ticks and key presses interleave. */
export const STATUS_CHUNK = 25;

export async function collectStatus(ctx: Context, opts: CollectOptions = {}): Promise<StatusRow[]> {
  // Nested planners inherit the MCP request contract too, without relying on facade-local wrappers.
  if (cachedRequest()) opts = { ...opts, cachedOnly: true };
  const { runner, tmux, config } = ctx;
  const infos = await tmux.windows();
  const live = new Set(infos.map((w) => w.plain));
  const rows: StatusRow[] = [];
  const knownWindows = new Set<string>();
  // The records are copied: the loop annotates them (reportCandidate), and the caller's scan cache must stay pristine.
  const scanned = opts.records ?? { current: listTaskRecords(config), archived: opts.archived ? listArchivedRecords(config) : [] };
  const records = scanned.current.map((record) => ({ record: { ...record }, archived: false }));
  if (opts.archived) {
    // A folder in the archive counts as closed. A live window or a current state folder of the same name wins over it.
    const current = new Set(records.map((r) => r.record.window));
    for (const record of scanned.archived) if (!current.has(record.window) && !live.has(record.window)) records.push({ record: { ...record }, archived: true });
  }
  const tokenRecords: TaskRecord[] = [];
  let sinceYield = 0;
  for (const { record, archived } of records) {
    // The synchronous sections of this loop are long with hundreds of archived tasks; yield so keys interleave.
    if (++sinceYield >= STATUS_CHUNK) {
      sinceYield = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (!archived) knownWindows.add(record.window);
    const alive = live.has(record.window);
    // Closed, cancelled or archived and not live: the board only counts them (unless a section is expanded), so the
    // prompt queue, the outputs and the tokens are not collected for them. Everything that decides the state stays.
    const shallow = opts.shallowClosed === true && !alive && (archived || record.closed === true || record.cancelled === true);
    if (opts.tokens && !shallow) tokenRecords.push(record);
    const startedMs = Date.parse(record.started);
    let reportMtime: number | undefined;
    try {
      reportMtime = record.report ? fs.statSync(record.report).mtimeMs : undefined;
    } catch {
      reportMtime = undefined;
    }
    // A leftover report from before this run does not count as "ready".
    let reportReady = false;
    let duration = '-';
    if (!Number.isNaN(startedMs)) {
      if (alive) duration = formatDuration(runner.now() - startedMs);
      else if (reportReady && reportMtime !== undefined) duration = formatDuration(reportMtime - startedMs);
    }
    let screenText = '';
    let screenRead = !alive;
    if (alive) {
      const screen = await tmux.capture(record.window, undefined, infos, record.windowId);
      if (screen.code === 0) { screenText = screen.stdout; screenRead = true; }
    }
    const screenAgent = record.agent === 'unknown' ? guessAgent(screenText) : record.agent;
    const settings = config.agents[screenAgent] ?? provider(screenAgent).defaultSettings();
    if (!opts.cachedOnly && !cachedRequest()) await provider(screenAgent).events.poll?.(ctx, record);
    const stored = readStoredEvent(config, record);
    const reportState = inspectReport(config, { ...record, ...(stored?.outcome === 'turn-complete' ? { turnEndedAt: stored.at } : {}) }, runner.now(), !record.attemptId && (!alive || (config.reportSettleS === 0 && classifyScreen(screenText, settings) === 'idle')));
    reportReady = reportState.ready;
    // The candidate lives on the row, not on the record copy: one bounded discovery walk per task per collect (R3).
    let reportCandidate = record.reportCandidate;
    let candidatesCache: ReturnType<typeof findCandidates> | undefined;
    const candidates = () => (candidatesCache ??= findCandidates(ctx, record));
    if (!opts.cachedOnly && reportCandidate && reportCandidate !== record.report && !candidates().some(c => c.file === reportCandidate)) reportCandidate = undefined;
    if (reportState.exists && !reportReady && !reportCandidate) reportCandidate = record.report;
    if (reportReady && !alive && reportState.mtime !== undefined && !Number.isNaN(startedMs)) duration = formatDuration(reportState.mtime - startedMs);
    // mtimeMs has a fraction, the stored time only whole milliseconds: a pull in the same millisecond as the report still counts.
    const pulled = record.pulled && reportMtime !== undefined && Date.parse(record.pulled) >= Math.floor(reportMtime) ? record.pulled : null;
    // Cancelled wins over closed: the task was abandoned, not finished.
    const cancelled = record.cancelled === true && !alive;
    const closed = !cancelled && (archived || (record.closed === true && !alive));
    let hiddenBy: StatusRow['hiddenBy'] = cancelled ? 'cancelled' : closed ? 'closed' : record.hidden === true ? 'user' : record.hidden === undefined && config.board.autoHidePulledDead && !alive && pulled !== null ? 'auto' : null;
    const deliveryReport = reportReady && (record.promptDelivery === 'needs-attention' || (record.deliveryId && reportState.signature !== record.deliveryReportBaseline)) && (!alive || classifyScreen(screenText, settings) === 'idle');
    const writeFailure = stateWriteFailure(path.join(config.stateDir, record.window, 'TASK.md'));
    const unconfirmed = record.promptDelivery === 'needs-attention' && !reportReady && !deliveryEvidence(ctx, record, screenText);
    // A startup dialog `new` stopped at (prompt_delivery: needs-input) is a question to the human, not a delivery failure.
    const startupDialog = record.promptDelivery === 'needs-input' && !reportReady;
    const lossHint = await tmuxLoss(ctx, record, alive, reportReady || cancelled || closed || archived || !!record.supersededBy, infos.length > 0, opts.cachedOnly);
    if (lossHint && hiddenBy === 'auto') hiddenBy = null;
    let state: TaskState = cancelled ? 'cancelled' : closed ? 'closed' : record.supersededBy ? 'superseded' : lossHint ? 'needs-attention' : writeFailure ? 'needs-attention' : deliveryReport ? 'report-ready' : startupDialog ? 'needs-input' : unconfirmed ? 'needs-attention' : taskState({ alive, screen: screenText, settings, reportReady, event: stored?.outcome });
    // Passive wire failures fill an idle screen; legacy hook recovery keeps its existing precedence.
    if (state === 'waiting' && stored?.outcome === 'overloaded' && record.agent !== 'unknown' && provider(record.agent).events.payloadFrom === 'wire') state = 'overloaded';
    const observationKey = `${config.stateDir}:${record.window}`;
    if (idleObservations.size > 2000) idleObservations.delete(idleObservations.keys().next().value!);
    const identity = `${record.attemptId ?? record.started}:${record.deliveryStartedAt ?? ''}:${record.windowId ?? ''}`;
    const observationFile = path.join(config.stateDir, record.window, 'idle-observation.json');
    let release: (() => void) | undefined;
    try { if (!opts.cachedOnly && !runner.dryRun && alive && !archived) release = tryFileLock(`${observationFile}.lock`); } catch { /* read-only state: retain process-local observations */ }
    let prev = idleObservations.get(observationKey);
    try { const stored = JSON.parse(fs.readFileSync(observationFile, 'utf8')); if (typeof stored.attempt === 'string' && typeof stored.idle === 'number' && typeof stored.working === 'boolean' && typeof stored.observedWork === 'boolean') prev = stored; } catch { /* first observation */ }
    const observation = prev?.attempt === identity ? prev : { working: true, idle: 0, attempt: identity, observedWork: false };
    if (!screenRead && state === 'waiting') state = 'working';
    if (state === 'working' || state === 'background') { observation.working = true; observation.idle = 0; observation.observedWork = true; observation.workStopAt = stored?.at ?? record.turnEndedAt; }
    else if (state === 'waiting' && observation.working) {
      observation.idle++;
      const stopAt = stored?.outcome === 'turn-complete' ? stored.at : !observation.observedWork ? record.turnEndedAt : undefined;
      const stop = !!stopAt && stopAt !== observation.workStopAt && Date.parse(stopAt) >= Date.parse(record.deliveryStartedAt ?? record.attemptStarted ?? record.started);
      if (!stop && observation.idle < config.watch.idleConfirmTicks) state = 'working';
      else observation.working = false;
    } else { observation.working = false; observation.idle = 0; }
    if (!opts.cachedOnly && !reportState.exists && (state === 'waiting' || !alive)) reportCandidate = candidates()[0]?.file;
    idleObservations.set(observationKey, observation);
    if (release) { try { atomicWriteFile(observationFile, JSON.stringify(observation)); } catch { /* observation persistence is best effort */ } finally { release(); } }
    // Still being written (no report-end yet, or not settled): readOutputs says `outputs_pending` and judges nothing.
    const outputData = !shallow && reportReady ? await readOutputs(ctx, record) : undefined;
    let verdict: OutputVerdict | undefined;
    if (!shallow && reportReady) {
      try {
        const reportText = fs.readFileSync(record.report, 'utf8');
        verdict = dependencyVerdict(reportText, record.reviewOf != null);
        // P70: a review's verdict is the FIRST line of its report ("Werdykt: NO-GO — …"), never only the outputs block.
        if (record.reviewOf) { const rv = reviewVerdict(reportText); if (rv) verdict = reviewVerdictAsOutput(rv.first); }
      } catch { /* absent */ }
    }
    let progress: Progress | null = null;
    if (record.repos.length && opts.progress !== false) {
      const file = path.join(config.stateDir, record.window, 'progress.json');
      if (opts.cachedOnly) { try { progress = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* watch has not sampled yet */ } }
      else {
        progress = await taskProgress(runner, record.repos);
        if (!runner.dryRun && !archived) await runner.writeFile(file, JSON.stringify(progress)).catch(() => undefined);
      }
    }
    rows.push({
      ...(outputData ? { ...outputData, verdict, decisionsCount: outputData.outputs?.decisions.length ?? 0, actionsCount: outputData.outputs?.actions.length ?? 0 } : {}),
      task: record.task,
      promptQueue: shallow ? [] : promptQueueView(ctx, record.window, record),
      promptDelivery: record.promptDelivery,
      ...(record.deliveryResult ? { deliveryResult: record.deliveryResult } : {}),
      attempt: record.attempt,
      attemptId: record.attemptId,
      summaryDelivered: record.summaryDelivered ?? null,
      agent: record.agent,
      model: record.model,
      effort: record.effort,
      requested: `${record.requested.agent} ${formatModelEffort(record.requested)}`,
      ...(record.observed ? { observed: record.observed } : {}),
      ...(record.observedWarning ? { observedWarning: record.observedWarning } : {}),
      effective: `${record.agent} ${record.model}/${record.effort}`,
      switchedBy: record.switchedBy ?? null,
      state,
      ...(lossHint ? { tmuxLost: true } : {}),
      ...(reportCandidate && !reportReady ? { reportCandidate } : {}),
      ...screenMetadata(screenText),
      window: alive ? 'alive' : 'gone',
      windowName: record.window,
      windowId: alive ? (tmux.resolve(record.window, infos, record.windowId)?.id || null) : null,
      started: record.started ? record.started.replace('T', ' ').slice(0, 16) : '-',
      startedLocal: formatLocalTime(record.started),
      duration,
      report: reportReady ? 'yes' : 'missing',
      reportPath: record.report,
      reportSignature: reportState.signature,
      ...(record.reportSource ? { reportSource: record.reportSource } : {}),
      ...(record.reportConfirmed ? { reportConfirmed: record.reportConfirmed } : {}),
      pulled,
      lastLine: lastContentLine(screenText, settings.footerPatterns),
      progress,
      collide: [],
      hint: [lossHint, reportCandidate && reportCandidate !== record.report && !reportState.exists ? `Raport poza ścieżką kanoniczną; użyj report_from ze ścieżką ${reportCandidate}` : null, writeFailure ? `State write failed: ${writeFailure.reason}; old TASK.md preserved` : startupDialog ? record.promptError : unconfirmed ? record.promptError : record.promptDelivery === 'confirming' || record.promptDelivery === 'sending' ? (deliveryNote(record) ?? 'dostarczenie niepotwierdzone – sprawdzam; watch confirms within delivery_confirm_s') : record.promptDelivery === 'pending' ? 'original prompt pending; watch sends it once after folder trust and empty ready input' : stateHint(record.task, state, record.pin === true, record.supersededBy), !record.reportConfirmed && record.reportSource && path.normalize(record.reportSource) !== path.normalize(record.report) ? `raport pochodzi z kopii ${record.reportSource} – sprawdź` : null].filter(Boolean).join('; ') || null,
      // Codex: the session log names a pending request_user_input question exactly (the text of the expanded view),
      // for a collapsed one and for a waiting one alike; the screen reader covers every other dialog.
      question: state === 'needs-input' ? ((record.agent === 'codex' ? sessionQuestion(config, record) : undefined) ?? extractQuestion(screenText) ?? (stored?.outcome === 'needs-input' && stored.text !== '' ? stored.text : null)) : null,
      ...((state === 'needs-input' || state === 'needs-trust') && alive ? { menuOptions: menuOptionLines(screenText) } : {}),
      pin: record.pin === true,
      finished: (!alive && !lossHint) || state === 'superseded',
      hidden: hiddenBy !== null,
      hiddenBy,
      closed,
      closedAt: closed ? (record.closedAt ?? null) : null,
      archived,
      cancelled,
      cancelledAt: cancelled ? (record.cancelledAt ?? null) : null,
      cancelReason: cancelled ? (record.cancelReason ?? null) : null,
      cohort: record.cohort ?? null,
      supersededBy: record.supersededBy ?? null,
      continues: record.continues ?? null,
      reviewOf: record.reviewOf ?? null,
    });
  }
  // Windows of the session that agentctl has no state file for: never skipped silently.
  for (const window of opts.orphans === false ? [] : [...live].sort()) {
    if (window === WATCH_WINDOW || window === BOARD_WINDOW || window === MANAGER_WINDOW || knownWindows.has(window)) continue;
    const screen = await tmux.capture(window, undefined, infos);
    const screenText = screen.code === 0 ? screen.stdout : '';
    const info = tmux.resolve(window, infos);
    const command = await ctx.runner.exec('tmux', ['display-message', '-p', '-t', info?.id || tmux.target(window), '#{pane_current_command}'], { readOnly: true });
    let providerCommand = matchesProviderCommand(command.stdout.trim(), 'pane');
    if (info?.role !== 'task' && !providerCommand && isProviderLauncher(command.stdout.trim())) {
      // tmux names a Node launcher rather than the provider: inspect only this pane's process.
      const pid = await ctx.runner.exec('tmux', ['display-message', '-p', '-t', info?.id || tmux.target(window), '#{pane_pid}'], { readOnly: true });
      if (/^\d+$/.test(pid.stdout.trim())) {
        const process = await ctx.runner.exec('ps', ['-p', pid.stdout.trim(), '-o', 'args='], { readOnly: true });
        providerCommand = process.code === 0 && matchesProviderCommand(process.stdout.trim(), 'args');
      }
    }
    if (info?.role !== 'task' && !providerCommand) continue;
    const agent = guessAgent(screenText);
    const task = window.toUpperCase();
    rows.push({
      task,
      agent: 'unknown',
      model: 'unknown',
      effort: 'unknown',
      requested: '-',
      effective: 'unknown',
      switchedBy: null,
      state: 'orphan',
      window: 'alive',
      windowName: window,
      windowId: tmux.resolve(window, infos)?.id || null,
      started: '-',
      startedLocal: '-',
      duration: '-',
      report: 'missing',
      reportPath: '',
      pulled: null,
      lastLine: lastContentLine(screenText, (config.agents[agent] ?? provider(agent).defaultSettings()).footerPatterns),
      progress: null,
      collide: [],
      hint: orphanHint(ctx, window),
      question: null,
      pin: false,
      finished: false,
      hidden: false,
      hiddenBy: null,
      closed: false,
      closedAt: null,
      archived: false,
      cancelled: false,
      cancelledAt: null,
      cancelReason: null,
      cohort: null,
      supersededBy: null,
      continues: null,
    });
  }
  if (opts.tokens) {
    const tokens = taskTokenMap(config, runner.now(), tokenRecords, opts.reader ?? openReader(config));
    for (const row of rows) row.tokens = tokens.get(row.task) ?? null;
  }
  attachCollisions(rows, config.collisions.ignore, config.collisions.enabled);
  return rows;
}

/** `status`: collect the rows and, when `mirror_dir` is configured, copy new reports and status.json there. */
export async function reportStatus(ctx: Context, opts: { archived?: boolean } = {}): Promise<{ rows: StatusRow[]; mirror: MirrorResult | undefined }> {
  const rows = await collectStatus(ctx, { archived: Boolean(opts.archived), tokens: true, cachedOnly: true, shallowClosed: true });
  return { rows, mirror: await syncMirror(ctx, rows.filter((r) => !r.archived)) };
}

/** Compact Markdown table of all tasks, to paste at the start of a planning chat. */
export function statusMarkdown(rows: StatusRow[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const pulled = (r: StatusRow): string => (r.report === 'missing' ? '-' : r.pulled ? `yes (${formatLocalTime(r.pulled)})` : 'no');
  const cohort = rows.some((r) => r.cohort !== null);
  const tokens = rows.some((r) => Boolean(r.tokens));
  const lines = [
    `| task | ${cohort ? 'cohort | ' : ''}agent/model/effort | state | time | ${tokens ? 'tokens | ' : ''}progress | report | pulled? |`,
    `|---|${cohort ? '---|' : ''}---|---|---|${tokens ? '---|' : ''}---|---|---|`,
    ...rows.map((r) => `| ${cell(r.task)} | ${cohort ? `${cell(r.cohort ?? '-')} | ` : ''}${cell(`${r.agent}/${r.model}/${r.effort}`)} | ${r.state} | ${r.duration} | ${tokens ? `${r.tokens ? formatTokens(r.tokens.fresh) : 'n/d'} | ` : ''}${r.progress?.text ?? '-'} | ${r.report}${r.reportSource ? ` (z ${cell(shortPath(r.reportSource))})` : ''} | ${pulled(r)} |`),
  ];
  return `${lines.join('\n')}\n`;
}

/** What to do about a task in this state, if anything. */
export function stateHint(task: string, state: TaskState, pinned: boolean, supersededBy?: string): string | null {
  if (state === 'limited') return pinned ? `${task} hit its usage limit and is pinned (pin: true): wait for the reset` : `usage limit reached: agentctl move ${task}`;
  if (state === 'superseded') return `moved to ${supersededBy ?? 'another task'}; close this window when you are done: agentctl close ${task}`;
  return null;
}

/** Command that restores the state file of an orphan window. */
export function orphanHint(ctx: Context, window: string): string {
  const task = window.toUpperCase();
  const report = `${ctx.config.cache}/${window}/${task}.md`;
  return `no state file in ${ctx.config.stateDir}/${window}: agentctl adopt ${task} --report ${shellQuote(report)}`;
}
