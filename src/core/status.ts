import fs from 'node:fs';
import type { Context } from './context.ts';
import { formatModelEffort } from './equivalents.ts';
import { syncMirror } from './mirror.ts';
import type { MirrorResult } from './mirror.ts';
import { taskState } from './state.ts';
import { readStoredEvent } from './event-command.ts';
import { extractQuestion } from './events.ts';
import type { TaskState } from './state.ts';
import { taskProgress } from './progress.ts';
import type { Progress } from './progress.ts';
import { lastContentLine } from './tmux.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import { BOARD_WINDOW } from './windows.ts';
import { WATCH_WINDOW } from './watch.ts';
import { formatDuration, formatLocalTime, shellQuote } from './util.ts';
import type { AgentName } from './config.ts';

export interface StatusRow {
  task: string;
  /** Effective agent, model and effort: what is actually running. */
  agent: string;
  model: string;
  effort: string;
  /** "agent model/effort" as ordered in the spec, and as it runs. They differ after --agent or a limit switch. */
  requested: string;
  effective: string;
  switchedBy: 'flag' | 'limit' | null;
  state: TaskState;
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
  /** ISO time of the last pull that took the current report; null when never pulled or the report changed since. */
  pulled: string | null;
  lastLine: string;
  /** Commits over the base and changed files per worktree ("2c 7f"); null when the task has no readable worktree. */
  progress: Progress | null;
  /** What to do about this row (orphans: the adopt command, limited tasks: the move command); null otherwise. */
  hint: string | null;
  /** The question the agent waits on (state needs-input), from the screen or from its event; null otherwise. */
  question: string | null;
  /** `pin: true` in the spec: the task is never moved to the other provider. */
  pin: boolean;
  /** The task has no tmux window any more (or was moved to the other provider): it is done, whatever it left behind. Shown under "Finished" on the board. */
  finished: boolean;
  /** Hidden from board and status: by `agentctl hide`, or by itself (`auto`: no window and the report was pulled). The task and its worktree are untouched. */
  hidden: boolean;
  /** `closed`: `agentctl close` ran and the window is gone, or the state folder is in the archive. */
  hiddenBy: 'user' | 'auto' | 'closed' | null;
  /** The task was closed (`agentctl close`) and has no window: state `closed`, listed only by `status --all`. */
  closed: boolean;
  /** ISO time of the `close`; null when not closed (or an archived folder that does not say). */
  closedAt: string | null;
  /** The state folder sits in the archive (`agentctl archive`, or moved there by hand). */
  archived: boolean;
}

/** The rows `status` and the board show: without the hidden ones unless `all`. */
export function shownRows<T extends Pick<StatusRow, 'hidden'>>(rows: T[], all: boolean): T[] {
  return all ? rows : rows.filter((r) => !r.hidden);
}

/** For a task whose agent is unknown: guess it from the screen (Codex draws "›" prompts and "OpenAI Codex"). */
export function guessAgent(screen: string): AgentName {
  return /OpenAI Codex|^\s*›/m.test(screen) ? 'codex' : 'claude';
}

export interface CollectOptions {
  /** Ask git for the progress of each worktree (default). The watcher and the close plan have no use for it. */
  progress?: boolean;
  /** Also the tasks whose state folder was moved to the archive (`status --all`, the board). */
  archived?: boolean;
}

export async function collectStatus(ctx: Context, opts: CollectOptions = {}): Promise<StatusRow[]> {
  const { runner, tmux, config } = ctx;
  const infos = await tmux.windows();
  const live = new Set(infos.map((w) => w.plain));
  const rows: StatusRow[] = [];
  const knownWindows = new Set<string>();
  const records = listTaskRecords(config).map((record) => ({ record, archived: false }));
  if (opts.archived) {
    // A folder in the archive counts as closed. A live window or a current state folder of the same name wins over it.
    const current = new Set(records.map((r) => r.record.window));
    for (const record of listArchivedRecords(config)) if (!current.has(record.window) && !live.has(record.window)) records.push({ record, archived: true });
  }
  for (const { record, archived } of records) {
    if (!archived) knownWindows.add(record.window);
    const alive = live.has(record.window);
    const startedMs = Date.parse(record.started);
    let reportMtime: number | undefined;
    try {
      reportMtime = record.report ? fs.statSync(record.report).mtimeMs : undefined;
    } catch {
      reportMtime = undefined;
    }
    // A leftover report from before this run does not count as "ready".
    const reportReady = reportMtime !== undefined && (Number.isNaN(startedMs) || reportMtime >= startedMs);
    let duration = '-';
    if (!Number.isNaN(startedMs)) {
      if (alive) duration = formatDuration(runner.now() - startedMs);
      else if (reportReady && reportMtime !== undefined) duration = formatDuration(reportMtime - startedMs);
    }
    let screenText = '';
    if (alive) {
      const screen = await tmux.capture(record.window, undefined, infos, record.windowId);
      if (screen.code === 0) screenText = screen.stdout;
    }
    const screenAgent = record.agent === 'unknown' ? guessAgent(screenText) : record.agent;
    const settings = config.agents[screenAgent];
    const stored = alive ? readStoredEvent(config, record) : undefined;
    const pulled = record.pulled && reportMtime !== undefined && Date.parse(record.pulled) >= reportMtime ? record.pulled : null;
    const closed = archived || (record.closed === true && !alive);
    const hiddenBy: StatusRow['hiddenBy'] = closed ? 'closed' : record.hidden === true ? 'user' : record.hidden === undefined && config.board.autoHidePulledDead && !alive && pulled !== null ? 'auto' : null;
    const state: TaskState = closed ? 'closed' : record.supersededBy ? 'superseded' : taskState({ alive, screen: screenText, settings, reportReady, event: stored?.outcome });
    rows.push({
      task: record.task,
      agent: record.agent,
      model: record.model,
      effort: record.effort,
      requested: `${record.requested.agent} ${formatModelEffort(record.requested)}`,
      effective: `${record.agent} ${record.model}/${record.effort}`,
      switchedBy: record.switchedBy ?? null,
      state,
      window: alive ? 'alive' : 'gone',
      windowName: record.window,
      windowId: alive ? (tmux.resolve(record.window, infos, record.windowId)?.id || null) : null,
      started: record.started ? record.started.replace('T', ' ').slice(0, 16) : '-',
      startedLocal: formatLocalTime(record.started),
      duration,
      report: reportMtime !== undefined ? 'yes' : 'missing',
      reportPath: record.report,
      pulled,
      lastLine: lastContentLine(screenText, settings.footerPatterns),
      progress: opts.progress === false || record.repos.length === 0 ? null : await taskProgress(runner, record.repos),
      hint: stateHint(record.task, state, record.pin === true, record.supersededBy),
      question: state === 'needs-input' ? (extractQuestion(screenText) ?? (stored?.outcome === 'needs-input' && stored.text !== '' ? stored.text : null)) : null,
      pin: record.pin === true,
      finished: !alive || state === 'superseded',
      hidden: hiddenBy !== null,
      hiddenBy,
      closed,
      closedAt: closed ? (record.closedAt ?? null) : null,
      archived,
    });
  }
  // Windows of the session that agentctl has no state file for: never skipped silently.
  for (const window of [...live].sort()) {
    if (window === WATCH_WINDOW || window === BOARD_WINDOW || knownWindows.has(window)) continue;
    const screen = await tmux.capture(window, undefined, infos);
    const screenText = screen.code === 0 ? screen.stdout : '';
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
      lastLine: lastContentLine(screenText, config.agents[agent].footerPatterns),
      progress: null,
      hint: orphanHint(ctx, window),
      question: null,
      pin: false,
      finished: false,
      hidden: false,
      hiddenBy: null,
      closed: false,
      closedAt: null,
      archived: false,
    });
  }
  return rows;
}

/** `status`: collect the rows and, when `mirror_dir` is configured, copy new reports and status.json there. */
export async function reportStatus(ctx: Context, opts: { archived?: boolean } = {}): Promise<{ rows: StatusRow[]; mirror: MirrorResult | undefined }> {
  const rows = await collectStatus(ctx, { archived: Boolean(opts.archived) });
  return { rows, mirror: await syncMirror(ctx, rows.filter((r) => !r.archived)) };
}

/** Compact Markdown table of all tasks, to paste at the start of a planning chat. */
export function statusMarkdown(rows: StatusRow[]): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|');
  const pulled = (r: StatusRow): string => (r.report === 'missing' ? '-' : r.pulled ? `yes (${formatLocalTime(r.pulled)})` : 'no');
  const lines = [
    '| task | agent/model/effort | state | time | progress | report | pulled? |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${cell(r.task)} | ${cell(`${r.agent}/${r.model}/${r.effort}`)} | ${r.state} | ${r.duration} | ${r.progress?.text ?? '-'} | ${r.report} | ${pulled(r)} |`),
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
