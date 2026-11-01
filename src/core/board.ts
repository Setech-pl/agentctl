import path from 'node:path';
import { closeTask } from './close.ts';
import { Context } from './context.ts';
import type { GlobalConfig } from './config.ts';
import { DEFAULT_WINDOW_ICONS } from './icons.ts';
import type { SelfArgv } from './events.ts';
import { interruptTask } from './interrupt.ts';
import { moveTask } from './move.ts';
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
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import { errorMessage } from './util.ts';

/*
 * The model of `agentctl board`: what is on the screen as plain data, and what a key press does to it. The Ink front
 * (src/board/app.ts) only draws this and forwards keys, so everything here runs without a terminal.
 */

export const BOARD_REFRESH_MS = 2000;
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
  task: string;
  lines: string[];
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
  | { kind: 'confirm'; action: 'interrupt' | 'close' | 'close-worktree' | 'move'; task: string }
  | { kind: 'help' };

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
}

export function initialBoardState(width: number, height: number): BoardState {
  return { rows: [], selected: null, mode: { kind: 'list' }, notice: null, preview: null, width, height, refreshedAt: null, busy: null, loadError: null, quit: false, showFinished: false, showHidden: false };
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
  /** The selection moved: load the preview of the new one now instead of at the next refresh. */
  | { type: 'refresh' }
  | { type: 'quit' };

/** The part of Ink's key object the board looks at. */
export interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
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

/** Tasks that still have a window, in the order of the status table; hidden ones only with the `a` key. */
export function activeRows(state: BoardState): BoardRow[] {
  return state.rows.filter((r) => !r.closed && !r.finished && (state.showHidden || !r.hidden));
}

/** Tasks without a window (or moved to the other provider) that were not closed: the "Finished" section. */
export function finishedRows(state: BoardState): BoardRow[] {
  return state.rows.filter((r) => !r.closed && r.finished && (state.showHidden || !r.hidden));
}

/** Tasks closed with `agentctl close` (or archived): their own section, only while the `a` key lists hidden tasks. */
export function closedRows(state: BoardState): BoardRow[] {
  return state.showHidden ? state.rows.filter((r) => r.closed) : [];
}

/** The rows the cursor can stand on: the active ones, the finished ones while that section is open, then the closed ones. */
export function displayRows(state: BoardState): BoardRow[] {
  return [...activeRows(state), ...(state.showFinished ? finishedRows(state) : []), ...closedRows(state)];
}

export function selectedIndex(state: BoardState): number {
  return state.selected === null ? -1 : displayRows(state).findIndex((r) => r.task === state.selected);
}

export function selectedRow(state: BoardState): BoardRow | undefined {
  return displayRows(state)[selectedIndex(state)];
}

/** After a change of what is listed (a section closed, a refresh): the selection stays when its row is still listed, else the first row. */
function keepSelection(state: BoardState): BoardState {
  const rows = displayRows(state);
  if (state.selected !== null && rows.some((r) => r.task === state.selected)) return state;
  const selected = rows[0]?.task ?? null;
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

  const move = key.upArrow || input === 'k' ? -1 : key.downArrow || input === 'j' ? 1 : 0;
  if (move !== 0) {
    const listed = displayRows(state);
    if (listed.length === 0) return stay();
    const next = Math.min(listed.length - 1, Math.max(0, Math.max(selectedIndex(state), 0) + move));
    const task = (listed[next] as BoardRow).task;
    if (task === state.selected) return stay();
    return stay({ ...state, selected: task, notice: null }, [{ type: 'refresh' }]);
  }

  if (input === '?') return stay({ ...state, mode: { kind: 'help' } });
  if (input === 'z') {
    const next = keepSelection({ ...state, notice: null, showFinished: !state.showFinished });
    return stay(next, next.selected !== state.selected ? [{ type: 'refresh' }] : []);
  }
  if (input === 'a') {
    const next = keepSelection({ ...state, notice: null, showHidden: !state.showHidden });
    return stay(withNotice(next, 'info', next.showHidden ? 'Hidden tasks are listed too (dimmed). a hides them again.' : 'Hidden tasks are not listed.'), next.selected !== state.selected ? [{ type: 'refresh' }] : []);
  }
  if (input === 'r') return stay(withNotice(state, 'info', 'Collecting the new reports…'), [{ type: 'pull-ready' }]);

  const row = selectedRow(state);
  const needsTask = key.return || input === 'm' || input === 'M' || input === 'i' || input === 'c' || input === 'x' || input === 'h';
  if (!needsTask) return stay();
  if (!row) return stay(withNotice(state, 'error', 'No task selected.'));

  if (input === 'c') return stay(withNotice(state, 'info', `${row.task}: copying the report…`), [{ type: 'pull', task: row.task }]);
  if (row.closed && (input === 'x' || input === 'h' || input === 'm' || input === 'M' || input === 'i')) return stay(withNotice(state, 'error', `${row.task} is closed${row.archived ? ' and archived' : ''}; only c (copy the report) works on it.`));
  if (input === 'x') return stay({ ...state, notice: null, mode: { kind: 'confirm', action: 'close', task: row.task } });
  if (input === 'h') return stay(withNotice(state, 'info', row.hidden ? `${row.task}: showing it again…` : `${row.task}: hiding it (a lists hidden tasks)…`), [{ type: 'hide', task: row.task, hidden: !row.hidden }]);
  // A task without a window cannot be switched to: Enter offers what still makes sense.
  if (key.return && (row.finished || row.closed)) return stay({ ...state, notice: null, mode: { kind: 'finished', task: row.task } });
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
  if (row.closed && input !== 'c') return { state, effects: [] };
  if (input === 'x') return { state: { ...state, mode: { kind: 'confirm', action: 'close', task: row.task } }, effects: [] };
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

function confirmKey(state: BoardState, mode: Extract<BoardMode, { kind: 'confirm' }>, input: string, key: KeyPress): KeyResult {
  const yes = input === 'y' || input === 'Y';
  const cancel = (): KeyResult => ({ state: withNotice(toList(state), 'info', 'Cancelled.'), effects: [] });
  if (mode.action === 'interrupt') {
    return yes ? { state: withNotice(toList(state), 'info', `${mode.task}: interrupting…`), effects: [{ type: 'interrupt', task: mode.task }] } : cancel();
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
    case 'help':
      return { state: toList(state), effects: [] };
  }
}

// ---- data in

export interface BoardSnapshot {
  rows: BoardRow[];
  preview: Preview | null;
  refreshedAt: string;
}

/** Keep the selection when the task is still there, otherwise take the first row. */
export function applySnapshot(state: BoardState, snap: BoardSnapshot): BoardState {
  const next: BoardState = { ...state, rows: snap.rows, refreshedAt: snap.refreshedAt, loadError: null };
  const listed = displayRows(next);
  const selected = listed.some((r) => r.task === state.selected) ? state.selected : (listed[0]?.task ?? null);
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

/** One refresh from the core: the rows (with cached progress) and the preview of the selected task. */
export async function loadBoard(ctx: Context, selected: string | null, cache: ProgressCache, previewLines: number = PREVIEW_LINES): Promise<BoardSnapshot> {
  const { runner, config } = ctx;
  const statusRows = await collectStatus(ctx, { progress: false, archived: true });
  const records = new Map([...listArchivedRecords(config), ...listTaskRecords(config)].map((r) => [r.task, r]));
  const now = runner.now();
  const rows: BoardRow[] = [];
  for (const row of statusRows) {
    const record = records.get(row.task);
    const progress = record && record.repos.length > 0 && !row.hidden ? await cache.get(runner, row.task, record.repos, now) : null;
    const worktrees = (record?.repos ?? []).filter((r) => path.resolve(r.worktree) !== path.resolve(r.path)).map((r) => r.worktree);
    rows.push({ ...row, progress, worktrees });
  }
  // The selected task; else the first one the list shows (not a hidden, closed or finished one).
  const target = rows.find((r) => r.task === selected) ?? rows.find((r) => !r.hidden && !r.finished) ?? rows.find((r) => !r.hidden) ?? rows[0];
  let preview: Preview | null = null;
  if (target) {
    let lines: string[];
    if (target.closed) lines = [`(closed${target.closedAt ? ` ${target.closedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}${target.archived ? ', archived' : ''}; the report ${target.report === 'yes' ? 'is still there: c copies it' : 'was never written'})`];
    else if (!isAlive(target)) lines = [`(finished: no tmux window${target.report === 'yes' ? `; the report is ${target.pulled ? 'pulled' : 'ready: c copies it'}` : '; no report was written'})`];
    else {
      try {
        lines = await peekWindow(ctx, target.windowName, previewLines);
      } catch (e) {
        lines = [`(cannot read the window: ${errorMessage(e)})`];
      }
    }
    preview = { task: target.task, lines };
  }
  return { rows, preview, refreshedAt: clock(now) };
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
        if (!env.insideTmux) return { level: 'error', text: `Not inside tmux: run "agentctl attach ${effect.task}".` };
        await showWindow(ctx, effect.window, true);
        return { level: 'info', text: `Switched to ${effect.task}. Back to the board: Ctrl-b l` };
      case 'send':
        await sendPrompts(ctx, [{ task: effect.task, window: effect.window, prompt: effect.text }]);
        return { level: 'info', text: `${effect.task}: prompt sent` };
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
      case 'hide':
        await setHidden(ctx, [effect.task], effect.hidden);
        return { level: 'info', text: effect.hidden ? `${effect.task}: hidden (a lists hidden tasks, h shows it again)` : `${effect.task}: shown again` };
      case 'refresh':
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

export function boardLayout(width: number): BoardLayout {
  const showPreview = width >= PREVIEW_MIN_WIDTH;
  return showPreview ? { showPreview, listWidth: LIST_WIDTH, previewWidth: width - LIST_WIDTH } : { showPreview, listWidth: width, previewWidth: 0 };
}

export interface BoardColumns {
  marker: number;
  task: number;
  who: number;
  state: number;
  time: number;
  progress: number;
  report: number;
}

/** Column widths for a list of `width` columns; the agent column takes what the others leave (8 to 18). */
export function boardColumns(width: number): BoardColumns {
  const fixed = { marker: 1, task: 10, state: 14, time: 7, progress: 8, report: 7 };
  const gaps = 6;
  const used = Object.values(fixed).reduce((a, b) => a + b, 0) + gaps;
  return { ...fixed, who: Math.max(8, Math.min(18, width - used)) };
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
  working: 'cyan',
  waiting: 'yellow',
  'needs-input': 'magenta',
  'needs-trust': 'magenta',
  limited: 'red',
  'report-ready': 'green',
  superseded: 'gray',
  orphan: 'red',
  dead: 'red',
  closed: 'gray',
};

export function headerCells(cols: BoardColumns): BoardCell[] {
  return [
    { key: 'marker', text: '', width: cols.marker },
    { key: 'task', text: 'TASK', width: cols.task },
    { key: 'who', text: 'AGENT', width: cols.who },
    { key: 'state', text: 'STATE', width: cols.state },
    { key: 'time', text: 'TIME', width: cols.time },
    { key: 'progress', text: 'PROGRESS', width: cols.progress },
    { key: 'report', text: 'REPORT', width: cols.report },
  ].map((c) => ({ ...c, dim: true }));
}

export function reportLabel(row: StatusRow): string {
  if (row.report === 'missing') return '-';
  return row.pulled ? 'pulled' : 'ready';
}

export function rowCells(row: StatusRow, selected: boolean, cols: BoardColumns, icons: Record<TaskState, string> | null = null): BoardCell[] {
  const icon = (icons ?? DEFAULT_WINDOW_ICONS)[row.state];
  // Finished and hidden tasks are dimmed: they are history, not work in progress.
  const quiet = row.finished || row.hidden;
  const cells: BoardCell[] = [
    { key: 'marker', text: selected ? '▸' : row.hidden ? '·' : '', width: cols.marker, bold: true },
    { key: 'task', text: row.task, width: cols.task, bold: selected },
    { key: 'who', text: row.agent === 'unknown' ? 'unknown' : `${row.agent} ${row.model}/${row.effort}`, width: cols.who },
    { key: 'state', text: `${icon} ${row.state}`, width: cols.state, color: STATE_COLOR[row.state] },
    { key: 'time', text: row.duration, width: cols.time },
    { key: 'progress', text: row.progress?.text ?? '-', width: cols.progress },
    { key: 'report', text: reportLabel(row), width: cols.report, ...(row.report === 'missing' ? { dim: true } : row.pulled ? {} : { color: 'green' }) },
  ];
  return quiet ? cells.map((c) => (c.key === 'marker' ? c : { ...c, dim: true, ...(c.color ? { color: 'gray' } : {}) })) : cells;
}

export type ListItem = { kind: 'row'; row: BoardRow } | { kind: 'finished'; count: number; expanded: boolean } | { kind: 'closed'; count: number };

/** `Finished (3)` title that stands between the active and the finished rows (or under the active ones while the section is closed). */
export function finishedTitle(count: number, expanded: boolean): string {
  return expanded ? `Finished (${count}) – z closes` : `Finished (${count}) – z opens`;
}

/** Title of the section of tasks closed with `agentctl close` (shown while `a` lists hidden tasks). */
export function closedTitle(count: number): string {
  return `Closed (${count}) – off the list; \`agentctl archive\` moves their state away`;
}

/** Everything the list shows, top to bottom: active rows, the "Finished" title and rows, the "Closed" title and rows. */
export function listItems(state: BoardState): ListItem[] {
  const finished = finishedRows(state);
  const closed = closedRows(state);
  return [
    ...activeRows(state).map((row): ListItem => ({ kind: 'row', row })),
    ...(finished.length > 0 ? [{ kind: 'finished', count: finished.length, expanded: state.showFinished } as ListItem] : []),
    ...(state.showFinished ? finished.map((row): ListItem => ({ kind: 'row', row })) : []),
    ...(closed.length > 0 ? [{ kind: 'closed', count: closed.length } as ListItem] : []),
    ...closed.map((row): ListItem => ({ kind: 'row', row })),
  ];
}

/** The items that fit in `capacity` lines, scrolled so that the selected row is visible. */
export function visibleItems(state: BoardState, capacity: number): { items: ListItem[]; offset: number } {
  const cap = Math.max(1, capacity);
  const all = listItems(state);
  if (all.length <= cap) return { items: all, offset: 0 };
  const index = Math.max(0, all.findIndex((i) => i.kind === 'row' && i.row.task === state.selected));
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

export const KEY_HINTS = '↑↓ ⏎ go  m msg  M move  i int  c pull  r new  x close  h hide  z done  a all  ?';

export const HELP_LINES: string[] = [
  'agentctl board',
  '',
  '  ↑ ↓ (j k)   select a task',
  '  Enter       go to the task window (tmux switch-client); back: Ctrl-b l',
  '              on a finished task (no window): a menu (c copy, x close, h hide)',
  '  m           type a message and send it to the agent (Enter sends, Esc cancels)',
  '  M           move the task to the other provider after a limit (asks first)',
  '  i           interrupt the current turn (asks first; the window stays open)',
  '  c           copy the report of the task to the clipboard',
  '  r           copy all new reports to the clipboard (pull --ready)',
  '  x           close the window (asks first; then asks about the git worktree)',
  '  h           hide the task (or show a hidden one); nothing is closed or removed',
  '  z           open or close the "Finished" section (tasks without a window)',
  '  a           list hidden tasks too (dimmed, marked ·)',
  '  q           leave the board; the agents keep running',
  '',
  'The list refreshes every 2 s. The preview of the selected window shows',
  'from 110 columns on.',
  'Press any key to go back.',
];

/** The question or the prompt of the footer for the current mode, or null in the list. */
export function promptText(state: BoardState): string | null {
  const mode = state.mode;
  if (mode.kind === 'input') return `Message to ${mode.task} (Enter sends, Esc cancels): ${mode.text}`;
  if (mode.kind === 'finished') return `${mode.task} is finished (no window): c copy report · x close · h hide${state.rows.find((r) => r.task === mode.task && isAlive(r)) ? ' · o open window' : ''} · Esc`;
  if (mode.kind !== 'confirm') return null;
  const row = state.rows.find((r) => r.task === mode.task);
  if (mode.action === 'move') return `Move ${mode.task} to the other provider? A new window starts in the same worktree; this one stays. [y/N]`;
  if (mode.action === 'interrupt') return `Interrupt ${mode.task}? Sends Escape to the agent; the window stays open. [y/N]`;
  if (mode.action === 'close' && row?.finished) return `Close ${mode.task}? It has no window; it is marked closed and leaves the list${row.report === 'missing' ? ' – WARNING: no report was written' : ''}. [y/N]`;
  if (mode.action === 'close') return `Close ${mode.task}? Kills its tmux window${row && row.report === 'missing' ? ' – WARNING: no report yet' : ''}. [y/N]`;
  return `Also remove the git worktree of ${mode.task} (git worktree remove, the branch stays)? [y/N, Esc cancels]`;
}
