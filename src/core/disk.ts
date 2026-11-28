import { kickAutoGc } from './auto-gc.ts';
import { planRemoteGc } from './host-gc.ts';
import { readHostsCache, writeHostsCache } from './hosts.ts';
import { probeHosts, probeLocalHost } from './host-health.ts';
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
import { inferredWorktreeMount, missingWorktreeVolume, volumeMounted, type WorktreeVolume } from './worktree-volume.ts';
import { nodeModulesStore, type NodeModulesStore } from './node-modules-store.ts';

type DiskWorktree = WorktreeVolume & { nodeModules?: 'clone' };

export type DiskLevel = 'ok' | 'warn' | 'critical' | 'unknown';
export interface DiskVolume { host?: string; workDir?: string; samplePath?: string; mount?: string; worktreeShareWarning?: {bytes: number; measuredAt: string; ageSeconds: number}; device: string | null; paths: string[]; availableBytes: number | null; totalBytes: number | null; level: DiskLevel; error?: string }
export interface DiskReport { nodeModulesStore?: NodeModulesStore; freeMeasuredAt?: string; worktreeAgeSeconds?: number; gcPolicyNote?: string; reclaimableBytes?: number | null; gcHint?: boolean; measurementError?: string; /** The sizes below are the last ones measured (or none yet): a measurement is still running in the background. */ measuring?: boolean; worktreeCount?: number; largestWorktrees?: { path: string; bytes: number }[]; pathsTotal?: number; pathsOffset?: number; pathsNextOffset?: number | null; volumes: DiskVolume[]; worktreeBytes: number | null; measuredAt: string; level: DiskLevel }
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
const FREE_SPACE_BUDGET_MS = 1000;
const START_DISK_BUDGET_MS = 5000;
type Statfs = typeof fs.promises.statfs;
const pendingStats = new WeakMap<Statfs, Map<string, ReturnType<Statfs>>>();

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`free-space probe timed out after ${ms} ms`)), ms);
    });
    return await Promise.race([work, expired]);
  } finally { clearTimeout(timer); }
}

async function freeSpace(ctx: Context, ancestor: string, statfs: Statfs, budgetMs: number) {
  const timeoutMs = Math.max(1, Math.floor(budgetMs / 2));
  let pending = pendingStats.get(statfs);
  if (!pending) { pending = new Map(); pendingStats.set(statfs, pending); }
  let sample = pending.get(ancestor);
  if (!sample) {
    const requests = pending;
    sample = Promise.resolve().then(() => statfs(ancestor)).finally(() => requests.delete(ancestor));
    requests.set(ancestor, sample);
  }
  try {
    const st = await bounded(sample, timeoutMs);
    return { availableBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
  } catch (statError) {
    try {
      const r = await bounded(ctx.runner.exec('df', ['-kP', ancestor], { readOnly: true, timeoutMs }), timeoutMs);
      const fields = r.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/);
      if (r.code === 0 && fields && fields.length >= 6 && /^\d+$/.test(fields[1]!) && /^\d+$/.test(fields[3]!)) {
        return { availableBytes: Number(fields[3]) * 1024, totalBytes: Number(fields[1]) * 1024 };
      }
    } catch { /* return the failed sample below */ }
    return { availableBytes: null, totalBytes: null, error: statError instanceof Error ? statError.message : String(statError) };
  }
}

/** Read cached sizes only. Watch owns measurement jobs; no read starts a walk or writes the size cache. */
export async function collectDisk(ctx: Context, statfs = fs.promises.statfs, opts: { detail?: boolean; offset?: number; limit?: number; budgetMs?: number; records?: TaskRecord[]; asyncPaths?: boolean } = {}): Promise<DiskReport> {
  const records = (opts.records ?? [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)]).filter(r => !r.host);
  const targets = new Map<string, string | undefined>([[ctx.config.cache, undefined], [ctx.config.stateDir, undefined]]);
  const store = nodeModulesStore(ctx.config);
  if (store) targets.set(path.dirname(ctx.config.path), undefined);
  if (ctx.config.worktreeRoot) {
    const root = resolvePath(ctx.config.worktreeRoot);
    targets.set(root, ctx.config.worktreeMount ? resolvePath(ctx.config.worktreeMount) : inferredWorktreeMount(root));
  }
  const queuedRepos = readQueue(ctx.config).flatMap((entry) => {
    try { const spec = resolveSpec(splitSpecs(entry.spec, 'disk queue inventory')[0]!, { config: ctx.config }); return spec.host ? [] : spec.repos; }
    catch { return []; }
  });
  const repoPaths = new Set<string>();
  for (const repo of [...records.flatMap((r) => r.repos), ...queuedRepos]) {
    targets.set(repo.worktree, repo.worktreeMount ?? inferredWorktreeMount(repo.worktree));
    repoPaths.add(repo.path);
  }
  for (const repoPath of repoPaths) {
    try {
      const project = loadProjectConfig(repoPath);
      if (project?.worktreeRoot) {
        const root = resolvePath(project.worktreeRoot);
        targets.set(root, project.worktreeMount ? resolvePath(project.worktreeMount) : inferredWorktreeMount(root));
      }
    } catch { /* invalid project config does not hide other volumes */ }
  }
  const mounted = new Map<string, boolean>();
  const onVolume = (mount: string): boolean => {
    if (!mounted.has(mount)) mounted.set(mount, volumeMounted(mount));
    return mounted.get(mount)!;
  };
  const volumes = new Map<string, DiskVolume>();
  const devices = new Map<string, number>();
  if (opts.asyncPaths) {
    const mountedTargets = [...targets].filter(([, mount]) => !mount || onVolume(mount));
    for (let i = 0; i < mountedTargets.length; i += 128) {
      await Promise.all(mountedTargets.slice(i, i + 128).map(async ([target]) => {
        try { devices.set(target, (await fs.promises.stat(target)).dev); } catch { /* use the nearest existing ancestor */ }
      }));
    }
  }
  for (const [target, mount] of targets) {
    if (mount && !onVolume(mount)) {
      const key = `missing:${mount}`;
      if (volumes.has(key)) volumes.get(key)!.paths.push(target);
      else volumes.set(key, { mount, samplePath: target, paths: [target], device: null, availableBytes: null, totalBytes: null, level: 'unknown', error: 'volume missing' });
      continue;
    }
    let ancestor = target;
    let device: string | null = null;
    try {
      const dev = opts.asyncPaths ? devices.get(target) : fs.statSync(target, {throwIfNoEntry: false})?.dev;
      if (dev !== undefined) device = String(dev);
      else {
        ancestor = existingAncestor(path.dirname(target));
        device = String(fs.statSync(ancestor).dev);
      }
    } catch { /* n/d */ }
    const key = device ?? target;
    if (volumes.has(key)) { const volume = volumes.get(key)!; volume.paths.push(target); if (mount) volume.mount ??= mount; continue; }
    volumes.set(key, { samplePath: ancestor, ...(mount ? { mount } : {}), device, paths: [target], availableBytes: null, totalBytes: null, level: 'unknown' });
  }
  await Promise.all([...volumes.values()].map(async volume => {
    if (volume.error === 'volume missing') return;
    const sampled = await freeSpace(ctx, volume.samplePath!, statfs, opts.budgetMs ?? FREE_SPACE_BUDGET_MS);
    if (volume.mount && !volumeMounted(volume.mount)) {
      Object.assign(volume, { device: null, error: 'volume missing' });
      return;
    }
    Object.assign(volume, sampled);
    volume.level = diskLevel(volume.availableBytes, ctx.config.disk.warnGb, ctx.config.disk.criticalGb);
  }));
  const worktrees = [...new Set(records.flatMap((r) => r.repos.map((r) => r.worktree)))].sort();
  restoreDiskMeasurements(ctx);
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
      const device = String(devices.get(measurement.target) ?? fs.statSync(measurement.target).dev);
      byDevice.set(device, (byDevice.get(device) ?? 0) + measurement.bytes);
    } catch { /* disappeared since measurement */ }
  }
  for (const volume of volumes.values()) {
    const bytes = byDevice.get(volume.device ?? '') ?? 0;
    if (volume.totalBytes && bytes / volume.totalBytes * 100 > ctx.config.disk.worktreeSharePercent) {
      volume.worktreeShareWarning = {bytes, measuredAt: new Date(measuredAt).toISOString(), ageSeconds: Math.max(0, Math.floor((ctx.runner.now() - measuredAt) / 1000))};
    }
  }
  const health = readHostsCache();
  for (const [host, h] of Object.entries(ctx.config.hosts)) {
    const sample = health?.hosts.find(s => s.name === host);
    const fresh = sample && sample.state === 'reachable' && ctx.runner.now() - Date.parse(sample.probedAt) < 120_000;
    const availableBytes = fresh && sample.disk ? sample.disk.freeKb * 1024 : null;
    volumes.set(`host:${host}`, { host, workDir: h.workDir, device: `host:${host}`, paths: [h.workDir], availableBytes, totalBytes: fresh && sample.disk ? sample.disk.totalKb * 1024 : null, level: diskLevel(availableBytes, ctx.config.disk.warnGb, ctx.config.disk.criticalGb), ...(!fresh ? { error: 'host health unavailable/stale; run agentctl hosts' } : {}) });
  }
  const gcHint = [...volumes.values()].some(v => v.level === 'warn' || v.level === 'critical');
  // A disk read never computes a GC plan; that belongs to an explicit gc preview.
  const reclaimableBytes = null;
  const all = [...volumes.values()];
  const level = (['critical', 'warn', 'unknown', 'ok'] as const).find((l) => all.some((v) => v.level === l)) ?? 'unknown';
  const offset = opts.offset ?? 0, limit = Math.min(opts.limit ?? 20, 100);
  const paths = all.flatMap(v => v.paths), page = new Set(opts.detail ? paths.slice(offset, offset + limit) : []);
  return { ...(store ? { nodeModulesStore: store } : {}), freeMeasuredAt: new Date(ctx.runner.now()).toISOString(), worktreeAgeSeconds: Math.max(0, Math.floor((ctx.runner.now() - measuredAt) / 1000)), gcPolicyNote: 'GC removal blocked for pinned, active, dirty/unpushed or linked worktrees; cache kept unless explicitly authorized. Preview safety policy first.', gcHint, reclaimableBytes, worktreeCount: worktrees.length, largestWorktrees, pathsTotal: paths.length, pathsOffset: offset, pathsNextOffset: opts.detail && offset + limit < paths.length ? offset + limit : null, volumes: all.map(v => ({ ...v, pathCount: v.paths.length, paths: v.paths.filter(p => page.has(p)) })), worktreeBytes, measuredAt: new Date(measuredAt).toISOString(), level, ...(pending ? { measuring: true } : {}), ...(measurementError ? { measurementError } : {}) };
}
/** Restore the watch's persisted samples; never schedule or validate a recursive measurement. */
export function restoreDiskMeasurements(ctx: Context): void {
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
  const free = disk.volumes.map(v => `${v.host ? `[${v.host}] ${v.workDir ?? ''} ` : v.mount ? `[${v.mount}] ` : ''}${v.availableBytes === null ? v.error === 'volume missing' ? v.error : 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`}`).join(' / ');
  const store = disk.nodeModulesStore;
  return `Disk: ${disk.level}; free ${free}; agentctl worktrees ${disk.worktreeBytes === null ? 'n/d' : `${(disk.worktreeBytes / 1024 ** 3).toFixed(1)} GiB`}${note}${store ? `; node_modules store ${store.bytes} bytes (${store.entries} entries, ${store.hits} hits, ${store.misses} misses)` : ''}${disk.level === 'critical' || disk.level === 'warn' ? `; run agentctl gc --preview (gc_preview); reclaimable ${disk.reclaimableBytes ?? 'n/d'} bytes; ${disk.gcPolicyNote ?? 'GC may be blocked by protection policy; preview first.'}` : ''}`;
}

/**
 * After gc, publish gc's own accounting. Never walk surviving worktrees to explain bytes just removed.
 */
export async function refreshDiskAfterGc(ctx: Context, freedBytes: number): Promise<string | null> {
  if (ctx.runner.dryRun) return null;
  await persistDiskMeasurements(ctx);
  const disk = await collectDisk(ctx);
  const free = disk.volumes.map((v) => `${v.host ? `[${v.host}] ${v.workDir ?? ''} ` : ''}${v.availableBytes === null ? 'n/d' : `${(v.availableBytes / 1024 ** 3).toFixed(1)} GiB`}`).join(' / ');
  const text = `gc freed ${(freedBytes / 1024 ** 3).toFixed(1)} GiB, free now ${free}`;
  await recordJournal(ctx, { kind: 'gc-freed', text });
  return text;
}
async function persistDiskMeasurements(ctx: Context, records?: TaskRecord[]): Promise<void> {
  const repos = (records ?? [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)]).filter(r => !r.host).flatMap(r => r.repos);
  const worktrees = [...new Set(repos.map(r => r.worktree))];
  const entries = worktrees.flatMap(wt => { const m = lastMeasurement(wt); return m ? [{...m, repo: repos.find(r => r.worktree === wt)?.path}] : []; });
  await ctx.runner.writeFile(path.join(path.dirname(ctx.config.path), 'disk-sizes.json'), JSON.stringify({ version: 2, entries }));
}
const refreshing = new Set<string>();
const refreshed = new Map<string, number>();
/** Incremental watch inventory: one stale worktree per tick, at most once per 5 seconds; workers run at nice 10. */
export async function refreshDiskMeasurements(ctx: Context, records?: TaskRecord[]): Promise<void> {
  const key = ctx.config.path, now = ctx.runner.now();
  if (ctx.runner.dryRun || refreshing.has(key) || now - (refreshed.get(key) ?? -Infinity) < 5000) return;
  refreshed.set(key, now);
  restoreDiskMeasurements(ctx);
  const targets = [...new Set((records ?? [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)]).filter(r => !r.host).flatMap(r => r.repos.map(r => r.worktree)))];
  const target = targets.sort((a, b) => (lastMeasurement(a)?.at ?? 0) - (lastMeasurement(b)?.at ?? 0)).find(wt => !cachedMeasurement(wt) || now - lastMeasurement(wt)!.at >= DISK_INTERVAL_MS);
  if (!target) return;
  configureMeasurements(ctx.config.disk);
  refreshing.add(key);
  try {
    const lease = requestMeasurement(target, { background: true, now: () => ctx.runner.now() });
    try { await lease.promise; await persistDiskMeasurements(ctx, records); }
    finally { lease.release(); }
  } finally { refreshing.delete(key); }
}
const sampled = new Map<string, number>();
export async function diskTick(ctx: Context, notifier: Notifier, log?: (line: string) => Promise<void>, records?: TaskRecord[], collect = () => collectDisk(ctx, undefined, {records}), signal?: AbortSignal): Promise<void> {
  const background = (label: string, work: Promise<void>) => {
    void work.catch(error => log?.(`${label}: ${error instanceof Error ? error.message : String(error)}`)).catch(() => undefined);
  };
  background('host health', refreshHostHealth(ctx));
  background('worktree measurement', refreshDiskMeasurements(ctx, records));
  const file = path.join(path.dirname(ctx.config.path), 'disk-state.json');
  if (ctx.runner.dryRun || ctx.runner.now() - (sampled.get(file) ?? -Infinity) < DISK_INTERVAL_MS) return;
  sampled.set(file, ctx.runner.now());
  await withFileLock(`${file}.lock`, async () => {
    const report = await collect();
    kickAutoGc(ctx, report.volumes.flatMap(volume =>
      !volume.host && volume.device && volume.samplePath && volume.availableBytes !== null
        ? [{ device: volume.device, path: volume.mount ?? volume.samplePath }] : []),
    { ...(log ? { log } : {}), ...(signal ? { signal } : {}) });
    let previous: Record<string, DiskLevel> = {};
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first reading */ }
    const next = { ...previous };
    const changed: Array<{ kind: 'disk-warn' | 'disk-critical' | 'disk-ok'; text: string }> = [];
    for (const volume of report.volumes) {
      if (volume.level === 'unknown') continue;
      const id = volume.device ?? volume.paths.slice().sort().join('\n');
      next[id] = volume.level;
      if (previous[id] === volume.level || (!previous[id] && volume.level === 'ok')) continue;
      changed.push({ kind: `disk-${volume.level}`, text: diskLine({ ...report, volumes: [volume], level: volume.level }) });
    }
    if (Object.keys(next).some(id => next[id] !== previous[id])) await ctx.runner.writeFile(file, JSON.stringify(next));
    for (const { kind, text } of changed) {
      await notifier.notify('agentctl', text).catch(() => undefined);
      await recordJournal(ctx, { kind, text });
    }
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

const hostRefreshing = new Set<string>();
const hostRefreshed = new Map<string, number>();
/** Watch owns host probes; UI reads only their bounded cache. */
export async function refreshHostHealth(ctx: Context, forceSample = false): Promise<void> {
  if (ctx.runner.dryRun || (!forceSample && !Object.keys(ctx.config.hosts).length && !ctx.config.localHost && ctx.config.placement.default !== 'auto') || hostRefreshing.has(ctx.config.path) || ctx.runner.now() - (hostRefreshed.get(ctx.config.path) ?? -Infinity) < 30_000) return;
  const now = ctx.runner.now();
  const recent = readHostsCache()?.hosts ?? [];
  if (['local', ...Object.keys(ctx.config.hosts)].every(name => recent.some(sample => sample.name === name && now - Date.parse(sample.probedAt) < 30_000))) return;
  hostRefreshing.add(ctx.config.path);
  hostRefreshed.set(ctx.config.path, now);
  try {
    const [local, remote] = await Promise.all([probeLocalHost(ctx.runner, ctx.config), probeHosts(ctx.runner, ctx.config.hosts, ctx.config, { timeoutMs: 5000 })]);
    await writeHostsCache(ctx.runner, [local, ...remote]);
    await planRemoteGc(ctx, {}, 7 * 86400_000);
  }
  finally { hostRefreshing.delete(ctx.config.path); }
}
interface StartVolume { target: string; floor: number; label: string }

function stateVolumes(config: Context['config']): StartVolume[] {
  return [...new Set([config.stateDir, config.cache])].map(target => ({target, floor: config.disk.minFreeStateGb, label: `state volume ${target}`}));
}

function startVolumeHold(volumes: StartVolume[], statfs = fs.statfsSync): string | undefined {
  const checked = new Set<number>();
  // If paths share a device, the strictest floor is sufficient.
  for (const {target, floor, label} of volumes.sort((a, b) => b.floor - a.floor)) {
    if (!floor) continue;
    try {
      const ancestor = existingAncestor(target);
      const device = fs.statSync(ancestor).dev;
      if (checked.has(device)) continue;
      checked.add(device);
      const stat = statfs(ancestor);
      const gb = Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3;
      if (!Number.isFinite(gb)) throw Error('invalid free-space sample');
      if (gb < floor) return `wstrzymane: dysk ${Math.floor(gb)} GB < ${floor} GB (${label})`;
    } catch {
      return `wstrzymane: dysk – nie można odczytać wolnego miejsca (${label})`;
    }
  }
  return undefined;
}

export function worktreeVolumeLabel(repo: WorktreeVolume): string {
  return repo.worktreeMount ?? inferredWorktreeMount(repo.worktree) ?? existingAncestor(repo.worktree);
}

/** Fresh cheap filesystem admission, independent of recursive worktree measurements. Unknown space fails closed. */
function localStartVolumes(config: Context['config'], worktrees: (string | DiskWorktree)[]): {missing?: string; volumes: StartVolume[]} {
  const repos = worktrees.map(worktree => typeof worktree === 'string' ? { worktree } : worktree);
  if (!repos.length && config.worktreeRoot) repos.push({ worktree: resolvePath(config.worktreeRoot), ...(config.worktreeMount ? { worktreeMount: resolvePath(config.worktreeMount) } : {}) });
  const missing = missingWorktreeVolume(repos);
  if (missing) return {missing, volumes: []};
  const volumes = repos.map(repo => ({target: repo.worktree, floor: config.disk.minFreeStartGb, label: worktreeVolumeLabel(repo)}));
  if (config.nodeModules === 'clone' || repos.some(repo => repo.nodeModules === 'clone')) {
    const target = path.dirname(config.path);
    volumes.push({target, floor: config.disk.minFreeStartGb, label: `node_modules store volume ${target}`});
  }
  return {volumes: [...volumes, ...stateVolumes(config)]};
}

export function diskStartHold(config: Context['config'], worktrees: (string | DiskWorktree)[] = [], statfs = fs.statfsSync): string | undefined {
  const plan = localStartVolumes(config, worktrees);
  return plan.missing ? `volume missing: ${plan.missing}` : startVolumeHold(plan.volumes, statfs);
}

async function freshVolumeHold(ctx: Context, volumes: StartVolume[]): Promise<string | undefined> {
  const samples = new Map<number, number | null>();
  for (const {target, floor, label} of volumes) {
    if (floor === 0) continue;
    const ancestor = existingAncestor(target);
    const dev = fs.statSync(ancestor, {throwIfNoEntry: false})?.dev;
    if (dev === undefined) return `wstrzymane: dysk – nie można odczytać wolnego miejsca (${label})`;
    if (!samples.has(dev)) samples.set(dev, (await freeSpace(ctx, ancestor, fs.promises.statfs, START_DISK_BUDGET_MS)).availableBytes);
    const bytes = samples.get(dev);
    if (bytes == null) return `wstrzymane: dysk – nie można odczytać wolnego miejsca (${label})`;
    const gb = bytes / 1024 ** 3;
    if (gb >= floor) continue;
    const held = `wstrzymane: dysk ${Math.floor(gb)} GB < ${floor} GB (${label})`;
    if (!ctx.config.disk.autoGc.enabled || ctx.runner.dryRun) return held;
    kickAutoGc(ctx, [{path: inferredWorktreeMount(target) ?? ancestor, device: String(dev)}], {held: true});
    return held + '; zlecono auto_gc';
  }
  return undefined;
}

export function worktreeCostEstimates(ctx: Context, repos: {path: string}[], opts: {persistedOnly?: boolean} = {}) {
  restoreDiskMeasurements(ctx);
  const records = opts.persistedOnly ? [] : [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
  let persisted: {repo: string; bytes: number; at: number}[] = [];
  try { const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(ctx.config.path), 'disk-sizes.json'), 'utf8')); if (saved.version === 2) persisted = saved.entries.filter((e: {repo?: unknown; bytes?: unknown; at?: unknown}) => typeof e.repo === 'string' && typeof e.bytes === 'number' && Number.isFinite(e.bytes) && typeof e.at === 'number' && Number.isFinite(e.at)); } catch { /* no reading yet */ }
  return repos.map(repo => {
    const samples = records.flatMap(r => r.repos.filter(r => path.resolve(r.path) === path.resolve(repo.path)).flatMap(r => { const m = lastMeasurement(r.worktree); return m ? [m] : []; })).sort((a, b) => b.at - a.at);
    const last = [...samples, ...persisted.filter(e => path.resolve(e.repo) === path.resolve(repo.path))].sort((a, b) => b.at - a.at)[0];
    return {repo: path.basename(repo.path), bytes: last?.bytes ?? null, measuredAt: last ? new Date(last.at).toISOString() : null, ageSeconds: last ? Math.max(0, Math.floor((ctx.runner.now() - last.at) / 1000)) : null};
  });
}

/** Refresh snapshot counters without scanning tasks, queued specs or recursive sizes. */
export async function refreshDiskFreeSpace(ctx: Context, previous: DiskReport): Promise<DiskReport> {
  const now = ctx.runner.now(), ageSeconds = Math.max(0, Math.floor((now - Date.parse(previous.measuredAt)) / 1000));
  const volumes = await Promise.all(previous.volumes.map(async volume => {
    if (volume.host) {
      const health = readHostsCache(process.env, now, 60_000)?.hosts.find(h => h.name === volume.host);
      if (!health || health.state !== 'reachable' || !health.disk || health.disk.workDir !== volume.workDir) return {...volume, availableBytes: null, totalBytes: null, level: 'unknown' as const};
      const availableBytes = health.disk.freeKb * 1024, totalBytes = health.disk.totalKb * 1024;
      return {...volume, availableBytes, totalBytes, level: diskLevel(availableBytes, ctx.config.disk.warnGb, ctx.config.disk.criticalGb)};
    }
    if (volume.mount && !volumeMounted(volume.mount)) return { ...volume, device: null, availableBytes: null, totalBytes: null, level: 'unknown' as const, error: 'volume missing' };
    const ancestor = existingAncestor(volume.samplePath ?? ctx.config.cache);
    const sampled = await freeSpace(ctx, ancestor, fs.promises.statfs, FREE_SPACE_BUDGET_MS);
    if (volume.mount && !volumeMounted(volume.mount)) return { ...volume, device: null, availableBytes: null, totalBytes: null, level: 'unknown' as const, error: 'volume missing' };
    const level = diskLevel(sampled.availableBytes, ctx.config.disk.warnGb, ctx.config.disk.criticalGb);
    const device = volume.mount ? String(fs.statSync(ancestor, { throwIfNoEntry: false })?.dev ?? '') || null : volume.device;
    return {...volume, device, error: undefined, ...sampled, level, ...(volume.worktreeShareWarning ? {worktreeShareWarning: {...volume.worktreeShareWarning, ageSeconds}} : {})};
  }));
  const level = (['critical', 'warn', 'unknown', 'ok'] as const).find(l => volumes.some(v => v.level === l)) ?? 'unknown';
  return {...previous, nodeModulesStore: nodeModulesStore(ctx.config), volumes, level, gcHint: volumes.some(v => v.level === 'warn' || v.level === 'critical'), freeMeasuredAt: new Date(now).toISOString(), worktreeAgeSeconds: ageSeconds};
}

/** Cached host admission for synchronous queue previews; never stat a remote path locally. */
export function taskDiskStartHold(config: Context['config'], host: string | undefined, worktrees: (string | DiskWorktree)[], now = Date.now()): string | undefined {
  if (!host) return diskStartHold(config, worktrees);
  const local = startVolumeHold(stateVolumes(config));
  if (local || config.disk.minFreeStartGb === 0) return local;
  const health = readHostsCache(process.env, now, 60_000)?.hosts.find(h => h.name === host);
  if (!health || health.state !== 'reachable' || health.disk?.workDir !== config.hosts[host]?.workDir) return `wstrzymane: dysk [${host}] – brak świeżego odczytu work_dir`;
  const gb = health.disk.freeKb / 1024 ** 2;
  return gb < config.disk.minFreeStartGb ? `wstrzymane: dysk [${host}] ${Math.floor(gb)} GB < ${config.disk.minFreeStartGb} GB` : undefined;
}

/** Fresh local and remote filesystem counters before any worktree/setup mutation. */
export async function freshTaskDiskStartHold(ctx: Context, host: string | undefined, worktrees: (string | DiskWorktree)[]): Promise<string | undefined> {
  if (!host) {
    const plan = localStartVolumes(ctx.config, worktrees);
    return plan.missing ? `volume missing: ${plan.missing}` : freshVolumeHold(ctx, plan.volumes);
  }
  const local = await freshVolumeHold(ctx, stateVolumes(ctx.config));
  if (local) return local;
  const workDir = ctx.config.hosts[host]!.workDir;
  const mount = inferredWorktreeMount(workDir);
  if (ctx.config.disk.minFreeStartGb === 0 && !mount) return undefined;
  try {
    const script = "const fs=require('node:fs'),p=require('node:path'); let dir=process.argv[1].replace(/^~(?=\\/|$)/,process.env.HOME); const mount=process.argv[2]; if(mount){ const st=fs.statSync(mount,{throwIfNoEntry:false}); if(!st?.isDirectory() || st.dev===fs.statSync(p.dirname(mount),{throwIfNoEntry:false})?.dev){ console.log('volume missing: '+mount); process.exit(0); } } while(!fs.existsSync(dir)&&p.dirname(dir)!==dir) dir=p.dirname(dir); const s=fs.statfsSync(dir); console.log(Number(s.bavail)*Number(s.bsize)/1024**3)";
    const r = await ctx.hosts.forHost(host).checked('node', ['-e', script, workDir, ...(mount ? [mount] : [])], {readOnly: true, timeoutMs: 5000});
    if (mount && r.stdout.trim() === `volume missing: ${mount}`) return r.stdout.trim();
    const gb = Number(r.stdout.trim());
    if (!r.stdout.trim() || !Number.isFinite(gb) || gb < 0) throw Error('invalid disk sample');
    return gb < ctx.config.disk.minFreeStartGb ? `wstrzymane: dysk [${host}] ${Math.floor(gb)} GB < ${ctx.config.disk.minFreeStartGb} GB` : undefined;
  } catch { return `wstrzymane: dysk [${host}] – nie można odczytać work_dir`; }
}
