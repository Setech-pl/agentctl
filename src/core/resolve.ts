import type { Context } from './context.ts';
import { listTaskRecords } from './taskstore.ts';
import { AgentctlError } from './util.ts';
import { WATCH_WINDOW } from './watch.ts';
import { BOARD_WINDOW } from './board-window.ts';

/** A task agentctl can point at: it has a state file, a tmux window, or both. */
export interface TaskTarget {
  task: string;
  window: string;
  /** The tmux window exists. */
  alive: boolean;
}

export type TaskMatch = { kind: 'one'; target: TaskTarget } | { kind: 'many'; matches: TaskTarget[] } | { kind: 'none' };

/** Case-insensitive: an exact task ID wins, otherwise a prefix that fits exactly one task. */
export function matchTask(input: string, targets: TaskTarget[]): TaskMatch {
  const wanted = input.trim().toLowerCase();
  if (wanted === '') return { kind: 'none' };
  const exact = targets.find((t) => t.task.toLowerCase() === wanted || t.window.toLowerCase() === wanted);
  if (exact) return { kind: 'one', target: exact };
  const prefixed = targets.filter((t) => t.task.toLowerCase().startsWith(wanted) || t.window.toLowerCase().startsWith(wanted));
  if (prefixed.length === 1) return { kind: 'one', target: prefixed[0] as TaskTarget };
  if (prefixed.length > 1) return { kind: 'many', matches: prefixed };
  return { kind: 'none' };
}

/** Tasks with a state file plus the windows of the session that have none (orphans); windows "watch" and "board" are not tasks. */
export async function listTargets(ctx: Context): Promise<TaskTarget[]> {
  const live = new Set(await ctx.tmux.listWindows());
  const targets: TaskTarget[] = [];
  const known = new Set<string>();
  for (const record of listTaskRecords(ctx.config)) {
    known.add(record.window);
    targets.push({ task: record.task, window: record.window, alive: live.has(record.window) });
  }
  for (const window of [...live].sort()) {
    if (known.has(window) || window === WATCH_WINDOW || window === BOARD_WINDOW) continue;
    targets.push({ task: window.toUpperCase(), window, alive: true });
  }
  return targets;
}

export function describeTargets(targets: TaskTarget[]): string[] {
  return targets.map((t) => `  - ${t.task}${t.alive ? '' : ' (no window)'}`);
}

/**
 * Resolve what the user typed to one task with a live window. Case does not matter and a unique prefix is enough.
 * An ambiguous prefix is an error that lists the candidates; so is a task whose window is gone.
 */
export async function resolveRunningTask(ctx: Context, input: string): Promise<TaskTarget> {
  const targets = await listTargets(ctx);
  const running = matchTask(input, targets.filter((t) => t.alive));
  if (running.kind === 'one') return running.target;
  if (running.kind === 'many') {
    throw new AgentctlError(`"${input}" fits more than one task:\n${describeTargets(running.matches).join('\n')}`, 'Type more of the task ID.');
  }
  const any = matchTask(input, targets);
  if (any.kind === 'one') {
    throw new AgentctlError(`${any.target.task} has no tmux window in session "${ctx.config.session}"`, 'The task is closed or dead; see "agentctl status". "agentctl pull" reads its report.');
  }
  if (any.kind === 'many') {
    throw new AgentctlError(`"${input}" fits more than one task, none of them has a window:\n${describeTargets(any.matches).join('\n')}`, 'See "agentctl status".');
  }
  throw new AgentctlError(
    `no task "${input}"${targets.length ? `; known tasks:\n${describeTargets(targets).join('\n')}` : ' (no tasks at all)'}`,
    'See "agentctl status".',
  );
}
