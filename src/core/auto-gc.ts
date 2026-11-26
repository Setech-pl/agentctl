import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
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
  blockers: { reason: string; count: number; bytes: number }[];
  dryRun: boolean;
  /** 0.26.4 (L2): wall-clock duration of this volume's part of the run and the number of per-item checks. */
  durationMs: number;
  prechecks: number;
}

function deviceAt(target: string): string | undefined {
  try { return String(fs.lstatSync(target).dev); } catch { return undefined; }
}

function blockersFor(skipped: GcSkip[]) {
  const groups = new Map<string, { reason: string; count: number; bytes: number; seen: Set<string> }>();
  for (const item of skipped) {
    const reason = item.dirtyFiles || item.unpushedCommits ? 'dirty/unpushed (decyzja właściciela)' :
      item.reason.startsWith('newer than') ? 'zbyt nowe' : item.reason.startsWith('links target') ? 'w użyciu przez linki' : item.reason;
    const group = groups.get(reason) ?? { reason, count: 0, bytes: 0, seen: new Set<string>() };
    if (group.seen.has(item.target)) continue;
    group.seen.add(item.target); group.count++; group.bytes += item.bytes ?? 0;
    groups.set(reason, group);
  }
  return [...groups.values()].map(({ reason, count, bytes }) => ({ reason, count, bytes }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 10);
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
        if (wt === path.resolve(repo.path) || seen.has(wt)) continue;
        seen.add(wt);
        if (!await fs.promises.lstat(wt).then(() => true, () => false)) continue;
        if (await run.location(wt) === await run.location(repo.path)) continue;
        if (reason) { skipped.push({ task: record.task, kind, target: wt, reason }); continue; }
        items.push({ kind, task: record.task, target: wt, bytes: 0, detail: `${record.cancelled ? 'cancelled' : 'closed'} task`, repo: repo.path, ...(repo.base ? { base: repo.base } : {}), ...(record.cohort ? { cohort: record.cohort } : {}) });
      }
    } else if (kind === 'cache') {
      const dir = record.report ? path.dirname(path.resolve(record.report)) : path.join(cacheRoot, record.window);
      if (dir === cacheRoot || !dir.startsWith(`${cacheRoot}${path.sep}`) || seen.has(dir)) continue;
      seen.add(dir);
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
let host: { signal?: AbortSignal; log?: (line: string) => Promise<void> } | undefined;

/**
 * L1: only a long-lived watcher runs automatic GC. It registers here with its Ctrl-C signal; a CLI or MCP process that hits a disk
 * hold leaves a kick file for the watcher instead of deleting in a process that may exit or be interrupted mid-tree.
 */
export function hostAutoGc(opts: { signal?: AbortSignal; log?: (line: string) => Promise<void> }): () => void {
  host = opts;
  return () => { if (host === opts) host = undefined; };
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
  kickAutoGc(ctx, volumes, { held: true, ...(signal ? { signal } : {}), ...(log ? { log } : {}) });
  return true;
}

/** One background run at a time, even across a CLI start and an overlapping watcher. */
export async function runAutoGc(ctx: Context, volumes: AutoGcVolume[], held = false, signal?: AbortSignal): Promise<void> {
  const policy = ctx.config.disk.autoGc;
  if (!policy.enabled || ctx.runner.dryRun || signal?.aborted || !volumes.length) return;
  const release = tryFileLock(path.join(ctx.config.stateDir, 'auto-gc.lock'));
  if (!release) return;
  const run = new AutoGcRun(ctx, policy, signal);
  try {
    const target = policy.targetFreeGb * GiB;
    const threshold = (held ? Math.max(policy.triggerFreeGb, ctx.config.disk.minFreeStartGb) : policy.triggerFreeGb) * GiB;
    const active = new Map<string, number>();
    const stateFile = path.join(ctx.config.stateDir, 'auto-gc-state.json');
    let previous: Record<string, string> = {};
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
    for (const volume of volumes) {
      const before = active.get(volume.device);
      if (before === undefined) continue;
      const started = ctx.runner.now();
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
            run.check();
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
            run.check();
          }
        }
      } catch (error) {
        if (!(error instanceof AutoGcStop)) throw error;
        remaining = stopped = error.message;
      }
      if (current >= target) remaining = 'osiągnięto cel';
      const after = policy.dryRun || deviceAt(volume.path) !== volume.device ? undefined : await GcSpace.available(volume.path);
      const blockers = blockersFor(skipped);
      const summary: AutoGcSummary = { volume, planned, targets, estimatedBytes, removed, freedBytes: after === undefined ? null : Math.max(0, after - before),
        freeBytes: after ?? before, remaining, blockers, dryRun: policy.dryRun, durationMs: Math.max(0, ctx.runner.now() - started), prechecks: run.stats.prechecks };
      const signature = createHash('sha256').update(JSON.stringify({ policy, items: ordered, blockers, remaining: stopped ? 'stopped' : remaining })).digest('hex');
      if (!removed && previous[volume.device] === signature) { if (stopped) break; continue; }
      if (after !== undefined && after >= threshold) delete next[volume.device];
      else next[volume.device] = signature;
      summaries.push(summary);
      if (stopped) break;
    }
    if (!summaries.length) return;
    const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
    const body = summaries.map(summary => {
      const action = summary.dryRun ? `plan: ${summary.planned} pozycji (${gib(summary.estimatedBytes)})`
        : `usunięto ${summary.removed}; odzyskano ${summary.freedBytes === null ? 'n/d' : gib(summary.freedBytes)} (statfs); wolne ${gib(summary.freeBytes)}`;
      return [`${summary.volume.path}: ${action}; ${summary.remaining}; czas ${(summary.durationMs / 1000).toFixed(1)} s.`, ...summary.targets.map(i => `- ${i.kind}: ${i.path} (${gib(i.bytes)})`), ...summary.blockers.map(b => `- ${b.reason}: ${b.count}, ${gib(b.bytes)}`)].join('\n');
    }).join('\n\n');
    const subject = policy.dryRun ? 'Automatyczne GC — plan' : 'Automatyczne GC — wynik';
    await recordJournal(ctx, { kind: 'disk-auto-gc', text: `${subject}\n${body}`, diskGc: summaries });
    await postMessage(ctx, OWNER_IDENTITY, { channel: WALL_TOOL_CHANNEL, kind: 'info', subject, body: body.slice(0, 4000) });
    await ctx.runner.writeFile(stateFile, JSON.stringify(next));
  } finally { release(); }
}

export function kickAutoGc(ctx: Context, volumes: AutoGcVolume[], opts: { held?: boolean; signal?: AbortSignal; log?: (line: string) => Promise<void> } = {}): void {
  if (!ctx.config.disk.autoGc.enabled || ctx.runner.dryRun || !volumes.length) return;
  if (!opts.signal && !host) {
    // L1: not the watcher. Leave the request; the watcher runs it with its own stop signal on its next disk tick.
    try { atomicWriteFile(kickFile(ctx), JSON.stringify({ at: new Date(ctx.runner.now()).toISOString(), held: Boolean(opts.held), volumes })); } catch { /* the periodic disk tick still runs auto_gc */ }
    return;
  }
  const signal = opts.signal ?? host?.signal, log = opts.log ?? host?.log;
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
