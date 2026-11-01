import type { Runner } from './runner.ts';
import type { ResolvedRepo } from './spec.ts';

/** What one worktree has to show for the task so far. */
export interface RepoProgress {
  worktree: string;
  /** The ref the commits are counted from: the spec's `base`, else main or master; null when neither exists. */
  base: string | null;
  /** Commits on HEAD that are not in `base`; null without a base. */
  commits: number | null;
  /** Files changed since the merge base with `base`, plus files with uncommitted changes (a file counts once). */
  files: number;
}

export interface Progress {
  commits: number | null;
  files: number;
  /** "2c 7f": the sum over the worktrees; "?c 3f" when no base is known. */
  text: string;
  repos: RepoProgress[];
}

async function git(runner: Runner, worktree: string, args: string[]): Promise<{ ok: boolean; lines: string[] }> {
  const r = await runner.exec('git', ['-C', worktree, ...args], { readOnly: true });
  return { ok: r.code === 0, lines: r.stdout.split('\n').filter((l) => l !== '') };
}

async function resolveBase(runner: Runner, repo: ResolvedRepo): Promise<string | null> {
  const candidates = repo.base ? [repo.base] : ['main', 'master'];
  for (const ref of candidates) {
    if ((await git(runner, repo.worktree, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) return ref;
  }
  return null;
}

/** A path from a line of `git status --porcelain` ("XY path", renames as "XY old -> new"). */
function porcelainPath(line: string): string {
  const rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  return arrow >= 0 ? rest.slice(arrow + 4) : rest;
}

/** Commits over the base and changed files of one worktree; null when git cannot read it (the worktree is gone). */
export async function repoProgress(runner: Runner, repo: ResolvedRepo): Promise<RepoProgress | null> {
  const status = await git(runner, repo.worktree, ['status', '--porcelain']);
  if (!status.ok) return null;
  const files = new Set(status.lines.map(porcelainPath));
  const base = await resolveBase(runner, repo);
  let commits: number | null = null;
  if (base) {
    const count = await git(runner, repo.worktree, ['rev-list', '--count', `${base}..HEAD`]);
    if (count.ok && /^\d+$/.test(count.lines[0] ?? '')) commits = Number(count.lines[0]);
    // Three dots: the changes of this branch since it left the base, not the changes the base got meanwhile.
    for (const f of (await git(runner, repo.worktree, ['diff', '--name-only', `${base}...HEAD`])).lines) files.add(f);
  }
  return { worktree: repo.worktree, base, commits, files: files.size };
}

export function formatProgress(commits: number | null, files: number): string {
  return `${commits ?? '?'}c ${files}f`;
}

/** The progress of a task: the sum over its worktrees; null when none of them can be read. */
export async function taskProgress(runner: Runner, repos: ResolvedRepo[]): Promise<Progress | null> {
  const found: RepoProgress[] = [];
  for (const repo of repos) {
    const p = await repoProgress(runner, repo);
    if (p) found.push(p);
  }
  if (found.length === 0) return null;
  const known = found.filter((p) => p.commits !== null);
  const commits = known.length === found.length ? known.reduce((n, p) => n + (p.commits as number), 0) : null;
  const files = found.reduce((n, p) => n + p.files, 0);
  return { commits, files, text: formatProgress(commits, files), repos: found };
}
