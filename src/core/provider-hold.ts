import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { activeProviders } from './providers/registry.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';
import { AgentctlError, formatLocalTime } from './util.ts';

export interface ProviderHold { until: string; source: 'manual' | 'automatic'; reason?: string; detectedIn?: string; scope?: 'global' }
export interface HoldState { holds: Partial<Record<AgentName, ProviderHold>>; seen: Record<string, string> }
export const providerHoldFile = (config: Pick<GlobalConfig, 'path'>) => path.join(path.dirname(config.path), 'provider-holds.json');
export function readProviderHoldState(config: Pick<GlobalConfig, 'path'>): HoldState {
  try { const data = JSON.parse(fs.readFileSync(providerHoldFile(config), 'utf8')); return {holds: data.holds ?? {}, seen: data.seen ?? {}}; } catch { return {holds: {}, seen: {}}; }
}
export function providerHolds(config: Pick<GlobalConfig, 'path'>, now: number): Partial<Record<AgentName, ProviderHold>> {
  return Object.fromEntries(Object.entries(readProviderHoldState(config).holds).filter(([, hold]) => hold && Date.parse(hold.until) > now));
}
export function providerHoldText(agent: string, hold: ProviderHold): string {
  if (hold.source === 'manual') return `wstrzymane: ${agent} do ${formatLocalTime(hold.until).slice(-5)} (ręcznie); globalnie: wszystkie kohorty/czaty`;
  return `${agent}: wstrzymane do ${formatLocalTime(hold.until)} (wyczerpany plan${hold.detectedIn ? `, wykryte w ${hold.detectedIn}` : ''}; globalnie: wszystkie kohorty/czaty)`;
}
/** Local HH:MM means the next occurrence; ISO must carry an explicit date. */
export function holdUntil(value: string, now: number): string {
  const duration = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(value);
  let time: number;
  if (duration) time = now + Number(duration[1]) * ({s: 1000, m: 60000, h: 3600000, d: 86400000}[duration[2]!]!);
  else if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    const date = new Date(now); date.setHours(Number(value.slice(0, 2)), Number(value.slice(3)), 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    time = date.getTime();
  } else time = /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time <= now) throw new AgentctlError(`hold: ${value}: expected a future HH:MM, ISO timestamp, duration (3h), or off`);
  return new Date(time).toISOString();
}
export type TimedHolds = Partial<Record<AgentName, string>>;
export function parseTimedHolds(config: GlobalConfig, input: unknown, now: number): TimedHolds {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AgentctlError('hold: expected {glm: "3h"}');
  const out: TimedHolds = {};
  for (const [agent, value] of Object.entries(input)) {
    if (!activeProviders(config).includes(agent as AgentName) || typeof value !== 'string') throw new AgentctlError(`hold.${agent}: expected an active provider and a time string`);
    out[agent as AgentName] = value === 'off' ? 'off' : holdUntil(value, now);
  }
  if (!Object.keys(out).length) throw new AgentctlError('hold: give at least one provider');
  return out;
}
export async function setProviderHolds(ctx: Context, assignments: TimedHolds): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = providerHoldFile(ctx.config);
  await withFileLock(`${file}.lock`, async () => {
    const state = readProviderHoldState(ctx.config);
    for (const [agent, until] of Object.entries(assignments) as [AgentName, string][]) {
      if (until === 'off') delete state.holds[agent];
      else state.holds[agent] = {until, source: 'manual', scope: 'global'};
    }
    await ctx.runner.writeFile(file, JSON.stringify(state));
    for (const [agent, until] of Object.entries(assignments) as [AgentName, string][]) await recordJournal(ctx, {kind: 'limits-changed', text: until === 'off' ? `${agent}: hold off` : providerHoldText(agent, state.holds[agent]!)});
  });
}
export async function expireProviderHolds(ctx: Context): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = providerHoldFile(ctx.config);
  if (!fs.existsSync(file)) return;
  await withFileLock(`${file}.lock`, async () => {
    const state = readProviderHoldState(ctx.config);
    for (const [agent, hold] of Object.entries(state.holds) as [AgentName, ProviderHold][]) {
      if (Date.parse(hold.until) > ctx.runner.now()) continue;
      delete state.holds[agent];
      await ctx.runner.writeFile(file, JSON.stringify(state));
      await recordJournal(ctx, {kind: 'limits-changed', text: `${agent}: wstrzymanie wygasło (${hold.source === 'manual' ? 'ręcznie' : 'automatycznie'})`});
    }
  });
}

/** A stable evidence key is consumed once, so a stale pane cannot extend/re-arm an expired hold. */
export async function automaticProviderHold(ctx: Context, agent: AgentName, key: string, evidence: string, reset?: number): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = providerHoldFile(ctx.config);
  await withFileLock(`${file}.lock`, async () => {
    const state = readProviderHoldState(ctx.config);
    const fingerprint = createHash('sha256').update(evidence).digest('hex');
    if (state.seen[key] === fingerprint) return;
    state.seen[key] = fingerprint;
    while (Object.keys(state.seen).length > 2000) delete state.seen[Object.keys(state.seen)[0]!];
    const current = state.holds[agent];
    const until = new Date(reset && reset > ctx.runner.now() ? reset : ctx.runner.now() + 3600000).toISOString();
    if (!current || Date.parse(current.until) <= ctx.runner.now() || (current.source === 'automatic' && Date.parse(current.until) < Date.parse(until))) state.holds[agent] = {until, source: 'automatic', reason: 'provider quota/rate-limit error', detectedIn: key.split(':')[0], scope: 'global'};
    await ctx.runner.writeFile(file, JSON.stringify(state));
    await recordJournal(ctx, {kind: 'limits-changed', task: key.split(':')[0], text: `${providerHoldText(agent, state.holds[agent]!)}; błąd quota/rate-limit dostawcy`});
  });
}

export function providerHoldLines(config: Pick<GlobalConfig, 'path'>, now: number): string[] {
  return Object.entries(providerHolds(config, now)).map(([agent, hold]) => providerHoldText(agent, hold!));
}
