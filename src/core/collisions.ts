import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { Notifier } from './notify.ts';
import type { Progress } from './progress.ts';
import { taskProgress } from './progress.ts';
import type { ResolvedSpec } from './spec.ts';
import type { StatusRow } from './status.ts';
import { listTaskRecords } from './taskstore.ts';
import { isObject } from './util.ts';

/*
 * Collisions: two active tasks working in the same source repository whose worktrees changed the same files. That is a merge conflict
 * waiting to happen, and it is cheap to say early. The data comes from git (commits over the base plus uncommitted files, see progress.ts).
 */

/** The files one task changed, per repository. */
export interface TaskFiles {
  task: string;
  repos: { repoPath: string; files: string[] }[];
}

/** Two tasks, one repository, the files both changed. */
export interface Overlap {
  a: string;
  b: string;
  repo: string;
  files: string[];
}

/** A pair of tasks (the key does not depend on the order), for the "one notification per pair" memory. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** A path glob: `**` crosses folders, `*` and `?` stay in one, `{a,b}` alternatives. A pattern without a slash matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
  const anywhere = !glob.includes('/');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',' && /\{[^}]*$/.test(glob.slice(0, i))) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${re}$`);
}

export const matchesAny = (file: string, globs: readonly string[]): boolean => globs.some((g) => globToRegExp(g).test(file));

/** The tasks that share files, one entry per pair and repository. Files that `ignore` matches never count. */
export function findOverlaps(tasks: readonly TaskFiles[], ignore: readonly string[] = []): Overlap[] {
  const overlaps: Overlap[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i] as TaskFiles;
      const b = tasks[j] as TaskFiles;
      for (const ra of a.repos) {
        const rb = b.repos.find((r) => r.repoPath === ra.repoPath);
        if (!rb) continue;
        const other = new Set(rb.files);
        const shared = ra.files.filter((f) => other.has(f) && !matchesAny(f, ignore)).sort();
        if (shared.length > 0) overlaps.push({ a: a.task, b: b.task, repo: ra.repoPath, files: shared });
      }
    }
  }
  return overlaps;
}

export function filesOfProgress(task: string, progress: Progress): TaskFiles {
  return { task, repos: progress.repos.map((r) => ({ repoPath: path.resolve(r.repoPath), files: r.fileNames })) };
}

/** What `status` and the board show for one task: the tasks it collides with and how many files they share. */
export interface Collide {
  task: string;
  files: number;
}

export function collideOf(overlaps: readonly Overlap[], task: string): Collide[] {
  const byOther = new Map<string, number>();
  for (const o of overlaps) {
    if (o.a !== task && o.b !== task) continue;
    const other = o.a === task ? o.b : o.a;
    byOther.set(other, (byOther.get(other) ?? 0) + o.files.length);
  }
  return [...byOther].map(([other, files]) => ({ task: other, files })).sort((x, y) => x.task.localeCompare(y.task));
}

/** "⚠ LANDING-QS-1: 2, NC-7: 1" (empty when there is nothing). */
export function collideText(collide: readonly Collide[]): string {
  return collide.length === 0 ? '' : `⚠ ${collide.map((c) => `${c.task}: ${c.files}`).join(', ')}`;
}

/** A task takes part in collisions while its window runs (a finished task changes nothing any more). */
const isActive = (r: Pick<StatusRow, 'window' | 'closed' | 'state'>): boolean => r.window === 'alive' && !r.closed && r.state !== 'superseded';

/**
 * Fill `collide` of the rows from the progress they carry. Rows without progress (git could not be asked, or it was not asked)
 * have nothing to compare and stay empty. Returns the overlaps it found.
 */
export function attachCollisions(rows: StatusRow[], ignore: readonly string[], enabled = true): Overlap[] {
  for (const r of rows) r.collide = [];
  if (!enabled) return [];
  const overlaps = findOverlaps(rows.filter((r) => isActive(r) && r.progress).map((r) => filesOfProgress(r.task, r.progress as Progress)), ignore);
  for (const r of rows) r.collide = collideOf(overlaps, r.task);
  return overlaps;
}

/** The files of every task with a live window, asked from git now. */
export async function collectActiveFiles(ctx: Context): Promise<TaskFiles[]> {
  const live = new Set(await ctx.tmux.listWindows());
  const tasks: TaskFiles[] = [];
  for (const record of listTaskRecords(ctx.config)) {
    if (record.closed || record.supersededBy || !live.has(record.window) || record.repos.length === 0) continue;
    const progress = await taskProgress(ctx.runner, record.repos);
    if (progress) tasks.push(filesOfProgress(record.task, progress));
  }
  return tasks;
}

/** `agentctl overlap`: every colliding pair, or only the ones with `task`. */
export async function collectOverlaps(ctx: Context, task?: string): Promise<Overlap[]> {
  const all = findOverlaps(await collectActiveFiles(ctx), ctx.config.collisions.ignore);
  return task ? all.filter((o) => o.a === task || o.b === task) : all;
}

export function renderOverlaps(overlaps: readonly Overlap[], limit = 20): string[] {
  if (overlaps.length === 0) return ['No two active tasks change the same files.'];
  const lines: string[] = [];
  for (const o of overlaps) {
    lines.push(`${o.a} <-> ${o.b}  ${o.files.length} shared file${o.files.length === 1 ? '' : 's'}  (${o.repo})`);
    for (const f of o.files.slice(0, limit)) lines.push(`  ${f}`);
    if (o.files.length > limit) lines.push(`  … and ${o.files.length - limit} more`);
  }
  return lines;
}

// ---- touches: the warning before a task starts

/**
 * For every spec with `touches`: the active tasks of the same repository that already change files matching its globs.
 * Returns warning lines (empty when there is nothing to say). A spec without `touches` is not checked.
 */
export async function touchWarnings(ctx: Context, specs: readonly ResolvedSpec[]): Promise<string[]> {
  const asking = specs.filter((s) => s.touches.length > 0);
  if (asking.length === 0 || !ctx.config.collisions.enabled) return [];
  const active = await collectActiveFiles(ctx);
  const warnings: string[] = [];
  for (const spec of asking) {
    for (const repo of spec.repos) {
      const repoPath = path.resolve(repo.path);
      for (const t of active) {
        if (t.task === spec.task) continue;
        const mine = t.repos.find((r) => r.repoPath === repoPath);
        const files = (mine?.files ?? []).filter((f) => matchesAny(f, spec.touches) && !matchesAny(f, ctx.config.collisions.ignore));
        if (files.length === 0) continue;
        warnings.push(`${spec.task} touches ${spec.touches.join(', ')}, and ${t.task} already changes ${files.length} matching file${files.length === 1 ? '' : 's'} in ${repoPath}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? ', …' : ''}`);
      }
    }
  }
  return warnings;
}

// ---- watch: one notification per new pair

/** What the watcher remembers: the pairs it announced (kept in a file, so a restart does not announce them again) and the time of the last check. */
export class CollisionMemory {
  lastCheck: number | undefined;
  pairs: Set<string> | undefined;
}

const memoryFile = (ctx: Context): string => path.join(path.dirname(ctx.config.path), 'collisions.json');

function loadPairs(ctx: Context): Set<string> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(memoryFile(ctx), 'utf8'));
    if (isObject(data) && Array.isArray(data.pairs)) return new Set(data.pairs.filter((x): x is string => typeof x === 'string'));
  } catch {
    // none yet
  }
  return new Set();
}

export const collisionText = (o: Overlap): string => `⚠ ${o.a} i ${o.b} zmieniają te same pliki (${o.files.length}): ${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? ', …' : ''}`;

/**
 * Every `collisions.interval` seconds: ask git for the changed files of the active tasks and announce each pair that is new since the
 * last check (once; when it goes away and comes back it is new again). Returns the overlaps found, or undefined when it was not time.
 */
export async function collisionTick(ctx: Context, memory: CollisionMemory, notifier: Notifier, log?: (line: string) => Promise<void> | void): Promise<Overlap[] | undefined> {
  const { collisions } = ctx.config;
  if (!collisions.enabled) return undefined;
  const now = ctx.runner.now();
  if (memory.lastCheck !== undefined && now - memory.lastCheck < collisions.interval * 1000) return undefined;
  memory.lastCheck = now;
  const overlaps = await collectOverlaps(ctx);
  const known = (memory.pairs ??= loadPairs(ctx));
  const current = new Set(overlaps.map((o) => pairKey(o.a, o.b)));
  const announced = new Set<string>();
  for (const o of overlaps) {
    const key = pairKey(o.a, o.b);
    if (known.has(key) || announced.has(key)) continue;
    announced.add(key);
    // one message per pair, with all its files (a pair can collide in several repositories)
    const all = { ...o, files: overlaps.filter((x) => pairKey(x.a, x.b) === key).flatMap((x) => x.files) };
    await log?.(collisionText(all));
    if (collisions.notify) await notifier.notify('agentctl', collisionText(all)).catch(() => undefined);
  }
  const next = new Set(current);
  const changed = next.size !== known.size || [...next].some((k) => !known.has(k));
  memory.pairs = next;
  if (changed) await ctx.runner.writeFile(memoryFile(ctx), `${JSON.stringify({ pairs: [...next].sort() }, null, 2)}\n`);
  return overlaps;
}
