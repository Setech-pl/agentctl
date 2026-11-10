import { worktreeCacheFreed } from './worktree-cache.ts';
import { lastMeasurement } from './fs-measure.ts';
import { restoreDiskMeasurements } from './disk.ts';
import { inspectReport } from './report-state.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { gitFailure } from './git.ts';
import { recordEvent } from './history.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
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
      `cannot remove worktrees of ${taskArg}: no TASK.md in ${config.stateDir}/${window} lists them`,
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

  // The window is gone: the task is closed, whether or not the worktree can be removed below. The state and the report stay.
  if (record) {
    await setHeaderFields(runner, taskFile(config, window), { closed: true, closed_at: new Date(runner.now()).toISOString() });
    // Before the worktree goes: the progress is read from it.
    const closed = readTaskRecord(config, window);
    if (closed) await recordEvent(ctx, closed, 'closed');
  }

  if (record) {
    const cacheFreed = worktreeCacheFreed(ctx, record);
    if (cacheFreed > 0) ctx.info(`${taskArg}: .cache cleanup: ${cacheFreed} bytes freed in total`);
    restoreDiskMeasurements(ctx);
    const sizes = [...new Set(record.repos.filter(r => path.resolve(r.worktree) !== path.resolve(r.path)).map(r => r.worktree))].map(wt => lastMeasurement(wt));
    if (sizes.length && sizes.every(n => n !== undefined)) {
      const bytes = sizes.reduce((sum, n) => sum + n!.bytes, 0);
      const age = Math.max(0, Math.floor((runner.now() - Math.min(...sizes.map(n => n!.at))) / 1000));
      ctx.info(`${taskArg}: worktree size: ${bytes} bytes (watch reading, ${age} s old)${opts.rmWorktree ? ' before removal' : ' retained; inspect agentctl gc --preview'}`);
    }
  }
  if (!opts.rmWorktree || !record) return;
  await removeWorktrees(ctx, taskArg, record.repos);
}

/** `git worktree remove` (never --force) for each worktree of a task. The main checkout, main/master and missing worktrees are left alone; branches are never deleted. */
export async function removeWorktrees(ctx: Context, taskArg: string, repos: TaskRecord['repos']): Promise<void> {
  const { runner } = ctx;
  for (const repo of repos) {
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
    const r = await runner.exec('git', ['-C', repo.path, 'worktree', 'remove', repo.worktree], { timeoutMs: ctx.config.git.timeoutS * 1000 });
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
  const p = new Problems();
  const items = unique.map((task): ClosePlanItem => {
    const window = windowName(task);
    const record = readTaskRecord(config, window);
    const known = record !== undefined;
    const hasReport = record ? inspectReport(config, record, runner.now(), !record.attemptId && !live.has(window)).ready : false;
    if (opts.rmWorktree && !known) p.add(`${task}: no TASK.md in ${config.stateDir}/${window} lists its worktrees`);
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
