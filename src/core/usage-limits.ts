import fs from 'node:fs';
import path from 'node:path';
import { AGENT_NAMES } from './config.ts';
import type { AgentName, GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import type { Notifier } from './notify.ts';
import type { ResolvedSpec } from './spec.ts';
import { formatReset, openReader, readPlans } from './usage.ts';
import type { PlanState, PlanWindowView } from './usage.ts';
import { planLine } from './usage-report.ts';
import { homeDir } from './usage-sources.ts';
import { isObject } from './util.ts';

/*
 * What the plan percentages are used for: a notification when a window crosses `usage.warn` or `usage.critical`, a hint when a task is
 * about to start on a provider that is close to its limit while the other one has room, and the hold of the queue (`usage.queue_hold`).
 * Nothing here ever changes the provider of a task: it only says what it sees.
 */

export type Level = 'warn' | 'critical';
const RANK: Record<Level, number> = { warn: 1, critical: 2 };

const NAME: Record<AgentName, string> = { claude: 'Claude', codex: 'Codex' };

/** The level a percentage has for a provider, or undefined below the warning threshold. */
export function levelOf(config: Pick<GlobalConfig, 'usage'>, provider: AgentName, percent: number): Level | undefined {
  if (percent >= config.usage.critical[provider]) return 'critical';
  if (percent >= config.usage.warn[provider]) return 'warn';
  return undefined;
}

// ---- the notifications

/** `<AGENTCTL_HOME>/usage-alerts.json`: per window instance (provider, window, its reset) the highest level that was announced. */
export const alertsFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(homeDir(config), 'usage-alerts.json');

export function readAlertLedger(config: Pick<GlobalConfig, 'path'>): Record<string, Level> {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(alertsFile(config), 'utf8'));
    const out: Record<string, Level> = {};
    if (isObject(data)) for (const [k, v] of Object.entries(data)) if (v === 'warn' || v === 'critical') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export interface UsageAlert {
  provider: AgentName;
  window: PlanWindowView;
  level: Level;
  percent: number;
  /** provider|window|reset: one window of one period. */
  key: string;
}

const windowKey = (provider: AgentName, w: PlanWindowView): string => `${provider}|${w.kind}${w.kind === 'other' ? w.minutes ?? '' : ''}|${w.resetsAt ?? 'open'}`;

/** The windows that crossed a threshold they were not announced for yet: one alert per threshold and window instance (a window is a new one after its reset). */
export function pendingAlerts(config: Pick<GlobalConfig, 'usage'>, plans: Record<AgentName, PlanState>, ledger: Record<string, Level>): UsageAlert[] {
  const out: UsageAlert[] = [];
  for (const provider of AGENT_NAMES) {
    for (const window of plans[provider].windows) {
      const level = levelOf(config, provider, window.usedPercent);
      if (!level) continue;
      const key = windowKey(provider, window);
      const done = ledger[key];
      if (done !== undefined && RANK[done] >= RANK[level]) continue;
      out.push({ provider, window, level, percent: window.usedPercent, key });
    }
  }
  return out;
}

const otherOf = (p: AgentName): AgentName => (p === 'claude' ? 'codex' : 'claude');

/** "claude blisko limitu (83%), codex ma zapas (12%): --agent codex"; undefined when no hint applies (the other provider is n/d or close too). */
export function providerHint(config: Pick<GlobalConfig, 'usage'>, plans: Record<AgentName, PlanState>, provider: AgentName): string | undefined {
  const mine = plans[provider];
  const other = plans[otherOf(provider)];
  if (!mine.available || mine.maxPercent === null || mine.maxPercent < config.usage.warn[provider]) return undefined;
  if (!other.available || other.maxPercent === null || other.maxPercent >= config.usage.warn[other.provider]) return undefined;
  return `${provider} blisko limitu (${Math.round(mine.maxPercent)}%), ${other.provider} ma zapas (${Math.round(other.maxPercent)}%): --agent ${other.provider}`;
}

export function alertText(config: Pick<GlobalConfig, 'usage'>, plans: Record<AgentName, PlanState>, alert: UsageAlert, now: number): string {
  const when = alert.window.resetsAt === null ? '' : ` (reset ${formatReset(alert.window.resetsAt, now)})`;
  const base = `${NAME[alert.provider]}: ${Math.round(alert.percent)}% limitu ${alert.window.label}${when} – ${alert.level === 'critical' ? 'limit prawie wyczerpany' : 'blisko limitu'}`;
  const other = otherOf(alert.provider);
  return providerHint(config, plans, alert.provider) ? `${base}; ${other} ma zapas (${Math.round(plans[other].maxPercent as number)}%): --agent ${other}` : base;
}

/**
 * One look at the plans for `watch`: a notification for every window that crossed `usage.warn` or `usage.critical` since the last look
 * (once per threshold and window period; the ledger survives a restart of the watcher). Returns the texts that were sent.
 */
export async function usageTick(ctx: Context, notifier: Notifier, log?: (line: string) => Promise<void> | void): Promise<string[]> {
  const { config, runner } = ctx;
  const now = runner.now();
  const reader = openReader(config);
  const plans = readPlans(config, reader, now);
  reader.save();
  const ledger = readAlertLedger(config);
  const alerts = pendingAlerts(config, plans, ledger);
  // Windows that are over are forgotten, so the ledger does not grow for ever.
  const live = new Set(AGENT_NAMES.flatMap((p) => plans[p].windows.map((w) => windowKey(p, w))));
  let changed = false;
  for (const key of Object.keys(ledger)) {
    if (!live.has(key) && !alerts.some((a) => a.key === key)) {
      delete ledger[key];
      changed = true;
    }
  }
  const sent: string[] = [];
  for (const alert of alerts) {
    const text = alertText(config, plans, alert, now);
    ledger[alert.key] = alert.level;
    changed = true;
    await notifier.notify('agentctl', text).catch(() => undefined);
    await log?.(`usage: ${text}`);
    sent.push(text);
  }
  if (changed) await runner.writeFile(alertsFile(config), `${JSON.stringify(ledger, null, 2)}\n`);
  return sent;
}

// ---- before a task starts

/** Lines for the summary of `new` and `queue`: the state of the plan of each provider the tasks use, and the hint for a task that could do with the other one. */
export function usageSummaryLines(config: GlobalConfig, specs: readonly Pick<ResolvedSpec, 'task' | 'agent' | 'pin'>[], now: number, plans?: Record<AgentName, PlanState>): string[] {
  if (specs.length === 0) return [];
  let state = plans;
  if (!state) {
    const reader = openReader(config);
    state = readPlans(config, reader, now);
    reader.save();
  }
  const lines: string[] = [];
  for (const agent of new Set(specs.map((s) => s.agent))) lines.push(`plan:     ${agent} ${planLine(state[agent], now)}`);
  for (const spec of specs) {
    const hint = providerHint(config, state, spec.agent);
    if (!hint) continue;
    lines.push(spec.pin ? `hint:     ${spec.task} is pinned (pin: true): it stays on ${spec.agent} whatever the plan says` : `hint:     ${spec.task}: ${hint}`);
  }
  return lines;
}

// ---- the queue

/** For each provider that `usage.queue_hold` holds: why. A provider whose plan is n/d is never held (nothing is known). */
export function queueHolds(config: GlobalConfig, now: number, plans?: Record<AgentName, PlanState>): Partial<Record<AgentName, string>> {
  const limits = config.usage.queueHold;
  if (Object.keys(limits).length === 0) return {};
  let state = plans;
  if (!state) {
    const reader = openReader(config);
    state = readPlans(config, reader, now);
    reader.save();
  }
  const out: Partial<Record<AgentName, string>> = {};
  for (const provider of AGENT_NAMES) {
    const limit = limits[provider];
    const plan = state[provider];
    if (limit === undefined || !plan.available || plan.maxPercent === null || plan.maxPercent <= limit) continue;
    const worst = plan.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
    out[provider] = `wstrzymane: ${provider} ${Math.round(worst.usedPercent)}% limitu ${worst.label}${worst.resetsAt === null ? '' : ` (reset ${formatReset(worst.resetsAt, now)})`} > usage.queue_hold ${limit}%`;
  }
  return out;
}
