import fs from 'node:fs';
import path from 'node:path';
import type { Context } from '../context.ts';
import { gitFailure } from '../git.ts';
import { readTaskRecord } from '../taskstore.ts';
import { AgentctlError, windowName } from '../util.ts';

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
