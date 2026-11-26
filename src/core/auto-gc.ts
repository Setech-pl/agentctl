import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { AutoGcCategory } from './config.ts';
import type { Context } from './context.ts';
import { commandStage } from './command-stage.ts';
import { withoutResponseBudget } from './response-budget.ts';
import { tryFileLock, withoutFileLockOwnership } from './file-lock.ts';
import { applyGc, checkAutomaticGc, planGc, type GcItem, type GcKind, type GcSkip } from './gc.ts';
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

/** One background run at a time, even across a CLI start and an overlapping watcher. */
export async function runAutoGc(ctx: Context, volumes: AutoGcVolume[], held = false, signal?: AbortSignal): Promise<void> {
  const policy = ctx.config.disk.autoGc;
  if (!policy.enabled || ctx.runner.dryRun || signal?.aborted || !volumes.length) return;
  const release = tryFileLock(path.join(ctx.config.stateDir, 'auto-gc.lock'));
  if (!release) return;
  try {
    const target = policy.targetFreeGb * GiB;
    const threshold = (held ? Math.max(policy.triggerFreeGb, ctx.config.disk.minFreeStartGb) : policy.triggerFreeGb) * GiB;
    const active = new Map<string, number>();
    const stateFile = path.join(ctx.config.stateDir, 'auto-gc-state.json');
    let previous: Record<string, string> = {};
    try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
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
    const selected = new Set(policy.categories.map(category => kinds[category]));
    const plan = await planGc(ctx, { olderThan: policy.olderThan, localKinds: selected, includeCache: selected.has('cache') });
    const trash = selected.has('trash') ? (await planGc(ctx, { purgeTrash: true })).items : [];
    const candidates = [...plan.items, ...trash];
    const summaries: AutoGcSummary[] = [];
    let budget = policy.maxPerRunGb * GiB;
    for (const volume of volumes) {
      const before = active.get(volume.device);
      if (before === undefined || signal?.aborted) continue;
      let current = before;
      let planned = 0, estimatedBytes = 0, removed = 0;
      const targets: AutoGcSummary['targets'] = [];
      let remaining = 'wyczerpano dostępne kategorie';
      const skipped = plan.skipped.filter(item => deviceAt(item.target) === volume.device);
      const ordered: GcItem[] = [];
      for (const category of policy.categories) {
        for (const item of candidates.filter(i => i.kind === kinds[category] && deviceAt(i.target) === volume.device)) {
          try {
            const bytes = await checkAutomaticGc(ctx, item, volume.device, plan.olderThanMs);
            ordered.push({ ...item, bytes });
          } catch (error) { skipped.push({ ...item, reason: errorMessage(error) }); }
        }
      }
      for (const item of ordered) {
        if (signal?.aborted || ctx.config.disk.autoGc !== policy) { remaining = 'zmiana polityki lub zatrzymanie watch'; break; }
        if (current >= target) { remaining = 'osiągnięto cel'; break; }
        if (item.bytes > budget || budget === 0) {
          remaining = 'limit max_per_run_gb';
          skipped.push({ ...item, reason: 'limit max_per_run_gb' });
          continue;
        }
        budget -= item.bytes; planned++; estimatedBytes += item.bytes;
        if (policy.dryRun && targets.length < 20) targets.push({ kind: item.kind, path: item.target, bytes: item.bytes });
        if (policy.dryRun) { current += item.bytes; continue; }
        if (deviceAt(volume.path) !== volume.device) { remaining = 'wolumin odłączony'; break; }
        const result = await applyGc(ctx, { ...plan, automatic: { device: volume.device }, items: [item] });
        removed += result.done.length;
        for (const failure of result.failed) skipped.push({ ...failure.item, reason: failure.reason });
        const sample = await GcSpace.available(volume.path);
        if (sample === undefined) { remaining = 'odczyt statfs niedostępny'; break; }
        current = sample;
      }
      if (current >= target) remaining = 'osiągnięto cel';
      const after = policy.dryRun || deviceAt(volume.path) !== volume.device ? undefined : await GcSpace.available(volume.path);
      const blockers = blockersFor(skipped);
      const summary: AutoGcSummary = { volume, planned, targets, estimatedBytes, removed, freedBytes: after === undefined ? null : Math.max(0, after - before),
        freeBytes: after ?? before, remaining, blockers, dryRun: policy.dryRun };
      const signature = createHash('sha256').update(JSON.stringify({ policy, items: ordered.map(item => [item.target, item.bytes]), blockers, remaining })).digest('hex');
      if (!removed && previous[volume.device] === signature) continue;
      if (after !== undefined && after >= threshold) delete next[volume.device];
      else next[volume.device] = signature;
      summaries.push(summary);
    }
    if (!summaries.length) return;
    const gib = (bytes: number) => `${(bytes / GiB).toFixed(2)} GiB`;
    const body = summaries.map(summary => {
      const action = summary.dryRun ? `plan: ${summary.planned} pozycji (${gib(summary.estimatedBytes)})`
        : `usunięto ${summary.removed}; odzyskano ${summary.freedBytes === null ? 'n/d' : gib(summary.freedBytes)}; wolne ${gib(summary.freeBytes)}`;
      return [`${summary.volume.path}: ${action}; ${summary.remaining}.`, ...summary.targets.map(i => `- ${i.kind}: ${i.path} (${gib(i.bytes)})`), ...summary.blockers.map(b => `- ${b.reason}: ${b.count}, ${gib(b.bytes)}`)].join('\n');
    }).join('\n\n');
    const subject = policy.dryRun ? 'Automatyczne GC — plan' : 'Automatyczne GC — wynik';
    await recordJournal(ctx, { kind: 'disk-auto-gc', text: `${subject}\n${body}`, diskGc: summaries });
    await postMessage(ctx, OWNER_IDENTITY, { channel: WALL_TOOL_CHANNEL, kind: 'info', subject, body: body.slice(0, 4000) });
    await ctx.runner.writeFile(stateFile, JSON.stringify(next));
  } finally { release(); }
}

export function kickAutoGc(ctx: Context, volumes: AutoGcVolume[], opts: { held?: boolean; signal?: AbortSignal; log?: (line: string) => Promise<void> } = {}): void {
  if (!ctx.config.disk.autoGc.enabled || ctx.runner.dryRun || !volumes.length) return;
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
  void nextTurn().then(() => commandStage.exit(() => withoutFileLockOwnership(() => withoutResponseBudget(() =>
    runAutoGc(ctx, volumes, opts.held, opts.signal)))))
    .catch(error => opts.log?.(`auto_gc: ${errorMessage(error)}`) ?? ctx.info(`auto_gc: ${errorMessage(error)}`)).catch(() => undefined);
}
