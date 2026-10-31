import type { Runner } from './runner.ts';
import type { ResolvedRepo } from './spec.ts';
import { AgentctlError } from './util.ts';

/**
 * Create a worktree. agentctl only ever runs `git worktree add|remove`:
 * never merge, rebase, push, branch deletion or --force.
 *
 * - branch given and new:      git worktree add -b <branch> <path> [<base>]
 * - branch given and existing: git worktree add <path> <branch>
 * - no branch:                 git worktree add --detach <path> [<base>]
 *   (detached, so a base such as `main` that is checked out elsewhere does not clash)
 */
export async function addWorktree(runner: Runner, repo: ResolvedRepo): Promise<void> {
  const args = ['-C', repo.path, 'worktree', 'add'];
  if (repo.branch) {
    const exists = await runner.exec(
      'git',
      ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${repo.branch}`],
      { readOnly: true, dryResult: { code: 1 } },
    );
    if (exists.code === 0) args.push(repo.worktree, repo.branch);
    else {
      args.push('-b', repo.branch, repo.worktree);
      if (repo.base) args.push(repo.base);
    }
  } else {
    args.push('--detach', repo.worktree);
    if (repo.base) args.push(repo.base);
  }
  const r = await runner.exec('git', args);
  if (r.code !== 0) throw gitFailure(`git worktree add failed for ${repo.worktree}`, r.stderr);
}

export function gitFailure(message: string, stderr: string, hint?: string): AgentctlError {
  const detail = stderr.trim();
  return new AgentctlError(detail ? `${message}: ${detail}` : message, hint ?? 'Fix the cause above (branch name, base ref, repo path) and run the command again.');
}
