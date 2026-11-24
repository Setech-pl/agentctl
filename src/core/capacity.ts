import { renderChatLoad } from './chat-quotas.ts';
import { providerHoldText } from './provider-hold.ts';
import { collectMachine, machineLine } from './machine.ts';
import { get as providerValue } from './providers/registry.ts';
import { provider as adapter, activeProviders, perProvider } from './providers/registry.ts';
import { collectDisk, diskLine } from './disk.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { recordStaleCapacity } from './capacity-events.ts';
import type { AgentName } from './config.ts';
import { AGENT_NAMES } from './config.ts';
import type { Context } from './context.ts';
import { computeStats, selectHistory } from './history.ts';
import { collectLimits } from './limits.ts';
import { liveWindows } from './plan.ts';
import { readQueue, waiting } from './queue.ts';
import { codexPlanFile, openReader, readPlans, stalePlanLabel } from './usage.ts';
import type { PlanWindowView } from './usage.ts';
import { readSamples } from './usage-samples.ts';
import type { UsageSample } from './usage-samples.ts';
import { isObject, plural } from './util.ts';
import { agentHomes } from './usage-sources.ts';
import { windowKind } from './usage-parse.ts';

export interface TokenEstimate {
  tokensPerPercent: number;
  remainingTokens: number;
  confidence: 'low' | 'medium' | 'high';
  basis: { from: string; to: string; samples: number; percentIncrease: number; agentctlTokens: number; agentctlTokenShare: number | null; note: string };
}

/** Only a monotone sequence in the current window is comparable; never bridge a reset or missing samples. */
export function capacityTrend(samples: UsageSample[], provider: AgentName, window: PlanWindowView) {
  const current = samples.filter((s) => s.provider === provider);
  const segment: { sample: UsageSample; used: number }[] = [];
  for (const sample of current) {
    const w = sample.windows.find((w) => w.kind === window.kind && w.minutes === window.minutes && w.resetsAt === window.resetsAt);
    if (!w || (segment.length > 0 && w.usedPercent < segment.at(-1)!.used)) segment.length = 0;
    if (w) segment.push({ sample, used: w.usedPercent });
  }
  const first = segment[0];
  const last = segment.at(-1);
  const span = first && last ? last.sample.at - first.sample.at : 0;
  const delta = first && last ? last.used - first.used : 0;
  const rate = segment.length >= 2 && span >= 60_000 ? delta * 3_600_000 / span : null;
  const projectedExhaustAt = rate !== null && rate > 0 && last ? new Date(last.sample.at + (100 - last.used) / rate * 3_600_000).toISOString() : null;
  let estimate: TokenEstimate | null = null;
  // Counter samples are captured within 60 s of the matching percentage. Historical logs read much later cannot estimate token cost.
  if (first && last && segment.length >= 3 && span >= 300_000 && delta >= 2 && segment.every((s) => Math.abs(s.sample.capturedAt - s.sample.at) <= 60_000)) {
    const tokens = last.sample.taskTokens - first.sample.taskTokens;
    if (tokens > 0 && segment.every((s, i) => i === 0 || s.sample.taskTokens >= segment[i - 1]!.sample.taskTokens)) {
      const tokensPerPercent = tokens / delta;
      estimate = { tokensPerPercent, remainingTokens: Math.round(tokensPerPercent * (100 - window.usedPercent)), confidence: 'low', basis: { from: new Date(first.sample.at).toISOString(), to: new Date(last.sample.at).toISOString(), samples: segment.length, percentIncrease: delta, agentctlTokens: tokens, agentctlTokenShare: null, note: 'Percent includes usage outside agentctl. The share attributable to agentctl is n/d; confidence is capped at low. Fresh tokens = input + output + cache writes.' } };
    }
  }
  return { percentPerHour: rate, projectedExhaustAt, estimate };
}

export { refreshCodexCapacity } from './providers/codex-usage.ts';

export async function collectCapacity(ctx: Context, opts: { diskBudgetMs?: number; cachedOnly?: boolean; save?: boolean; rows?: StatusRow[]; live?: Awaited<ReturnType<typeof liveWindows>> } = {}) {
  const refreshNotes = perProvider(activeProviders(ctx.config), () => null as string | null);
  if (!opts.cachedOnly) for (const id of activeProviders(ctx.config)) refreshNotes[id] = await adapter(id).usage.refreshPlan?.(ctx) ?? null;
  const now = ctx.runner.now();
  const reader = openReader(ctx.config);
  const plans = readPlans(ctx.config, reader, now);
  if (opts.save !== false) {
    reader.save();
    await recordStaleCapacity(ctx, plans);
  }
  const samples = readSamples(ctx.config);
  const loads = collectLimits(ctx.config, opts.live ?? await liveWindows(ctx), now);
  const queue = waiting(readQueue(ctx.config));
  const rows = opts.rows ?? await collectStatus(ctx, { cachedOnly: true, shallowClosed: true, progress: false });
  const stats = computeStats(selectHistory(ctx, { since: '7d' }));
  return {
    at: new Date(now).toISOString(),
    machine: collectMachine(ctx.config),
    disk: await collectDisk(ctx, undefined, opts.diskBudgetMs === undefined ? {} : { budgetMs: opts.diskBudgetMs }),
    hosts: loads.hosts ?? [],
    note: 'n/d = null. Plan percentages include use outside agentctl. Estimates are not provider token quotas.',
    providers: activeProviders(ctx.config).map((provider) => {
      const plan = providerValue(plans, provider);
      const load = loads.providers.find((p) => p.agent === provider)!;
      const windows = plan.windows.map((w) => ({ ...w, remainingPercent: 100 - w.usedPercent, resetsInMinutes: w.resetsAt === null ? null : Math.max(0, Math.ceil((w.resetsAt - now) / 60_000)), ...capacityTrend(samples, provider, w) }));
      const hints: string[] = [];
      for (const w of windows) {
        for (const threshold of ctx.config.capacity.thresholds) if (w.usedPercent >= threshold) hints.push(`${w.label} usage >= ${threshold}%`);
        if (w.percentPerHour !== null && w.percentPerHour > 0 && w.projectedExhaustAt && w.resetsAt !== null && Date.parse(w.projectedExhaustAt) < w.resetsAt) hints.push(`${w.label} projected exhaustion before reset at observed pace`);
      }
      if (plan.stale) hints.push(`reading older than ${ctx.config.capacity.staleMinutes} minutes`);
      if (load.free === 0) hints.push('no free configured slots');
      return {
        provider, estimate: [...windows].sort((a, b) => a.remainingPercent - b.remainingPercent)[0]?.estimate ?? null, source: plan.source, ageSeconds: plan.readAt === null ? null : Math.max(0, Math.floor((now - plan.readAt) / 1000)), stale: plan.stale, expired: plan.expired === true, staleDescription: plan.expired && plan.readAt !== null ? stalePlanLabel(now - plan.readAt) : plan.stale && plan.readAt !== null ? `${adapter(provider).displayName}: brak aktywnej sesji od ${((now - plan.readAt) / 3600000).toFixed(1)} h (odczyt z ${new Date(plan.readAt).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })})` : null, windows,
        providerHold: load.providerHold ?? null,
        limited: Boolean(load.providerHold) || rows.some((r) => r.agent === provider && r.window === 'alive' && r.state === 'limited') || (windows.length > 0 ? windows.some((w) => w.usedPercent >= 100) : null),
        slots: { starting: load.starting, active: load.working.length, reportReady: load.reportReady.length, used: load.used, limit: load.limit, reserved: load.reserved, external: load.external.length, free: load.free },
        ...(load.chats ? { chats: load.chats } : {}),
        queue: { count: load.queued, next: queue.find((q) => q.agent === provider)?.task ?? null, hold: load.queueHold },
        models: [...new Map(ctx.config.equivalents.flatMap((e) => e[provider] ? [[`${e[provider].model}/${e[provider].effort}`, e[provider]] as const] : [])).values()],
        stats: stats.filter((s) => s.agent === provider), hints, note: [plan.expired ? null : plan.note, refreshNotes[provider]].filter(Boolean).join('; '),
      };
    }),
  };
}
export type Capacity = Awaited<ReturnType<typeof collectCapacity>>;
export function capacitySnapshot(report: Capacity, ordered: readonly AgentName[] = []) {
  return report.providers.map((p) => {
    const worst = [...p.windows].sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
    return { provider: p.provider, ...((report.hosts ?? []).length ? {hostSlots: report.hosts!.map(h => ({host: h.host, ...h.providers.find(s => s.agent === p.provider)})).filter(s => s.agent === p.provider)} : {}), ordered: ordered.includes(p.provider), queueHold: p.queue.hold ?? null, providerHold: p.providerHold, remainingPercent: worst?.remainingPercent ?? null, resetsInMinutes: worst?.resetsInMinutes ?? null, ageSeconds: p.ageSeconds, stale: p.stale, expired: p.expired, staleDescription: p.staleDescription, planNote: p.provider === 'glm' && p.ageSeconds === null ? p.note : '', reportReady: p.slots.reportReady, freeSlots: p.slots.free, ...(p.chats ? {globalSlots: {used: p.slots.used, limit: p.slots.limit}, chats: p.chats} : {}), estimate: worst?.estimate ? { remainingTokens: worst.estimate.remainingTokens, confidence: worst.estimate.confidence } : null };
  });
}
export function snapshotLines(snapshot: ReturnType<typeof capacitySnapshot>): string[] {
  return snapshot.flatMap((p) => {
    const reading = p.expired && p.ageSeconds !== null ? stalePlanLabel(p.ageSeconds * 1000)
      : `remaining ${p.remainingPercent === null ? 'n/d' : `${p.remainingPercent}%`}${p.planNote ? ` (${p.planNote})` : ''}, reset ${p.resetsInMinutes ?? 'n/d'} min, age ${p.ageSeconds ?? 'n/d'} s${p.staleDescription ? `, ${p.staleDescription}` : ''}`;
    return [`capacity: ${p.provider}${p.ordered ? ' (order)' : ''}: ${reading}, free slots ${p.freeSlots ?? 'unbounded'}, queue_hold ${p.queueHold === null ? 'off' : `${p.queueHold}%`}${p.providerHold ? `; ${providerHoldText(p.provider, p.providerHold)}` : ''}${p.hostSlots?.length ? `; hosts ${p.hostSlots.map(h => `${h.host} ${h.used}/${h.limit ?? 'unbounded'}, free ${h.free ?? 'unbounded'}`).join(' / ')}` : ''}${p.reportReady ? `; ${p.reportReady} ${plural(p.reportReady, 'okno', 'okna', 'okien')} report-ready – close zwolni ${plural(p.reportReady, 'okno', 'okna', 'okien')}` : ''}${p.estimate ? `, estimate.remainingTokens ${p.estimate.remainingTokens} (${p.estimate.confidence})` : ''}`, ...(p.globalSlots ? [`  ${p.provider} global ${p.globalSlots.used}/${p.globalSlots.limit ?? '∞'}`, ...p.chats!.map(chat => `  ${p.provider} ${renderChatLoad(chat)}`)] : [])];
  });
}
export function renderCapacity(report: Capacity): string[] {
  return [machineLine(report.machine), diskLine(report.disk), ...(report.hosts ?? []).map(h => `host ${h.host}: ${h.providers.map(p => `${p.agent} ${p.used}/${p.limit ?? 'unbounded'}, free ${p.free ?? 'unbounded'}, queued ${p.queued}`).join(' · ')} (account limits/holds also apply)`), ...snapshotLines(capacitySnapshot(report)), ...report.providers.flatMap((p) => [
    ...p.windows.map((w) => `${p.provider} ${w.label}: used ${w.usedPercent}%, remaining ${w.remainingPercent}%, reset ${w.resetsInMinutes ?? 'n/d'} min, pace ${w.percentPerHour === null ? 'n/d' : w.percentPerHour.toFixed(2)}%/h, projectedExhaustAt ${w.projectedExhaustAt ?? 'n/d'}, estimate ${w.estimate ? JSON.stringify(w.estimate) : 'n/d'}`),
    `${p.provider}: slots ${p.slots.active}/${p.slots.limit ?? 'unbounded'}, reserve ${p.slots.reserved}, queue ${p.queue.count} (next ${p.queue.next ?? 'n/d'}, queue_hold ${p.queue.hold == null ? 'off' : `${p.queue.hold}%`}), limited ${p.limited ?? 'n/d'}, source ${p.source}`,
    `${p.provider}: models ${p.models.map((m) => `${m.model}/${m.effort}`).join(', ')}`,
    ...p.stats.map((s) => `${p.provider} ${s.model}/${s.effort} 7d: n=${s.tasks}, median ${s.medianDurationMs ?? 'n/d'} ms, tokens ${s.medianTokens ?? 'n/d'}, ok/partial/fail ${s.ok}/${s.partial}/${s.fail}, unmarked ${s.unmarked}`),
    ...p.hints.map((h) => `${p.provider}: ${h}`), ...(p.note && (p.provider !== 'glm' || p.ageSeconds !== null) ? [`${p.provider}: ${p.note}`] : []),
  ]), report.note];
}
