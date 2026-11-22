import path from 'node:path';
import type { Context } from './context.ts';
import { findAuthorRecord } from './review-gate.ts';
import type { ResolvedRepo, ResolvedSpec } from './spec.ts';
import { AgentctlError } from './util.ts';

export const INTEGRATION_BRANCHES = ['main', 'master'] as const;
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function git(ctx: Context, repo: string, args: string[], write = false) {
  return ctx.runner.exec('git', ['-C', repo, ...args], { readOnly: !write, async: true, timeoutMs: ctx.config.git.timeoutS * 1000 });
}

export async function commitAt(ctx: Context, repo: string, ref: string): Promise<string | undefined> {
  const result = await git(ctx, repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const commit = result.stdout.trim();
  return result.code === 0 && oid.test(commit) ? commit : undefined;
}

export async function localIntegrationBase(ctx: Context, repo: string): Promise<{ branch: string; commit: string } | undefined> {
  const preferred = await git(ctx, repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const branch = preferred.stdout.trim().replace(/^origin\//, '');
  const options = INTEGRATION_BRANCHES.filter(name => name === branch);
  if (!options.length) {
    const head = await git(ctx, repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    options.push(...INTEGRATION_BRANCHES.filter(name => name === head.stdout.trim()));
  }
  for (const name of new Set([...options, ...INTEGRATION_BRANCHES])) {
    const commit = await commitAt(ctx, repo, `refs/heads/${name}`);
    if (commit) return { branch: name, commit };
  }
  return undefined;
}

export class ReviewBlocked extends AgentctlError {
  readonly task: string;
  readonly retryOnUpdate: boolean;

  constructor(task: string, reason: string, retryOnUpdate = false) {
    super(`${task}: BLOCKED – ${reason}`, retryOnUpdate ? 'Update the reviewed branch with the local base; watch will recheck queued reviews.' : 'Resolve the review conflict and retry.');
    this.task = task;
    this.retryOnUpdate = retryOnUpdate;
  }
}

interface ReviewedHead {
  repo: ResolvedRepo;
  task: string;
  head: string;
  base: { branch: string; commit: string };
  stale: boolean;
}

async function reviewedHeads(ctx: Context, spec: ResolvedSpec): Promise<ReviewedHead[]> {
  const checks: ReviewedHead[] = [];
  for (const task of spec.reviewOfAll ?? (spec.reviewOf ? [spec.reviewOf] : [])) {
    const author = findAuthorRecord(ctx.config, task);
    if (!author || author.host) throw new AgentctlError(`${spec.task}: cannot find a local author for ${task}`);
    for (const repo of spec.repos) {
      const source = author.repos.find(item => path.resolve(item.path) === path.resolve(repo.path));
      if (!source) continue;
      const base = await localIntegrationBase(ctx, repo.path);
      const pinned = spec.autoReview?.heads[repo.path];
      const localBranch = !spec.reviewMode && source.branch ? `refs/heads/${source.branch}` : undefined;
      const head = await commitAt(ctx, localBranch || pinned ? repo.path : source.worktree, pinned ?? localBranch ?? 'HEAD');
      if (!base || !head) throw new AgentctlError(`${spec.task}: cannot resolve ${task} and local main/master in ${repo.path}`);
      const ancestry = await git(ctx, repo.path, ['merge-base', '--is-ancestor', base.commit, head]);
      if (ancestry.code > 1 || ancestry.code < 0) throw new AgentctlError(`${spec.task}: cannot inspect ancestry in ${repo.path}: ${ancestry.stderr.trim()}`);
      checks.push({ repo, task, head, base, stale: ancestry.code === 1 });
    }
  }
  if (spec.repos.some(repo => !checks.some(item => item.repo === repo))) throw new AgentctlError(`${spec.task}: no reviewed task records a matching repository for merge_base_check`);
  return checks;
}

export async function assertReviewBase(ctx: Context, spec: ResolvedSpec): Promise<ResolvedSpec> {
  if (!spec.mergeBaseCheck || ctx.runner.dryRun) return spec;
  const checks = await reviewedHeads(ctx, spec);
  const stale = checks.filter(item => item.stale);
  const reason = stale.map(({ task, repo, base }) => `${task} in ${path.basename(repo.path)} lacks local ${base.branch} ${base.commit.slice(0, 12)}`).join('; ');
  if (reason && spec.mergeBaseCheck === 'block') throw new ReviewBlocked(spec.task, reason, true);
  if (spec.mergeBaseCheck === 'candidate') {
    const repos = [];
    for (const check of checks) repos.push(await candidateRepo(ctx, spec.task, check));
    return { ...spec, repos, prompt: `Review the local merge candidate on review/${spec.task}.\n\n${spec.prompt}` };
  }
  const repos = spec.repos.map(repo => {
    const matches = checks.filter(item => item.repo === repo);
    return !spec.reviewMode && !repo.base && !repo.branch && matches.length === 1 ? { ...repo, base: matches[0]!.head } : repo;
  });
  return { ...spec, repos, ...(reason ? { reviewFreshness: `Review freshness warning: ${reason}` } : {}) };
}

async function candidateRepo(ctx: Context, task: string, { repo, head, base, stale }: ReviewedHead): Promise<ResolvedRepo> {
  const branch = `review/${task}`;
  const existing = await commitAt(ctx, repo.path, `refs/heads/${branch}`);
  const finish = (commit: string) => {
    if (existing && existing !== commit) throw new ReviewBlocked(task, `local ${branch} already points elsewhere in ${repo.path}`);
    return { ...repo, branch, base: commit };
  };
  if (!stale) return finish(head);
  // Write the merge result to Git's object database before touching any worktree or branch.
  const merge = await git(ctx, repo.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', head, base.commit], true);
  const [tree, ...paths] = merge.stdout.trimEnd().split('\0');
  if (merge.code === 1) throw new ReviewBlocked(task, `merge conflicts in ${path.basename(repo.path)}: ${paths.filter(Boolean).map(file => JSON.stringify(file)).join(', ') || 'unknown paths'}`);
  if (merge.code !== 0 || !tree || !oid.test(tree)) throw new ReviewBlocked(task, `cannot construct merge candidate in ${repo.path}: ${merge.stderr.trim() || 'git merge-tree failed'}`);
  if (existing) {
    const result = await git(ctx, repo.path, ['show', '-s', '--format=%T %P', existing]);
    if (result.code === 0 && result.stdout.trim() === `${tree} ${head} ${base.commit}`) return finish(existing);
    throw new ReviewBlocked(task, `local ${branch} already points to a different candidate in ${repo.path}; choose a new task ID`);
  }
  const result = await git(ctx, repo.path, ['-c', 'user.name=agentctl', '-c', 'user.email=agentctl@localhost', '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', head, '-p', base.commit, '-m', `Review ${task} against ${base.branch}`], true);
  const commit = result.stdout.trim();
  if (result.code !== 0 || !oid.test(commit)) throw new ReviewBlocked(task, `cannot commit candidate for ${repo.path}: ${result.stderr.trim()}`);
  return finish(commit);
}

export async function assertCandidateCheckout(ctx: Context, task: string, repo: ResolvedRepo): Promise<void> {
  if (ctx.runner.dryRun) return;
  const head = await git(ctx, repo.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const clean = await git(ctx, repo.worktree, ['status', '--porcelain', '--untracked-files=normal']);
  if (head.code !== 0 || head.stdout.trim() !== repo.branch || await commitAt(ctx, repo.worktree, 'HEAD') !== repo.base || clean.code !== 0 || clean.stdout) {
    throw new ReviewBlocked(task, `review candidate checkout is dirty or changed: ${repo.worktree}`);
  }
}
