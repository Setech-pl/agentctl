import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { gitFailure } from './git.ts';
import { collectStatus } from './status.ts';
import { readTaskRecord } from './taskstore.ts';
import { AgentctlError, Problems, windowName } from './util.ts';

export interface CloseOptions {
  rmWorktree?: boolean;
}

const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * Kill the task's tmux window; with rmWorktree also `git worktree remove` (no --force).
 * Branches are never deleted, and a worktree on main/master or the repository itself is left alone.
 */
export async function closeTask(ctx: Context, taskArg: string, opts: CloseOptions = {}): Promise<void> {
  const { runner, tmux, config } = ctx;
  const window = windowName(taskArg);
  const record = readTaskRecord(config, window);
  if (opts.rmWorktree && !record) {
    throw new AgentctlError(
      `cannot remove worktrees of ${taskArg}: no TASK.md in ${config.cache}/${window} lists them`,
      'Remove the worktree yourself with "git worktree remove <path>".',
    );
  }

  const windows = runner.dryRun ? [window] : await tmux.listWindows();
  if (windows.includes(window)) {
    await tmux.killWindow(window);
    ctx.info(`${taskArg}: window ${config.session}:${window} closed`);
  } else {
    ctx.info(`${taskArg}: no window "${window}" in session "${config.session}" (already closed)`);
  }

  if (!opts.rmWorktree || !record) return;
  for (const repo of record.repos) {
    if (path.resolve(repo.worktree) === path.resolve(repo.path)) {
      ctx.info(`${taskArg}: skipping ${repo.worktree}: it is the main checkout`);
      continue;
    }
    if (!runner.dryRun && !fs.existsSync(repo.worktree)) {
      ctx.info(`${taskArg}: worktree ${repo.worktree} is already gone`);
      continue;
    }
    const head = await runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'], { readOnly: true });
    const branch = head.stdout.trim();
    if (PROTECTED_BRANCHES.has(branch)) {
      throw new AgentctlError(
        `refusing to remove ${repo.worktree}: it has "${branch}" checked out`,
        'agentctl never touches main/master. Switch that worktree to another branch first, or remove it by hand.',
      );
    }
    const r = await runner.exec('git', ['-C', repo.path, 'worktree', 'remove', repo.worktree]);
    if (r.code !== 0) {
      throw gitFailure(
        `git worktree remove failed for ${repo.worktree}`,
        r.stderr,
        'The worktree probably has uncommitted or untracked files. Commit or stash them; agentctl never uses --force.',
      );
    }
    ctx.info(`${taskArg}: worktree ${repo.worktree} removed (branch ${branch || 'detached HEAD'} kept)`);
  }
}

export interface ClosePlanItem {
  task: string;
  /** TASK.md exists for it. */
  known: boolean;
  windowAlive: boolean;
  /** The report file is there and was written after the task started. */
  hasReport: boolean;
  /** Printable line for the confirmation list. */
  line: string;
}

/** What `close A B C` is about to do, per task. Reads only; fails for all tasks at once if a request cannot work. */
export async function planClose(ctx: Context, tasks: string[], opts: CloseOptions = {}): Promise<ClosePlanItem[]> {
  const { tmux, config, runner } = ctx;
  const unique = [...new Set(tasks.map((t) => t.toUpperCase()))];
  const live = new Set(runner.dryRun ? [] : await tmux.listWindows());
  const rows = new Map((await collectStatus(ctx)).map((r) => [r.task.toUpperCase(), r]));
  const p = new Problems();
  const items = unique.map((task): ClosePlanItem => {
    const window = windowName(task);
    const known = readTaskRecord(config, window) !== undefined;
    const hasReport = rows.get(task)?.report === 'yes';
    if (opts.rmWorktree && !known) p.add(`${task}: no TASK.md in ${config.cache}/${window} lists its worktrees`);
    const notes: string[] = [];
    if (!known) notes.push('unknown task (no TASK.md)');
    else if (!hasReport) notes.push('WARNING: no report yet');
    if (known && !live.has(window) && !runner.dryRun) notes.push('window already gone');
    return { task, known, windowAlive: live.has(window), hasReport, line: `${task}${notes.length ? `  (${notes.join('; ')})` : ''}` };
  });
  p.throwIfAny('Cannot close:', 'Remove those tasks from the list, or remove their worktrees yourself with "git worktree remove <path>".');
  return items;
}

/** Close several tasks one after another; a failure does not stop the others, it is reported at the end. */
export async function closeTasks(ctx: Context, tasks: string[], opts: CloseOptions = {}): Promise<void> {
  const failures: string[] = [];
  for (const task of tasks) {
    try {
      await closeTask(ctx, task, opts);
    } catch (e) {
      failures.push(`${task}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new AgentctlError(`${failures.length} of ${tasks.length} tasks could not be closed completely:\n${failures.map((f) => `  - ${f}`).join('\n')}`, 'The others were closed. Fix the cause and run close again for the failed ones.');
  }
}
