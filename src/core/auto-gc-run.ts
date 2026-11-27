import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { AutoGcSettings } from './config.ts';
import type { Context } from './context.ts';
import { knownLinkReferences } from './links.ts';
import { readQueue } from './queue.ts';
import { splitSpecs } from './spec.ts';
import { pendingStarts } from './start-lock.ts';
import { pathsOverlap } from './start-paths.ts';
import { snapshotRecords, type RecordScan, type TaskRecord } from './taskstore.ts';
import { isObject } from './util.ts';

/*
 * 0.26.4 (M1): one automatic GC run shares one inventory of the task records, one index of declared links, one index of real
 * symlinks and one index of report references. The per-item checks only look things up; they never walk every worktree again.
 * Every walk yields to the event loop and checks the stop conditions (watch stop, changed auto_gc settings, max_run_s).
 */

export class AutoGcStop extends Error {}

/** Only the auto_gc settings decide whether a run must stop; a reload of other keys keeps it going (L2). */
export const autoGcPolicyKey = (policy: AutoGcSettings): string => JSON.stringify(policy);

const PACE = 64;
const MAX_REPORT_BYTES = 4 * 1024 ** 2;
const PATH_TOKEN = /(?:file:\/\/|~\/|\/)[^\s\x22\x27\x60<>()[\]{},;]+/g;
const RELATIVE_TOKEN = /(?<![\w/~.-])(?:\.\.?\/)?[A-Za-z0-9_.@-][^\s\x22\x27\x60<>()[\]{},;:]*\/[^\s\x22\x27\x60<>()[\]{},;:]*/g;

export interface SymlinkEntry { root: string; link: string; targets: string[] }
export interface QueueGuard { tasks: Map<string, string>; paths: { path: string; task: string }[] }

export class AutoGcRun {
  readonly startedAt: number;
  private deadline: number;
  readonly key: string;
  private ops = 0;
  private pausedMs = 0;
  private scan?: Promise<RecordScan>;
  private liveSet?: Promise<Set<string>>;
  private refs?: Promise<{ source: string; any: boolean; real: string }[]>;
  private links?: Promise<SymlinkEntry[]>;
  private reports?: Promise<{ path: string; report: string }[]>;
  private roots?: Promise<{ worktrees: Map<TaskRecord, string[]>; reportDirs: Map<TaskRecord, string>; known: Set<string> }>;
  private readonly real = new Map<string, Promise<string>>();
  private readonly memos = new Map<string, Promise<unknown>>();
  /** Counters for the run summary and the scale tests. */
  readonly stats = { prechecks: 0, inventories: 0, symlinkWalks: 0, walkedDirs: 0, reportReads: 0 };

  readonly ctx: Context;
  readonly policy: AutoGcSettings;
  private signal: AbortSignal | undefined;

  private readonly suspend: (() => Promise<void>) | undefined;
  private readonly indexedInventory: (() => Promise<RecordScan>) | undefined;

  constructor(ctx: Context, policy: AutoGcSettings, signal?: AbortSignal, suspend?: () => Promise<void>, indexedInventory?: () => Promise<RecordScan>) {
    this.suspend = suspend;
    this.indexedInventory = indexedInventory;
    this.ctx = ctx;
    this.policy = policy;
    this.signal = signal;
    this.startedAt = ctx.runner.now();
    this.deadline = this.startedAt + policy.maxRunS * 1000;
    this.key = autoGcPolicyKey(policy);
  }

  resume(signal?: AbortSignal): void {
    this.signal = signal;
    this.deadline = this.ctx.runner.now() + this.policy.maxRunS * 1000;
  }

  activeTime(): number { return this.ctx.runner.now() - this.pausedMs; }

  async checkpoint(): Promise<void> {
    if (this.suspend && !this.signal?.aborted && this.ctx.runner.now() >= this.deadline) {
      const pausedAt = this.ctx.runner.now();
      await this.suspend();
      this.pausedMs += Math.max(0, this.ctx.runner.now() - pausedAt);
    }
    this.check();
  }

  stopReason(): string | undefined {
    if (this.signal?.aborted) return 'zatrzymanie watch';
    if (!this.ctx.config.disk.autoGc.enabled || autoGcPolicyKey(this.ctx.config.disk.autoGc) !== this.key) return 'zmiana ustawień auto_gc';
    if (this.ctx.runner.now() >= this.deadline) return `limit czasu max_run_s (${this.policy.maxRunS} s)`;
    return undefined;
  }

  check(): void {
    const reason = this.stopReason();
    if (reason) throw new AutoGcStop(reason);
  }

  /** Called inside every walk: yields to the event loop regularly so the watch tick keeps running, and stops a run that must stop. */
  async pace(): Promise<void> {
    if (++this.ops % PACE === 0) { await nextTurn(); await this.checkpoint(); }
  }

  /** Realpath once per run; a missing path stays as written. */
  location(target: string): Promise<string> {
    const key = path.resolve(target);
    let found = this.real.get(key);
    if (!found) { found = fs.promises.realpath(key).catch(() => key); this.real.set(key, found); }
    return found;
  }

  inventory(): Promise<RecordScan> {
    if (!this.scan) { this.stats.inventories++; this.scan = this.indexedInventory?.() ?? snapshotRecords(this.ctx.config, true); }
    return this.scan;
  }

  /** Under the path claim: the same facts, re-read (unchanged TASK.md files come from the scan cache). Walk indexes stay. */
  refresh(): void {
    this.memos.clear();
    this.scan = snapshotRecords(this.ctx.config, true);
    this.liveSet = undefined;
    this.roots = undefined;
  }

  /** One answer per key until the next refresh (for example `git worktree list` of a repository with 2000 worktrees). */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
    let found = this.memos.get(key) as Promise<T> | undefined;
    if (!found) { found = compute(); this.memos.set(key, found); }
    return found;
  }

  async records(): Promise<TaskRecord[]> {
    return this.memo('local records', async () => {
      const { current, archived } = await this.inventory();
      const windows = new Set(current.map(record => record.window));
      return [...current, ...archived.filter(record => !windows.has(record.window))].filter(record => !record.host);
    });
  }

  live(): Promise<Set<string>> {
    this.liveSet ??= (async () => new Set([...await this.ctx.localTmux.listWindows(), ...pendingStarts(this.ctx.config).filter(start => !start.host).map(start => start.window)]))();
    return this.liveSet;
  }

  /** Real paths of every recorded worktree and report folder, computed once per inventory. */
  private rootIndex() {
    this.roots ??= (async () => {
      const worktrees = new Map<TaskRecord, string[]>(), reportDirs = new Map<TaskRecord, string>(), known = new Set<string>();
      for (const record of await this.records()) {
        const own: string[] = [];
        for (const repo of record.repos) {
          await this.pace();
          own.push(await this.location(repo.worktree));
          known.add(own.at(-1)!);
        }
        worktrees.set(record, own);
        if (record.report) {
          const dir = await this.location(path.dirname(record.report));
          reportDirs.set(record, dir);
          known.add(dir);
        }
      }
      return { worktrees, reportDirs, known };
    })();
    return this.roots;
  }

  async worktreeOwners(real: string): Promise<TaskRecord[]> {
    const { worktrees } = await this.rootIndex();
    return [...worktrees].filter(([, roots]) => roots.some(root => pathsOverlap(root, real))).map(([record]) => record);
  }

  async cacheOwners(real: string): Promise<TaskRecord[]> {
    const { reportDirs } = await this.rootIndex();
    return [...reportDirs].filter(([, dir]) => pathsOverlap(dir, real)).map(([record]) => record);
  }

  async knownRoots(): Promise<Set<string>> { return (await this.rootIndex()).known; }

  /** Declared links (active tasks' links and every known project's .agentctl.yaml), resolved once. */
  linkRefs() {
    this.refs ??= (async () => {
      const raw = knownLinkReferences(this.ctx.config, await this.inventory());
      const out: { source: string; any: boolean; real: string }[] = [];
      for (const ref of raw) {
        await this.pace();
        out.push(ref.target === '*' ? { source: ref.source, any: true, real: '' } : { source: ref.source, any: false, real: await this.location(ref.target.replace(/\/\*$/, '')) });
      }
      return out;
    })();
    return this.refs;
  }

  async linkUsers(target: string): Promise<string[]> {
    const real = await this.location(target);
    return [...new Set((await this.linkRefs()).filter(ref => ref.any || pathsOverlap(ref.real, real)).map(ref => ref.source))];
  }

  /**
   * Real symlinks in every recorded checkout and worktree, ignored files included, one walk per run. Inside node_modules only the
   * package level is read (node_modules/<pkg>, node_modules/@scope/<pkg>): that is where npm/yarn/pnpm put links to other folders;
   * .bin and the package contents link only within their own tree.
   */
  symlinks(): Promise<SymlinkEntry[]> {
    this.links ??= (async () => {
      this.stats.symlinkWalks++;
      const roots = new Set<string>();
      for (const record of await this.records()) for (const repo of record.repos) {
        for (const root of [repo.path, repo.worktree]) {
          await this.pace();
          if (await fs.promises.lstat(root).then(st => st.isDirectory(), () => false)) roots.add(await this.location(root));
        }
      }
      const entries: SymlinkEntry[] = [];
      const record = async (root: string, dir: string, name: string) => {
        const item = path.join(dir, name);
        const link = await fs.promises.readlink(item).catch(() => undefined);
        if (link === undefined) return;
        const targets = [path.resolve(dir, link)];
        const real = await fs.promises.realpath(item).catch(() => undefined);
        if (real) targets.push(real);
        entries.push({ root, link: item, targets });
      };
      const read = async (dir: string) => {
        await this.pace();
        this.stats.walkedDirs++;
        return fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
      };
      for (const root of roots) {
        const pending: { dir: string; modules: 0 | 1 | 2 }[] = [{ dir: root, modules: 0 }];
        while (pending.length) {
          const { dir, modules } = pending.pop()!;
          for (const entry of await read(dir)) {
            if (entry.name === '.git') continue;
            const item = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) await record(root, dir, entry.name);
            else if (entry.isDirectory()) {
              if (roots.has(item)) continue;
              if (modules === 0) pending.push({ dir: item, modules: entry.name === 'node_modules' ? 1 : 0 });
              else if (modules === 1 && entry.name.startsWith('@')) pending.push({ dir: item, modules: 2 });
            }
          }
        }
      }
      return entries;
    })();
    return this.links;
  }

  /** A symlink outside the candidate points into it. */
  async linkedInto(target: string): Promise<string | undefined> {
    const real = await this.location(target);
    const hit = (await this.symlinks()).find(entry => !pathsOverlap(entry.root, real) && entry.targets.some(t => pathsOverlap(t, real)));
    return hit?.link;
  }

  /** Paths named in reports (absolute, ~/, file://, and paths relative to the task's own worktrees), read once per run. */
  reportRefs() {
    this.reports ??= (async () => {
      const refs: { path: string; report: string }[] = [];
      for (const record of await this.records()) {
        const files = [...new Set([record.report, record.reportSource, ...(record.reportAlt ?? [])].filter((p): p is string => Boolean(p) && !/[?*]/.test(p!)))];
        for (const file of files) {
          await this.pace();
          const st = await fs.promises.stat(file).catch(() => undefined);
          if (!st?.isFile() || st.size > MAX_REPORT_BYTES) continue;
          this.stats.reportReads++;
          const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
          for (const match of text.matchAll(PATH_TOKEN)) {
            const value = match[0].replace(/[.:]+$/, '').replace(/^file:\/\//, '').replace(/^~\//, `${os.homedir()}/`);
            refs.push({ path: path.resolve(value), report: file });
          }
          for (const match of text.matchAll(RELATIVE_TOKEN)) {
            const value = match[0].replace(/[.:]+$/, '');
            for (const repo of record.repos) refs.push({ path: path.resolve(repo.worktree, value), report: file });
          }
        }
      }
      return refs;
    })();
    return this.reports;
  }

  /** M3: what queued, starting and needs-attention entries still need: their tasks, the tasks they build on, and the paths they name. */
  queueGuard(): QueueGuard {
    const tasks = new Map<string, string>(), paths: QueueGuard['paths'] = [];
    const home = os.homedir();
    const addPath = (value: string, task: string) => {
      const clean = value.replace(/^file:\/\//, '').replace(/[.:,;]+$/, '');
      if (!clean || clean.includes('{')) return;
      const full = clean === '~' ? home : clean.startsWith('~/') ? path.join(home, clean.slice(2)) : clean;
      if (path.isAbsolute(full)) paths.push({ path: path.resolve(full), task });
    };
    const addTask = (value: unknown, task: string) => {
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string' && item.trim()) tasks.set(item.trim().replace(/^@/, '').split(':')[0]!.toLowerCase(), task);
    };
    for (const entry of readQueue(this.ctx.config)) {
      const task = entry.task;
      addTask(task, task);
      addTask(entry.reviewOf, task);
      addTask(entry.after, task);
      addTask(entry.autoReview?.author, task);
      addTask(entry.directAuthor, task);
      let header: Record<string, unknown> = {}, prompt = '';
      try { const raw = splitSpecs(entry.spec, `queue entry ${task}`)[0]; header = raw?.header ?? {}; prompt = raw?.prompt ?? ''; } catch { prompt = entry.spec; }
      addTask(header.review_of, task);
      addTask(header.after, task);
      if (Array.isArray(header.repos)) for (const repo of header.repos) {
        if (!isObject(repo)) continue;
        if (typeof repo.base === 'string' && repo.base.startsWith('@')) addTask(repo.base, task);
        if (typeof repo.base_task === 'string') addTask(repo.base_task, task);
        if (typeof repo.worktree === 'string') addPath(repo.worktree, task);
      }
      if (typeof header.base_task === 'string') addTask(header.base_task, task);
      if (typeof header.reuse_worktree === 'string') addTask(header.reuse_worktree, task);
      if (typeof header.report === 'string') addPath(header.report, task);
      if (Array.isArray(header.links)) for (const link of header.links) if (isObject(link) && typeof link.to === 'string') addPath(link.to, task);
      for (const match of prompt.matchAll(PATH_TOKEN)) addPath(match[0], task);
    }
    return { tasks, paths };
  }

  /** The reason a queued task protects this candidate, or undefined. */
  async queueProtection(target: string, owners: TaskRecord[]): Promise<string | undefined> {
    const guard = this.policy.dryRun ? await this.memo('queue guard', async () => this.queueGuard()) : this.queueGuard();
    for (const owner of owners) {
      const by = guard.tasks.get(owner.task.toLowerCase());
      if (by) return `needed by queued task ${by}${by.toLowerCase() === owner.task.toLowerCase() ? '' : ` (uses ${owner.task})`}`;
    }
    if (!guard.paths.length) return undefined;
    const real = await this.location(target), known = await this.knownRoots();
    for (const named of guard.paths) {
      const where = await this.location(named.path);
      // A path inside the candidate, the candidate itself, or a task folder (worktree, report folder) that holds the candidate.
      if (pathsOverlap(where, real) && (where.startsWith(real) || known.has(where))) return `path named by queued task ${named.task}`;
    }
    return undefined;
  }
}

/** M2: which ignored files a worktree holds outside the throwaway list. A bare name matches at any depth, a path with "/" from the root. */
export async function valuableIgnored(run: AutoGcRun, worktree: string, ignored: string[]): Promise<{ valuable: string[]; throwaway: string[] }> {
  const ok = run.policy.ignoredOk;
  const valuable: string[] = [], throwaway: string[] = [];
  const allowed = (rel: string) => {
    const parts = rel.split('/');
    return ok.some(entry => entry.includes('/') ? rel === entry || rel.startsWith(`${entry}/`) : parts.includes(entry));
  };
  const visit = async (rel: string, dir: boolean, depth: number): Promise<void> => {
    await run.pace();
    if (allowed(rel)) { throwaway.push(rel); return; }
    if (dir && depth < 8 && ok.some(entry => entry.includes('/') && entry.startsWith(`${rel}/`))) {
      const children = await fs.promises.readdir(path.join(worktree, rel), { withFileTypes: true }).catch(() => undefined);
      if (children) {
        for (const child of children) await visit(`${rel}/${child.name}`, child.isDirectory() && !child.isSymbolicLink(), depth + 1);
        return;
      }
    }
    valuable.push(rel);
  };
  for (const entry of ignored) await visit(entry.replace(/\/+$/, ''), entry.endsWith('/'), 0);
  return { valuable, throwaway };
}
