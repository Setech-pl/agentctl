import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { checkReportPath } from './report-path.ts';
import { findAuthorRecord } from './review-gate.ts';
import type { ResolvedRepo, ResolvedSpec } from './spec.ts';
import { pendingStarts } from './start-lock.ts';
import { listTaskRecords, type TaskRecord } from './taskstore.ts';
import { AgentctlError, shellQuote } from './util.ts';
import { insidePath } from './worktree-volume.ts';

type Review = Pick<TaskRecord, 'task' | 'window' | 'reviewOf' | 'repos' | 'report' | 'reportAlt'>;

function reviewAuthor(ctx: Context, review: Pick<Review, 'task' | 'reviewOf'>): TaskRecord {
  const author = review.reviewOf && findAuthorRecord(ctx.config, review.reviewOf);
  if (!author || author.host || author.reviewMode || !author.repos.length) throw new AgentctlError(`${review.task}: readonly-on-author requires a local author task with a worktree`);
  return author;
}

export function assertReadonlyReview(ctx: Context, review: Pick<Review, 'task' | 'reviewOf' | 'report' | 'reportAlt'> & { repos: { worktree: string }[] }): TaskRecord {
  const author = reviewAuthor(ctx, review);
  const roots = author.repos.map(repo => path.resolve(repo.worktree));
  for (const file of [review.report, ...(review.reportAlt ?? [])]) {
    if (!path.isAbsolute(file) || roots.some(root => insidePath(root, file)) || path.resolve(file) === path.resolve(author.report)) {
      throw new AgentctlError(`${review.task}: readonly review must write its own report under the cache, outside the author's worktrees`);
    }
    const output = checkReportPath(ctx.config, { repos: [] }, file);
    // The report can exist already on resume. It must not be a hard link to an author file.
    if ((fs.lstatSync(output, { throwIfNoEntry: false })?.nlink ?? 0) > 1) throw new AgentctlError(`${review.task}: report path is hard-linked: ${file}`);
  }
  if (review.repos.some(repo => !roots.includes(path.resolve(repo.worktree)))) throw new AgentctlError(`${review.task}: readonly review checkout does not match the author record`);
  return author;
}

export function assertAuthorStopped(ctx: Context, author: TaskRecord, live: string[]): void {
  if (live.includes(author.window) || pendingStarts(ctx.config).some(start => start.task === author.task)) {
    throw new AgentctlError(`${author.task}: author task is still running or starting`, `Close ${author.task} before starting the readonly review.`);
  }
}

/** Author starts already reserve their task ID. Check both a review's reservation and its live window. */
export async function assertCheckoutNotBorrowed(ctx: Context, task: string): Promise<void> {
  if (ctx.runner.dryRun) return;
  const reviews = listTaskRecords(ctx.config).filter(record => record.reviewMode && record.reviewOf === task || record.reuseWorktree === task && !record.closed && !record.cancelled);
  const reserved = pendingStarts(ctx.config).find(start => start.reuseWorktree === task);
  if (reserved) throw new AgentctlError(`${task}: task ${reserved.task} is starting in the worktree`);
  if (!reviews.length) return;
  const pending = new Set(pendingStarts(ctx.config).map(start => start.window));
  const live = reviews.some(review => review.host) ? await ctx.tmux.listWindows() : await ctx.localTmux.listWindows();
  const borrower = reviews.find(review => pending.has(review.window) || live.includes(review.window));
  if (borrower) throw new AgentctlError(`${task}: readonly review ${borrower.task} is using the author worktree`, `Close ${borrower.task} before using the worktree.`);
}

export async function readonlyReviewRepos(ctx: Context, spec: ResolvedSpec): Promise<ResolvedRepo[]> {
  const author = reviewAuthor(ctx, spec);
  const repos = spec.repos.map(repo => {
    const source = author.repos.find(item => path.resolve(item.path) === path.resolve(repo.path));
    if (!source || path.resolve(source.path) === path.resolve(source.worktree)) throw new AgentctlError(`${spec.task}: no author worktree for ${repo.path}`);
    return source;
  });
  assertReadonlyReview(ctx, { ...spec, repos });
  if (!ctx.runner.dryRun) {
    assertAuthorStopped(ctx, author, await ctx.localTmux.listWindows());
    for (const repo of repos) {
      const top = await ctx.runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--show-toplevel'], { readOnly: true });
      if (top.code !== 0 || path.resolve(top.stdout.trim()) !== path.resolve(repo.worktree)) throw new AgentctlError(`${spec.task}: author worktree is missing or changed: ${repo.worktree}`);
    }
  }
  return repos;
}

export const readonlyReviewEvidence = (ctx: Context, window: string): string => path.join(ctx.config.cache, window, 'evidence');

/** Command-scoped hooks leave the author's Git configuration usable before and after the agent process. */
export async function readonlyReviewEnvironment(ctx: Context, review: Review, env: Record<string, string>): Promise<Record<string, string>> {
  const evidence = readonlyReviewEvidence(ctx, review.window);
  const hooks = path.join(evidence, 'hooks');
  const refused = checkReportPath(ctx.config, { repos: [] }, path.join(evidence, 'git-refused.log'));
  for (const name of ['pre-commit', 'prepare-commit-msg', 'pre-merge-commit', 'pre-push']) {
    const file = checkReportPath(ctx.config, { repos: [] }, path.join(hooks, name));
    const existing = fs.lstatSync(file, { throwIfNoEntry: false });
    if (existing && (!existing.isFile() || existing.nlink > 1)) throw new AgentctlError(`Invalid readonly review hook: ${file}`);
    await ctx.runner.writeFile(file, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(name)} >> ${shellQuote(refused)}\necho 'agentctl readonly review: Git write refused' >&2\nexit 1\n`);
    const chmod = await ctx.runner.exec('chmod', ['0700', file]);
    if (chmod.code !== 0) throw new AgentctlError(`Cannot protect readonly review hook: ${file}`);
  }
  const count = Number(env.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? '0');
  if (!Number.isSafeInteger(count) || count < 0 || count >= 1000) throw new AgentctlError('Invalid GIT_CONFIG_COUNT for readonly review');
  return { ...env, AGENTCTL_REVIEW_EVIDENCE: evidence, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${count}`]: hooks };
}
