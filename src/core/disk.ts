import { readQueue } from './queue.ts';
import { resolveSpec, splitSpecs } from './spec.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from './config.ts';
import type { Context } from './context.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import { sizeOf } from './gc.ts';
import { resolvePath } from './util.ts';
import { recordJournal } from './journal.ts';
import type { Notifier } from './notify.ts';
import { withFileLock } from './file-lock.ts';

export type DiskLevel = 'ok' | 'warn' | 'critical' | 'unknown';
export interface DiskVolume { device: string | null; paths: string[]; availableBytes: number | null; totalBytes: number | null; level: DiskLevel; error?: string }
export interface DiskReport { worktreeCount?: number; largestWorktrees?: { path: string; bytes: number }[]; pathsTotal?: number; pathsOffset?: number; pathsNextOffset?: number | null; volumes: DiskVolume[]; worktreeBytes: number | null; measuredAt: string; level: DiskLevel }
export const DISK_INTERVAL_MS = 5 * 60_000;
const sizes = new Map<string, { at: number; bytes: number | null; worktrees?: { path: string; bytes: number }[] }>();
export function diskLevel(bytes: number | null, warnGb: number, criticalGb: number): DiskLevel {
  return bytes === null ? 'unknown' : bytes < criticalGb * 1024 ** 3 ? 'critical' : bytes < warnGb * 1024 ** 3 ? 'warn' : 'ok';
}
function existingAncestor(target: string): string {
  let current = target;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}
export async function collectDisk(ctx: Context, statfs = fs.promises.statfs, opts: { detail?: boolean; offset?: number; limit?: number } = {}): Promise<DiskReport> {
  const records = [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
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
  const key = `${ctx.config.path}:${JSON.stringify(worktrees)}`;
  const sizeFile = path.join(path.dirname(ctx.config.path), 'disk-sizes.json');
  let size = sizes.get(key);
  if (!size) {
    try {
      const cached = JSON.parse(fs.readFileSync(sizeFile, 'utf8'));
      if (cached.key === key && Array.isArray(cached.worktrees) && typeof cached.at === 'number' && (cached.bytes === null || typeof cached.bytes === 'number') && ctx.runner.now() >= cached.at && ctx.runner.now() - cached.at < DISK_INTERVAL_MS) size = { at: cached.at, bytes: cached.bytes, worktrees: cached.worktrees };
    } catch { /* first read or torn cache */ }
  }
  if (!size || ctx.runner.now() - size.at >= DISK_INTERVAL_MS) {
    try { const entries = worktrees.map(wt => ({ path: wt, bytes: sizeOf(wt) })).sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)); size = { at: ctx.runner.now(), bytes: entries.reduce((n, wt) => n + wt.bytes, 0), worktrees: entries }; }
    catch { size = { at: ctx.runner.now(), bytes: null }; }
    try { await ctx.runner.writeFile(sizeFile, JSON.stringify({ key, ...size })); } catch { /* cache cannot make a read fail */ }
    sizes.set(key, size);
    if (sizes.size > 32) sizes.delete(sizes.keys().next().value!);
  }
  const all = [...volumes.values()];
  const level = (['critical', 'warn', 'unknown', 'ok'] as const).find((l) => all.some((v) => v.level === l)) ?? 'unknown';
  const offset = opts.offset ?? 0, limit = Math.min(opts.limit ?? 20, 100);
  const paths = all.flatMap(v => v.paths), page = new Set(opts.detail ? paths.slice(offset, offset + limit) : []);
  return { worktreeCount: worktrees.length, largestWorktrees: size.worktrees?.slice(0, 5) ?? [], pathsTotal: paths.length, pathsOffset: offset, pathsNextOffset: opts.detail && offset + limit < paths.length ? offset + limit : null, volumes: all.map(v => ({ ...v, pathCount: v.paths.length, paths: v.paths.filter(p => page.has(p)) })), worktreeBytes: size.bytes, measuredAt: new Date(size.at).toISOString(), level };
}
export function diskLine(disk: DiskReport): string {
  return `Disk: ${disk.level}; free ${disk.volumes.map((v) => v.availableBytes === null ? 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`).join(' / ')}; agentctl worktrees ${disk.worktreeBytes === null ? 'n/d' : `${(disk.worktreeBytes / 1024 ** 3).toFixed(1)} GiB`}${disk.level === 'critical' || disk.level === 'warn' ? '; inspect gc_preview / agentctl gc' : ''}`;
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
