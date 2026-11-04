import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { AutoReviewSource, RawSpec, ResolvedRepo } from './spec.ts';
import type { StatusRow } from './status.ts';
import type { TaskRecord } from './taskstore.ts';
import { readTaskRecord } from './taskstore.ts';
import { withFileLock } from './file-lock.ts';
import { loadProjectConfig } from './config.ts';
import { fillPlaceholders, resolvePath, windowName } from './util.ts';

/*
 * An automatic review reads the author's finished work. It starts only when the author's turn is really over, and it runs in its own
 * checkout (detached at the author's commit), so it never shares a worktree, an index or a branch with the author.
 */

const BUSY_STATES = new Set(['working', 'background', 'limited', 'overloaded', 'needs-trust']);

/** Why the review of `entry` must wait for its author; undefined when the author is quiet (or gone) and the review may start. */
export function authorWaitReason(autoReview: AutoReviewSource | undefined, rows: StatusRow[], settleS: number, nowMs: number): string | undefined {
  if (!autoReview) return undefined;
  const author = rows.find((r) => r.task === autoReview.author);
  // No window left, closed or cancelled: nobody can change the work any more.
  if (!author || author.window !== 'alive' || author.closed || author.cancelled) return undefined;
  const why: string[] = [];
  if (BUSY_STATES.has(author.state)) why.push(`stan ${author.state}`);
  if ((author.promptQueue?.length ?? 0) > 0) why.push(`follow-up w kolejce (${author.promptQueue!.length})`);
  if (author.promptDelivery && author.promptDelivery !== 'sent') why.push(`wiadomość niepotwierdzona (${author.promptDelivery})`);
  if (author.draft_input) why.push('szkic w polu wpisywania');
  if (author.report !== 'yes') why.push('raport bez report-end');
  else {
    try {
      const age = nowMs - fs.statSync(author.reportPath).mtimeMs;
      if (settleS > 0 && age < settleS * 1000) why.push(`raport ustala się (${Math.ceil(settleS - age / 1000)} s)`);
    } catch { /* the report is gone: the fields above decide */ }
  }
  return why.length > 0 ? `czeka na autora ${autoReview.author}: ${why.join('; ')}` : undefined;
}

export function sameDelta(heads: Record<string, string>, bases: Record<string, string>): string {
  return Object.keys(heads).map((p) => `${path.basename(p)}: ${bases[p] ?? '?'}..${heads[p]}`).join(', ');
}

/** The review's own checkout of an author repository: <worktree_root>/<repo>-<task-rev>, else next to the author's checkout. */
export function reviewWorktree(ctx: Context, repoPath: string, authorWorktree: string, task: string): string {
  let root = ctx.config.worktreeRoot;
  try { root = loadProjectConfig(resolvePath(repoPath))?.worktreeRoot ?? root; } catch { /* a broken project config fails the spec later, with its own message */ }
  const dir = root ? resolvePath(fillPlaceholders(root, { task, cache: ctx.config.cache })) : path.dirname(authorWorktree);
  return path.join(dir, `${path.basename(repoPath)}-${windowName(task)}`);
}

export interface RepinResult { raw: RawSpec; autoReview: AutoReviewSource; reuse: boolean; changed: boolean; reason?: string }

/**
 * Before the review starts: make sure it reads the author's current commit in a checkout of its own. A newer author commit moves the
 * pin (spec base, delta text, heads). An entry written by 0.17.4 before this fix (author's worktree and branch, reuse) is converted to
 * the new layout. `head` resolves the author's branch tip; undefined result: nothing to do.
 */
export async function repinReview(ctx: Context, raw: RawSpec, autoReview: AutoReviewSource, reuse: boolean, head: (repoPath: string, branch: string) => Promise<string | undefined>): Promise<RepinResult | undefined> {
  const author: TaskRecord | undefined = readTaskRecord(ctx.config, windowName(autoReview.author));
  if (!author) return undefined;
  const repos = Array.isArray(raw.header.repos) ? (raw.header.repos as Record<string, unknown>[]) : [];
  const shares = (r: Record<string, unknown>): boolean => Boolean(r.branch) || author.repos.some((a: ResolvedRepo) => a.worktree === r.worktree);
  const legacy = repos.some(shares);
  const heads = { ...autoReview.heads }, bases = { ...(autoReview.bases ?? {}) };
  for (const r of repos) if (legacy && typeof r.path === 'string' && typeof r.base === 'string' && bases[r.path] === undefined) bases[r.path] = r.base;
  let moved = false;
  for (const a of author.repos) {
    if (!a.branch) continue;
    const now = await head(a.path, a.branch);
    if (now && heads[a.path] && now !== heads[a.path]) { heads[a.path] = now; moved = true; }
  }
  if (!legacy && !moved) return undefined;
  const nextRepos = repos.map((r) => {
    const p = r.path as string;
    const { branch: _branch, worktree, ...rest } = r;
    // A legacy entry pointed at the author's checkout: drop it, the review gets its own.
    const own = legacy && author.repos.some((a: ResolvedRepo) => a.worktree === worktree) ? reviewWorktree(ctx, p, worktree as string, String(raw.header.task)) : worktree;
    return { ...rest, ...(own ? { worktree: own } : {}), base: heads[p] ?? r.base };
  });
  const delta = sameDelta(heads, bases);
  const prompt = autoReview.delta && raw.prompt.includes(autoReview.delta) ? raw.prompt.split(autoReview.delta).join(delta) : raw.prompt;
  return {
    raw: { ...raw, header: { ...raw.header, repos: nextRepos }, prompt },
    autoReview: { ...autoReview, heads, bases, delta },
    reuse: legacy ? false : reuse,
    changed: true,
    reason: legacy ? 'przegląd przeniesiony do własnego checkoutu' : 'autor dodał commit: przegląd przypięty do nowego SHA',
  };
}

/** Another process is changing the author's checkout right now (a git command, or a stale index.lock). */
export async function authorCheckoutBusy(ctx: Context, authorTask: string): Promise<string | undefined> {
  const author = readTaskRecord(ctx.config, windowName(authorTask));
  if (!author || ctx.runner.dryRun) return undefined;
  const ps = await ctx.runner.exec('ps', ['-axo', 'pid=,args='], { readOnly: true });
  for (const repo of author.repos) {
    if (!fs.existsSync(repo.worktree)) continue;
    const lock = await ctx.runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--git-path', 'index.lock'], { readOnly: true });
    if (lock.code === 0 && lock.stdout.trim() && fs.existsSync(path.resolve(repo.worktree, lock.stdout.trim()))) return `index.lock w ${repo.worktree}`;
    if (ps.code !== 0) continue;
    for (const line of ps.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!m || !/(?:^|[\s/])git(?:\s|$)/.test(m[2]!) || !m[2]!.includes(repo.worktree)) continue;
      return `proces git w ${repo.worktree}`;
    }
  }
  return undefined;
}

/** The ledger of automatic reviews follows a re-pinned review, so that the next review's delta starts at the commit this one read. */
export async function syncReviewLedger(ctx: Context, authorTask: string, task: string, heads: Record<string, string>): Promise<void> {
  const file = path.join(path.dirname(ctx.config.path), 'auto-reviews.json');
  await withFileLock(`${file}.lock`, async () => {
    let state: Record<string, { hash: string; task: string; heads: Record<string, string> }[]> = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
    const run = state[authorTask]?.find((r) => r.task === task);
    if (!run) return;
    run.heads = heads;
    await ctx.runner.writeFile(file, JSON.stringify(state));
  });
}
