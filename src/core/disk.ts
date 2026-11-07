import { readQueue } from './queue.ts';
import { resolveSpec, splitSpecs } from './spec.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from './config.ts';
import type { Context } from './context.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { cachedMeasurement, configureMeasurements, requestMeasurement, restoreMeasurements } from './fs-measure.ts';
import type { PathMeasurement } from './fs-measure.ts';
import { resolvePath } from './util.ts';
import { recordJournal } from './journal.ts';
import type { Notifier } from './notify.ts';
import { withFileLock } from './file-lock.ts';

export type DiskLevel = 'ok' | 'warn' | 'critical' | 'unknown';
export interface DiskVolume { device: string | null; paths: string[]; availableBytes: number | null; totalBytes: number | null; level: DiskLevel; error?: string }
export interface DiskReport { measurementError?: string; /** The sizes below are the last ones measured (or none yet): a measurement is still running in the background. */ measuring?: boolean; worktreeCount?: number; largestWorktrees?: { path: string; bytes: number }[]; pathsTotal?: number; pathsOffset?: number; pathsNextOffset?: number | null; volumes: DiskVolume[]; worktreeBytes: number | null; measuredAt: string; level: DiskLevel }
export const DISK_INTERVAL_MS = 5 * 60_000;
const inventories = new Map<string, { id: string; signature?: string }>();
const restored = new Set<string>();
export function diskLevel(bytes: number | null, warnGb: number, criticalGb: number): DiskLevel {
  return bytes === null ? 'unknown' : bytes < criticalGb * 1024 ** 3 ? 'critical' : bytes < warnGb * 1024 ** 3 ? 'warn' : 'ok';
}
function existingAncestor(target: string): string {
  let current = target;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
/**
 * `budgetMs`: how long this call may wait for the size of the worktrees (the MCP server passes about a second). The walk of a few dozen worktrees
 * with node_modules takes minutes; it continues in the background (asynchronously, never on the event loop) and the call answers with the last
 * reading, or with "n/d" and `measuring: true` when there is none yet. Without a budget the call waits for the measurement.
 */
export async function collectDisk(ctx: Context, statfs = fs.promises.statfs, opts: { detail?: boolean; offset?: number; limit?: number; budgetMs?: number; records?: TaskRecord[] } = {}): Promise<DiskReport> {
  configureMeasurements(ctx.config.disk);
  const records = opts.records ?? [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
  const targets = new Set([ctx.config.cache, ctx.config.stateDir]);
  if (ctx.config.worktreeRoot) targets.add(resolvePath(ctx.config.worktreeRoot));
  const queuedRepos = readQueue(ctx.config).flatMap((entry) => {
    try { return resolveSpec(splitSpecs(entry.spec, 'disk queue inventory')[0]!, { config: ctx.config }).repos; }
    catch { return []; }
  });
  for (const repo of [...records.flatMap((r) => r.repos), ...queuedRepos]) {
    targets.add(repo.worktree);
    try {
      const root = loadProjectConfig(repo.path)?.worktreeRoot;
      if (root) targets.add(resolvePath(root, repo.path));
    } catch { /* invalid project config does not hide other volumes */ }
  }
  const volumes = new Map<string, DiskVolume>();
  for (const target of targets) {
    const ancestor = existingAncestor(target);
    let device: string | null = null;
    let availableBytes: number | null = null;
    let totalBytes: number | null = null;
    let error: string | undefined;
    try { device = String(fs.statSync(ancestor).dev); } catch { /* n/d */ }
    const key = device ?? target;
    if (volumes.has(key)) { volumes.get(key)!.paths.push(target); continue; }
    try {
      const st = await statfs(ancestor);
      availableBytes = Number(st.bavail) * Number(st.bsize);
      totalBytes = Number(st.blocks) * Number(st.bsize);
    } catch (e) {
      const r = await ctx.runner.exec('df', ['-kP', ancestor], { readOnly: true });
      const fields = r.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/);
      if (r.code === 0 && fields && fields.length >= 6 && /^\d+$/.test(fields[3]!)) {
        availableBytes = Number(fields[3]) * 1024; totalBytes = Number(fields[1]) * 1024;
      } else error = e instanceof Error ? e.message : String(e);
    }
    volumes.set(key, { device, paths: [target], availableBytes, totalBytes, level: diskLevel(availableBytes, ctx.config.disk.warnGb, ctx.config.disk.criticalGb), ...(error ? { error } : {}) });
  }
  const worktrees = [...new Set(records.flatMap((r) => r.repos.map((r) => r.worktree)))].sort();
  const sizeFile = path.join(path.dirname(ctx.config.path), 'disk-sizes.json');
  if (!restored.has(sizeFile)) {
    restored.add(sizeFile);
    try {
      const stored = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
      // Old aggregate timestamps cannot establish the ages of individual paths.
      if (stored.version === 2) restoreMeasurements(stored.entries, ctx.runner.now());
    } catch { /* first reading, torn or incompatible cache */ }
  }
  const id = JSON.stringify(worktrees);
  let inventory = inventories.get(ctx.config.path);
  if (!inventory || inventory.id !== id) { inventory = { id }; inventories.set(ctx.config.path, inventory); }
  const current = inventory;
  const leases = worktrees.map(wt => {
    try { return requestMeasurement(wt, { background: opts.budgetMs !== undefined, now: () => ctx.runner.now() }); }
    catch (error) { return { promise: Promise.reject<PathMeasurement>(error), startedAt: Date.now(), release() {} }; }
  });
  const done = Promise.allSettled(leases.map(l => l.promise)).then(results => {
    for (const lease of leases) lease.release();
    return results;
  });
  const entries = (): PathMeasurement[] => worktrees.flatMap(wt => {
    try { const m = cachedMeasurement(wt); return m ? [m] : []; } catch { return []; }
  });
  // Persist only the current inventory. Older consumers join path jobs; they never publish a superseded aggregate.
  void done.then(async results => {
    if (results.some(r => r.status === 'rejected') || inventories.get(ctx.config.path) !== current) return;
    const values = entries();
    const signature = JSON.stringify(values);
    if (current.signature === signature) return;
    current.signature = signature;
    try { await ctx.runner.writeFile(sizeFile, JSON.stringify({ version: 2, entries: values })); }
    catch { if (current.signature === signature) current.signature = undefined; }
  }).catch(() => undefined);
  let pending = false;
  let completed: Awaited<typeof done> | undefined;
  if (opts.budgetMs === undefined) completed = await done;
  else {
    const known = entries().length > 0;
    const startedAt = Math.min(Date.now(), ...leases.map(l => l.startedAt));
    const wait = Math.max(0, (known ? Math.min(opts.budgetMs, 250) : opts.budgetMs) - (Date.now() - startedAt));
    let timer: NodeJS.Timeout | undefined;
    completed = await Promise.race([done, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), wait); })]);
    clearTimeout(timer);
    pending = completed === undefined;
  }
  const values = entries();
  const failures = completed?.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  const measurementError = failures?.length ? String(failures[0]!.reason instanceof Error ? failures[0]!.reason.message : failures[0]!.reason) : undefined;
  const measuredAt = values.length ? Math.min(...values.map(m => m.at)) : ctx.runner.now();
  const worktreeBytes = values.length || worktrees.length === 0 ? values.reduce((n, m) => n + m.bytes, 0) : null;
  const largestWorktrees = values.map(m => ({ path: m.target, bytes: m.bytes })).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 5);
  if (!measurementError && values.length < worktrees.length) pending = true;
  const all = [...volumes.values()];
  const level = (['critical', 'warn', 'unknown', 'ok'] as const).find((l) => all.some((v) => v.level === l)) ?? 'unknown';
  const offset = opts.offset ?? 0, limit = Math.min(opts.limit ?? 20, 100);
  const paths = all.flatMap(v => v.paths), page = new Set(opts.detail ? paths.slice(offset, offset + limit) : []);
  return { worktreeCount: worktrees.length, largestWorktrees, pathsTotal: paths.length, pathsOffset: offset, pathsNextOffset: opts.detail && offset + limit < paths.length ? offset + limit : null, volumes: all.map(v => ({ ...v, pathCount: v.paths.length, paths: v.paths.filter(p => page.has(p)) })), worktreeBytes, measuredAt: new Date(measuredAt).toISOString(), level, ...(pending ? { measuring: true } : {}), ...(measurementError ? { measurementError } : {}) };
}
export function diskLine(disk: DiskReport): string {
  return `Disk: ${disk.level}; free ${disk.volumes.map((v) => v.availableBytes === null ? 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`).join(' / ')}; agentctl worktrees ${disk.worktreeBytes === null ? 'n/d' : `${(disk.worktreeBytes / 1024 ** 3).toFixed(1)} GiB`}${disk.measuring ? ' (measuring, last reading)' : disk.measurementError ? ' (measurement failed, last reading)' : ''}${disk.level === 'critical' || disk.level === 'warn' ? '; inspect gc_preview / agentctl gc' : ''}`;
}
const sampled = new Map<string, number>();
export async function diskTick(ctx: Context, notifier: Notifier): Promise<void> {
  const file = path.join(path.dirname(ctx.config.path), 'disk-state.json');
  if (ctx.runner.dryRun || ctx.runner.now() - (sampled.get(file) ?? -Infinity) < DISK_INTERVAL_MS) return;
  sampled.set(file, ctx.runner.now());
  await withFileLock(`${file}.lock`, async () => {
    const report = await collectDisk(ctx);
    let previous: Record<string, DiskLevel> = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first reading */ }
    const next: Record<string, DiskLevel> = {};
    for (const volume of report.volumes) {
      const id = volume.device ?? 'unknown';
      next[id] = volume.level;
      if (volume.level === 'unknown' || previous[id] === volume.level || (!previous[id] && volume.level === 'ok')) continue;
      const text = diskLine({ ...report, volumes: [volume], level: volume.level });
      await notifier.notify('agentctl', text).catch(() => undefined);
      await recordJournal(ctx, { kind: `disk-${volume.level}`, text });
    }
    await ctx.runner.writeFile(file, JSON.stringify(next));
  });
}

/** A low-disk start remains an explicit user choice, never an automatic hard limit. */
export async function confirmDiskStart(ctx: Context, yes = false): Promise<boolean> {
  const disk = await collectDisk(ctx);
  if (disk.level !== 'critical') return true;
  ctx.info(`WARNING: ${diskLine(disk)}. Review agentctl gc before starting more work.`);
  if (yes) return true;
  if (!ctx.confirm) throw new Error('Disk critical: rerun with --yes after reviewing agentctl gc, or free disk space.');
  return ctx.confirm('Disk critical. Start anyway? [y/N] ');
}
