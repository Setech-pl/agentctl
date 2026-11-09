import { readQueue } from './queue.ts';
import { resolveSpec, splitSpecs } from './spec.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from './config.ts';
import type { Context } from './context.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { cachedMeasurement, configureMeasurements, requestMeasurement, restoreMeasurements, lastMeasurement } from './fs-measure.ts';
import type { PathMeasurement } from './fs-measure.ts';
import { resolvePath } from './util.ts';
import { recordJournal } from './journal.ts';
import type { Notifier } from './notify.ts';
import { fileVersion } from './file-version.ts';
import { withFileLock } from './file-lock.ts';

export type DiskLevel = 'ok' | 'warn' | 'critical' | 'unknown';
export interface DiskVolume { device: string | null; paths: string[]; availableBytes: number | null; totalBytes: number | null; level: DiskLevel; error?: string }
export interface DiskReport { reclaimableBytes?: number | null; gcHint?: boolean; measurementError?: string; /** The sizes below are the last ones measured (or none yet): a measurement is still running in the background. */ measuring?: boolean; worktreeCount?: number; largestWorktrees?: { path: string; bytes: number }[]; pathsTotal?: number; pathsOffset?: number; pathsNextOffset?: number | null; volumes: DiskVolume[]; worktreeBytes: number | null; measuredAt: string; level: DiskLevel }
export const DISK_INTERVAL_MS = 5 * 60_000;
const restored = new Map<string, string>();
export function diskLevel(bytes: number | null, warnGb: number, criticalGb: number): DiskLevel {
  return bytes === null ? 'unknown' : bytes < criticalGb * 1024 ** 3 ? 'critical' : bytes < warnGb * 1024 ** 3 ? 'warn' : 'ok';
}
function existingAncestor(target: string): string {
  let current = target;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
/** Read cached sizes only. Watch owns measurement jobs; no read starts a walk or writes the size cache. */
export async function collectDisk(ctx: Context, statfs = fs.promises.statfs, opts: { detail?: boolean; offset?: number; limit?: number; budgetMs?: number; records?: TaskRecord[] } = {}): Promise<DiskReport> {
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
  let version: string | undefined;
  try { version = fileVersion(fs.statSync(sizeFile, { bigint: true })); } catch { /* no persisted sample yet */ }
  if (!version || restored.get(sizeFile) !== version) {
    if (version) restored.set(sizeFile, version);
    try {
      const stored = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
      // Old aggregate timestamps cannot establish the ages of individual paths.
      if (stored.version === 2) restoreMeasurements(stored.entries, ctx.runner.now());
    } catch { /* first reading, torn or incompatible cache */ }
  }
  const values = worktrees.flatMap(wt => { const m = lastMeasurement(wt); return m ? [m] : []; });
  const pending = values.length < worktrees.length;
  const measurementError = undefined;
  const measuredAt = values.length ? Math.min(...values.map(m => m.at)) : ctx.runner.now();
  const worktreeBytes = values.length === worktrees.length ? values.reduce((n, m) => n + m.bytes, 0) : null;
  const largestWorktrees = values.map(m => ({ path: m.target, bytes: m.bytes })).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 5);
  // Compare sizes only with their own filesystem; do not charge one disk for another's worktrees.
  const byDevice = new Map<string, number>();
  for (const measurement of values) {
    try {
      const device = String(fs.statSync(measurement.target).dev);
      byDevice.set(device, (byDevice.get(device) ?? 0) + measurement.bytes);
    } catch { /* disappeared since measurement */ }
  }
  for (const volume of volumes.values()) {
    const bytes = byDevice.get(volume.device ?? '') ?? 0;
    if (volume.totalBytes && bytes / volume.totalBytes * 100 > ctx.config.disk.worktreeSharePercent && volume.level !== 'critical') volume.level = 'warn';
  }
  const gcHint = [...volumes.values()].some(v => v.level === 'warn' || v.level === 'critical');
  // A disk read never computes a GC plan; that belongs to an explicit gc preview.
  const reclaimableBytes = null;
  const all = [...volumes.values()];
  const level = (['critical', 'warn', 'unknown', 'ok'] as const).find((l) => all.some((v) => v.level === l)) ?? 'unknown';
  const offset = opts.offset ?? 0, limit = Math.min(opts.limit ?? 20, 100);
  const paths = all.flatMap(v => v.paths), page = new Set(opts.detail ? paths.slice(offset, offset + limit) : []);
  return { gcHint, reclaimableBytes, worktreeCount: worktrees.length, largestWorktrees, pathsTotal: paths.length, pathsOffset: offset, pathsNextOffset: opts.detail && offset + limit < paths.length ? offset + limit : null, volumes: all.map(v => ({ ...v, pathCount: v.paths.length, paths: v.paths.filter(p => page.has(p)) })), worktreeBytes, measuredAt: new Date(measuredAt).toISOString(), level, ...(pending ? { measuring: true } : {}), ...(measurementError ? { measurementError } : {}) };
}
/** A reading older than this is shown with its age next to the number (a gc or a quiet minute can make it stale). */
export const READING_AGE_WARN_MS = 10 * 60_000;
function readingAge(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}
export function diskLine(disk: DiskReport, now: number = Date.now()): string {
  const age = `, ${readingAge(Math.max(0, now - Date.parse(disk.measuredAt)))} old`;
  const note = disk.measuring ? ` (measuring, last reading${age})` : disk.measurementError ? ` (measurement failed, last reading${age})` : age ? ` (last reading${age})` : '';
  return `Disk: ${disk.level}; free ${disk.volumes.map((v) => v.availableBytes === null ? 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`).join(' / ')}; agentctl worktrees ${disk.worktreeBytes === null ? 'n/d' : `${(disk.worktreeBytes / 1024 ** 3).toFixed(1)} GiB`}${note}${disk.level === 'critical' || disk.level === 'warn' ? `; run agentctl gc --preview (gc_preview); reclaimable ${disk.reclaimableBytes ?? 'n/d'} bytes` : ''}`;
}

/**
 * After gc, publish gc's own accounting. Never walk surviving worktrees to explain bytes just removed.
 */
export async function refreshDiskAfterGc(ctx: Context, freedBytes: number): Promise<string | null> {
  if (ctx.runner.dryRun) return null;
  await persistDiskMeasurements(ctx);
  const disk = await collectDisk(ctx);
  const free = disk.volumes.map((v) => v.availableBytes === null ? 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`).join(' / ');
  const text = `gc freed ${(freedBytes / 1024 ** 3).toFixed(1)} GiB, free now ${free}`;
  await recordJournal(ctx, { kind: 'gc-freed', text });
  return text;
}
async function persistDiskMeasurements(ctx: Context): Promise<void> {
  const worktrees = [...new Set([...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)].flatMap(r => r.repos.map(r => r.worktree)))];
  const entries = worktrees.flatMap(wt => { const m = lastMeasurement(wt); return m ? [m] : []; });
  await ctx.runner.writeFile(path.join(path.dirname(ctx.config.path), 'disk-sizes.json'), JSON.stringify({ version: 2, entries }));
}
const refreshing = new Set<string>();
const refreshed = new Map<string, number>();
/** Incremental watch inventory: one stale worktree per tick, at most once per 5 seconds; workers run at nice 10. */
export async function refreshDiskMeasurements(ctx: Context): Promise<void> {
  const key = ctx.config.path, now = ctx.runner.now();
  if (ctx.runner.dryRun || refreshing.has(key) || now - (refreshed.get(key) ?? -Infinity) < 5000) return;
  refreshed.set(key, now);
  await collectDisk(ctx); // restore persisted readings without scheduling any work
  const targets = [...new Set([...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)].flatMap(r => r.repos.map(r => r.worktree)))];
  const target = targets.sort((a, b) => (lastMeasurement(a)?.at ?? 0) - (lastMeasurement(b)?.at ?? 0)).find(wt => !cachedMeasurement(wt) || now - lastMeasurement(wt)!.at >= DISK_INTERVAL_MS);
  if (!target) return;
  configureMeasurements(ctx.config.disk);
  refreshing.add(key);
  const lease = requestMeasurement(target, { background: true, now: () => ctx.runner.now() });
  try { await lease.promise; await persistDiskMeasurements(ctx); }
  finally { lease.release(); refreshing.delete(key); }
}
const sampled = new Map<string, number>();
export async function diskTick(ctx: Context, notifier: Notifier): Promise<void> {
  void refreshDiskMeasurements(ctx).catch(() => undefined);
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
