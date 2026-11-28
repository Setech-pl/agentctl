import { chatQuotaWait } from './chat-quotas.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import { diskStartHold, taskDiskStartHold } from './disk.ts';
import { hostAvailability } from './host-availability.ts';
import { checkHostLimit } from './host-limits.ts';
import type { HostSlot } from './host-limits.ts';
import { readHostsCache } from './hosts.ts';
import { collectMachine } from './machine.ts';
import { legacyLocalTarget, resolveSpec, specHost, splitSpecs } from './spec.ts';
import { findRecordAnywhere } from './taskstore.ts';

export interface PlacementOrder {
  task: string;
  spec: string;
  agent: AgentName;
  owner?: string;
  host?: string;
  after: string[];
  reviewOf?: string;
  queuedAt: string;
  reuse?: boolean;
  perf?: boolean;
}

export type Placement = { host?: string; reason: string; hold?: never } | { hold: string; host?: never; reason?: never };

export function choosePlacement(config: GlobalConfig, order: PlacementOrder, live: readonly HostSlot[], now: number): Placement {
  const raw = splitSpecs(order.spec)[0]!;
  const requested = specHost(raw, config, order.owner);
  const auto = requested === 'auto';
  if (legacyLocalTarget(raw, config)) return { host: 'local', reason: '[local] host SSH wskazany w zleceniu' };
  if (!auto && requested === 'local' && !config.localHost && !raw.header.reuse_worktree) {
    const available = hostAvailability(config, 'local', undefined, now);
    // High load only alerts unless the owner opts in to holding starts on it (queue.hold_on_load).
    const machine = !config.queue.holdOnLoad || config.capacity.loadThreshold === undefined ? undefined : collectMachine(config);
    if (available || machine?.overloaded) return { hold: available ?? `obciążenie (load1 ${machine!.loadAverage[0]!.toFixed(1)} > ${machine!.threshold}) [local]` };
    const disk = diskStartHold(config, resolveSpec(raw, { config, owner: order.owner }).repos);
    return disk ? { hold: disk } : { reason: '[local] host domyślny' };
  }
  const cache = readHostsCache();
  const health = new Map(cache?.hosts.map(sample => [sample.name, sample]));
  const eligible: { name: string; running: number }[] = [];
  const reasons: string[] = [];
  let offlineGrace = false;
  const source = resolveSpec(raw, { config, owner: order.owner });
  const refs = [source.reuseWorktree, source.setupFromTask, ...(source.reviewOfAll ?? [order.reviewOf]), ...source.repos.map(r => /^@([^:]+)/.exec(r.base ?? '')?.[1]), ...order.after];
  if (order.reuse) refs.unshift(order.task);
  const related = auto ? refs.flatMap(id => {
    const task = id && findRecordAnywhere(config, id);
    return task ? [task.host ?? 'local'] : [];
  }) : [];
  const reuse = source.reuseWorktree ? findRecordAnywhere(config, source.reuseWorktree) : undefined;
  const hardAffinity = reuse ? reuse.host ?? 'local' : order.reuse && related[0] || undefined;
  if (source.reuseWorktree && !reuse?.closed) return { hold: `[${requested}] czeka na worktree ${source.reuseWorktree}` };
  if (hardAffinity && !auto && hardAffinity !== requested) return { hold: `[${requested}] worktree zadania znajduje się na [${hardAffinity}]` };
  const remotes = Object.keys(config.hosts).filter(name => name !== 'local').filter(name => {
    const h = config.hosts[name]!;
    return h.providers.includes(order.agent) && source.repos.every(r => Object.hasOwn(h.repos, (r.name ?? path.basename(r.path)))) && !source.review && !source.reviewMode && !source.mergeBaseCheck;
  });
  const names = hardAffinity ? [hardAffinity] : auto ? [...remotes, 'local'] : [requested];
  for (const name of names) {
    const host = name === 'local' ? undefined : name;
    const sample = health.get(name);
    const available = hostAvailability(config, name, sample, now);
    if (available) { reasons.push(available); continue; }
    const policy = host ? config.hosts[host] : config.localHost;
    if (host && !policy) { reasons.push(`[${host}] brak konfiguracji`); continue; }
    const strict = auto || order.perf || policy?.loadThreshold !== undefined;
    if (!strict && host && sample && sample.state !== 'reachable') { reasons.push(`[${name}] ${sample.state}`); continue; }
    if (strict) {
      const age = sample ? now - Date.parse(sample.probedAt) : Infinity;
      let backoff = 0;
      if (host) {
        try {
          const connection = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'hosts', `${host}.json`), 'utf8'));
          if (connection.unreachable && connection.retryAt > now) backoff = connection.retryAt;
        } catch { /* No runtime sample yet. */ }
      }
      if (backoff || !sample || !Number.isFinite(age) || age > 60_000 || sample.state !== 'reachable') {
        const since = sample?.offlineSince ?? sample?.probedAt ?? order.queuedAt;
        if (auto && host && now - Math.max(Date.parse(since), Date.parse(order.queuedAt)) < config.placement.failoverAfterMs) offlineGrace = true;
        reasons.push(`[${name}] ${backoff ? 'SSH niedostępne' : sample?.state === 'reachable' || !sample ? 'brak świeżej próbki hosta' : sample.state}`);
        continue;
      }
      const cli = sample.clis?.find(cli => cli.id === order.agent);
      if (!cli?.present || cli.loggedIn !== 'in') { reasons.push(`[${name}] ${order.agent}: wymagany CLI i logowanie`); continue; }
      if (host && (!sample.tmux?.present || source.repos.some(repo => !sample.repos?.some(r => r.present && r.name === (repo.name ?? path.basename(repo.path)))))) {
        reasons.push(`[${name}] brak tmux lub klonu repozytorium`);
        continue;
      }
      if (host && (!sample.disk || sample.disk.workDir !== config.hosts[host]?.workDir)) { reasons.push(`[${name}] brak odczytu work_dir`); continue; }
      const threshold = policy?.loadThreshold ?? config.capacity.loadThreshold ?? 3 * (sample.cpus ?? 1);
      if (sample.load === undefined || sample.load > threshold) { reasons.push(`[${name}] load1 ${sample.load ?? '?'} (limit ${threshold})`); continue; }
    }
    if (name === 'local' && config.queue.holdOnLoad && config.capacity.loadThreshold !== undefined && collectMachine(config).overloaded) {
      reasons.push('[local] obciążenie przekracza limit');
      continue;
    }
    if (!host && auto && source.repos.some(repo => !fs.existsSync(repo.path))) { reasons.push('[local] brak klonu repozytorium'); continue; }
    const disk = host ? taskDiskStartHold(config, host, [], now) : diskStartHold(config, source.repos);
    const limit = checkHostLimit(config, { host, agent: order.agent, perf: order.perf }, live) ?? (auto ? chatQuotaWait(config, { ...order, host }, live) : undefined);
    if (disk || limit) { reasons.push(`[${name}] ${disk ?? limit}`); continue; }
    eligible.push({ name, running: live.filter(w => w.agent && (w.host ?? 'local') === name && !w.reportReady).length });
  }
  const preferred = [...new Set([...related, ...config.placement.prefer, ...names])];
  const selected = eligible.filter(h => h.name !== 'local' || !offlineGrace || related[0] === 'local')
    .sort((a, b) => Number(b.name === related[0]) - Number(a.name === related[0]) || a.running - b.running || preferred.indexOf(a.name) - preferred.indexOf(b.name))[0];
  if (!selected) return { hold: [...reasons, ...(offlineGrace ? ['[local] czeka na failover'] : [])].join(' · ') || `[${requested}] brak wolnego hosta` };
  return { host: selected.name === 'local' ? undefined : selected.name, reason: auto
    ? `[${selected.name}] ${selected.name === related[0] ? 'worktree powiązanego zadania' : `wolne limity, ${selected.running} aktywnych zadań`}`
    : `[${selected.name}] host wskazany w zleceniu` };
}
