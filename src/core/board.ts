import { provider as providerAdapter, PROVIDERS } from './providers/registry.ts';
import { get as providerValue } from './providers/registry.ts';
import type { ProviderValues } from './providers/registry.ts';
import { markTasks } from './mark.ts';
import { collectDisk, DISK_INTERVAL_MS } from './disk.ts';
import type { DiskReport } from './disk.ts';
import { collectCapacity, renderCapacity } from './capacity.ts';
import { shortPath } from './report-detect.ts';
import { modelLabel, providerLabel } from './model-label.ts';
import path from 'node:path';
import fs from 'node:fs';
import { attachCollisions, collideText } from './collisions.ts';
import { cancelTasks, planCancel } from './cancel.ts';
import { countsLine, lastActivity, listCohorts } from './cohort.ts';
import { closeTask } from './close.ts';
import { Context } from './context.ts';
import type { GlobalConfig } from './config.ts';
import { DEFAULT_WINDOW_ICONS } from './icons.ts';
import type { SelfArgv } from './events.ts';
import { interruptTask } from './interrupt.ts';
import { moveTask } from './move.ts';
import { liveWindows } from './plan.ts';
import { collectLimits, renderLimits } from './limits.ts';
import { planGc, renderGc } from './gc.ts';
import { findResumable, planResume, resumeTasks } from './resume.ts';
import { describeQueue, moveToFront, readQueue, removeFromQueue, setPaused, isPaused } from './queue.ts';
import type { QueueView } from './queue.ts';
import { peekWindow } from './peek.ts';
import { pullReady, pullTask } from './pull.ts';
import { showWindow } from './attach.ts';
import { setHidden } from './hide.ts';
import { taskProgress } from './progress.ts';
import type { Runner } from './runner.ts';
import { sendPrompts } from './send.ts';
import type { TaskState } from './state.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { snapshotRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { logLines, markTask } from './history.ts';
import type { Result } from './history.ts';
import { readPlans, sharedReader } from './usage.ts';
import type { PlanState } from './usage.ts';
import { formatTokens } from './usage-parse.ts';
import { formatReset } from './usage.ts';
import { awayView, setAway } from './away.ts';
import type { AwayView } from './away.ts';
import { MANAGER_STATE_TEXT, managerView } from './manager.ts';
import type { ManagerView } from './manager.ts';
import { MANAGER_WINDOW } from './windows.ts';
import { AGENT_NAMES } from './config.ts';
import type { AgentName, UsageSettings } from './config.ts';
import { cohortKey, errorMessage } from './util.ts';

/*
 * The model of `agentctl board`: what is on the screen as plain data, and what a key press does to it. The Ink front
 * (src/board/app.ts) only draws this and forwards keys, so everything here runs without a terminal.
 */

export const BOARD_REFRESH_MS = 2000;
/** The refresh slows to this when nothing is alive or unfinished any more. */
export const BOARD_IDLE_REFRESH_MS = 5000;
/** Ticks fired by the fs.watch of the state dir are at least this far apart (agent events write event.json on every hook). */
export const WATCH_TICK_MIN_MS = 500;

/** The refresh cadence for the rows on the board: fast while anything runs, slow when every task is done. */
export function boardRefreshMs(rows: readonly Pick<BoardRow, 'closed' | 'cancelled' | 'finished'>[]): number {
  return rows.some((r) => !r.closed && !r.cancelled && !r.finished) ? BOARD_REFRESH_MS : BOARD_IDLE_REFRESH_MS;
}

/** Trailing debounce for the fs.watch events: the first event fires right away, bursts coalesce to one tick per window. */
export class TickGate {
  private readonly minMs: number;
  private readonly fire: () => void;
  private last = 0;
  private pending: NodeJS.Timeout | undefined;

  constructor(minMs: number, fire: () => void) {
    this.minMs = minMs;
    this.fire = fire;
  }

  ping(now: number): void {
    const wait = this.minMs - (now - this.last);
    if (wait <= 0) {
      this.stop(); // A due but delayed trailing callback is superseded by this immediate fire.
      this.last = now;
      this.fire();
      return;
    }
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.last = Date.now();
      this.fire();
    }, wait);
    this.pending.unref?.();
  }

  stop(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
  }
}
/** Lines of the selected window shown in the preview. */
export const PREVIEW_LINES = 30;
/** git is asked for the progress of a task at most this often. */
export const PROGRESS_TTL_MS = 10_000;
/** Below this width the preview is hidden and the list gets the whole line. */
export const PREVIEW_MIN_WIDTH = 110;
/** Width of the task list: fits an 80-column terminal. */
export const LIST_WIDTH = 71;

/** A status row plus what only the board needs. */
export interface BoardRow extends StatusRow {
  /** Worktrees `close --rm-worktree` would remove (the main checkout is not one of them). */
  worktrees: string[];
}

export interface Preview {
  model?: string;
  task: string;
  lines: string[];
  /** Said next to the title of the preview, e.g. the collisions of the task. */
  note?: string;
}

export interface Notice {
  level: 'info' | 'error';
  text: string;
}

export type BoardMode =
  | { kind: 'list' }
  | { kind: 'input'; task: string; text: string }
  /** Enter on a finished task (no window): it cannot be switched to, so the choices are the ones that still make sense. */
  | { kind: 'finished'; task: string }
  | { kind: 'confirm'; action: 'interrupt' | 'close' | 'close-worktree' | 'move' | 'queue-rm' | 'cancel' | 'resume' | 'away' | 'mark-cohort'; task: string; reason?: string; tasks?: string[]; result?: Result }
  /** `X`: the reason for the cancellation (optional: Enter on an empty line goes on without one). */
  | { kind: 'cancel-reason'; task: string; text: string }
  /** `k`: pick the cohort to show; `value` null is every task, '' the tasks without a cohort. */
  | { kind: 'cohort-pick'; options: CohortOption[]; index: number; expanded?: boolean }
  | { kind: 'help' }
  /** `l`: the history of the tasks (`agentctl log`), scrolled with the arrows. */
  | { kind: 'log'; lines: string[]; offset: number }
  /** `L` (limits), `G` (gc preview): a page of lines from the core, scrolled with the arrows. */
  | { kind: 'view'; what: ViewKind; lines: string[]; offset: number };

export type ViewKind = 'limits' | 'gc' | 'capacity';

export const VIEW_TITLES: Record<ViewKind, string> = { capacity: 'Capacity', limits: 'Limits', gc: 'Clean-up preview (agentctl gc)' };

export interface CohortOption {
  label: string;
  value: string | null;
}

export interface BoardState {
  rows: BoardRow[];
  /** The selected task; kept across refreshes while the task exists. */
  selected: string | null;
  mode: BoardMode;
  notice: Notice | null;
  preview: Preview | null;
  width: number;
  height: number;
  /** Local time of the last refresh ("HH:MM:SS"); null before the first one. */
  refreshedAt: string | null;
  /** An action is running (label for the footer). */
  busy: string | null;
  loadError: string | null;
  quit: boolean;
  /** The "Finished" section is open (key z). Closed: only its title and count show under the active tasks. */
  showFinished: boolean;
  /** Hidden tasks are listed too, dimmed (key a). */
  showHidden: boolean;
  /** The queue (`agentctl queue`): waiting, starting and failed entries, in turn order; its own section under the active tasks. */
  queue: QueueView[];
  /** The queue is paused (`p`) or switched off in the config: nothing starts. */
  queuePaused: boolean;
  /** `k`: only this cohort is listed (its key); '' is "bez kohorty"; null every task. */
  cohortFilter: string | null;
  /** `g`: the groups (cohort keys, '' for "bez kohorty") whose tasks are folded away under their header. */
  folded: string[];
  /** The plans of Claude and Codex for the panel on top; null before the first refresh. */
  disk: DiskReport | null;
  plans: ProviderValues<PlanState> | null;
  /** Tasks that can be resumed (active, a worktree, no window): the section "Do wznowienia", key R. */
  resumable: string[];
  /** Away mode (the phone gets the notifications); null before the first refresh. */
  away: AwayView | null;
  /** The manager session (`agentctl manager`): its window and what its screen says; null before the first refresh. */
  manager: ManagerView | null;
  /** Keys of the cohorts hidden by `cohort archive`: not in the `k` choice. */
  archivedCohorts: string[];
  /** `board.cohorts_recent`: how many of the most recently active cohorts the `k` choice lists before "starsze…". */
  cohortsRecent: number;
}

/** The cursor stands on the line of the manager (it is no task: Enter goes to its window). */
export const MANAGER_SELECT = '@manager';

export function initialBoardState(width: number, height: number): BoardState {
  return { rows: [], selected: null, mode: { kind: 'list' }, notice: null, preview: null, width, height, refreshedAt: null, busy: null, loadError: null, quit: false, showFinished: false, showHidden: false, queue: [], queuePaused: false, cohortFilter: null, folded: [], disk: null, plans: null, resumable: [], away: null, manager: null, archivedCohorts: [], cohortsRecent: 10 };
}

/** What the front has to do after a key press. */
export type BoardEffect =
  | { type: 'switch'; task: string; window: string }
  | { type: 'send'; task: string; window: string; text: string }
  | { type: 'interrupt'; task: string }
  | { type: 'pull'; task: string }
  | { type: 'pull-ready' }
  | { type: 'close'; task: string; rmWorktree: boolean }
  | { type: 'hide'; task: string; hidden: boolean }
  | { type: 'move'; task: string }
  | { type: 'queue-up'; task: string }
  | { type: 'queue-rm'; task: string }
  | { type: 'cancel'; task: string; reason?: string }
  | { type: 'queue-pause'; paused: boolean }
  /** `R`: resume every task listed under "Do wznowienia" (agentctl resume). */
  | { type: 'resume' }
  /** `w`: away on or off (agentctl away). */
  | { type: 'away'; on: boolean }
  /** `o`, `p`, `f`: the result of a finished task, for the history (`agentctl mark`). */
  | { type: 'mark'; task: string; result: Result }
  | { type: 'mark-cohort'; cohort: string; tasks: string[]; result: Result }
  /** `l`: load the history into the log view. */
  | { type: 'log' }
  /** `L`, `G`: load the lines of a view. */
  | { type: 'view'; what: ViewKind }
  /** The selection moved: load the preview of the new one now instead of at the next refresh. */
  | { type: 'refresh' }
  | { type: 'quit' };

/** The part of Ink's key object the board looks at. */
export interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  return?: boolean;
  escape?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
}

export interface KeyResult {
  state: BoardState;
  effects: BoardEffect[];
}

/** The cohort key of a row or a queue entry: '' for "bez kohorty". */
const groupOf = (cohort: string | null | undefined): string => (cohort ? cohortKey(cohort) : '');

/** `k` filter: the row passes when no cohort is picked, or it is in the picked one ('' picks the tasks without a cohort). */
const passes = (state: BoardState, cohort: string | null | undefined): boolean => state.cohortFilter === null || groupOf(cohort) === state.cohortFilter;

/** Some task has a cohort: the list is grouped under cohort headers. Without any cohort the list is the flat one it always was. */
export function isGrouped(state: BoardState): boolean {
  return state.rows.some((r) => r.cohort !== null) || state.queue.some((v) => v.entry.cohort !== undefined);
}

/** The groups in the order they are listed: cohorts by name, "bez kohorty" ('') last. */
function groupOrder(state: BoardState): { key: string; name: string | null }[] {
  const names = new Map<string, string>();
  for (const name of [...state.rows.map((r) => r.cohort), ...state.queue.map((v) => v.entry.cohort)]) if (name) names.set(cohortKey(name), names.get(cohortKey(name)) ?? name);
  const cohorts = [...names].sort((a, b) => a[0].localeCompare(b[0])).map(([key, name]) => ({ key, name: name as string | null }));
  return [...cohorts, { key: '', name: null }];
}

/** The rows of the active section, in list order (grouped by cohort when there are cohorts), including the ones of folded groups. */
function activeAll(state: BoardState): BoardRow[] {
  const rows = state.rows.filter((r) => !r.closed && !r.cancelled && !r.finished && (state.showHidden || !r.hidden) && passes(state, r.cohort));
  if (!isGrouped(state)) return rows;
  return groupOrder(state).flatMap((g) => rows.filter((r) => groupOf(r.cohort) === g.key));
}

/** Tasks that still have a window, in the order of the status table (cohort by cohort when there are cohorts); hidden ones only with the `a` key. */
export function activeRows(state: BoardState): BoardRow[] {
  return activeAll(state);
}

/** The active rows the cursor can reach: the ones in a folded group are not among them. */
export function reachableRows(state: BoardState): BoardRow[] {
  return activeAll(state).filter((r) => !state.folded.includes(groupOf(r.cohort)));
}

/** The queue as the board lists it: the cohort filter applies. */
export function queueViews(state: BoardState): QueueView[] {
  return state.queue.filter((v) => passes(state, v.entry.cohort));
}

/** Tasks without a window (or moved to the other provider) that were not closed: the "Finished" section. */
export function finishedRows(state: BoardState): BoardRow[] {
  return state.rows.filter((r) => !r.closed && !r.cancelled && r.finished && (state.showHidden || !r.hidden) && passes(state, r.cohort));
}

/** Tasks closed with `agentctl close` (or archived): their own section, only while the `a` key lists hidden tasks. */
export function closedRows(state: BoardState): BoardRow[] {
  return state.showHidden ? state.rows.filter((r) => r.closed && passes(state, r.cohort)) : [];
}

/** Tasks cancelled with `agentctl cancel`: their own section, like the closed ones only while `a` lists hidden tasks. */
export function cancelledRows(state: BoardState): BoardRow[] {
  return state.showHidden ? state.rows.filter((r) => r.cancelled && passes(state, r.cohort)) : [];
}

/** The rows the cursor can stand on: the active ones, the finished ones while that section is open, then the closed and the cancelled ones. */
export function displayRows(state: BoardState): BoardRow[] {
  return [...reachableRows(state), ...(state.showFinished ? finishedRows(state) : []), ...closedRows(state), ...cancelledRows(state)];
}

/** Every task the cursor can stand on, top to bottom: the active rows, the queue, the finished rows (while open), the closed ones. */
export function navTasks(state: BoardState): string[] {
  const active = reachableRows(state).map((r) => r.task);
  const rest = displayRows(state).slice(active.length).map((r) => r.task);
  return [...(managerListed(state) ? [MANAGER_SELECT] : []), ...active, ...queueViews(state).map((v) => v.entry.task), ...rest];
}

/** The manager line is on the board and can be selected: its window exists. */
export const managerListed = (state: BoardState): boolean => state.manager !== null && state.manager.state !== 'missing';

/** The first thing a refresh selects: a task, never the manager line (unless it is all there is). */
const firstSelectable = (tasks: string[]): string | null => tasks.find((t) => t !== MANAGER_SELECT) ?? tasks[0] ?? null;

export function selectedIndex(state: BoardState): number {
  return state.selected === null ? -1 : displayRows(state).findIndex((r) => r.task === state.selected);
}

/** The cursor stands on a queued task (no window, not a row of the status table). */
export function selectedQueueView(state: BoardState): QueueView | undefined {
  return state.selected === null ? undefined : state.queue.find((v) => v.entry.task === state.selected);
}

export function selectedRow(state: BoardState): BoardRow | undefined {
  return displayRows(state)[selectedIndex(state)];
}

/** After a change of what is listed (a section closed, a refresh): the selection stays when its row is still listed, else the first row. */
function keepSelection(state: BoardState): BoardState {
  const tasks = navTasks(state);
  if (state.selected !== null && tasks.includes(state.selected)) return state;
  const selected = firstSelectable(tasks);
  return selected === state.selected ? state : { ...state, selected, preview: null };
}

const isAlive = (row: BoardRow): boolean => row.window === 'alive';

const withNotice = (state: BoardState, level: Notice['level'], text: string): BoardState => ({ ...state, notice: { level, text } });
const toList = (state: BoardState): BoardState => ({ ...state, mode: { kind: 'list' } });

/** Pasted text arrives as one string, possibly with line breaks; the field is a single line. */
const printable = (input: string): string => input.replace(/\r?\n|\r/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '');

function listKey(state: BoardState, input: string, key: KeyPress): KeyResult {
  const stay = (s: BoardState = state, effects: BoardEffect[] = []): KeyResult => ({ state: s, effects });
  if ((input === 'q' && !key.ctrl && !key.meta) || (key.ctrl && input === 'c')) return stay({ ...state, quit: true }, [{ type: 'quit' }]);

  // k is the cohort filter now; the arrow up moves up (j still moves down).
  const move = key.upArrow ? -1 : key.downArrow || input === 'j' ? 1 : 0;
  if (move !== 0) {
    const listed = navTasks(state);
    if (listed.length === 0) return stay();
    const next = Math.min(listed.length - 1, Math.max(0, Math.max(state.selected === null ? -1 : listed.indexOf(state.selected), 0) + move));
    const task = listed[next] as string;
    if (task === state.selected) return stay();
    return stay({ ...state, selected: task, notice: null }, [{ type: 'refresh' }]);
  }

  if (input === '?') return stay({ ...state, mode: { kind: 'help' } });
  if (input === 'l') return stay({ ...state, notice: null, mode: { kind: 'log', lines: ['Loading…'], offset: 0 } }, [{ type: 'log' }]);
  const view: ViewKind | null = input === 'C' ? 'capacity' : input === 'L' ? 'limits' : input === 'G' ? 'gc' : null;
  if (view) return stay({ ...state, notice: null, mode: { kind: 'view', what: view, lines: ['Loading…'], offset: 0 } }, [{ type: 'view', what: view }]);
  // o / p / f: how a finished task turned out. `p` is also the queue's pause: it marks only while a finished task is selected.
  const result = input === 'o' ? 'ok' : input === 'p' ? 'partial' : input === 'f' ? 'fail' : null;
  if (result) {
    if (state.cohortFilter) {
      const tasks = state.rows.filter(r => r.cohort && cohortKey(r.cohort) === cohortKey(state.cohortFilter!)).map(r => r.task);
      if (tasks.length > 1) return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'mark-cohort', task: state.cohortFilter, tasks, result } });
      if (tasks.length === 1) return stay(state, [{ type: 'mark', task: tasks[0]!, result }]);
    }
    const picked = selectedRow(state);
    const markable = picked !== undefined && selectedQueueView(state) === undefined && (picked.finished || picked.closed || picked.cancelled || picked.state === 'report-ready');
    if (markable) return stay(withNotice(state, 'info', `${picked.task}: marking it ${result}…`), [{ type: 'mark', task: picked.task, result }]);
    if (input !== 'p') return stay(withNotice(state, 'error', 'o / p / f mark the result of a finished task (one with a report, or without a window): select one first.'));
  }
  if (input === 'w') {
    const on = !(state.away?.on ?? false);
    return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'away', task: on ? 'on' : 'off' } });
  }
  if (input === 'R') {
    if (state.resumable.length === 0) return stay(withNotice(state, 'info', 'Nothing to resume: no active task without a window.'));
    return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'resume', task: state.resumable.join(', ') } });
  }
  if (input === 'z') {
    const next = keepSelection({ ...state, notice: null, showFinished: !state.showFinished });
    return stay(next, next.selected !== state.selected ? [{ type: 'refresh' }] : []);
  }
  if (input === 'a') {
    const next = keepSelection({ ...state, notice: null, showHidden: !state.showHidden });
    return stay(withNotice(next, 'info', next.showHidden ? 'Hidden tasks are listed too (dimmed). a hides them again.' : 'Hidden tasks are not listed.'), next.showHidden || next.selected !== state.selected ? [{ type: 'refresh' }] : []);
  }
  if (input === 'r') return stay(withNotice(state, 'info', 'Collecting the new reports…'), [{ type: 'pull-ready' }]);
  if (input === 'k') {
    const options = cohortOptions(state);
    if (options.length <= 2 && state.cohortFilter === null) return stay(withNotice(state, 'error', 'No cohorts yet: a task joins one with "cohort: <name>" in its spec, or agentctl cohort add.'));
    return stay({ ...state, notice: null, mode: { kind: 'cohort-pick', options, index: Math.max(0, options.findIndex((o) => o.value === state.cohortFilter)) } });
  }
  if (input === 'E') return stay(withNotice({ ...state, folded: [] }, 'info', 'All groups are open.'));
  if (input === 'p') {
    const pause = !state.queuePaused;
    return stay(withNotice(state, 'info', pause ? 'Pausing the queue…' : 'Resuming the queue…'), [{ type: 'queue-pause', paused: pause }]);
  }

  // A queued task has no window: only u (front), d (remove) and X (cancel) apply to it.
  const queued = selectedQueueView(state);
  if (input === 'g') {
    if (!isGrouped(state)) return stay(withNotice(state, 'error', 'No cohorts: nothing to fold.'));
    const cohort = queued ? queued.entry.cohort : selectedRow(state)?.cohort;
    if (queued === undefined && selectedRow(state) === undefined) return stay(withNotice(state, 'error', 'No task selected.'));
    const group = groupOf(cohort);
    const folded = state.folded.includes(group) ? state.folded.filter((g) => g !== group) : [...state.folded, group];
    const next = keepSelection({ ...state, notice: null, folded });
    return stay(withNotice(next, 'info', folded.includes(group) ? `${cohort ?? 'bez kohorty'}: folded (G opens all groups).` : `${cohort ?? 'bez kohorty'}: open.`), next.selected !== state.selected ? [{ type: 'refresh' }] : []);
  }
  if (input === 'X') {
    const target = queued ?? selectedRow(state);
    if (!target) return stay(withNotice(state, 'error', 'No task selected.'));
    if (queued) {
      if (queued.entry.status === 'starting') return stay(withNotice(state, 'error', `${queued.entry.task} is being started right now.`));
      return stay({ ...state, notice: null, mode: { kind: 'cancel-reason', task: queued.entry.task, text: '' } });
    }
    const r = target as BoardRow;
    if (r.cancelled || r.closed) return stay(withNotice(state, 'error', `${r.task} is ${r.cancelled ? 'cancelled' : 'closed'} already; nothing to cancel.`));
    return stay({ ...state, notice: null, mode: { kind: 'cancel-reason', task: r.task, text: '' } });
  }
  if (input === 'u' || input === 'd') {
    if (!queued) return stay(withNotice(state, 'error', 'Select a task of the Queue section first.'));
    if (input === 'u') {
      if (queued.entry.status !== 'queued') return stay(withNotice(state, 'error', `${queued.entry.task} is ${queued.entry.status}, not waiting.`));
      return stay(withNotice(state, 'info', `${queued.entry.task}: moving to the front…`), [{ type: 'queue-up', task: queued.entry.task }]);
    }
    return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'queue-rm', task: queued.entry.task } });
  }

  if (state.selected === MANAGER_SELECT) {
    if (key.return) return stay(state, [{ type: 'switch', task: MANAGER_WINDOW, window: MANAGER_WINDOW }]);
    if (input === 'm' || input === 'M' || input === 'i' || input === 'c' || input === 'x' || input === 'h') return stay(withNotice(state, 'info', 'This is the manager, not a task: Enter goes to its window (agentctl manager stop closes it).'));
    return stay();
  }
  const row = selectedRow(state);
  const needsTask = key.return || input === 'm' || input === 'M' || input === 'i' || input === 'c' || input === 'x' || input === 'h';
  if (!needsTask) return stay();
  if (queued) return stay(withNotice(state, 'error', `${queued.entry.task} is in the queue and has no window yet (u front, d remove, p pause).`));
  if (!row) return stay(withNotice(state, 'error', 'No task selected.'));

  if (input === 'c') return stay(withNotice(state, 'info', `${row.task}: copying the report…`), [{ type: 'pull', task: row.task }]);
  if ((row.closed || row.cancelled) && (input === 'x' || input === 'h' || input === 'm' || input === 'M' || input === 'i')) return stay(withNotice(state, 'error', `${row.task} is ${row.cancelled ? 'cancelled' : 'closed'}${row.archived ? ' and archived' : ''}; only c (copy the report) works on it.`));
  if (input === 'x') return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'close', task: row.task } });
  if (input === 'h') return stay(withNotice(state, 'info', row.hidden ? `${row.task}: showing it again…` : `${row.task}: hiding it (a lists hidden tasks)…`), [{ type: 'hide', task: row.task, hidden: !row.hidden }]);
  // A task without a window cannot be switched to: Enter offers what still makes sense.
  if (key.return && (row.finished || row.closed || row.cancelled)) return stay({ ...state, notice: null, mode: { kind: 'finished', task: row.task } });
  if (input === 'M') {
    if (row.state === 'superseded') return stay(withNotice(state, 'error', `${row.task} was already moved.`));
    if (row.pin) return stay(withNotice(state, 'error', `${row.task} is pinned (pin: true): it is never moved to the other provider.`));
    return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'move', task: row.task } });
  }
  // The rest talk to the window.
  if (!isAlive(row)) return stay(withNotice(state, 'error', `${row.task} has no tmux window (closed or dead).`));
  if (key.return) return stay(state, [{ type: 'switch', task: row.task, window: row.windowName }]);
  if (input === 'm') return stay({ ...state, notice: null, mode: { kind: 'input', task: row.task, text: '' } });
  return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'interrupt', task: row.task } });
}

function finishedKey(state: BoardState, mode: Extract<BoardMode, { kind: 'finished' }>, input: string, key: KeyPress): KeyResult {
  const row = state.rows.find((r) => r.task === mode.task);
  if (key.escape || (key.ctrl && input === 'c')) return { state: toList(state), effects: [] };
  if (!row) return { state: withNotice(toList(state), 'error', `${mode.task} is gone.`), effects: [] };
  if (input === 'c') return { state: withNotice(toList(state), 'info', `${row.task}: copying the report…`), effects: [{ type: 'pull', task: row.task }] };
  const result = input === 'p' ? 'partial' : input === 'f' ? 'fail' : input === 'o' && !isAlive(row) ? 'ok' : null;
  if (result) return { state: withNotice(toList(state), 'info', `${row.task}: marking it ${result}…`), effects: [{ type: 'mark', task: row.task, result }] };
  if ((row.closed || row.cancelled) && input !== 'c') return { state, effects: [] };
  if (input === 'x') return { state: { ...state, mode: { kind: 'confirm', action: 'close', task: row.task } }, effects: [] };
  if (input === 'X') return { state: { ...state, mode: { kind: 'cancel-reason', task: row.task, text: '' } }, effects: [] };
  if (input === 'h') return { state: withNotice(toList(state), 'info', `${row.task}: hiding it (a lists hidden tasks)…`), effects: [{ type: 'hide', task: row.task, hidden: true }] };
  if (input === 'o' && isAlive(row)) return { state: toList(state), effects: [{ type: 'switch', task: row.task, window: row.windowName }] };
  return { state, effects: [] };
}

function inputKey(state: BoardState, mode: Extract<BoardMode, { kind: 'input' }>, input: string, key: KeyPress): KeyResult {
  if (key.escape || (key.ctrl && input === 'c')) return { state: withNotice(toList(state), 'info', 'Message cancelled.'), effects: [] };
  if (key.return) {
    const text = mode.text.trim();
    if (text === '') return { state: toList(state), effects: [] };
    const row = state.rows.find((r) => r.task === mode.task);
    if (!row || !isAlive(row)) return { state: withNotice(toList(state), 'error', `${mode.task} has no tmux window any more.`), effects: [] };
    return { state: toList(state), effects: [{ type: 'send', task: row.task, window: row.windowName, text }] };
  }
  if (key.backspace || key.delete) return { state: { ...state, mode: { ...mode, text: [...mode.text].slice(0, -1).join('') } }, effects: [] };
  if (key.ctrl && input === 'u') return { state: { ...state, mode: { ...mode, text: '' } }, effects: [] };
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return { state, effects: [] };
  return { state: { ...state, mode: { ...mode, text: mode.text + printable(input) } }, effects: [] };
}

function cancelReasonKey(state: BoardState, mode: Extract<BoardMode, { kind: 'cancel-reason' }>, input: string, key: KeyPress): KeyResult {
  if (key.escape || (key.ctrl && input === 'c')) return { state: withNotice(toList(state), 'info', 'Cancelled.'), effects: [] };
  if (key.return) {
    const reason = mode.text.trim();
    return { state: { ...state, mode: { kind: 'confirm', action: 'cancel', task: mode.task, ...(reason !== '' ? { reason } : {}) } }, effects: [] };
  }
  if (key.backspace || key.delete) return { state: { ...state, mode: { ...mode, text: [...mode.text].slice(0, -1).join('') } }, effects: [] };
  if (key.ctrl && input === 'u') return { state: { ...state, mode: { ...mode, text: '' } }, effects: [] };
  if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) return { state, effects: [] };
  return { state: { ...state, mode: { ...mode, text: mode.text + printable(input) } }, effects: [] };
}

/** The choices of the `k` list: every task, each cohort that is in use, and the tasks without one (when there are any). */
export const OLDER_COHORTS = '\u0000older';
export function cohortOptions(state: BoardState, expanded = false): CohortOption[] {
  const groups = groupOrder(state).filter((g) => g.key !== '' && !state.archivedCohorts.includes(g.key));
  const anyPlain = state.rows.some((r) => r.cohort === null) || state.queue.some((v) => v.entry.cohort === undefined);
  // Cohorts with work in progress or queued always show; of the rest the `cohorts_recent` most recently active ones, the others fold into "starsze…".
  const active = (key: string): boolean => state.queue.some((v) => groupOf(v.entry.cohort) === key) || state.rows.some((r) => groupOf(r.cohort) === key && !r.closed && !r.cancelled && !r.finished);
  const last = (key: string): number => { const t = Date.parse(lastActivity({ created: '' }, state.rows.filter((r) => groupOf(r.cohort) === key), state.queue.filter((v) => groupOf(v.entry.cohort) === key).map((v) => v.entry))); return Number.isFinite(t) ? t : 0; };
  const quiet = groups.filter((g) => !active(g.key)).sort((a, b) => last(b.key) - last(a.key));
  const slots = Math.max(0, state.cohortsRecent - groups.filter((g) => active(g.key)).length);
  const hidden = expanded ? new Set<string>() : new Set(quiet.slice(slots).map((g) => g.key));
  // The cohort being filtered stays in the choice even when it is old.
  if (state.cohortFilter) hidden.delete(state.cohortFilter);
  const shown = groups.filter((g) => !hidden.has(g.key));
  return [{ label: 'wszystkie', value: null }, ...shown.map((g) => ({ label: g.name as string, value: g.key })), ...(hidden.size > 0 ? [{ label: `starsze… (${hidden.size})`, value: OLDER_COHORTS }] : []), ...(anyPlain ? [{ label: 'bez kohorty', value: '' }] : [])];
}

function cohortPickKey(state: BoardState, mode: Extract<BoardMode, { kind: 'cohort-pick' }>, input: string, key: KeyPress): KeyResult {
  if (key.escape || (key.ctrl && input === 'c')) return { state: toList(state), effects: [] };
  const last = mode.options.length - 1;
  const choose = (index: number): KeyResult => {
    const option = mode.options[index] as CohortOption;
    if (option.value === OLDER_COHORTS) {
      const options = cohortOptions(state, true);
      return { state: { ...state, mode: { kind: 'cohort-pick', options, index: Math.min(options.length - 1, index), expanded: true } }, effects: [] };
    }
    const next = keepSelection({ ...toList(state), cohortFilter: option.value, notice: null });
    return { state: withNotice(next, 'info', option.value === null ? 'All tasks are listed.' : `Only ${option.label} is listed (k picks another).`), effects: next.selected !== state.selected ? [{ type: 'refresh' }] : [] };
  };
  if (key.return) return choose(mode.index);
  if (/^[1-9]$/.test(input) && Number(input) - 1 <= last) return choose(Number(input) - 1);
  const move = key.upArrow ? -1 : key.downArrow || input === 'j' ? 1 : key.pageUp ? -COHORT_PAGE : key.pageDown ? COHORT_PAGE : 0;
  if (move !== 0) return { state: { ...state, mode: { ...mode, index: Math.min(last, Math.max(0, mode.index + move)) } }, effects: [] };
  return { state, effects: [] };
}

const COHORT_PAGE = 7;
/** The visible part of the `k` choice: a page around the cursor, with arrows where more is. */
export function cohortPickWindow(options: CohortOption[], index: number): string {
  const start = options.length <= COHORT_PAGE ? 0 : Math.min(Math.max(0, index - Math.floor(COHORT_PAGE / 2)), options.length - COHORT_PAGE);
  const end = Math.min(options.length, start + COHORT_PAGE);
  return `${start > 0 ? `‹${start} ` : ''}${options.slice(start, end).map((o, i) => (start + i === index ? `[${start + i + 1} ${o.label}]` : `${start + i + 1} ${o.label}`)).join('  ')}${end < options.length ? ` ${options.length - end}›` : ''}`;
}

function confirmKey(state: BoardState, mode: Extract<BoardMode, { kind: 'confirm' }>, input: string, key: KeyPress): KeyResult {
  const yes = input === 'y' || input === 'Y';
  const cancel = (): KeyResult => ({ state: withNotice(toList(state), 'info', 'Cancelled.'), effects: [] });
  if (mode.action === 'mark-cohort') {
    if (!yes) return cancel();
    const tasks = state.rows.filter(r => r.cohort && cohortKey(r.cohort) === cohortKey(mode.task)).map(r => r.task);
    if (JSON.stringify([...tasks].sort()) !== JSON.stringify([...(mode.tasks ?? [])].sort())) return { state: withNotice(toList(state), 'error', 'Cohort scope changed; preview o / p / f again.'), effects: [] };
    return { state: toList(state), effects: [{ type: 'mark-cohort', cohort: mode.task, tasks: mode.tasks!, result: mode.result! }] };
  }
  if (mode.action === 'interrupt') {
    return yes ? { state: withNotice(toList(state), 'info', `${mode.task}: interrupting…`), effects: [{ type: 'interrupt', task: mode.task }] } : cancel();
  }
  if (mode.action === 'cancel') {
    return yes ? { state: withNotice(toList(state), 'info', `${mode.task}: cancelling…`), effects: [{ type: 'cancel', task: mode.task, ...(mode.reason ? { reason: mode.reason } : {}) }] } : cancel();
  }
  if (mode.action === 'queue-rm') {
    return yes ? { state: withNotice(toList(state), 'info', `${mode.task}: removing from the queue…`), effects: [{ type: 'queue-rm', task: mode.task }] } : cancel();
  }
  if (mode.action === 'away') {
    return yes ? { state: withNotice(toList(state), 'info', `Away ${mode.task}…`), effects: [{ type: 'away', on: mode.task === 'on' }] } : cancel();
  }
  if (mode.action === 'resume') {
    return yes ? { state: withNotice(toList(state), 'info', 'Resuming…'), effects: [{ type: 'resume' }] } : cancel();
  }
  if (mode.action === 'move') {
    return yes ? { state: withNotice(toList(state), 'info', `${mode.task}: moving to the other provider…`), effects: [{ type: 'move', task: mode.task }] } : cancel();
  }
  if (mode.action === 'close') {
    if (!yes) return cancel();
    const row = state.rows.find((r) => r.task === mode.task);
    if (row && row.worktrees.length > 0) return { state: { ...state, mode: { kind: 'confirm', action: 'close-worktree', task: mode.task } }, effects: [] };
    return { state: withNotice(toList(state), 'info', `${mode.task}: closing…`), effects: [{ type: 'close', task: mode.task, rmWorktree: false }] };
  }
  // close-worktree: y removes the worktrees, n (or Enter) only closes the window, Esc cancels it all.
  if (key.escape) return cancel();
  return { state: withNotice(toList(state), 'info', `${mode.task}: closing…`), effects: [{ type: 'close', task: mode.task, rmWorktree: yes }] };
}

/** What a key press does: the new state and the effects for the front to run. Pure. */
export function handleKey(state: BoardState, input: string, key: KeyPress): KeyResult {
  switch (state.mode.kind) {
    case 'list':
      return listKey(state, input, key);
    case 'input':
      return inputKey(state, state.mode, input, key);
    case 'finished':
      return finishedKey(state, state.mode, input, key);
    case 'confirm':
      return confirmKey(state, state.mode, input, key);
    case 'cancel-reason':
      return cancelReasonKey(state, state.mode, input, key);
    case 'cohort-pick':
      return cohortPickKey(state, state.mode, input, key);
    case 'help':
      return { state: toList(state), effects: [] };
    case 'log':
      return logKey(state, state.mode, input, key);
    case 'view':
      return viewKey(state, state.mode, input, key);
  }
}

function viewKey(state: BoardState, mode: Extract<BoardMode, { kind: 'view' }>, input: string, key: KeyPress): KeyResult {
  const opener = mode.what === 'limits' ? 'L' : 'G';
  if (key.escape || input === 'q' || input === opener || (key.ctrl && input === 'c')) return { state: toList(state), effects: [] };
  const step = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0;
  if (step === 0) return { state, effects: [] };
  return { state: { ...state, mode: { ...mode, offset: Math.max(0, Math.min(Math.max(0, mode.lines.length - 1), mode.offset + step)) } }, effects: [] };
}

function logKey(state: BoardState, mode: Extract<BoardMode, { kind: 'log' }>, input: string, key: KeyPress): KeyResult {
  if (key.escape || input === 'q' || input === 'l' || (key.ctrl && input === 'c')) return { state: toList(state), effects: [] };
  const step = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0;
  if (step === 0) return { state, effects: [] };
  return { state: { ...state, mode: { ...mode, offset: Math.max(0, Math.min(Math.max(0, mode.lines.length - 1), mode.offset + step)) } }, effects: [] };
}

// ---- data in

export interface BoardSnapshot {
  disk?: DiskReport;
  rows: BoardRow[];
  /** Absent: no queue (older callers). */
  queue?: QueueView[];
  queuePaused?: boolean;
  /** Absent: no panel (older callers). */
  plans?: ProviderValues<PlanState>;
  resumable?: string[];
  away?: AwayView;
  manager?: ManagerView;
  archivedCohorts?: string[];
  cohortsRecent?: number;
  preview: Preview | null;
  refreshedAt: string;
}

/** Keep the selection when the task is still there, otherwise take the first row. */
export function applySnapshot(state: BoardState, snap: BoardSnapshot): BoardState {
  const next: BoardState = { ...state, rows: snap.rows, queue: snap.queue ?? [], queuePaused: snap.queuePaused ?? false, disk: snap.disk ?? null, plans: snap.plans ?? null, resumable: snap.resumable ?? [], away: snap.away ?? null, manager: snap.manager ?? null, archivedCohorts: snap.archivedCohorts ?? state.archivedCohorts, cohortsRecent: snap.cohortsRecent ?? state.cohortsRecent, refreshedAt: snap.refreshedAt, loadError: null };
  const listed = navTasks(next);
  const selected = state.selected !== null && listed.includes(state.selected) ? state.selected : firstSelectable(listed);
  const preview = snap.preview && snap.preview.task === selected ? snap.preview : selected === state.selected ? state.preview : null;
  return { ...next, selected, preview };
}

export const withLoadError = (state: BoardState, message: string): BoardState => ({ ...state, loadError: message });
export const withSize = (state: BoardState, width: number, height: number): BoardState => ({ ...state, width, height });
export const withBusy = (state: BoardState, busy: string | null): BoardState => ({ ...state, busy });
export const clearNotice = (state: BoardState): BoardState => (state.notice ? { ...state, notice: null } : state);
export const showNotice = (state: BoardState, notice: Notice): BoardState => ({ ...state, notice });

/** Git is slow compared to tmux: ask for the progress of a task at most every PROGRESS_TTL_MS. */
export class ProgressCache {
  private readonly entries = new Map<string, { at: number; value: StatusRow['progress'] }>();

  async get(runner: Runner, task: string, repos: Parameters<typeof taskProgress>[1], now: number): Promise<StatusRow['progress']> {
    const hit = this.entries.get(task);
    if (hit && now - hit.at < PROGRESS_TTL_MS) return hit.value;
    const value = await taskProgress(runner, repos);
    this.entries.set(task, { at: now, value });
    return value;
  }
}

const clock = (ms: number): string => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** The last disk report per agentctl home: collected on its own cadence, shown from the cache on the other ticks. */
const diskReadings = new Map<string, { at: number; report: DiskReport }>();

/** The disk reading of this tick: the last report while it is fresh (volumes and worktree sizes change slowly). */
async function boardDisk(ctx: Context, records: TaskRecord[]): Promise<DiskReport> {
  const key = ctx.config.path;
  const now = ctx.runner.now();
  const hit = diskReadings.get(key);
  if (hit && now - hit.at < DISK_INTERVAL_MS) return hit.report;
  // A bounded budget: the sizes of the worktrees keep measuring in the background, the tick shows the last reading.
  const report = await collectDisk(ctx, fs.promises.statfs, { budgetMs: 250, records });
  diskReadings.set(key, { at: now, report });
  return report;
}

export interface LoadBoardOptions {
  /** Full detail (prompt queue, outputs, tokens) also for closed/cancelled/archived rows: their section is expanded. */
  deepClosed?: boolean;
}

/** One refresh from the core: the rows (with cached progress) and the preview of the selected task. */
export async function loadBoard(ctx: Context, selected: string | null, cache: ProgressCache, previewLines: number = PREVIEW_LINES, opts: LoadBoardOptions = {}): Promise<BoardSnapshot> {
  const { runner, config } = ctx;
  // One scan of the record stores per tick (cached: unchanged TASK.md files are not read again), shared by every consumer.
  const scan = await snapshotRecords(config);
  const reader = sharedReader(config);
  reader.dropListings(); // directory listings are per tick, the parsed cache persists
  const statusRows = await collectStatus(ctx, { progress: false, archived: true, tokens: true, records: scan, reader, shallowClosed: opts.deepClosed !== true });
  const records = new Map([...scan.archived, ...scan.current].map((r) => [r.task, r]));
  const now = runner.now();
  const plans = readPlans(config, reader, now, scan.all);
  const disk = await boardDisk(ctx, scan.all);
  reader.save();
  const rows: BoardRow[] = [];
  for (const row of statusRows) {
    const record = records.get(row.task);
    const progress = record && record.repos.length > 0 && !row.hidden ? await cache.get(runner, row.task, record.repos, now) : null;
    const worktrees = (record?.repos ?? []).filter((r) => path.resolve(r.worktree) !== path.resolve(r.path)).map((r) => r.worktree);
    rows.push({ ...row, progress, worktrees });
  }
  attachCollisions(rows, config.collisions.ignore, config.collisions.enabled);
  const entries = readQueue(config);
  const queue = entries.length > 0 ? describeQueue(config, entries, await liveWindows(ctx), statusRows) : [];
  const queuePaused = isPaused(config) || !config.queue.enabled;
  const resumable = (await findResumable(ctx, { rows: statusRows })).map((c) => c.task);
  const manager = await managerView(ctx);
  const archivedCohorts = listCohorts(config).filter((m) => m.archived).map((m) => cohortKey(m.name));
  const queued = queue.find((v) => v.entry.task === selected);
  if (selected === MANAGER_SELECT && manager.state !== 'missing') {
    let lines: string[];
    try {
      lines = await peekWindow(ctx, MANAGER_WINDOW, previewLines);
    } catch (e) {
      lines = [`(cannot read the window: ${errorMessage(e)})`];
    }
    return { rows, queue, queuePaused, disk, plans, resumable, away: awayView(config), manager, archivedCohorts, cohortsRecent: config.board.cohortsRecent, preview: { task: MANAGER_SELECT, lines }, refreshedAt: clock(now) };
  }
  if (queued) return { rows, queue, queuePaused, disk, plans, resumable, away: awayView(config), manager, archivedCohorts, cohortsRecent: config.board.cohortsRecent, preview: { task: queued.entry.task, model: `${queued.entry.agent} · model: ${queued.entry.model} · effort: ${queued.entry.effort}`, lines: queuePreview(queued) }, refreshedAt: clock(now) };
  // The selected task; else the first one the list shows (not a hidden, closed or finished one).
  const target = rows.find((r) => r.task === selected) ?? rows.find((r) => !r.hidden && !r.finished) ?? rows.find((r) => !r.hidden) ?? rows[0];
  let preview: Preview | null = null;
  if (target) {
    let lines: string[];
    if (target.cancelled) lines = [`(cancelled${target.cancelledAt ? ` ${target.cancelledAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${target.cancelReason ? `: ${target.cancelReason}` : ''}; the report ${target.report === 'yes' ? 'is still there: c copies it' : 'was never written'})`];
    else if (target.closed) lines = [`(closed${target.closedAt ? ` ${target.closedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${target.archived ? ', archived' : ''}; the report ${target.report === 'yes' ? 'is still there: c copies it' : 'was never written'})`];
    else if (!isAlive(target)) lines = [`(finished: no tmux window${target.report === 'yes' ? `; the report is ${target.pulled ? 'pulled' : 'ready: c copies it'}` : '; no report was written'})`];
    else {
      try {
        lines = await peekWindow(ctx, target.windowName, previewLines);
      } catch (e) {
        lines = [`(cannot read the window: ${errorMessage(e)})`];
      }
    }
    const notes = [...(target.collide.length > 0 ? [collideText(target.collide)] : []), ...(target.reportSource ? [`report from ${shortPath(target.reportSource)}`] : []), ...(target.reportCandidate && target.report !== 'yes' ? [`report-candidate ${shortPath(target.reportCandidate)}`] : []), ...(target.usage_hint ? [`usage_hint: ${target.usage_hint}`] : []), ...(target.draft_input ? [`draft_input: ${target.draft_input}`] : [])];
    if (target.report === 'yes') notes.push(`decisions ${target.decisionsCount ?? 0}, actions ${target.actionsCount ?? 0}`);
    if (target.promptQueue?.length) notes.push(`${target.promptQueue.length} messages (${target.promptDelivery ?? 'queued'})`);
    preview = { task: target.task, model: `${target.agent} · model: ${target.model} · effort: ${target.effort}`, lines, ...(notes.length > 0 ? { note: notes.join(' · ') } : {}) };
  }
  return { rows, queue, queuePaused, disk, plans, resumable, away: awayView(config), manager, archivedCohorts, cohortsRecent: config.board.cohortsRecent, preview, refreshedAt: clock(now) };
}

/** The preview of a queued task: what it will run, what it waits for, how it ends if it failed, and the start of its prompt. */
function queuePreview(v: QueueView): string[] {
  const e = v.entry;
  const body = e.spec.replace(/\r\n/g, '\n').split(/\n---\n/).slice(1).join('\n---\n').split('\n');
  return [
    `${e.task} · ${e.status}${v.position ? ` · position ${v.position}` : ''}`,
    `${e.agent} ${e.model}/${e.effort} · priority ${e.priority}`,
    ...(e.after.length > 0 ? [`after: ${e.after.join(', ')}`] : []),
    `start: ${v.condition.text}`,
    ...(e.error ? ['', ...e.error.split('\n').slice(0, 8)] : []),
    '',
    ...body.slice(0, PREVIEW_LINES - 8),
  ];
}

// ---- actions

export interface EffectEnv {
  /** `$TMUX` is set: Enter can switch this client to the task window. */
  insideTmux: boolean;
  /** This very agentctl as a command line: the event hooks of a task started by `move` call it. */
  self?: SelfArgv | undefined;
}

/** Run one effect with the core functions the CLI commands use; the result is what the footer says. */
export async function runBoardEffect(runner: Runner, config: GlobalConfig, effect: BoardEffect, env: EffectEnv): Promise<Notice> {
  const lines: string[] = [];
  const ctx = new Context(runner, config, (l) => lines.push(l));
  try {
    switch (effect.type) {
      case 'switch':
        if (!env.insideTmux) return { level: 'error', text: effect.window === MANAGER_WINDOW ? `Not inside tmux: tmux attach -t ${config.session} \\; select-window -t ${MANAGER_WINDOW}` : `Not inside tmux: run "agentctl attach ${effect.task}".` };
        await showWindow(ctx, effect.window, true);
        return { level: 'info', text: `Switched to ${effect.task}. Back to the board: ${config.board.returnKey ?? 'Ctrl-b l'}` };
      case 'send':
        const sent = await sendPrompts(ctx, [{ task: effect.task, window: effect.window, prompt: effect.text }]);
        return { level: 'info', text: `${effect.task}: ${sent[0]?.message}` };
      case 'interrupt': {
        const r = await interruptTask(ctx, effect.task);
        return { level: 'info', text: `${r.task}: interrupted (${r.key} sent), the window stays open` };
      }
      case 'pull':
        await pullTask(ctx, effect.task);
        return { level: 'info', text: lines[0] ?? `${effect.task}: pulled` };
      case 'pull-ready':
        await pullReady(ctx);
        return { level: 'info', text: lines[0] ?? 'No reports ready.' };
      case 'move': {
        const moved = await moveTask(ctx, effect.task, { yes: true, self: env.self });
        return { level: 'info', text: moved ? `${effect.task} -> ${moved.plan.task} (${moved.plan.to.agent}); the old window stays open` : `${effect.task}: not moved` };
      }
      case 'close':
        await closeTask(ctx, effect.task, { rmWorktree: effect.rmWorktree });
        return { level: 'info', text: lines.length > 0 ? lines.join('; ') : `${effect.task}: closed` };
      case 'queue-up':
        await moveToFront(ctx, effect.task);
        return { level: 'info', text: `${effect.task}: first in line` };
      case 'queue-rm':
        await removeFromQueue(ctx, effect.task);
        return { level: 'info', text: `${effect.task}: removed from the queue` };
      case 'cancel': {
        const opts = { reason: effect.reason, source: 'board' as const };
        const plan = await planCancel(ctx, [effect.task], opts);
        await cancelTasks(ctx, plan, opts);
        const tasks = plan.items.map((i) => i.task).join(', ');
        const blocked = [...new Set(plan.items.flatMap((i) => i.blocks))];
        return { level: 'info', text: `${tasks}: cancelled${blocked.length > 0 ? `; ⛓ blocked: ${blocked.join(', ')}` : ''}` };
      }
      case 'mark-cohort': {
        const marked = await markTasks(ctx, effect.tasks, effect.result);
        return { level: 'info', text: `${effect.cohort}: marked ${marked.map(r => r.task).join(', ')} ${effect.result}` };
      }
      case 'mark': {
        const marked = await markTask(ctx, effect.task, effect.result);
        return { level: 'info', text: `${marked.task}: marked ${marked.result}${marked.previous && marked.previous !== marked.result ? ` (was ${marked.previous})` : ''}` };
      }
      case 'resume': {
        const plan = await planResume(ctx, []);
        if (plan.items.length === 0) return { level: 'info', text: plan.summary[0] ?? 'Nothing to resume.' };
        const results = await resumeTasks(ctx, plan, { self: env.self });
        return { level: 'info', text: `Resumed: ${results.map((r) => r.task).join(', ')}${plan.skipped.length > 0 ? `; skipped: ${plan.skipped.map((x) => x.task).join(', ')} (limit)` : ''}` };
      }
      case 'away': {
        const { state } = await setAway(ctx, effect.on, 'board');
        return { level: 'info', text: `away ${state.on ? 'on' : 'off'}${state.on && !config.notify.ntfy?.topic ? ' - but no phone is set up yet (agentctl ntfy-setup)' : ''}` };
      }
      case 'queue-pause':
        await setPaused(ctx, effect.paused);
        return { level: 'info', text: effect.paused ? 'Queue paused: nothing new starts (p resumes).' : 'Queue resumed.' };
      case 'hide':
        await setHidden(ctx, [effect.task], effect.hidden);
        return { level: 'info', text: effect.hidden ? `${effect.task}: hidden (a lists hidden tasks, h shows it again)` : `${effect.task}: shown again` };
      case 'refresh':
      case 'log':
      case 'view':
      case 'quit':
        return { level: 'info', text: '' };
    }
  } catch (e) {
    return { level: 'error', text: errorMessage(e).split('\n')[0] as string };
  }
}

// ---- layout and cells

export interface BoardLayout {
  showPreview: boolean;
  listWidth: number;
  /** Width of the preview column including its left border; 0 when hidden. */
  previewWidth: number;
}

export function boardLayout(width: number, requested?: number | string): BoardLayout {
  const showPreview = width >= PREVIEW_MIN_WIDTH;
  const preferred = requested === undefined ? (width >= 140 ? Math.max(92, Math.floor(width * .45)) : LIST_WIDTH)
    : typeof requested === 'number' ? requested : Math.floor(width * Number.parseInt(requested, 10) / 100);
  const listWidth = Math.min(width - 32, Math.max(64, preferred));
  return showPreview ? { showPreview, listWidth, previewWidth: width - listWidth } : { showPreview, listWidth: width, previewWidth: 0 };
}

export interface BoardColumns {
  marker: number;
  task: number;
  who: number;
  state: number;
  time: number;
  progress: number;
  report: number;
  /** The tokens of the task; absent (0) in a list too narrow for it. */
  tokens?: number;
}

/** A list of this many columns or more has the TOKENS column. */
export const TOKENS_MIN_WIDTH = 69;

/** Column widths for a list of `width` columns; the agent column takes what the others leave (8 to 18). */
export function boardColumns(width: number): BoardColumns {
  const tokens = width >= TOKENS_MIN_WIDTH ? 7 : 0;
  const fixed = { marker: 1, task: width >= 92 ? 20 : 10, state: width >= 92 ? 19 : 14, time: 7, progress: 8, report: width >= 92 ? 9 : 7 };
  const gaps = 6 + (tokens > 0 ? 1 : 0);
  const used = Object.values(fixed).reduce((a, b) => a + b, 0) + tokens + gaps;
  return { ...fixed, ...(tokens > 0 ? { tokens } : {}), who: Math.max(8, Math.min(18, width - used)) };
}

export interface BoardCell {
  key: string;
  text: string;
  width: number;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

const STATE_COLOR: Record<TaskState, string> = {
  'needs-attention': 'red',
  working: 'cyan',
  background: 'cyan',
  waiting: 'yellow',
  'needs-input': 'magenta',
  'needs-trust': 'magenta',
  overloaded: 'yellow',
  limited: 'red',
  'report-ready': 'green',
  superseded: 'gray',
  orphan: 'red',
  dead: 'red',
  closed: 'gray',
  cancelled: 'gray',
};

export function headerCells(cols: BoardColumns): BoardCell[] {
  return [
    { key: 'marker', text: '', width: cols.marker },
    { key: 'task', text: 'TASK', width: cols.task },
    { key: 'who', text: 'AGENT', width: cols.who },
    { key: 'state', text: 'STATE', width: cols.state },
    { key: 'time', text: 'TIME', width: cols.time },
    ...(cols.tokens ? [{ key: 'tokens', text: 'TOKENS', width: cols.tokens }] : []),
    { key: 'progress', text: 'PROGRESS', width: cols.progress },
    { key: 'report', text: 'REPORT', width: cols.report },
  ].map((c) => ({ ...c, dim: true }));
}

export function reportLabel(row: StatusRow): string {
  if (row.reportCandidate && row.report !== 'yes') return `candidate: ${row.reportCandidate}`;
  if (row.report === 'missing') return '-';
  return row.pulled ? 'pulled' : 'ready';
}

export function rowCells(row: StatusRow, selected: boolean, cols: BoardColumns, icons: Record<TaskState, string> | null = null, selectedColor = 'blue', versions: Readonly<Record<string, string>> = {}): BoardCell[] {
  const icon = (icons ?? DEFAULT_WINDOW_ICONS)[row.state];
  // Finished and hidden tasks are dimmed: they are history, not work in progress.
  const quiet = row.finished || row.hidden;
  const cells: BoardCell[] = [
    { key: 'marker', text: selected ? '▸' : row.collide.length > 0 ? '⚠' : row.hidden ? '·' : '', width: cols.marker, bold: true, ...(!selected && row.collide.length > 0 ? { color: 'yellow' } : {}) },
    { key: 'task', text: row.task, width: cols.task, bold: selected },
    { key: 'who', text: `${providerLabel(row.agent)} ${(PROVIDERS[row.agent as keyof typeof PROVIDERS]?.models.label ?? modelLabel)(row.model, row.effort, row.tokens?.observed?.model, versions)}`, width: cols.who },
    { key: 'state', text: `${icon} ${row.state}${row.question?.includes("zwinięte") ? " (zw.)" : ""}`, width: cols.state, color: STATE_COLOR[row.state] },
    { key: 'time', text: row.duration, width: cols.time },
    ...(cols.tokens ? [{ key: 'tokens', text: row.tokens ? formatTokens(row.tokens.fresh) : 'n/d', width: cols.tokens, ...(row.tokens ? {} : { dim: true }) }] : []),
    { key: 'progress', text: row.progress?.text ?? '-', width: cols.progress },
    { key: 'report', text: reportLabel(row), width: cols.report, ...(row.report === 'missing' ? { dim: true } : row.pulled ? {} : { color: 'green' }) },
  ];
  const subdued = quiet ? cells.map((c) => (c.key === 'marker' ? c : { ...c, dim: true, ...(c.color ? { color: 'gray' } : {}) })) : cells;
  return selected ? subdued.map((c) => ({ ...c, bold: true, ...(!process.env.NO_COLOR && !c.color ? { color: selectedColor } : {}) })) : subdued;
}

// ---- the usage panel

/** The lines of the log view: the history of the tasks, newest first. */
export const loadLogLines = (ctx: Context): string[] => logLines(ctx);

/** The lines of a view: the same text the command prints. */
export async function loadViewLines(ctx: Context, what: ViewKind): Promise<string[]> {
  if (what === 'capacity') return renderCapacity(await collectCapacity(ctx));
  if (what === 'limits') return renderLimits(collectLimits(ctx.config, await liveWindows(ctx)));
  return renderGc(await planGc(ctx, {}));
}

export const BAR_WIDTH = 10;

/** `▓▓▓▓▓▓░░░░`: the percentage in tenths. */
export function usageBar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(percent / (100 / BAR_WIDTH))));
  return `${'▓'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
}

export interface PanelLine {
  provider: AgentName;
  text: string;
  /** Green below the warning threshold, yellow from it, red from the critical one; undefined (dim) when the plan is n/d. */
  color?: string;
}

/** The two lines under the header: per provider the windows as a bar with the percentage and the reset, or n/d. */
export function usagePanel(plans: ProviderValues<PlanState> | null, usage: UsageSettings, now: number): PanelLine[] {
  if (plans === null) return [];
  return (Object.keys(plans) as AgentName[]).map((provider): PanelLine => {
    const plan = providerValue(plans, provider);
    const name = provider.padEnd(6);
    if (!plan.available) return { provider, text: `${name} n/d${plan.note ? ` – ${plan.note}` : ''}` };
    const parts = plan.windows.map((w) => `${w.label} ${usageBar(w.usedPercent)} ${Math.round(w.usedPercent)}%${w.resetsAt === null ? '' : ` ↻${formatReset(w.resetsAt, now)}`}`);
    const worst = plan.maxPercent ?? 0;
    return { provider, text: `${name} ${parts.join('  ')}${plan.stale ? ' (old)' : ''}`, color: worst >= providerValue(usage.critical, provider) ? 'red' : worst >= providerValue(usage.warn, provider) ? 'yellow' : 'green' };
  });
}

export type ListItem =
  | { kind: 'row'; row: BoardRow }
  | { kind: 'group'; key: string; name: string | null; folded: boolean; rows: BoardRow[]; queued: number }
  | { kind: 'queue-title'; count: number; paused: boolean }
  | { kind: 'queue'; view: QueueView }
  | { kind: 'resume-title'; count: number }
  | { kind: 'resume'; task: string }
  | { kind: 'finished'; count: number; expanded: boolean }
  | { kind: 'closed'; count: number }
  | { kind: 'cancelled'; count: number };

/** The name of the cohort the `k` filter shows, for the header of the board. */
export function cohortLabel(state: BoardState): string {
  if (state.cohortFilter === null) return 'wszystkie';
  if (state.cohortFilter === '') return 'bez kohorty';
  return cohortOptions(state).find((o) => o.value === state.cohortFilter)?.label ?? state.cohortFilter;
}

/** Header of a cohort group: `- sprint-1 (4) 2⚙ 1✓ 1⧗`; `+` while it is folded. The last group is "bez kohorty". */
export function groupTitle(item: Extract<ListItem, { kind: 'group' }>, icons: Record<TaskState, string> | null = null): string {
  const counts = countsLine(item.rows, item.queued, icons ?? DEFAULT_WINDOW_ICONS);
  return `${item.folded ? '+' : '-'} ${item.name ?? 'bez kohorty'} (${item.rows.length + item.queued})${counts ? ` ${counts}` : ''}${item.folded ? ' – g opens, G opens all' : ''}`;
}

/** `Queue (3)` title under the active tasks. */
export function queueTitle(count: number, paused: boolean): string {
  return `Queue (${count})${paused ? ' – PAUSED (p resumes)' : ' – u front  d remove  p pause'}`;
}

/** A queued task as cells: the task, what it runs, and one wide cell for the place in line and what it waits for. */
export function queueCells(view: QueueView, selected: boolean, cols: BoardColumns, selectedColor = 'blue', versions: Readonly<Record<string, string>> = {}): BoardCell[] {
  const e = view.entry;
  const wide = cols.state + cols.time + (cols.tokens ?? 0) + cols.progress + cols.report + (cols.tokens ? 4 : 3);
  const text = `${view.position === null ? (e.status === 'failed' ? '✗' : '…') : `${view.position}.`} ${view.condition.text}${e.priority === 'high' ? ' · high' : ''}`;
  const cells: BoardCell[] = [
    { key: 'marker', text: selected ? '▸' : '', width: cols.marker, bold: true },
    { key: 'task', text: e.task, width: cols.task, bold: selected },
    { key: 'who', text: `${providerLabel(e.agent)} ${providerAdapter(e.agent).models.label(e.model, e.effort, undefined, versions)}`, width: cols.who },
    { key: 'report', text, width: wide, ...(e.status === 'failed' ? { color: 'red' } : view.condition.kind === 'blocked' ? { color: 'yellow' } : { dim: true }) },
  ];
  return selected ? cells.map((c) => ({ ...c, bold: true, ...(!process.env.NO_COLOR && !c.color ? { color: selectedColor } : {}) })) : cells;
}

/** `Finished (3)` title that stands between the active and the finished rows (or under the active ones while the section is closed). */
export const resumeTitle = (count: number): string => `Do wznowienia (${count}) – R wznawia (agentctl resume)`;

export function finishedTitle(count: number, expanded: boolean): string {
  return expanded ? `Finished (${count}) – z closes` : `Finished (${count}) – z opens`;
}

/** Title of the section of tasks closed with `agentctl close` (shown while `a` lists hidden tasks). */
export function closedTitle(count: number): string {
  return `Closed (${count}) – off the list; \`agentctl archive\` moves their state away`;
}

/** Title of the section of tasks cancelled with `agentctl cancel` (shown while `a` lists hidden tasks). */
export function cancelledTitle(count: number): string {
  return `Cancelled (${count}) – abandoned; the report, if any, stays: c copies it`;
}

/** Everything the list shows, top to bottom: active rows, the "Finished" title and rows, the "Closed" title and rows. */
export function listItems(state: BoardState): ListItem[] {
  const finished = finishedRows(state);
  const closed = closedRows(state);
  const cancelled = cancelledRows(state);
  const queue = queueViews(state);
  const active = activeRows(state);
  const activeItems: ListItem[] = isGrouped(state)
    ? groupOrder(state).flatMap((g): ListItem[] => {
        const rows = active.filter((r) => groupOf(r.cohort) === g.key);
        const queued = queue.filter((v) => groupOf(v.entry.cohort) === g.key).length;
        if (rows.length + queued === 0) return [];
        const folded = state.folded.includes(g.key);
        return [{ kind: 'group', key: g.key, name: g.name, folded, rows, queued }, ...(folded ? [] : rows.map((row): ListItem => ({ kind: 'row', row })))];
      })
    : active.map((row): ListItem => ({ kind: 'row', row }));
  return [
    ...activeItems,
    ...(queue.length > 0 ? [{ kind: 'queue-title', count: queue.length, paused: state.queuePaused } as ListItem, ...queue.map((view): ListItem => ({ kind: 'queue', view }))] : []),
    ...(state.resumable.length > 0 ? [{ kind: 'resume-title', count: state.resumable.length } as ListItem, ...state.resumable.map((task): ListItem => ({ kind: 'resume', task }))] : []),
    ...(finished.length > 0 ? [{ kind: 'finished', count: finished.length, expanded: state.showFinished } as ListItem] : []),
    ...(state.showFinished ? finished.map((row): ListItem => ({ kind: 'row', row })) : []),
    ...(closed.length > 0 ? [{ kind: 'closed', count: closed.length } as ListItem] : []),
    ...closed.map((row): ListItem => ({ kind: 'row', row })),
    ...(cancelled.length > 0 ? [{ kind: 'cancelled', count: cancelled.length } as ListItem] : []),
    ...cancelled.map((row): ListItem => ({ kind: 'row', row })),
  ];
}

/** The items that fit in `capacity` lines, scrolled so that the selected row is visible. */
export function visibleItems(state: BoardState, capacity: number): { items: ListItem[]; offset: number } {
  const cap = Math.max(1, capacity);
  const all = listItems(state);
  if (all.length <= cap) return { items: all, offset: 0 };
  const index = Math.max(0, all.findIndex((i) => (i.kind === 'row' && i.row.task === state.selected) || (i.kind === 'queue' && i.view.entry.task === state.selected)));
  const offset = Math.min(all.length - cap, Math.max(0, index - Math.floor(cap / 2)));
  return { items: all.slice(offset, offset + cap), offset };
}

/** The rows that fit in `capacity` lines, scrolled so that the selected one is visible. */
export function visibleRows(state: BoardState, capacity: number): { rows: BoardRow[]; offset: number } {
  const cap = Math.max(1, capacity);
  const listed = displayRows(state);
  if (listed.length <= cap) return { rows: listed, offset: 0 };
  const index = Math.max(0, selectedIndex(state));
  const offset = Math.min(listed.length - cap, Math.max(0, index - Math.floor(cap / 2)));
  return { rows: listed.slice(offset, offset + cap), offset };
}

// ---- texts

export const KEY_HINTS = 'm M move i int c/r pull x close X cancel k cohort h hide l log L G R w u/d/p ?';

export const HELP_LINES: string[] = [
  'agentctl board',
  '  AGENT: cl=claude, cx=codex, ki=kimi; S 6.1 XH = model family/version/effort',
  '  Effort: MN minimal, LO low, MD medium, HI high, XH xhigh, MX max, NO none',
  '          – = unknown; full selected model and effort appear above',
  '',
  '  ↑ ↓ (j)     select a task (↑ up, ↓ or j down)',
  '  Enter       go to the task window (tmux switch-client); back: F12 or Ctrl-b l',
  '              on a finished task (no window): a menu (c copy, x close, h hide)',
  '              🧭 line = the manager (the session you open from the phone):',
  '              ↑ from the first task selects it, Enter goes to its window',
  '  m           type a message and send it to the agent (Enter sends, Esc cancels)',
  '  M           move to another active provider after a limit (asks first)',
  '  i           interrupt the current turn (asks first; the window stays open)',
  '  c           copy the report of the task to the clipboard',
  '  r           copy all new reports to the clipboard (pull --ready)',
  '  x           close the window (asks first; then asks about the git worktree)',
  '  X           cancel the task: a reason (optional), then y/N. The agent is',
  '              interrupted, its window closed (a queued task leaves the queue);',
  '              worktree and branch stay. A move is cancelled with its other half.',
  '              Cancelled tasks are listed under "a", in their own section.',
  '  l           the history of the tasks (agentctl log): ↑↓ scroll, Esc back',
  '  o / p / f   mark a finished task ok / partial / fail (agentctl mark);',
  '              p marks only on a finished task, else it pauses the queue',
  '  k           pick a cohort to show (↑↓ PgUp/PgDn ⏎, number); "wszystkie" = all,',
  '              newest first; "starsze…" opens the rest',
  '              "bez kohorty" = the tasks that are in no cohort',
  '  g / E       fold the cohort group of the selected task / open all groups',
  '  L           the limits per provider and what uses them (agentctl limits)',
  '  C           current capacity (plans, pace, slots, stats, estimates)',
  '  G           preview of the clean-up (agentctl gc): what would be freed',
  '  R           resume the tasks under "Do wznowienia" (asks first)',
  '  w           away on or off (asks first): notifications to the phone',
  '  h           hide the task (or show a hidden one); nothing is closed or removed',
  '  z           open or close the "Finished" section (tasks without a window)',
  '  a           list hidden tasks too (dimmed, marked ·)',
  '  u           (on a queued task) move it to the front',
  '  d           (on a queued task) remove it (asks first)',
  '  p           pause or resume the queue (nothing new starts while paused)',
  '  ⚠           first column: another active task changes the same files',
  '  q           leave the board; the agents keep running',
  '',
  'The list refreshes every 2 s, or every 5 s when nothing runs.',
  'The preview of the selected window shows from 110 columns on.',
  'Press any key to go back.',
];

/** The question or the prompt of the footer for the current mode, or null in the list. */
export function promptText(state: BoardState): string | null {
  const mode = state.mode;
  if (mode.kind === 'input') return `Message to ${mode.task} (Enter sends, Esc cancels): ${mode.text}`;
  if (mode.kind === 'cancel-reason') return `Cancel ${mode.task} – reason, optional (Enter goes on, Esc stops): ${mode.text}`;
  if (mode.kind === 'cohort-pick') return `Cohort: ${cohortPickWindow(mode.options, mode.index)}  (↑↓ PgUp/PgDn ⏎ or a number, Esc)`;
  if (mode.kind === 'finished') return `${mode.task} is finished (no window): c copy report · x close · X cancel · h hide · ${state.rows.find((r) => r.task === mode.task && isAlive(r)) ? 'o open window · ' : 'o ok · '}p partial · f fail · Esc`;
  if (mode.kind !== 'confirm') return null;
  const row = state.rows.find((r) => r.task === mode.task);
  if (mode.action === 'mark-cohort') return `Mark cohort ${mode.task}: ${(mode.tasks ?? []).join(', ')} ${mode.result}? [y/N]`;
  if (mode.action === 'queue-rm') return `Remove ${mode.task} from the queue? [y/N]`;
  if (mode.action === 'away') return mode.task === 'on' ? `Away on? The notifications go to the phone as well.${state.away && !state.away.phone ? ' (No phone is set up yet: agentctl ntfy-setup.)' : ''} [y/N]` : 'Away off? The phone is quiet again (the Mac still gets everything). [y/N]';
  if (mode.action === 'resume') return `Resume ${mode.task}? New windows, the agents continue their conversations (no prompt is pasted). [y/N]`;
  if (mode.action === 'cancel') {
    const partner = row?.supersededBy ?? row?.continues;
    const queued = state.queue.some((v) => v.entry.task === mode.task);
    return `Cancel ${mode.task}${partner ? ` and ${partner} (the other half of a move)` : ''}${mode.reason ? ` – ${mode.reason}` : ''}? ${queued ? 'It is taken out of the queue.' : 'Interrupts the agent, closes the window; worktree and branch stay.'} [y/N]`;
  }
  if (mode.action === 'move') return `Move ${mode.task} to the other provider? A new window starts in the same worktree; this one stays. [y/N]`;
  if (mode.action === 'interrupt') return `Interrupt ${mode.task}? Sends Escape to the agent; the window stays open. [y/N]`;
  if (mode.action === 'close' && row?.finished) return `Close ${mode.task}? It has no window; it is marked closed and leaves the list${row.report === 'missing' ? ' – WARNING: no report was written' : ''}. [y/N]`;
  if (mode.action === 'close') return `Close ${mode.task}? Kills its tmux window${row && row.report === 'missing' ? ' – WARNING: no report yet' : ''}. [y/N]`;
  return `Also remove the git worktree of ${mode.task} (git worktree remove, the branch stays)? [y/N, Esc cancels]`;
}

/** The line of the manager under the header; null when there is no window and none is configured. */
export function managerLine(state: Pick<BoardState, 'manager' | 'selected'>, configured: boolean): { text: string; selected: boolean; dim: boolean } | null {
  const m = state.manager;
  if (!m || (m.state === 'missing' && !configured)) return null;
  const state_ = MANAGER_STATE_TEXT[m.state];
  if (m.state === 'missing') return { text: `🧭 ${m.name}: ${state_} – agentctl manager`, selected: false, dim: true };
  return { text: `🧭 ${m.name}: ${state_}${state.selected === MANAGER_SELECT ? ' · ⏎ wejście' : ''}`, selected: state.selected === MANAGER_SELECT, dim: m.state === 'connected' ? false : m.state === 'starting' };
}

/** The indicator in the header: "📱 away" while away is on, "📱 always" with notify.ntfy.always, dimmed "📱 off" when a phone is set up but quiet; null with no phone and no away. */
export function awayLabel(away: AwayView | null): { text: string; dim: boolean } | null {
  if (!away) return null;
  if (away.on) return { text: '📱 away', dim: false };
  if (away.always) return { text: '📱 always', dim: false };
  return away.phone ? { text: '📱 off', dim: true } : null;
}

/** Full selected model facts stay available even in terminals without a preview. */
export function modelHelp(state: BoardState): string[] {
  const row = state.rows.find(r => r.task === state.selected) ?? state.queue.find(v => v.entry.task === state.selected)?.entry;
  return row ? [`${row.task}: ${row.agent} · model: ${row.model} · effort: ${row.effort}`] : [];
}
