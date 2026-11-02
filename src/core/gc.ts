import fs from 'node:fs';
import path from 'node:path';
import { parseAge } from './archive.ts';
import { findCohort } from './cohort.ts';
import type { Context } from './context.ts';
import { formatBytes } from './pull.ts';
import { archiveDir, listArchivedRecords, listTaskRecords, taskDir } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, cohortKey, errorMessage } from './util.ts';

/*
 * `agentctl gc`: take back the disk space that finished tasks leave behind - their worktrees, the files next to their reports, the state
 * folders (moved to the archive) and, on request, their merged branches. A dry run unless `--apply`. It touches only what a task record
 * of agentctl names; the history, the reports (*.md) and anything it does not recognise stay. Branches go only with `git branch -d`.
 */

export type GcKind = 'worktree' | 'cache' | 'archive' | 'branch';

export interface GcItem {
  kind: GcKind;
  task: string;
  /** The worktree, the file or folder in the cache, the state folder, or `<repo>#<branch>`. */
  target: string;
  /** What is freed (0 for an archive move and for a branch). */
  bytes: number;
  detail: string;
  /** Branches: the repository to run git in. */
  repo?: string;
  branch?: string;
}

export interface GcSkip {
  task: string;
  kind: GcKind | 'worktree-foreign';
  target: string;
  reason: string;
}

export interface GcPlan {
  items: GcItem[];
  skipped: GcSkip[];
  freeBytes: number;
  olderThanMs: number;
  /** Folders of the cache that belong to no task of agentctl (not touched, not listed one by one). */
  unknownCacheDirs: number;
}

export interface GcOptions {
  /** Age of the files next to the reports before they go; default 7 days. */
  olderThan?: string | undefined;
  branches?: boolean | undefined;
  cohort?: string | undefined;
}

export const DEFAULT_OLDER_THAN = '7d';
const PROTECTED = new Set(['main', 'master']);

/** Bytes of a file or folder (links are not followed). */
export function sizeOf(target: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

/** The newest modification time (ms) of a file, or of anything inside a folder. */
export function newestMtime(target: string): number {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.mtimeMs;
  // A folder is as old as the newest thing in it (its own time only moves when an entry is added or removed).
  const names = fs.readdirSync(target);
  return names.length === 0 ? st.mtimeMs : Math.max(...names.map((name) => newestMtime(path.join(target, name))));
}

const same = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

async function git(ctx: Context, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await ctx.runner.exec('git', args, { readOnly: true });
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

interface WorktreeListing {
  path: string;
  branch: string | null;
}

async function listWorktrees(ctx: Context, repo: string): Promise<WorktreeListing[] | undefined> {
  const r = await git(ctx, ['-C', repo, 'worktree', 'list', '--porcelain']);
  if (r.code !== 0) return undefined;
  const out: WorktreeListing[] = [];
  let current: WorktreeListing | undefined;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice(9), branch: null };
      out.push(current);
    } else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}

/** What `gc` would do now. Reads (files, git), changes nothing. */
export async function planGc(ctx: Context, opts: GcOptions = {}): Promise<GcPlan> {
  const { config, runner } = ctx;
  const olderThanMs = parseAge(opts.olderThan ?? DEFAULT_OLDER_THAN);
  const cohort = opts.cohort === undefined ? undefined : findCohort(config, opts.cohort).name;
  const archived = new Set(listArchivedRecords(config).map((r) => r.window));
  const all: TaskRecord[] = [...listTaskRecords(config), ...listArchivedRecords(config).filter((r) => !listTaskRecords(config).some((x) => x.window === r.window))];
  const live = new Set(await ctx.tmux.listWindows());
  const finished = (r: TaskRecord): boolean => (r.closed === true || r.cancelled === true || archived.has(r.window)) && !live.has(r.window);
  const items: GcItem[] = [];
  const skipped: GcSkip[] = [];
  const mine = all.filter((r) => finished(r) && (cohort === undefined || (r.cohort !== undefined && cohortKey(r.cohort) === cohortKey(cohort))));
  const others = all.filter((r) => !finished(r));
  const removing = new Set<string>();
  const seenWorktrees = new Set<string>();
  const listings = new Map<string, WorktreeListing[] | undefined>();
  const listingOf = async (repo: string): Promise<WorktreeListing[] | undefined> => {
    if (!listings.has(repo)) listings.set(repo, await listWorktrees(ctx, repo));
    return listings.get(repo);
  };

  // 1. worktrees
  for (const record of mine) {
    for (const repo of record.repos) {
      const wt = repo.worktree;
      if (same(wt, repo.path)) continue; // the main checkout is never a candidate
      if (!fs.existsSync(wt)) continue;
      const key = path.resolve(wt);
      if (seenWorktrees.has(key)) continue;
      seenWorktrees.add(key);
      const user = others.find((o) => o.repos.some((x) => same(x.worktree, wt)));
      if (user) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, reason: `also used by ${user.task}, which is not finished` });
        continue;
      }
      const head = await git(ctx, ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
      if (PROTECTED.has(head.out)) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, reason: `has ${head.out} checked out` });
        continue;
      }
      const status = await git(ctx, ['-C', wt, 'status', '--porcelain']);
      if (status.code !== 0) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, reason: `git does not answer (${status.err.split('\n')[0] || `exit ${status.code}`})` });
        continue;
      }
      if (status.out !== '') {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, reason: `uncommitted changes (${status.out.split('\n').length} file${status.out.split('\n').length === 1 ? '' : 's'})` });
        continue;
      }
      const bytes = sizeOf(wt);
      items.push({ kind: 'worktree', task: record.task, target: wt, bytes, detail: `${record.cancelled ? 'cancelled' : 'closed'} task, no uncommitted changes`, repo: repo.path });
      removing.add(key);
    }
  }

  // worktrees nobody of agentctl owns: only said, never removed
  const repos = [...new Set(all.flatMap((r) => r.repos.map((x) => path.resolve(x.path))))];
  const known = new Set(all.flatMap((r) => r.repos.map((x) => path.resolve(x.worktree))));
  for (const repo of repos) {
    for (const wt of (await listingOf(repo)) ?? []) {
      const p = path.resolve(wt.path);
      if (p === repo || known.has(p)) continue;
      skipped.push({ task: '-', kind: 'worktree-foreign', target: wt.path, reason: 'not a worktree of an agentctl task' });
    }
  }

  // 2. what lies next to the reports (the *.md stay)
  const cacheRoot = path.resolve(config.cache);
  const seenCache = new Set<string>();
  for (const record of mine) {
    const dir = record.report ? path.dirname(path.resolve(record.report)) : path.join(cacheRoot, record.window);
    if (dir === cacheRoot || !dir.startsWith(`${cacheRoot}${path.sep}`) || seenCache.has(dir)) continue;
    seenCache.add(dir);
    const shared = others.find((o) => o.report && path.dirname(path.resolve(o.report)) === dir);
    if (shared) {
      skipped.push({ task: record.task, kind: 'cache', target: dir, reason: `also the folder of ${shared.task}, which is not finished` });
      continue;
    }
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (/\.md$/i.test(name)) continue;
      const target = path.join(dir, name);
      const age = runner.now() - newestMtime(target);
      if (age < olderThanMs) {
        skipped.push({ task: record.task, kind: 'cache', target, reason: `newer than ${opts.olderThan ?? DEFAULT_OLDER_THAN}` });
        continue;
      }
      items.push({ kind: 'cache', task: record.task, target, bytes: sizeOf(target), detail: `older than ${opts.olderThan ?? DEFAULT_OLDER_THAN}, no active task` });
    }
  }
  const taskNames = new Set(all.map((r) => r.window));
  let unknownCacheDirs = 0;
  try {
    for (const name of fs.readdirSync(cacheRoot)) {
      if (!taskNames.has(name) && fs.statSync(path.join(cacheRoot, name)).isDirectory()) unknownCacheDirs++;
    }
  } catch {
    // no cache folder yet
  }

  // 3. state of closed tasks -> archive
  for (const record of mine) {
    if (!record.closed || archived.has(record.window)) continue;
    const dir = taskDir(config, record.window);
    if (fs.existsSync(path.join(archiveDir(config), record.window))) {
      skipped.push({ task: record.task, kind: 'archive', target: dir, reason: 'the archive already has a folder of that name' });
      continue;
    }
    items.push({ kind: 'archive', task: record.task, target: dir, bytes: 0, detail: `state moved to ${archiveDir(config)} (history and the report stay)` });
  }

  // 4. merged branches
  if (opts.branches) {
    for (const record of mine) {
      for (const repo of record.repos) {
        const branch = repo.branch;
        if (!branch) continue;
        const target = `${repo.path}#${branch}`;
        const skip = (reason: string): void => void skipped.push({ task: record.task, kind: 'branch', target, reason });
        if (PROTECTED.has(branch)) {
          skip('main/master are never deleted');
          continue;
        }
        if ((await git(ctx, ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code !== 0) continue; // already gone
        const current = (await git(ctx, ['-C', repo.path, 'rev-parse', '--abbrev-ref', 'HEAD'])).out;
        if (branch === current) {
          skip('it is the current branch of the repository');
          continue;
        }
        const base = repo.base && repo.base !== branch ? repo.base : current;
        if (!base || base === 'HEAD') {
          skip('no base branch to compare with');
          continue;
        }
        const usedBy = others.find((o) => o.repos.some((x) => x.branch === branch && same(x.path, repo.path)));
        if (usedBy) {
          skip(`also the branch of ${usedBy.task}, which is not finished`);
          continue;
        }
        const checkedOut = ((await listingOf(path.resolve(repo.path))) ?? []).find((w) => w.branch === branch && !removing.has(path.resolve(w.path)));
        if (checkedOut) {
          skip(`checked out in ${checkedOut.path}`);
          continue;
        }
        const merged = await git(ctx, ['-C', repo.path, 'merge-base', '--is-ancestor', branch, base]);
        if (merged.code !== 0) {
          skip(`not merged into ${base}`);
          continue;
        }
        items.push({ kind: 'branch', task: record.task, target, bytes: 0, detail: `merged into ${base}; git branch -d`, repo: repo.path, branch });
      }
    }
  }

  const freeBytes = items.reduce((n, i) => n + i.bytes, 0);
  return { items, skipped, freeBytes, olderThanMs, unknownCacheDirs };
}

export interface GcResult {
  done: GcItem[];
  failed: { item: GcItem; reason: string }[];
  freedBytes: number;
}

/** Do the plan: worktrees (`git worktree remove`, never forced), cache entries, archive moves, then branches (`git branch -d`, never -D). */
export async function applyGc(ctx: Context, plan: GcPlan): Promise<GcResult> {
  const { runner, config } = ctx;
  const result: GcResult = { done: [], failed: [], freedBytes: 0 };
  const order: GcKind[] = ['worktree', 'cache', 'archive', 'branch'];
  for (const kind of order) {
    for (const item of plan.items.filter((i) => i.kind === kind)) {
      try {
        if (kind === 'worktree') {
          const r = await runner.exec('git', ['-C', item.repo as string, 'worktree', 'remove', item.target]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        } else if (kind === 'cache') {
          await runner.remove(item.target);
        } else if (kind === 'archive') {
          await runner.rename(item.target, path.join(archiveDir(config), path.basename(item.target)));
        } else {
          const r = await runner.exec('git', ['-C', item.repo as string, 'branch', '-d', item.branch as string]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        }
        result.done.push(item);
        result.freedBytes += item.bytes;
      } catch (e) {
        result.failed.push({ item, reason: errorMessage(e) });
      }
    }
  }
  return result;
}

const KIND_WORD: Record<GcKind, string> = { worktree: 'worktree', cache: 'cache', archive: 'archive', branch: 'branch' };

export function renderGc(plan: GcPlan, opts: { applied?: GcResult | undefined } = {}): string[] {
  const lines: string[] = [];
  if (plan.items.length === 0) lines.push('Nothing to clean up.');
  else {
    lines.push(opts.applied ? 'Cleaned up:' : 'Would clean up (a dry run; --apply does it, after a y/N):');
    for (const i of plan.items) lines.push(`  ${KIND_WORD[i.kind].padEnd(8)} ${i.task.padEnd(12)} ${i.target}${i.bytes > 0 ? `  ${formatBytes(i.bytes)}` : ''}  (${i.detail})`);
  }
  if (plan.skipped.length > 0) {
    lines.push('Skipped (reason):');
    for (const s of plan.skipped) lines.push(`  ${s.kind === 'worktree-foreign' ? 'worktree' : s.kind.padEnd(8)} ${s.task.padEnd(12)} ${s.target}  (${s.reason})`);
  }
  if (plan.unknownCacheDirs > 0) lines.push(`${plan.unknownCacheDirs} folder${plan.unknownCacheDirs === 1 ? '' : 's'} in the cache belong to no task of agentctl: not touched.`);
  if (opts.applied) {
    lines.push(`Freed ${formatBytes(opts.applied.freedBytes)} (${opts.applied.done.length} done${opts.applied.failed.length > 0 ? `, ${opts.applied.failed.length} failed` : ''}).`);
    for (const f of opts.applied.failed) lines.push(`  failed: ${f.item.kind} ${f.item.target}: ${f.reason}`);
  } else lines.push(`Could free ${formatBytes(plan.freeBytes)}. History and reports (*.md) stay.`);
  return lines;
}

export function assertApplyable(plan: GcPlan): void {
  if (plan.items.length === 0) throw new AgentctlError('nothing to clean up');
}
