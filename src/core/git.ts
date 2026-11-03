import fs from 'node:fs';
import path from 'node:path';
import type { Runner } from './runner.ts';
import type { ResolvedRepo } from './spec.ts';
import { withFileLock } from './file-lock.ts';
import { AgentctlError } from './util.ts';

/** Repository identity is the common git directory, including callers in linked worktrees. */
async function commonDir(runner: Runner, repo: ResolvedRepo): Promise<string> {
  const r = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--git-common-dir'], { readOnly: true });
  if (r.code !== 0) throw gitFailure(`cannot locate git directory of ${repo.path}`, r.stderr);
  const dir = path.resolve(repo.path, r.stdout.trim() || '.git');
  try { return fs.realpathSync(dir); } catch { return dir; }
}

/** Never reuse an arbitrary directory after a failed start. A retry may reuse only a registered worktree. */
export async function checkRetryWorktrees(runner: Runner, repos: ResolvedRepo[]): Promise<void> {
  for (const repo of repos) {
    if (!fs.existsSync(repo.worktree)) continue;
    const r = await runner.exec('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { readOnly: true });
    const listed = r.code === 0 && r.stdout.split('\n').includes(`worktree ${path.resolve(repo.worktree)}`);
    const head = await runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--show-toplevel'], { readOnly: true });
    if (!listed || head.code !== 0 || path.resolve(head.stdout.trim()) !== path.resolve(repo.worktree)) {
      throw new AgentctlError(`unsafe start residue: ${repo.worktree}`, `Inspect this directory and its git worktree registration; preserve any work, then remove only this failed start's residue before queue retry.`);
    }
  }
}

/** Serialize checkout per repository, across CLI/new and queue processes. Recover only a dead PID. */
export async function addWorktree(runner: Runner, repo: ResolvedRepo, timeoutS = 600): Promise<void> {
  const run = async (): Promise<void> => {
    const existed = fs.existsSync(repo.worktree);
    const args = ['-C', repo.path, 'worktree', 'add'];
    let createdBranch = false;
    let baseOid = '';
    if (repo.branch) {
      const exists = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${repo.branch}`], { readOnly: true, dryResult: { code: 1 } });
      if (exists.code === 0) args.push(repo.worktree, repo.branch);
      else {
        const base = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', repo.base ?? 'HEAD'], { readOnly: true });
        if (base.code === 0) baseOid = base.stdout.trim();
        // A successful explicit creation is ownership evidence; a failed -b checkout alone is not.
        if (!baseOid && !runner.dryRun) throw gitFailure(`cannot resolve base for ${repo.worktree}`, base.stderr);
        const created = await runner.exec('git', ['-C', repo.path, 'branch', repo.branch, repo.base ?? 'HEAD'], { timeoutMs: timeoutS * 1000, async: true });
        if (created.code !== 0) throw gitFailure(`cannot create branch ${repo.branch}`, created.stderr);
        createdBranch = !runner.dryRun;
        args.push(repo.worktree, repo.branch);
      }
    } else {
      args.push('--detach', repo.worktree);
      if (repo.base) args.push(repo.base);
    }
    const r = await runner.exec('git', args, { timeoutMs: timeoutS * 1000, async: true });
    if (r.code === 0) return;
    const residue: string[] = [];
    // Nonempty partial checkouts are kept: a failed checkout cannot prove who wrote their contents.
    if (!existed && !runner.dryRun && fs.existsSync(repo.worktree)) {
      const stat = fs.lstatSync(repo.worktree);
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(repo.worktree).length === 0) fs.rmdirSync(repo.worktree);
      else residue.push(`directory ${repo.worktree} (kept: contents cannot safely be attributed)`);
    }
    if (createdBranch && fs.existsSync(repo.worktree)) residue.push(`branch ${repo.branch} (kept with worktree residue)`);
    if (createdBranch && baseOid && !fs.existsSync(repo.worktree)) {
      const current = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', `refs/heads/${repo.branch}`], { readOnly: true });
      if (current.code === 0 && current.stdout.trim() === baseOid && !['main', 'master'].includes(repo.branch!)) {
        const removed = await runner.exec('git', ['-C', repo.path, 'branch', '-d', repo.branch!]);
        if (removed.code !== 0) residue.push(`branch ${repo.branch}: ${removed.stderr.trim()}`);
      } else if (current.code === 0) residue.push(`branch ${repo.branch} (kept: changed since start)`);
    }
    const listing = await runner.exec('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { readOnly: true });
    if (listing.stdout.split('\n').includes(`worktree ${path.resolve(repo.worktree)}`)) residue.push(`worktree registration ${repo.worktree}`);
    const timedOut = /ETIMEDOUT|timed? out/i.test(r.stderr);
    throw gitFailure(`git worktree add failed for ${repo.worktree}${timedOut ? ` after ${timeoutS}s (git.timeout_s)` : ''}`, r.stderr,
      `${timedOut ? 'Check disk space and I/O load; increase git.timeout_s if needed. ' : ''}${residue.length ? `Remaining: ${residue.join('; ')}. Inspect and preserve any work before removing these exact paths/registrations and retrying.` : 'No directory from this attempt remains; retry after fixing the cause.'}`);
  };
  if (runner.dryRun) return run();
  const dir = await commonDir(runner, repo);
  return withFileLock(path.join(dir, 'agentctl-start.lock'), run, timeoutS * 1000 + 60_000);
}

export function gitFailure(message: string, stderr: string, hint?: string): AgentctlError {
  const detail = stderr.trim();
  return new AgentctlError(detail ? `${message}: ${detail}` : message, hint ?? 'Fix the cause above (branch name, base ref, repo path) and run the command again.');
}
