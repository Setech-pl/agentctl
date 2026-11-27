import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { configureMeasurements, lastMeasurement, sizeOf } from './fs-measure.ts';
import { restoreDiskMeasurements } from './disk.ts';
import type { RecordScan } from './taskstore.ts';
import type { AutoGcCategory } from './config.ts';
import type { Context } from './context.ts';
import { commandStage } from './command-stage.ts';
import { withoutResponseBudget } from './response-budget.ts';
import { tryFileLock, withoutFileLockOwnership } from './file-lock.ts';
import { applyGc, checkAutomaticGc, type GcItem, type GcKind, type GcPlan, type GcSkip } from './gc.ts';
import { AutoGcRun, AutoGcStop } from './auto-gc-run.ts';
import { parseAge } from './archive.ts';
import { atomicWriteFile } from './atomic-file.ts';
import { staleNodeModules } from './node-modules-store.ts';
import { planTrashPurge } from './trash.ts';
import { GcSpace } from './gc-space.ts';
import { recordJournal } from './journal.ts';
import { postMessage, OWNER_IDENTITY } from './wall.ts';
import { WALL_TOOL_CHANNEL } from './wall-config.ts';
import { errorMessage } from './util.ts';

const GiB = 1024 ** 3;
const lastHeldKick = new Map<string, number>();
const HELD_RECHECK_MS = 60_000;
const kinds: Record<AutoGcCategory, GcKind> = {
  closed_clean_worktrees: 'worktree', stale_node_modules: 'node-modules', own_trash: 'trash', closed_task_cache: 'cache',
};

export interface AutoGcVolume { device: string; path: string }
interface AutoGcSummary {
  volume: AutoGcVolume;
  planned: number;
  targets: { kind: GcKind; path: string; bytes: number }[];
  estimatedBytes: number;
  removed: number;
  freedBytes: number | null;
  freeBytes: number;
  remaining: string;
  blockers: { reason: string; kind: GcSkip['kind']; count: number; bytes: number; pending: number; measuredAt?: number }[];
  dryRun: boolean;
  /** 0.26.4 (L2): wall-clock duration of this volume's part of the run and the number of per-item checks. */
  durationMs: number;
  prechecks: number;
}

function deviceAt(target: string): string | undefined {
  try { return String(fs.lstatSync(target).dev); } catch { return undefined; }
}

function blockersFor(skipped: GcSkip[]): AutoGcSummary['blockers'] {
  const groups = new Map<string, AutoGcSummary['blockers'][number] & { paths: Set<string>; tasks: Set<string> }>();
  for (const item of skipped) {
    const reason = item.reason === 'pinned task' ? 'pinned' : item.dirtyFiles || item.unpushedCommits ? 'dirty/unpushed (decyzja właściciela)' :
      item.reason.startsWith('newer than') ? 'zbyt nowe' : item.reason.startsWith('links target') ? 'w użyciu przez linki' : item.reason;
    const key = `${item.kind}:${reason}`;
    const group = groups.get(key) ?? { kind: item.kind, reason, count: 0, bytes: 0, pending: 0, paths: new Set(), tasks: new Set() };
    group.tasks.add(item.task);
    if (reason === 'pinned') group.count = group.tasks.size;
    if (group.paths.has(item.target)) continue;
    group.paths.add(item.target);
    const sample = lastMeasurement(item.target);
    group.bytes += item.bytes || sample?.bytes || 0;
    if (sample) group.measuredAt = Math.min(group.measuredAt ?? sample.at, sample.at);
    else if (!item.bytes) group.pending++;
    group.count = reason === 'pinned' ? group.tasks.size : group.paths.size;
    groups.set(key, group);
  }
  return [...groups.values()].map(({ paths: _paths, tasks: _tasks, ...group }) => group)
    .sort((a, b) => Number(b.reason === 'pinned') - Number(a.reason === 'pinned') || b.count - a.count || a.reason.localeCompare(b.reason) || a.kind.localeCompare(b.kind)).slice(0, 10);
}

interface Candidates { items: GcItem[]; skipped: GcSkip[] }

/** Cheap candidate lists per category from the run's one inventory; every safety fact is checked lazily, item by item. */
async function autoGcCandidates(ctx: Context, run: AutoGcRun, kind: GcKind, olderThanMs: number): Promise<Candidates> {
  const { config, runner } = ctx;
  const items: GcItem[] = [], skipped: GcSkip[] = [];
  if (kind === 'node-modules') return { items: staleNodeModules(config, olderThanMs, runner.now()).map(entry => ({ ...entry, kind, task: 'nm-store', detail: 'unused node_modules store entry' })), skipped };
  if (kind === 'trash') {
    return { items: planTrashPurge(ctx, await run.records()).map(trash => ({ kind, task: '-', target: trash.target, bytes: 0, trash, detail: `original: ${trash.original}` })), skipped };
  }
  const { archived } = await run.inventory();
  const archivedNames = new Set(archived.map(record => record.window));
  const live = await run.live();
  const finished = (await run.records()).filter(record => (record.closed || record.cancelled || archivedNames.has(record.window)) && !live.has(record.window));
  const seen = new Set<string>();
  const cacheRoot = path.resolve(config.cache);
  for (const record of finished) {
    await run.pace();
    const reason = record.pin ? 'pinned task' : undefined;
    if (kind === 'worktree') {
      if (record.reviewMode) continue; // borrowed worktrees belong to their author
      for (const repo of record.repos) {
        const wt = path.resolve(repo.worktree);
        if (wt === path.resolve(repo.path) || (!reason && seen.has(wt))) continue;
        if (!await fs.promises.lstat(wt).then(() => true, () => false)) continue;
        if (await run.location(wt) === await run.location(repo.path)) continue;
        if (reason) { skipped.push({ task: record.task, kind, target: wt, reason }); continue; }
        seen.add(wt);
        items.push({ kind, task: record.task, target: wt, bytes: 0, detail: `${record.cancelled ? 'cancelled' : 'closed'} task`, repo: repo.path, ...(repo.base ? { base: repo.base } : {}), ...(record.cohort ? { cohort: record.cohort } : {}) });
      }
    } else if (kind === 'cache') {
      const dir = record.report ? path.dirname(path.resolve(record.report)) : path.join(cacheRoot, record.window);
      if (dir === cacheRoot || !dir.startsWith(`${cacheRoot}${path.sep}`) || (!reason && seen.has(dir))) continue;
      if (!reason) seen.add(dir);
      const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (/\.md$/i.test(name)) continue;
        const target = path.join(dir, name);
        if (reason) skipped.push({ task: record.task, kind, target, reason });
        else items.push({ kind, task: record.task, target, bytes: 0, detail: 'closed task cache', ...(record.cohort ? { cohort: record.cohort } : {}) });
      }
    }
  }
  return { items, skipped };
}

let running: Promise<void> | undefined;
interface AutoGcHost { signal?: AbortSignal; log?: (line: string) => Promise<void>; inventory?: () => Promise<RecordScan> }
let host: AutoGcHost | undefined;

/**
 * L1: only a long-lived watcher runs automatic GC. It registers here with its Ctrl-C signal; a CLI or MCP process that hits a disk
 * hold leaves a kick file for the watcher instead of deleting in a process that may exit or be interrupted mid-tree.
 */
export function hostAutoGc(opts: AutoGcHost): () => void {
  host = opts;
  return () => {
    if (host !== opts) return;
    host = undefined;
    for (const [key, plan] of previews) if (plan.owner === opts) { plan.discard(); previews.delete(key); }
  };
}

/** Resolves when the in-flight run (if any) has finished its current item and stopped. */
export function autoGcIdle(): Promise<void> {
  return running ?? Promise.resolve();
}

const kickFile = (ctx: Context) => path.join(ctx.config.stateDir, 'auto-gc-kick.json');

/** Watch: run a run requested by a CLI/MCP disk hold (held threshold). */
export async function takeAutoGcKick(ctx: Context, signal?: AbortSignal, log?: (line: string) => Promise<void>): Promise<boolean> {
  let raw: string;
  try { raw = await fs.promises.readFile(kickFile(ctx), 'utf8'); } catch { return false; }
  await fs.promises.unlink(kickFile(ctx)).catch(() => undefined);
  let volumes: AutoGcVolume[] = [];
  try { const data = JSON.parse(raw); volumes = Array.isArray(data.volumes) ? data.volumes.filter((v: AutoGcVolume) => typeof v?.device === 'string' && typeof v?.path === 'string') : []; } catch { /* unreadable request */ }
  if (!volumes.length) return false;
  kickAutoGc(ctx, volumes, { held: true, watcher: true, ...(signal ? { signal } : {}), ...(log ? { log } : {}) });
  return true;
}

/** A reporting-only run may park its scan at the next I/O checkpoint. Deletion always rechecks fresh facts. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class AutoGcPreview {
  readonly ctx: Context;
  readonly run: AutoGcRun;
  readonly owner = host;
  readonly key: string;
  private parked = deferred<void>();
  private wake: ((resume: boolean) => void) | undefined;
  private readonly work: Promise<void>;

  constructor(ctx: Context, volumes: AutoGcVolume[], held: boolean, signal?: AbortSignal) {
    this.ctx = ctx;
    this.run = new AutoGcRun(ctx, ctx.config.disk.autoGc, signal, () => this.suspend(), host?.inventory);
    this.key = previewKey(ctx, volumes);
    this.work = executeAutoGc(ctx, volumes, held, this.run).catch(error => {
      if (!(error instanceof DiscardPreview)) throw error;
    });
  }

  private async suspend(): Promise<void> {
    const resume = deferred<boolean>();
    this.wake = resume.resolve;
    this.parked.resolve();
    if (!await resume.promise) throw new DiscardPreview();
  }

  async advance(signal?: AbortSignal): Promise<boolean> {
    if (this.wake) {
      this.parked = deferred<void>();
      this.run.resume(signal);
      this.wake(true);
      this.wake = undefined;
    }
    return Promise.race([this.work.then(() => true), this.parked.promise.then(() => false)]);
  }

  discard(): void { this.wake?.(false); }
}

class DiscardPreview extends Error {}

const previews = new Map<string, AutoGcPreview>();
const previewKey = (ctx: Context, volumes: AutoGcVolume[]) => JSON.stringify([
  ctx.config.cache, ctx.config.disk.minFreeStartGb, ctx.config.disk.autoGc, [...new Set(volumes.map(volume => volume.device))],
]);

/** One invocation at a time. A deadline slice releases the lock, and the next preview resumes without rescanning. */
export async function runAutoGc(ctx: Context, volumes: AutoGcVolume[], held = false, signal?: AbortSignal): Promise<void> {
  const policy = ctx.config.disk.autoGc;
  if (ctx.runner.dryRun || !volumes.length) return;
  const key = ctx.config.stateDir;
  volumes = [...volumes].sort((a, b) => a.device.localeCompare(b.device) || a.path.localeCompare(b.path));
  const release = tryFileLock(path.join(key, 'auto-gc.lock'));
  if (!release) return;
  try {
    let preview = previews.get(key);
    if (preview && (!policy.enabled || signal?.aborted || !policy.dryRun || preview.ctx !== ctx || preview.key !== previewKey(ctx, volumes))) {
      preview.discard();
      previews.delete(key);
      preview = undefined;
    }
    if (!policy.enabled || signal?.aborted) return;
    if (preview) {
      const threshold = (held ? Math.max(policy.triggerFreeGb, ctx.config.disk.minFreeStartGb) : policy.triggerFreeGb) * GiB;
      const pressure = await Promise.all(volumes.map(async volume => {
        if (deviceAt(volume.path) !== volume.device) return false;
        const free = await GcSpace.available(volume.path);
        return free === undefined ? undefined : free < threshold && free < policy.targetFreeGb * GiB;
      }));
      if (!pressure.includes(true)) {
        // Missing pressure readings leave a suspended preview intact for the next tick.
        if (pressure.includes(undefined)) return;
        preview.discard();
        previews.delete(key);
        preview = undefined;
      }
    }
    if (!policy.dryRun) return await executeAutoGc(ctx, volumes, held, new AutoGcRun(ctx, policy, signal, undefined, host?.inventory));
    preview ??= new AutoGcPreview(ctx, volumes, held, signal);
    try {
      if (await preview.advance(signal)) previews.delete(key);
      else previews.set(key, preview);
    } catch (error) {
      previews.delete(key);
      throw error;
    }
  } finally { release(); }
}

async function executeAutoGc(ctx: Context, volumes: AutoGcVolume[], held: boolean, run: AutoGcRun): Promise<void> {
  const policy = run.policy;
  restoreDiskMeasurements(ctx);
  configureMeasurements(ctx.config.disk);
  const target = policy.targetFreeGb * GiB;
  const threshold = (held ? Math.max(policy.triggerFreeGb, ctx.config.disk.minFreeStartGb) : policy.triggerFreeGb) * GiB;
  const active = new Map<string, number>();
  const stateFile = path.join(ctx.config.stateDir, 'auto-gc-state.json');
  type Receipt = { signature: string; at: number };
  let previous: Record<string, Receipt | string> = {};
  try { previous = JSON.parse(await fs.promises.readFile(stateFile, 'utf8')); } catch { /* first run */ }
  const next = { ...previous };
  for (const volume of volumes) {
    if (deviceAt(volume.path) !== volume.device) continue;
    const free = await GcSpace.available(volume.path);
    if (free !== undefined && free < threshold && free < target) active.set(volume.device, free);
    else if (free !== undefined) delete next[volume.device];
  }
  if (!active.size) {
    if (Object.keys(next).length !== Object.keys(previous).length) await ctx.runner.writeFile(stateFile, JSON.stringify(next));
    return;
  }
  const olderThanMs = parseAge(policy.olderThan);
  const lists = new Map<GcKind, Candidates>();
  const listFor = async (kind: GcKind) => {
    if (!lists.has(kind)) lists.set(kind, await autoGcCandidates(ctx, run, kind, olderThanMs));
    return lists.get(kind)!;
  };
  const shell: GcPlan = { deleteMode: ctx.config.gc.deleteMode, includeCache: true, keep: [], keepCache: [], forceDirty: [], items: [], skipped: [], freeBytes: 0, olderThanMs, unknownCacheDirs: 0 };
  const summaries: AutoGcSummary[] = [];
  let budget = policy.maxPerRunGb * GiB;
  let stopped: string | undefined;
  let measurementSlots = ctx.config.disk.workers * 2;
  const measured = new Set<string>();
  const measureSkips = async (skips: GcSkip[]) => {
    const targets = skips.filter(item => {
      if (item.bytes || measured.has(item.target) || measurementSlots <= 0) return false;
      const reading = lastMeasurement(item.target);
      if (reading && ctx.runner.now() - reading.at < 60 * 60_000) return false;
      measured.add(item.target);
      measurementSlots--;
      return true;
    });
    if (!targets.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); });
    try {
      await Promise.race([deadline, Promise.allSettled(targets.map(async item => sizeOf(item.target, { background: true, now: () => ctx.runner.now() })))]);
    } finally { clearTimeout(timer); }
  };
  for (const volume of volumes) {
    const before = active.get(volume.device);
    if (before === undefined) continue;
    const started = run.activeTime();
    let current = before;
    let planned = 0, estimatedBytes = 0, removed = 0;
    const targets: AutoGcSummary['targets'] = [];
    let remaining = 'wyczerpano dostępne kategorie';
    const skipped: GcSkip[] = [];
    const ordered: [string, number][] = [];
    try {
      // Lazy: each candidate is checked only when it is the next one needed; the run stops at the target, the budget or the deadline.
      outer: for (const category of policy.categories) {
        const list = await listFor(kinds[category]);
        for (const skip of list.skipped) if (deviceAt(skip.target) === volume.device) skipped.push(skip);
        for (const candidate of list.items) {
          await run.checkpoint();
          if (current >= target) { remaining = 'osiągnięto cel'; break outer; }
          if (budget <= 0) { remaining = 'limit max_per_run_gb'; break outer; }
          if (deviceAt(candidate.target) !== volume.device) continue;
          let item: GcItem;
          try {
            item = { ...candidate, bytes: await checkAutomaticGc(ctx, candidate, volume.device, olderThanMs, run) };
          } catch (error) {
            if (error instanceof AutoGcStop) throw error;
            skipped.push({ ...candidate, reason: errorMessage(error) });
            continue;
          }
          ordered.push([item.target, item.bytes]);
          if (item.bytes > budget) {
            remaining = 'limit max_per_run_gb';
            skipped.push({ ...item, reason: 'limit max_per_run_gb' });
            continue;
          }
          budget -= item.bytes; planned++; estimatedBytes += item.bytes;
          if (policy.dryRun && targets.length < 20) targets.push({ kind: item.kind, path: item.target, bytes: item.bytes });
          if (policy.dryRun) { current += item.bytes; continue; }
          if (deviceAt(volume.path) !== volume.device) { remaining = 'wolumin odłączony'; break outer; }
          const result = await applyGc(ctx, { ...shell, automatic: { device: volume.device, run }, items: [item] });
          removed += result.done.length;
          for (const failure of result.failed) skipped.push({ ...failure.item, reason: failure.reason });
          const sample = await GcSpace.available(volume.path);
          if (sample === undefined) { remaining = 'odczyt statfs niedostępny'; break outer; }
          current = sample;
          await run.checkpoint();
        }
      }
    } catch (error) {
      if (!(error instanceof AutoGcStop)) throw error;
      remaining = stopped = error.message;
    }
    if (current >= target) remaining = 'osiągnięto cel';
    const after = policy.dryRun || deviceAt(volume.path) !== volume.device ? undefined : await GcSpace.available(volume.path);
    await measureSkips(skipped);
    const blockers = blockersFor(skipped);
    const summary: AutoGcSummary = { volume, planned, targets, estimatedBytes, removed, freedBytes: after === undefined ? null : Math.max(0, after - before),
      freeBytes: after ?? before, remaining, blockers, dryRun: policy.dryRun, durationMs: Math.max(0, run.activeTime() - started), prechecks: run.stats.prechecks };
    const stableBlocks = skipped.map(item => JSON.stringify([item.kind, item.task, item.target, item.reason])).sort();
    const signature = createHash('sha256').update(JSON.stringify({ policy, items: ordered, blockers: stableBlocks, remaining: stopped ? 'stopped' : remaining })).digest('hex');
    const last = previous[volume.device];
    const now = ctx.runner.now();
    if (!removed && last && typeof last === 'object' && last.signature === signature && now - last.at < parseAge(policy.reportEvery)) {
      if (stopped) break;
      continue;
    }
    if (after !== undefined && after >= threshold) delete next[volume.device];
    else next[volume.device] = { signature, at: now };
    summaries.push(summary);
    if (stopped) break;
  }
  if (!summaries.length) {
    if (Object.keys(next).length !== Object.keys(previous).length) await ctx.runner.writeFile(stateFile, JSON.stringify(next));
    return;
  }
  const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
  const overview = summaries.map(summary => {
    const action = summary.dryRun ? `plan: ${summary.planned} pozycji (${gib(summary.estimatedBytes)})`
      : `usunięto ${summary.removed}; odzyskano ${summary.freedBytes === null ? 'n/d' : gib(summary.freedBytes)} (statfs); wolne ${gib(summary.freeBytes)}`;
    return [`${summary.volume.path}: ${action}; ${summary.remaining}; czas ${(summary.durationMs / 1000).toFixed(1)} s.`, ...summary.blockers.map(b => {
      const age = b.measuredAt === undefined ? '' : `, pomiar sprzed ${Math.max(0, Math.floor((ctx.runner.now() - b.measuredAt) / 60_000))} min`;
      const unknown = b.pending ? `, bez pomiaru: ${b.pending}` : '';
      return b.reason === 'pinned' ? `- ${b.kind} · pinned: ${b.count} zadań, ${gib(b.bytes)} – decyzja właściciela (agentctl unpin / WT-PARK)${age}${unknown}`
        : `- ${b.reason} (${b.kind}): ${b.count}, ${gib(b.bytes)}${age}${unknown}`;
    })].join('\n');
  }).join('\n\n');
  const samples = summaries.flatMap(summary => summary.targets.map(i => `- ${i.kind}: ${i.path} (${gib(i.bytes)})`));
  const body = samples.length ? `${overview}\n\n${samples.join('\n')}` : overview;
  const subject = policy.dryRun ? 'Automatyczne GC — plan' : 'Automatyczne GC — wynik';
  await recordJournal(ctx, { kind: 'disk-auto-gc', text: `${subject}\n${body}`, diskGc: summaries });
  const origins = summaries.map(({volume}) => {
    const receipt = next[volume.device];
    return [volume.device, previous[volume.device] ?? null, typeof receipt === 'object' ? receipt.signature : null];
  });
  const origin = createHash('sha256').update(JSON.stringify(origins)).digest('hex');
  await postMessage(ctx, OWNER_IDENTITY, { channel: WALL_TOOL_CHANNEL, kind: 'info', subject, body: body.slice(0, 4000), ...(policy.dryRun ? { origin: `auto-gc:${origin}` } : {}) });
  await ctx.runner.writeFile(stateFile, JSON.stringify(next));
}

export function kickAutoGc(ctx: Context, volumes: AutoGcVolume[], opts: { held?: boolean; signal?: AbortSignal; log?: (line: string) => Promise<void>; watcher?: boolean } = {}): void {
  if (!ctx.config.disk.autoGc.enabled || ctx.runner.dryRun || !volumes.length) return;
  if (!opts.watcher && !opts.signal && !host) {
    // L1: not the watcher. Leave the request; the watcher runs it with its own stop signal on its next disk tick.
    try { atomicWriteFile(kickFile(ctx), JSON.stringify({ at: new Date(ctx.runner.now()).toISOString(), held: Boolean(opts.held), volumes })); } catch { /* the periodic disk tick still runs auto_gc */ }
    return;
  }
  const signal = host?.signal ?? opts.signal, log = opts.log ?? host?.log;
  if (opts.held) {
    const now = ctx.runner.now();
    volumes = volumes.filter(volume => {
      const key = `${ctx.config.stateDir}:${volume.device}`;
      if (now - (lastHeldKick.get(key) ?? -Infinity) < HELD_RECHECK_MS) return false;
      lastHeldKick.set(key, now);
      return true;
    });
    if (!volumes.length) return;
  }
  if (running) return;
  const work = nextTurn().then(() => commandStage.exit(() => withoutFileLockOwnership(() => withoutResponseBudget(() =>
    runAutoGc(ctx, volumes, opts.held, signal)))))
    .catch(error => log?.(`auto_gc: ${errorMessage(error)}`) ?? ctx.info(`auto_gc: ${errorMessage(error)}`)).catch(() => undefined)
    .finally(() => { if (running === work) running = undefined; });
  running = work;
}
