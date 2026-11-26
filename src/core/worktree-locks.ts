import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';

/** Serialize reuse and integration removal of the same checkout, including alternate paths to it. */
export function withWorktreeLocks<T>(ctx: Context, paths: readonly string[], action: () => Promise<T>): Promise<T> {
  if (ctx.runner.dryRun || !paths.length) return action();
  const targets = [...new Set(paths.map(target => {
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
  }))].sort();
  const next = (i: number): Promise<T> => {
    const target = targets[i];
    if (target === undefined) return action();
    const lock = createHash('sha256').update(target).digest('hex');
    return withFileLock(path.join(ctx.config.stateDir, '.worktree-locks', lock), () => next(i + 1));
  };
  return next(0);
}
