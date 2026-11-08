import { worktreeCacheFreed } from './worktree-cache.ts';
import { knownLinkReferences, linkUsers } from './links.ts';
import fs from 'node:fs';
import path from 'node:path';
import { configureMeasurements, sizeOf, newestMtime, cachedMeasurement, requestMeasurement } from './fs-measure.ts';
export { sizeOf, newestMtime } from './fs-measure.ts';
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
  cohort?: string;
  repo?: string;
  branch?: string;
}

export interface GcSkip {
  task: string;
  kind: GcKind | 'worktree-foreign';
  target: string;
  reason: string;
  bytes?: number;
  cohort?: string;
}

export interface GcPlan {
  autoCacheFreedBytes?: number;
  items: GcItem[];
  skipped: GcSkip[];
  freeBytes: number;
  olderThanMs: number;
  /** Folders of the cache that belong to no task of agentctl (not touched, not listed one by one). */
  unknownCacheDirs: number;
  foreignWorktrees?: number;
  forceLinks?: boolean;
}

export interface GcOptions {
  /** MCP estimates never wait for recursive size walks. */
  cachedSizes?: boolean;
  /** Age of the files next to the reports before they go; default 7 days. */
  olderThan?: string | undefined;
  branches?: boolean | undefined;
  cohort?: string | undefined;
  /** CLI-only override for link references, never dirty/active/protected worktrees. */
  forceLinks?: boolean;
}

export const DEFAULT_OLDER_THAN = '7d';
const PROTECTED = new Set(['main', 'master']);

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
  configureMeasurements(config.disk);
  const measurement = (target: string) => {
    const cached = cachedMeasurement(target);
    const lease = requestMeasurement(target, { background: true });
    void lease.promise.catch(() => undefined).finally(() => lease.release());
    return cached;
  };
  const size = (target: string) => opts.cachedSizes ? Promise.resolve(measurement(target)?.bytes ?? 0) : sizeOf(target);
  const newest = (target: string) => opts.cachedSizes ? Promise.resolve(measurement(target)?.newest ?? runner.now()) : newestMtime(target);
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
  const references = knownLinkReferences(config);
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
      const users = linkUsers(wt, references);
      if (users.length && !opts.forceLinks) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, bytes: await size(wt), reason: `links target used by ${users.join(', ')}; CLI --force-links overrides` });
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
      const bytes = await size(wt);
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
      const age = runner.now() - await newest(target);
      if (age < olderThanMs) {
        skipped.push({ task: record.task, kind: 'cache', target, bytes: await size(target), reason: `newer than ${opts.olderThan ?? DEFAULT_OLDER_THAN}` });
        continue;
      }
      items.push({ kind: 'cache', task: record.task, target, bytes: await size(target), detail: `older than ${opts.olderThan ?? DEFAULT_OLDER_THAN}, no active task` });
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

  for (const item of [...items, ...skipped]) {
    const record = all.find(r => r.task === item.task);
    if (record?.cohort) item.cohort = record.cohort;
    if (item.bytes === undefined) item.bytes = item.kind === 'branch' || item.kind === 'worktree-foreign' ? 0 : await size(item.target);
  }
  const freeBytes = items.reduce((n, i) => n + i.bytes, 0);
  const foreignWorktrees = skipped.filter(s => s.kind === 'worktree-foreign').length;
  return { autoCacheFreedBytes: all.filter(r => cohort === undefined || (r.cohort && cohortKey(r.cohort) === cohortKey(cohort))).reduce((sum, r) => sum + worktreeCacheFreed(ctx, r), 0), ...(opts.forceLinks ? { forceLinks: true } : {}), items, skipped: cohort === undefined ? skipped : skipped.filter(s => s.kind !== 'worktree-foreign'), freeBytes, olderThanMs, unknownCacheDirs, ...(cohort !== undefined ? { foreignWorktrees } : {}) };
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
        // The plan may be old; only successfully removed bytes belong in the result.
        const bytes = kind === 'worktree' || kind === 'cache' ? await sizeOf(item.target, { fresh: true, now: () => runner.now() }) : 0;
        if (kind === 'worktree') {
          const users = linkUsers(item.target, knownLinkReferences(config));
          if (users.length && !plan.forceLinks) throw new Error(`links target used by ${users.join(', ')}`);
          const r = await runner.exec('git', ['-C', item.repo as string, 'worktree', 'remove', item.target], { timeoutMs: config.git.timeoutS * 1000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        } else if (kind === 'cache') {
          if (runner.now() - await newestMtime(item.target, { fresh: true, now: () => runner.now() }) < plan.olderThanMs) throw new Error('cache contents changed since the plan; kept because they are too recent');
          await runner.remove(item.target);
        } else if (kind === 'archive') {
          await runner.rename(item.target, path.join(archiveDir(config), path.basename(item.target)));
        } else {
          const r = await runner.exec('git', ['-C', item.repo as string, 'branch', '-d', item.branch as string]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        }
        result.done.push({ ...item, bytes });
        result.freedBytes += bytes;
      } catch (e) {
        result.failed.push({ item, reason: errorMessage(e) });
      }
    }
  }
  return result;
}

const KIND_WORD: Record<GcKind, string> = { worktree: 'worktree', cache: 'cache', archive: 'archive', branch: 'branch' };

export interface GcViewOptions { detail?: boolean; offset?: number; limit?: number }
/** Bounded, aggregate-first representation; full paths are opt-in and paginated. */
export function gcView(plan: GcPlan, opts: GcViewOptions = {}) {
  const offset = opts.offset ?? 0, limit = Math.min(100, opts.limit ?? 10);
  const categories = (['worktree', 'archive', 'cache', 'branch'] as const).map(kind => ({ category: kind === 'branch' ? 'merged branches' : kind, count: plan.items.filter(i => i.kind === kind).length, bytes: plan.items.filter(i => i.kind === kind).reduce((n, i) => n + i.bytes, 0) }));
  const reasons = new Map<string, { reason: string; count: number; bytes: number }>();
  for (const s of plan.skipped) { const key = s.reason.startsWith('newer than ') ? s.reason : s.reason.startsWith('links target ') ? 'links target in use (see detail)' : s.reason.replace(/also used by .*/, 'also used by unfinished task'); const group = reasons.get(key) ?? { reason: key, count: 0, bytes: 0 }; group.count++; group.bytes += s.bytes ?? 0; reasons.set(key, group); }
  const cohorts = new Map<string, { cohort: string; count: number; bytes: number; skipped: number; skippedBytes: number }>();
  for (const i of plan.items) { const key = i.cohort ?? '(none)', group = cohorts.get(key) ?? { cohort: key, count: 0, bytes: 0, skipped: 0, skippedBytes: 0 }; group.count++; group.bytes += i.bytes; cohorts.set(key, group); }
  for (const i of plan.skipped) { const key = i.cohort ?? '(none)', group = cohorts.get(key) ?? { cohort: key, count: 0, bytes: 0, skipped: 0, skippedBytes: 0 }; group.skipped++; group.skippedBytes += i.bytes ?? 0; cohorts.set(key, group); }
  const newer = new Map<string, { task: string; files: number; bytes: number; reason: string }>();
  for (const s of plan.skipped.filter(s => s.reason.startsWith('newer than '))) { const group = newer.get(s.task) ?? { task: s.task, files: 0, bytes: 0, reason: s.reason }; group.files++; group.bytes += s.bytes ?? 0; newer.set(s.task, group); }
  const page = <T>(items: T[]) => ({ total: items.length, offset, next_offset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });
  return { autoCacheFreedBytes: plan.autoCacheFreedBytes ?? 0, freeBytes: plan.freeBytes, summary: `można zwolnić ${(plan.freeBytes / 1e9).toFixed(3)} GB (${plan.freeBytes} bytes)`, categories,
    skipped: { count: plan.skipped.length, bytes: plan.skipped.reduce((n, s) => n + (s.bytes ?? 0), 0), reasons: page([...reasons.values()]) },
    cohorts: page([...cohorts.values()]), newer: page([...newer.values()]), unknownCacheDirs: plan.unknownCacheDirs, foreignWorktrees: plan.foreignWorktrees ?? 0,
    ...(opts.detail ? { details: page([...plan.items.map(i => ({ ...i, action: 'remove/archive' })), ...plan.skipped.map(s => ({ ...s, action: 'skip' }))]) } : {}),
    more: 'Full list: detail: true / --verbose; offset/limit paginate details and grouped summaries.' };
}

const DONE_WORD: Record<GcKind, string> = { worktree: 'removed worktrees', cache: 'removed cache entries', archive: 'archived state folders', branch: 'deleted merged branches' };

export function renderGc(plan: GcPlan, opts: GcViewOptions & { applied?: GcResult | undefined } = {}): string[] {
  const view = gcView(plan, opts);
  const lines = opts.applied ? ['History and reports (*.md) stay.'] : [`Could free ${formatBytes(plan.freeBytes)}; ${view.summary}. History and reports (*.md) stay.`, ...view.categories.map(c => `${c.category}: ${c.count}, ${c.bytes} bytes`), `Skipped: ${view.skipped.count}, ${view.skipped.bytes} bytes`];
  lines.push(`Automatic .cache cleanup: ${plan.autoCacheFreedBytes ?? 0} bytes freed previously.`);
  if (!opts.applied) {
    lines.push('Would clean up (a dry run; --apply does it, after a y/N):');
    if (!plan.items.length) lines.push('Nothing to clean up.');
    for (const reason of view.skipped.reasons.items) lines.push(`  ${reason.reason}: ${reason.count}, ${reason.bytes} bytes`);
    for (const c of view.cohorts.items) lines.push(`cohort ${c.cohort}: ${c.count}, ${c.bytes} bytes; skipped ${c.skipped}, ${c.skippedBytes} bytes`);
    for (const n of view.newer.items) lines.push(`  ${n.task}: ${n.reason}, ${n.files} files, ${n.bytes} bytes`);
    for (const i of view.details?.items ?? []) lines.push(`  ${i.action} ${KIND_WORD[i.kind as GcKind] ?? i.kind} ${i.task} ${i.target} (${('reason' in i ? i.reason : i.detail)})`);
    for (const [label, page] of [['cohorts', view.cohorts], ['newer', view.newer], ['reasons', view.skipped.reasons], ['details', view.details]] as const) if (page?.next_offset !== null && page?.next_offset !== undefined) lines.push(`${label}: next offset ${page.next_offset} of ${page.total}`);
    if (plan.foreignWorktrees) lines.push(`${plan.foreignWorktrees} foreign worktrees: not touched.`);
    if (plan.unknownCacheDirs) lines.push(`${plan.unknownCacheDirs} folder${plan.unknownCacheDirs === 1 ? '' : 's'} in the cache belong to no task of agentctl: not touched.`);
    lines.push('Preview only; --apply executes. Full list: --verbose --offset N --limit N.');
    return lines;
  }
  // The result decides what is listed: done is removed, failed is named, skipped stays visibly out of "Cleaned up".
  const applied = opts.applied;
  lines.push('Cleaned up:');
  if (!applied.done.length) lines.push('Nothing was cleaned up.');
  for (const kind of ['worktree', 'cache', 'archive', 'branch'] as const) {
    const done = applied.done.filter(i => i.kind === kind);
    if (done.length) lines.push(`  ${DONE_WORD[kind]}: ${done.length}, ${done.reduce((n, i) => n + i.bytes, 0)} bytes`);
  }
  for (const f of applied.failed) lines.push(`  failed: ${f.item.target}: ${f.reason}`);
  lines.push(`Freed ${formatBytes(applied.freedBytes)} (removed ${applied.done.length}, failed ${applied.failed.length}; skipped entries were left in place).`);
  if (plan.skipped.length) {
    lines.push(`Skipped (left in place): ${plan.skipped.length}, ${view.skipped.bytes} bytes`);
    for (const reason of view.skipped.reasons.items) lines.push(`  skipped: ${reason.reason}: ${reason.count}, ${reason.bytes} bytes`);
  }
  if (opts.detail) {
    for (const i of applied.done) lines.push(`  ${i.kind === 'archive' ? 'archived state' : i.kind === 'branch' ? 'deleted branch' : `removed ${KIND_WORD[i.kind]}`} ${i.task} ${i.target} (${i.detail})`);
    for (const f of applied.failed) lines.push(`  failed ${KIND_WORD[f.item.kind]} ${f.item.task} ${f.item.target} (${f.reason})`);
    for (const s of plan.skipped) lines.push(`  skipped ${s.kind === 'worktree-foreign' ? 'worktree-foreign' : KIND_WORD[s.kind as GcKind]} ${s.task} ${s.target} (${s.reason})`);
  }
  if (plan.foreignWorktrees) lines.push(`${plan.foreignWorktrees} foreign worktrees: not touched.`);
  if (plan.unknownCacheDirs) lines.push(`${plan.unknownCacheDirs} folder${plan.unknownCacheDirs === 1 ? '' : 's'} in the cache belong to no task of agentctl: not touched.`);
  return lines;
}

export function assertApplyable(plan: GcPlan): void {
  if (plan.items.length === 0) throw new AgentctlError('nothing to clean up');
}
