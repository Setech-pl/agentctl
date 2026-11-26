import { claimGcPath, pathsOverlap } from './start-paths.ts';
import { pendingStarts } from './start-lock.ts';
import { recordJournal } from './journal.ts';
import { GcSpace, type GcVolumeFreed } from './gc-space.ts';
import { moveToTrash, planTrashPurge, purgeTrashItem, trashOwners, type TrashItem } from './trash.ts';
import { planRemoteGc, applyRemoteGc } from './host-gc.ts';
import { cacheProtection } from './gc-cache.ts';
import { restoreDiskMeasurements } from './disk.ts';
import { worktreeCacheFreed } from './worktree-cache.ts';
import { knownLinkReferences, linkUsers } from './links.ts';
import fs from 'node:fs';
import path from 'node:path';
import { configureMeasurements, sizeOf, newestMtime, lastMeasurement, removedMeasurement } from './fs-measure.ts';
export { sizeOf, newestMtime } from './fs-measure.ts';
import { parseAge } from './archive.ts';
import { findCohort } from './cohort.ts';
import type { Context } from './context.ts';
import { formatBytes } from './pull.ts';
import { archiveDir, listArchivedRecords, listTaskRecords, taskDir } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, cohortKey, errorMessage } from './util.ts';
import { applyIntegrationGc, protectLinkedWorktrees } from './integration-gc.ts';
import type { IntegrationGcScope } from './integration-gc.ts';

/*
 * `agentctl gc`: take back the disk space that finished tasks leave behind - their worktrees, the files next to their reports, the state
 * folders (moved to the archive) and, on request, their merged branches. A dry run unless `--apply`. It touches only what a task record
 * of agentctl names; the history, the reports (*.md) and anything it does not recognise stay. Branches go only with `git branch -d`.
 */

import { staleNodeModules, removeStaleNodeModules, storeOwnsPath } from './node-modules-store.ts';

export type GcKind = 'worktree' | 'cache' | 'archive' | 'branch' | 'node-modules' | 'trash';

export interface GcItem {
  host?: string;
  hostFingerprint?: string;
  trash?: TrashItem;
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
  base?: string;
  dirtyFiles?: number;
  unpushedCommits?: number;
  head?: string;
}

export interface GcSkip {
  host?: string;
  task: string;
  kind: GcKind | 'worktree-foreign';
  target: string;
  reason: string;
  bytes?: number;
  cohort?: string;
  repo?: string;
  dirtyFiles?: number;
  unpushedCommits?: number;
}

export interface GcPlan {
  integration?: IntegrationGcScope;
  automatic?: { device: string };
  /** An MCP plan may estimate sizes; safety checks are always fresh. */
  cachedSizes?: boolean;
  deleteMode?: 'delete' | 'trash';
  autoCacheFreedBytes?: number;
  items: GcItem[];
  skipped: GcSkip[];
  freeBytes: number;
  olderThanMs: number;
  /** Folders of the cache that belong to no task of agentctl (not touched, not listed one by one). */
  unknownCacheDirs: number;
  foreignWorktrees?: number;
  forceLinks?: boolean;
  includeCache?: boolean;
  keepCache?: string[];
  keep?: string[];
  forceDirty?: string[];
}

export interface GcOptions {
  localKinds?: ReadonlySet<GcKind>;
  purgeTrash?: boolean;
  /** MCP estimates never wait for recursive size walks. */
  cachedSizes?: boolean;
  /** Age of the files next to the reports before they go; default 7 days. */
  olderThan?: string | undefined;
  branches?: boolean | undefined;
  cohort?: string | undefined;
  /** Explicit owner override: true for CLI selection, or named tasks for MCP. */
  includeCache?: boolean;
  keepCache?: string[];
  keep?: string[];
  forceDirty?: boolean | string[];
  /** CLI-only override for link references, never dirty/active/protected worktrees. */
  forceLinks?: boolean;
}

export const DEFAULT_OLDER_THAN = '7d';
const PROTECTED = new Set(['main', 'master']);

const location = (p: string): string => {try {return fs.realpathSync(p);} catch {return path.resolve(p);}};
const same = (a: string, b: string): boolean => location(a) === location(b);

async function git(ctx: Context, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const r = await ctx.runner.exec('git', args, { readOnly: true });
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() };
}

/** Fresh safety facts, independent of cached disk measurements. No network or ignored files. */
async function worktreeRisk(ctx: Context, wt: string, base?: string) {
  const status = await git(ctx, ['-C', wt, 'status', '--porcelain', '--untracked-files=normal']);
  if (status.code !== 0) throw new Error(`git status failed: ${status.err || status.code}`);
  const upstream = await git(ctx, ['-C', wt, 'rev-parse', '--verify', '--quiet', '@{upstream}']);
  const comparison = upstream.code === 0 && upstream.out ? '@{upstream}' : base ?? 'main';
  const ahead = await git(ctx, ['-C', wt, 'rev-list', '--count', `${comparison}..HEAD`]);
  if (ahead.code !== 0 || !/^\d+$/.test(ahead.out)) throw new Error(`cannot check unpushed commits against ${comparison}: ${ahead.err || 'no count'}`);
  return { dirtyFiles: status.out ? status.out.split('\n').length : 0, unpushedCommits: Number(ahead.out), comparison };
}

const permitsDirty = (tasks: boolean | string[] | undefined, task: string) => tasks === true || Array.isArray(tasks) && tasks.some(t => t.toLowerCase() === task.toLowerCase());

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
  const selected = (kind: GcKind) => !opts.localKinds || opts.localKinds.has(kind);
  if (opts.purgeTrash) {
    if (opts.cohort || opts.branches || opts.olderThan || opts.includeCache || opts.keepCache?.length || opts.keep?.length || opts.forceDirty || opts.forceLinks) throw new AgentctlError('purge-trash selects only Trash items; remove other GC selection options');
    const items = planTrashPurge(ctx).map(trash => ({
      kind: 'trash' as const, task: '-', target: trash.target, bytes: 0, trash, detail: `original: ${trash.original}${trash.legacyMarker ? `; legacy marker: ${trash.legacyMarker}` : ''}`,
    }));
    return { items, skipped: [], freeBytes: 0, olderThanMs: 0, unknownCacheDirs: 0 };
  }
  if (opts.cachedSizes) restoreDiskMeasurements(ctx);
  else configureMeasurements(config.disk);
  const measurement = lastMeasurement;
  const size = (target: string) => opts.cachedSizes ? Promise.resolve(measurement(target)?.bytes ?? 0) : sizeOf(target);
  const olderThanMs = parseAge(opts.olderThan ?? DEFAULT_OLDER_THAN);
  const cohort = opts.cohort === undefined ? undefined : findCohort(config, opts.cohort).name;
  const currentRecords = listTaskRecords(config).filter(r => !r.host), archivedRecords = listArchivedRecords(config).filter(r => !r.host);
  const archived = new Set(archivedRecords.map(r => r.window));
  const currentNames = new Set(currentRecords.map(r => r.window));
  const all: TaskRecord[] = [...currentRecords, ...archivedRecords.filter(r => !currentNames.has(r.window))];
  const live = new Set([...await (opts.localKinds ? ctx.localTmux : ctx.tmux).listWindows(), ...pendingStarts(config).filter(start => !start.host).map(start => start.window)]);
  const finished = (r: TaskRecord): boolean => (r.closed === true || r.cancelled === true || archived.has(r.window)) && !live.has(r.window);
  const items: GcItem[] = [];
  const skipped: GcSkip[] = [];
  const kept = (r: TaskRecord) => r.pin === true || opts.keep?.some(t => t.toLowerCase() === r.task.toLowerCase()) === true;
  const mine = all.filter((r) => finished(r) && !kept(r) && (cohort === undefined || (r.cohort !== undefined && cohortKey(r.cohort) === cohortKey(cohort))));
  const others = all.filter((r) => !finished(r) || kept(r));
  for (const r of all.filter(r => finished(r) && kept(r) && (cohort === undefined || cohortKey(r.cohort ?? '') === cohortKey(cohort)))) {
    const reason = r.pin ? 'pinned task' : 'keep requested for task';
    for (const repo of r.repos) if (selected('worktree') && !same(repo.path, repo.worktree) && fs.existsSync(repo.worktree)) skipped.push({task: r.task, kind: 'worktree', target: repo.worktree, bytes: await size(repo.worktree), reason});
    const dir = r.report ? path.dirname(path.resolve(r.report)) : path.join(path.resolve(config.cache), r.window);
    if (selected('cache') && dir.startsWith(`${path.resolve(config.cache)}${path.sep}`) && fs.existsSync(dir)) skipped.push({task: r.task, kind: 'cache', target: dir, bytes: await size(dir), reason});
  }
  const references = knownLinkReferences(config);
  const removing = new Set<string>();
  const seenWorktrees = new Set<string>();
  const listings = new Map<string, WorktreeListing[] | undefined>();
  const listingOf = async (repo: string): Promise<WorktreeListing[] | undefined> => {
    if (!listings.has(repo)) listings.set(repo, await listWorktrees(ctx, repo));
    return listings.get(repo);
  };

  // 1. worktrees
  for (const record of selected('worktree') ? mine : []) {
    if (record.reviewMode) continue; // Borrowed worktrees are owned by the author record.
    for (const repo of record.repos) {
      const wt = repo.worktree;
      if (same(wt, repo.path)) continue; // the main checkout is never a candidate
      if (!fs.existsSync(wt)) continue;
      const key = path.resolve(wt);
      if (seenWorktrees.has(key)) continue;
      seenWorktrees.add(key);
      const user = others.find((o) => o.repos.some((x) => same(x.worktree, wt)));
      if (user) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, reason: kept(user) ? `pinned/kept task ${user.task} also uses this worktree` : `also used by ${user.task}, which is not finished` });
        continue;
      }
      let risk;
      try { risk = await worktreeRisk(ctx, wt, repo.base); }
      catch (error) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, repo: repo.path, reason: errorMessage(error) });
        continue;
      }
      const users = linkUsers(wt, references);
      if (users.length && !opts.forceLinks) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, repo: repo.path, ...risk, bytes: await size(wt), reason: `links target used by ${users.join(', ')}; CLI --force-links overrides` });
        continue;
      }
      const head = await git(ctx, ['-C', wt, 'rev-parse', '--abbrev-ref', 'HEAD']);
      if (PROTECTED.has(head.out)) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, repo: repo.path, ...risk, reason: `has ${head.out} checked out` });
        continue;
      }
      const detail = `${risk.dirtyFiles} dirty files, ${risk.unpushedCommits} unpushed commits vs ${risk.comparison}`;
      if ((risk.dirtyFiles || risk.unpushedCommits) && !permitsDirty(opts.forceDirty, record.task)) {
        skipped.push({ task: record.task, kind: 'worktree', target: wt, repo: repo.path, ...risk, bytes: await size(wt), reason: `uncommitted changes / unpushed work (${detail}); requires force_dirty: [${record.task}] / --force-dirty ${record.task}` });
        continue;
      }
      const bytes = await size(wt);
      items.push({ kind: 'worktree', task: record.task, target: wt, bytes, ...risk, detail: `${record.cancelled ? 'cancelled' : 'closed'} task, ${detail}`, repo: repo.path, ...(repo.base ? { base: repo.base } : {}) });
      removing.add(key);
    }
  }

  // worktrees nobody of agentctl owns: only said, never removed
  const repos = [...new Set(all.flatMap((r) => r.repos.map((x) => path.resolve(x.path))))];
  const known = new Set(all.flatMap((r) => r.repos.map((x) => path.resolve(x.worktree))));
  for (const repo of selected('worktree') ? repos : []) {
    for (const wt of (await listingOf(repo)) ?? []) {
      const p = path.resolve(wt.path);
      if (p === repo || known.has(p)) continue;
      skipped.push({ task: '-', kind: 'worktree-foreign', target: wt.path, reason: 'not a worktree of an agentctl task' });
    }
  }

  // 2. what lies next to the reports (the *.md stay)
  const cacheRoot = path.resolve(config.cache);
  const seenCache = new Set<string>();
  for (const record of selected('cache') ? mine : []) {
    const dir = record.report ? path.dirname(path.resolve(record.report)) : path.join(cacheRoot, record.window);
    if (dir === cacheRoot || !dir.startsWith(`${cacheRoot}${path.sep}`) || seenCache.has(dir)) continue;
    seenCache.add(dir);
    const shared = others.find((o) => o.report && path.dirname(path.resolve(o.report)) === dir);
    if (shared) {
      skipped.push({ task: record.task, kind: 'cache', target: dir, reason: kept(shared) ? `pinned/kept task ${shared.task} also uses this cache` : `also the folder of ${shared.task}, which is not finished` });
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
      const protection = cacheProtection(record, target);
      const kept = opts.keepCache?.some(t => t.toLowerCase() === record.task.toLowerCase());
      if (protection || kept || !opts.includeCache) {
        skipped.push({ task: record.task, kind: 'cache', target, bytes: await size(target), reason: protection ?? (kept ? 'keep_cache requested for task' : 'cache kept by default; owner must explicitly set include_cache: true / --include-cache') });
        continue;
      }
      // Owner-authorized cache deletion measures size and descendant age, including MCP plans.
      const age = runner.now() - await newestMtime(target, { fresh: true, now: () => runner.now() });
      if (age < olderThanMs) {
        skipped.push({ task: record.task, kind: 'cache', target, bytes: await size(target), reason: `newer than ${opts.olderThan ?? DEFAULT_OLDER_THAN}` });
        continue;
      }
      items.push({ kind: 'cache', task: record.task, target, bytes: await sizeOf(target, { fresh: true, now: () => runner.now() }), detail: `older than ${opts.olderThan ?? DEFAULT_OLDER_THAN}, no active task` });
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
  for (const record of selected('archive') ? mine : []) {
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
      if (record.reviewMode) continue;
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
  if (!opts.localKinds) {
    const remote = await planRemoteGc(ctx, opts, olderThanMs);
    items.push(...remote.items); skipped.push(...remote.skipped);
  }
  if (cohort === undefined && selected('node-modules')) items.push(...staleNodeModules(config, olderThanMs, runner.now()).map(entry => ({ ...entry, kind: 'node-modules' as const, task: 'nm-store', detail: `unused for ${opts.olderThan ?? DEFAULT_OLDER_THAN}` })));
  const freeBytes = items.reduce((n, i) => n + i.bytes, 0);
  const foreignWorktrees = skipped.filter(s => s.kind === 'worktree-foreign').length;
  return { deleteMode: config.gc.deleteMode, keep: opts.keep ?? [], includeCache: opts.includeCache === true, keepCache: opts.keepCache ?? [], forceDirty: mine.filter(r => permitsDirty(opts.forceDirty, r.task)).map(r => r.task), ...(opts.cachedSizes ? { cachedSizes: true } : {}), autoCacheFreedBytes: all.filter(r => cohort === undefined || (r.cohort && cohortKey(r.cohort) === cohortKey(cohort))).reduce((sum, r) => sum + worktreeCacheFreed(ctx, r), 0), ...(opts.forceLinks ? { forceLinks: true } : {}), items, skipped: cohort === undefined ? skipped : skipped.filter(s => s.kind !== 'worktree-foreign'), freeBytes, olderThanMs, unknownCacheDirs, ...(cohort !== undefined ? { foreignWorktrees } : {}) };
}

function currentLocalRecords(ctx: Context): TaskRecord[] {
  const current = listTaskRecords(ctx.config);
  const windows = new Set(current.map(record => record.window));
  return [...current, ...listArchivedRecords(ctx.config).filter(record => !windows.has(record.window))].filter(record => !record.host);
}

async function inspectAutomaticTree(target: string, device: string): Promise<{ bytes: number; newest: number }> {
  const stat = await fs.promises.lstat(target);
  if (String(stat.dev) !== device) throw new Error('different filesystem or nested mount; kept');
  let bytes = Math.max(stat.size, stat.blocks * 512), newest = stat.mtimeMs;
  if (stat.isDirectory()) {
    for await (const entry of await fs.promises.opendir(target)) {
      const child = await inspectAutomaticTree(path.join(target, entry.name), device);
      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    }
  }
  return { bytes, newest };
}

/** Extra safeguards for unattended deletion. The same facts are checked again with the path claimed. */
export async function checkAutomaticGc(ctx: Context, item: GcItem, device: string, olderThanMs: number): Promise<number> {
  const { config, runner } = ctx;
  const stat = fs.lstatSync(item.target);
  if (stat.isSymbolicLink() || String(stat.dev) !== device || String(fs.statSync(path.dirname(item.target)).dev) !== device ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe owner, symlink or filesystem boundary; kept');
  const real = fs.realpathSync(item.target);
  if (real !== path.join(fs.realpathSync(path.dirname(item.target)), path.basename(item.target))) throw new Error('path resolved outside its directory');
  const records = currentLocalRecords(ctx);
  const excluded = new Set(config.disk.autoGc.cohortsExclude.map(cohortKey));
  const live = new Set([...await ctx.localTmux.listWindows(), ...pendingStarts(config).filter(start => !start.host).map(start => start.window)]);
  const source = item.trash?.original ?? item.target;
  const isStore = (item.kind === 'node-modules' || item.kind === 'trash') && storeOwnsPath(config, source);
  const owners = item.kind === 'trash' ? trashOwners(ctx, source, records) : item.kind === 'worktree'
    ? records.filter(record => record.repos.some(repo => pathsOverlap(location(repo.worktree), real)))
    : item.kind === 'cache' ? records.filter(record => record.report && pathsOverlap(location(path.dirname(record.report)), real)) : [];
  if (!owners.length && !isStore) throw new Error('no verifiable agentctl owner');
  for (const owner of owners) {
    if (owner.pin || owner.keepCache) throw new Error('pinned / keep_cache task');
    if (owner.cohort && excluded.has(cohortKey(owner.cohort))) throw new Error('cohort excluded by owner');
    if ((!owner.closed && !owner.cancelled) || live.has(owner.window)) throw new Error('active task');
    const finishedAt = Date.parse(owner.closedAt ?? owner.cancelledAt ?? '');
    if (Number.isFinite(finishedAt) && runner.now() - finishedAt < olderThanMs) throw new Error('task closed too recently');
  }
  if (isStore && records.some(record => record.cohort && excluded.has(cohortKey(record.cohort)) &&
      record.repos.some(repo => storeOwnsPath(config, source, repo.path)))) throw new Error('cohort excluded by owner');
  if (knownLinkReferences(config).some(ref => ref.target === '*' || pathsOverlap(location(ref.target.replace(/\/\*$/, '')), location(source)))) throw new Error('links target in use');
  if (item.kind === 'worktree') {
    const registered = item.repo && await listWorktrees(ctx, item.repo);
    const row = registered && registered.find(worktree => same(worktree.path, item.target));
    if (!row || same(registered[0]!.path, item.target) || row.branch && PROTECTED.has(row.branch)) throw new Error('not a registered task worktree or protected branch');
    const owner = owners.find(record => record.task === item.task);
    if (!owner || owner.reviewMode || !owner.repos.some(repo => !same(repo.path, repo.worktree) && same(repo.path, item.repo!) && same(repo.worktree, item.target))) throw new Error('worktree ownership changed');
  }
  if (item.kind === 'cache') {
    const root = fs.realpathSync(config.cache);
    const under = path.relative(path.resolve(config.cache), path.resolve(item.target));
    if (real !== path.join(root, under) || !real.startsWith(root + path.sep) || !owners.some(owner => owner.task === item.task)) throw new Error('cache path is outside the owned cache');
    for (const owner of owners) {
      const protection = cacheProtection(owner, item.target);
      if (protection) throw new Error(protection);
    }
  }
  if (item.kind === 'trash') {
    if (!item.trash) throw new Error('missing Trash identity');
    for (const owner of owners) {
      if (owner.report && pathsOverlap(path.resolve(owner.report), source)) throw new Error('contains or is a task report');
      const worktree = owner.repos.find(repo => path.resolve(repo.worktree) === source);
      if (worktree) {
        const head = await git(ctx, ['-C', item.target, 'rev-parse', '--abbrev-ref', 'HEAD']);
        if (head.code !== 0 || PROTECTED.has(head.out)) throw new Error('cannot verify worktree branch or protected branch');
        const risk = await worktreeRisk(ctx, item.target, worktree.base);
        if (risk.dirtyFiles || risk.unpushedCommits) throw new Error('dirty/unpushed worktree; owner decision');
      } else if (owner.report && pathsOverlap(path.dirname(path.resolve(owner.report)), source)) {
        const protection = cacheProtection(owner, source);
        if (protection) throw new Error(protection);
      }
    }
  }
  const roots = [...new Set(records.flatMap(record => record.repos.flatMap(repo => [repo.path, repo.worktree])))];
  const knownRoots = new Set(roots.filter(root => fs.existsSync(root)).map(location));
  if (!(await protectLinkedWorktrees(knownRoots, [item])).length) throw new Error('links target in use');
  const tree = await inspectAutomaticTree(item.target, device);
  if (item.kind !== 'node-modules' && runner.now() - tree.newest < olderThanMs) throw new Error('contents changed too recently');
  const current = fs.lstatSync(item.target);
  if (current.ino !== stat.ino || current.dev !== stat.dev || current.birthtimeMs !== stat.birthtimeMs) throw new Error('path changed during verification');
  return tree.bytes;
}

export interface GcResult {
  done: GcItem[];
  failed: { item: GcItem; reason: string }[];
  freedBytes: number;
  freedByVolume?: GcVolumeFreed[];
}

/** Do the plan: worktrees (`git worktree remove`), cache entries, archive moves, then branches (`git branch -d`, never -D). */
export async function applyGc(ctx: Context, plan: GcPlan, space = new GcSpace()): Promise<GcResult> {
  if (plan.integration) return applyIntegrationGc(ctx, plan, space);
  const { runner, config } = ctx;
  const result: GcResult = { done: [], failed: [], freedBytes: 0 };
  if (plan.deleteMode && plan.deleteMode !== config.gc.deleteMode) throw new AgentctlError('GC delete mode changed; preview again');
  const staged: { item: GcItem; trash: TrashItem }[] = [];
  const remove = async (item: GcItem): Promise<void> => {
    if (config.gc.deleteMode === 'trash') {
      const trash = await moveToTrash(ctx, item.target);
      if (plan.automatic) await purgeTrashItem(ctx, trash);
      else staged.push({ item, trash });
    }
    else if (!runner.dryRun) await runner.remove(item.target);
  };
  const order: GcKind[] = ['worktree', 'cache', 'archive', 'branch', 'node-modules', 'trash'];
  for (const kind of order) {
    for (const item of plan.items.filter((i) => i.kind === kind)) {
      let release: (() => void) | undefined;
      try {
        if (plan.automatic) {
          if (!config.disk.autoGc.enabled || config.disk.autoGc.dryRun || !ctx.config.disk.autoGc.enabled || ctx.config.disk.autoGc.dryRun) throw new Error('automatic GC disabled or dry run');
          release = await claimGcPath(ctx, item.target, async () => {});
          const bytes = await checkAutomaticGc(ctx, item, plan.automatic.device, plan.olderThanMs);
          if (bytes > item.bytes) throw new Error('size grew after planning; kept within max_per_run_gb');
        }
        if (kind === 'node-modules') {
          await removeStaleNodeModules(ctx, item.target, plan.olderThanMs, async () => {
            if (!runner.dryRun) await space.before(item.target);
            await remove(item);
          });
          if (!staged.some(staging => staging.item === item)) result.done.push(item);
          continue;
        }
        if (kind === 'trash') {
          if (!item.trash || item.trash.target !== item.target) throw new Error('Missing Trash item identity');
          if (!runner.dryRun) await space.before(item.target);
          await purgeTrashItem(ctx, item.trash);
          result.done.push(item);
          continue;
        }
        const assertUnpinned = () => {
          const records = [...listTaskRecords(config), ...listArchivedRecords(config)];
          const protectedRecords = records.filter(r => r.host === item.host).filter(r => r.pin || plan.keep?.some(t => t.toLowerCase() === r.task.toLowerCase()));
          const overlaps = (a: string, b: string) => same(a, b) || location(a).startsWith(`${location(b)}${path.sep}`) || location(b).startsWith(`${location(a)}${path.sep}`);
          if (protectedRecords.some(r => r.task.toLowerCase() === item.task.toLowerCase() || (kind === 'worktree' && r.repos.some(repo => same(repo.worktree, item.target))) || (kind === 'cache' && r.report && overlaps(path.dirname(r.report), item.target)))) throw new Error('pinned/kept task; left in place');
        };
        assertUnpinned();
        if (item.host) {
          const done = await applyRemoteGc(ctx, item, plan.olderThanMs, plan);
          result.done.push(done); result.freedBytes += done.bytes; continue;
        }
        if (kind === 'worktree') {
          const borrowers = listTaskRecords(config).filter(r => r.reviewMode && !r.closed && !r.cancelled && r.repos.some(repo => same(repo.worktree, item.target)));
          if (borrowers.length) throw new Error(`worktree is used by readonly review ${borrowers[0]!.task}`);
          const users = linkUsers(item.target, knownLinkReferences(config));
          if (users.length && !plan.forceLinks) throw new Error(`links target used by ${users.join(', ')}`);
          const risk = await worktreeRisk(ctx, item.target, item.base);
          const forced = permitsDirty(plan.forceDirty, item.task);
          if ((risk.dirtyFiles || risk.unpushedCommits) && !forced) throw new Error(`worktree has ${risk.dirtyFiles} dirty files and ${risk.unpushedCommits} unpushed commits; kept`);
          if (forced && (risk.dirtyFiles !== item.dirtyFiles || risk.unpushedCommits !== item.unpushedCommits)) throw new Error('worktree risk counts changed since preview; kept');
          assertUnpinned();
          if (!runner.dryRun) await space.before(item.target);
          const forceRemove = forced && risk.dirtyFiles > 0;
          if (forceRemove || forced && risk.unpushedCommits > 0) await recordJournal(ctx, {
            kind: 'gc-force-dirty', task: item.task, text: `Owner-authorized worktree removal: ${item.target} (${risk.dirtyFiles} dirty files, ${risk.unpushedCommits} unpushed commits)`,
          });
          const r = await runner.exec('git', ['-C', item.repo as string, 'worktree', 'remove', ...(forceRemove ? ['--force'] : []), item.target], { timeoutMs: config.git.timeoutS * 1000 });
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        } else if (kind === 'cache') {
          if (!plan.includeCache) throw new Error('cache deletion requires explicit include_cache: true');
          const record = [...listTaskRecords(config), ...listArchivedRecords(config)].find(r => r.task === item.task);
          if (!record) throw new Error('cannot verify cache owner; kept');
          const protection = cacheProtection(record, item.target);
          if (protection || plan.keepCache?.some(t => t.toLowerCase() === item.task.toLowerCase())) throw new Error(protection ?? 'keep_cache requested for task');
          if (runner.now() - await newestMtime(item.target, { fresh: true, now: () => runner.now() }) < plan.olderThanMs) throw new Error('cache contents changed since the plan; kept because they are too recent');
          assertUnpinned();
          if (!runner.dryRun) await space.before(item.target);
          await remove(item);
        } else if (kind === 'archive') {
          assertUnpinned();
          await runner.rename(item.target, path.join(archiveDir(config), path.basename(item.target)));
        } else {
          assertUnpinned();
          const r = await runner.exec('git', ['-C', item.repo as string, 'branch', '-d', item.branch as string]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `git exit ${r.code}`);
        }
        if (kind === 'worktree' || kind === 'cache') removedMeasurement(item.target, runner.now());
        if (!staged.some(staging => staging.item === item)) result.done.push(item);
      } catch (e) {
        result.failed.push({ item, reason: errorMessage(e) });
      } finally { release?.(); }
    }
  }
  for (const { item, trash } of staged) {
    try {
      if (!runner.dryRun) await space.before(trash.target);
      await purgeTrashItem(ctx, trash);
      result.done.push(item);
    } catch (e) { result.failed.push({ item, reason: errorMessage(e) }); }
  }
  result.freedByVolume = await space.freedByVolume();
  result.freedBytes += result.freedByVolume.reduce((bytes, volume) => bytes + (volume.freedBytes ?? 0), 0);
  return result;
}

const KIND_WORD: Record<GcKind, string> = { worktree: 'worktree', cache: 'cache', archive: 'archive', branch: 'branch', 'node-modules': 'node_modules store entry', trash: 'Trash item' };

export interface GcViewOptions { detail?: boolean; offset?: number; limit?: number }
/** Bounded summaries with paginated safety facts and cache paths; combined details are opt-in. */
export function gcView(plan: GcPlan, opts: GcViewOptions = {}) {
  const offset = opts.offset ?? 0, limit = Math.min(100, opts.limit ?? 10);
  const kinds: GcKind[] = ['worktree', 'archive', 'cache', 'branch'];
  if (plan.items.some(item => item.kind === 'trash')) kinds.push('trash');
  if (plan.items.some(item => item.kind === 'node-modules')) kinds.push('node-modules');
  const categories = kinds.map(kind => ({ category: kind === 'branch' ? 'merged branches' : kind === 'node-modules' ? 'node_modules store' : kind, count: plan.items.filter(i => i.kind === kind).length, bytes: plan.items.filter(i => i.kind === kind).reduce((n, i) => n + i.bytes, 0) }));
  const reasons = new Map<string, { reason: string; count: number; bytes: number }>();
  for (const s of plan.skipped) { const key = s.reason.startsWith('newer than ') ? s.reason : s.reason.startsWith('links target ') ? 'links target in use (see detail)' : s.reason.replace(/also used by .*/, 'also used by unfinished task'); const group = reasons.get(key) ?? { reason: key, count: 0, bytes: 0 }; group.count++; group.bytes += s.bytes ?? 0; reasons.set(key, group); }
  const cohorts = new Map<string, { cohort: string; count: number; bytes: number; skipped: number; skippedBytes: number }>();
  for (const i of plan.items) { const key = i.cohort ?? '(none)', group = cohorts.get(key) ?? { cohort: key, count: 0, bytes: 0, skipped: 0, skippedBytes: 0 }; group.count++; group.bytes += i.bytes; cohorts.set(key, group); }
  for (const i of plan.skipped) { const key = i.cohort ?? '(none)', group = cohorts.get(key) ?? { cohort: key, count: 0, bytes: 0, skipped: 0, skippedBytes: 0 }; group.skipped++; group.skippedBytes += i.bytes ?? 0; cohorts.set(key, group); }
  const newer = new Map<string, { task: string; files: number; bytes: number; reason: string }>();
  for (const s of plan.skipped.filter(s => s.reason.startsWith('newer than '))) { const group = newer.get(s.task) ?? { task: s.task, files: 0, bytes: 0, reason: s.reason }; group.files++; group.bytes += s.bytes ?? 0; newer.set(s.task, group); }
  const hosts = [...new Set([...plan.items, ...plan.skipped].map(i => i.host ?? 'local'))].map(host => ({ host,
    count: plan.items.filter(i => (i.host ?? 'local') === host).length,
    bytes: plan.items.filter(i => (i.host ?? 'local') === host).reduce((n, i) => n + i.bytes, 0),
    skipped: plan.skipped.filter(i => (i.host ?? 'local') === host).length,
  }));
  const page = <T>(items: T[]) => ({ total: items.length, offset, next_offset: offset + limit < items.length ? offset + limit : null, items: items.slice(offset, offset + limit) });
  const skippedGroup = (name: string, test: (s: GcSkip) => boolean) => { const entries = plan.skipped.filter(test); return { name, count: entries.length, bytes: entries.reduce((n, s) => n + (s.bytes ?? 0), 0), ...page(entries) }; };
  const dirty = (s: GcSkip) => Boolean(s.dirtyFiles || s.unpushedCommits) && /uncommitted changes/.test(s.reason);
  const pinned = (s: GcSkip) => /^(pinned|keep requested)/.test(s.reason);
  const legacy = plan.items.filter(item => item.trash?.legacyMarker);
  const remove = plan.items.filter(item => !item.trash?.legacyMarker);
  const sections = { remove: { name: 'Would remove', count: remove.length, bytes: remove.reduce((n, item) => n + item.bytes, 0), ...page(remove) },
    ...(legacy.length ? { legacyTrash: { name: 'Legacy Trash with ownership markers', count: legacy.length, bytes: legacy.reduce((n, item) => n + item.bytes, 0), ...page(legacy) } } : {}), uncommitted: skippedGroup('Skipped (uncommitted changes)', dirty), pinned: skippedGroup('Skipped (pinned)', pinned), other: skippedGroup('Skipped (other)', s => !dirty(s) && !pinned(s)) };
  return { hosts, sections, autoCacheFreedBytes: plan.autoCacheFreedBytes ?? 0, freeBytes: plan.freeBytes, summary: `można zwolnić ${(plan.freeBytes / 1e9).toFixed(3)} GB (${plan.freeBytes} bytes)`, categories,
    cache: page([...plan.items, ...plan.skipped].filter(i => i.kind === 'cache').map(i => ({ ...i, action: 'reason' in i ? 'keep' : 'delete' }))),
    worktrees: page([...plan.items, ...plan.skipped].filter(i => i.kind === 'worktree').map(i => ({ task: i.task, repo: i.repo, target: i.target, dirtyFiles: i.dirtyFiles ?? null, unpushedCommits: i.unpushedCommits ?? null, detail: 'reason' in i ? i.reason : i.detail }))),
    skipped: { count: plan.skipped.length, bytes: plan.skipped.reduce((n, s) => n + (s.bytes ?? 0), 0), reasons: page([...reasons.values()]) },
    cohorts: page([...cohorts.values()]), newer: page([...newer.values()]), unknownCacheDirs: plan.unknownCacheDirs, foreignWorktrees: plan.foreignWorktrees ?? 0,
    ...(opts.detail ? { details: page([...plan.items.map(i => ({ ...i, action: 'remove/archive' })), ...plan.skipped.map(s => ({ ...s, action: 'skip' }))]) } : {}),
    more: 'Full list: detail: true / --verbose; offset/limit paginate details and grouped summaries.' };
}

const DONE_WORD: Record<GcKind, string> = { worktree: 'removed worktrees', cache: 'removed cache entries', archive: 'archived state folders', branch: 'deleted merged branches', 'node-modules': 'removed node_modules store entries', trash: 'purged Trash items' };

export function renderGc(plan: GcPlan, opts: GcViewOptions & { applied?: GcResult | undefined } = {}): string[] {
  const view = gcView(plan, opts);
  const lines = opts.applied ? ['History and reports (*.md) stay.'] : [`Could free ${formatBytes(plan.freeBytes)}; ${view.summary}. History and reports (*.md) stay.`, ...view.categories.map(c => `${c.category}: ${c.count}, ${c.bytes} bytes`), `Skipped: ${view.skipped.count}, ${view.skipped.bytes} bytes`];
  for (const h of view.hosts) lines.push(`host ${h.host}: ${h.count} candidates, ${h.bytes} bytes; skipped ${h.skipped}`);
  lines.push(`Automatic .cache cleanup: ${plan.autoCacheFreedBytes ?? 0} bytes freed previously.`);
  if (!opts.applied) {
    for (const section of Object.values(view.sections)) {
      lines.push(`${section.name}: ${section.count}, ${section.bytes} bytes`);
      for (const item of section.items) {
        const detail = 'reason' in item ? item.dirtyFiles ? `uncommitted changes (${item.dirtyFiles} files); ${item.reason}` : item.reason : item.detail;
        lines.push(`  ${item.kind} ${item.task} ${item.target}: ${item.bytes ?? 0} bytes (${detail})`);
      }
      if (section.next_offset !== null) lines.push(`${section.name}: next offset ${section.next_offset} of ${section.total}`);
    }
    for (const c of view.cohorts.items) lines.push(`cohort ${c.cohort}: ${c.count}, ${c.bytes} bytes; skipped ${c.skipped}, ${c.skippedBytes} bytes`);
    for (const n of view.newer.items) lines.push(`  ${n.task}: ${n.reason}, ${n.files} files, ${n.bytes} bytes`);
    for (const i of view.details?.items ?? []) lines.push(`  ${i.action} ${KIND_WORD[i.kind as GcKind] ?? i.kind} ${i.task}${i.host ? ` [${i.host}]` : ''} ${i.target} (${('reason' in i ? i.reason : i.detail)})`);
    for (const [label, page] of [['cohorts', view.cohorts], ['newer', view.newer], ['reasons', view.skipped.reasons], ['details', view.details]] as const) if (page?.next_offset !== null && page?.next_offset !== undefined) lines.push(`${label}: next offset ${page.next_offset} of ${page.total}`);
    if (!plan.items.length) lines.push('Nothing to clean up.');
    if (plan.foreignWorktrees) lines.push(`${plan.foreignWorktrees} foreign worktrees: not touched.`);
    if (plan.unknownCacheDirs) lines.push(`${plan.unknownCacheDirs} folder${plan.unknownCacheDirs === 1 ? '' : 's'} in the cache belong to no task of agentctl: not touched.`);
    lines.push('Preview only; --apply executes. Full list: --verbose --offset N --limit N.');
    return lines;
  }
  // The result decides what is listed: done is removed, failed is named, skipped stays visibly out of "Cleaned up".
  const applied = opts.applied;
  lines.push('Cleaned up:');
  if (!applied.done.length) lines.push('Nothing was cleaned up.');
  for (const kind of ['worktree', 'cache', 'archive', 'branch', 'node-modules', 'trash'] as const) {
    const done = applied.done.filter(i => i.kind === kind);
    if (done.length) lines.push(`  ${DONE_WORD[kind]}: ${done.length}, ${done.reduce((n, i) => n + i.bytes, 0)} bytes`);
  }
  for (const f of applied.failed) lines.push(`  failed: ${f.item.target}: ${f.reason}`);
  lines.push(`Freed ${formatBytes(applied.freedBytes)} (removed ${applied.done.length}, failed ${applied.failed.length}; skipped entries were left in place).`);
  for (const volume of applied.freedByVolume ?? []) lines.push(`  ${volume.path}: ${volume.freedBytes === null ? 'unavailable' : formatBytes(volume.freedBytes)}`);
  if (plan.skipped.length) {
    lines.push(`Skipped (left in place): ${plan.skipped.length}, ${view.skipped.bytes} bytes`);
    for (const reason of view.skipped.reasons.items) lines.push(`  skipped: ${reason.reason}: ${reason.count}, ${reason.bytes} bytes`);
  }
  if (opts.detail) {
    for (const i of applied.done) lines.push(`  ${i.kind === 'archive' ? 'archived state' : i.kind === 'branch' ? 'deleted branch' : `removed ${KIND_WORD[i.kind]}`} ${i.task}${i.host ? ` [${i.host}]` : ''} ${i.target} (${i.detail})`);
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
