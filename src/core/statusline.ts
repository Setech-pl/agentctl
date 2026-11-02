import type { Context } from './context.ts';
import { DEFAULT_WINDOW_ICONS } from './icons.ts';
import type { StatusRow } from './status.ts';
import { collectStatus, shownRows } from './status.ts';
import { readQueue } from './queue.ts';
import { openReader, readPlans } from './usage.ts';
import { planStatusLine } from './usage-report.ts';
import type { TaskState } from './state.ts';

/** The queue in the line: "3⧗" is three tasks waiting for a free window or for another task. */
export const QUEUE_ICON = '⧗';

/** Seconds between two runs of the status command in tmux. */
export const STATUS_INTERVAL = 10;

/** Left to right in the tmux status line: running work first, then what waits for you. */
const LINE_ORDER: TaskState[][] = [['working', 'background'], ['waiting'], ['report-ready'], ['needs-input'], ['needs-trust'], ['limited'], ['orphan', 'dead']];

/**
 * One short line for the tmux status bar: "2⚙ 1✓ 1? 3⧗" (the last one: tasks in the queue), then the plans "C 62% · X 18%" (usage.status_line). The count of tasks per state, zero counts left out; reports that were
 * already pulled do not count as ✓ (nothing is left to do with them). Empty when there is nothing to show.
 */
export function tmuxLine(rows: StatusRow[], icons: Record<TaskState, string> | null, queued = 0, plan = ''): string {
  const set = icons ?? DEFAULT_WINDOW_ICONS;
  const parts: string[] = [];
  for (const states of LINE_ORDER) {
    const count = rows.filter((r) => states.includes(r.state) && !(r.state === 'report-ready' && r.pulled !== null)).length;
    if (count > 0) parts.push(`${count}${set[states[0] as TaskState]}`);
  }
  if (queued > 0) parts.push(`${queued}${QUEUE_ICON}`);
  const tasks = parts.join(' ');
  return tasks !== '' && plan !== '' ? `${tasks} │ ${plan}` : `${tasks}${plan}`;
}

export async function statusTmuxLine(ctx: Context): Promise<string> {
  // Waiting and starting entries count; a failed one is waiting for a human, not for a window.
  const queued = readQueue(ctx.config).filter((e) => e.status !== 'failed').length;
  let plan = '';
  if (ctx.config.usage.statusLine) {
    const reader = openReader(ctx.config);
    plan = planStatusLine(readPlans(ctx.config, reader, ctx.runner.now()));
    reader.save();
  }
  return tmuxLine(shownRows(await collectStatus(ctx, { progress: false }), false), ctx.config.watch.windowIcons, queued, plan);
}

/**
 * `status-right` value that runs `command` every status-interval. `%` (strftime) and `#` (formats) are escaped; a command
 * with unbalanced parentheses cannot be put inside `#( )` and gives undefined.
 */
export function statusRightFormat(command: string): string | undefined {
  let depth = 0;
  for (const ch of command) {
    if (ch === '(') depth++;
    if (ch === ')' && --depth < 0) return undefined;
  }
  if (depth !== 0) return undefined;
  return `#(${command.replace(/#/g, '##').replace(/%/g, '%%')})`;
}

export type StatusLineResult = 'set' | 'no-session' | 'unsupported-command' | { failed: string };

/** Show the line in the status bar of the agentctl session only (session options, never `-g`). */
export async function applyStatusLine(ctx: Context, command: string): Promise<StatusLineResult> {
  const format = statusRightFormat(command);
  if (!format) return 'unsupported-command';
  if (!(await ctx.tmux.hasSession())) return 'no-session';
  for (const [option, value] of [['status-right', format], ['status-interval', String(STATUS_INTERVAL)]] as const) {
    const r = await ctx.tmux.setSessionOption(option, value);
    if (r.code !== 0) return { failed: `tmux set-option ${option}: ${r.stderr.trim() || `exit ${r.code}`}` };
  }
  return 'set';
}
