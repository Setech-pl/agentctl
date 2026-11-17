import type { AgentName, GlobalConfig } from './config.ts';
import { formatLocalTime } from './util.ts';
export interface PeakWindow { days: string | string[]; from: string; to: string; tz: string }
export interface ProviderSettings { command?: string; env?: Record<string, string>; peak?: PeakWindow[]; peakPolicy?: 'hold' | 'short_only' }
export const DEFAULT_GLM_PEAK: PeakWindow[] = [{days: 'mon-fri', from: '14:00', to: '18:00', tz: 'Asia/Singapore'}];
const WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export function peakDays(value: unknown): number[] | undefined {
  const tokens = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : [];
  if (!tokens.length) return undefined;
  const days = new Set<number>();
  for (const token of tokens) {
    if (typeof token !== 'string') return undefined;
    const [from, to, extra] = token.toLowerCase().split('-');
    const start = WEEK.indexOf(from!), end = to ? WEEK.indexOf(to) : start;
    if (start < 0 || end < 0 || extra !== undefined) return undefined;
    for (let day = start; ; day = (day + 1) % 7) { days.add(day); if (day === end) break; }
  }
  return [...days];
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function inWindow(window: PeakWindow, now: number): boolean {
  let fmt = formatters.get(window.tz);
  if (!fmt) { fmt = new Intl.DateTimeFormat('en-GB', {timeZone: window.tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}); formatters.set(window.tz, fmt); }
  const parts = fmt.formatToParts(now), part = (type: string) => parts.find(p => p.type === type)!.value;
  const day = WEEK.indexOf(part('weekday').toLowerCase()), minute = Number(part('hour')) * 60 + Number(part('minute'));
  const from = Number(window.from.slice(0, 2)) * 60 + Number(window.from.slice(3)), to = Number(window.to.slice(0, 2)) * 60 + Number(window.to.slice(3));
  const days = peakDays(window.days)!;
  return from < to ? days.includes(day) && minute >= from && minute < to : (days.includes(day) && minute >= from) || (days.includes((day + 6) % 7) && minute < to);
}
const memo = new WeakMap<GlobalConfig, Map<AgentName, {minute: number; signature: string; result: {until: string; policy: 'hold' | 'short_only'} | null}>>();
/** All calendar decisions are in each window's IANA zone, including DST and overnight windows. */
export function peakState(config: GlobalConfig, agent: AgentName, now: number): {until: string; policy: 'hold' | 'short_only'} | null {
  const settings = config.providersConfig?.[agent];
  const windows = settings?.peak ?? (agent === 'glm' ? DEFAULT_GLM_PEAK : []), policy = settings?.peakPolicy ?? 'hold';
  const minute = Math.floor(now / 60000), signature = JSON.stringify([windows, policy]);
  let cache = memo.get(config); if (!cache) {cache = new Map(); memo.set(config, cache);}
  const previous = cache.get(agent);
  if (previous?.minute === minute && previous.signature === signature) return previous.result;
  const active = (at: number) => windows.some(w => inWindow(w, at));
  let result = null;
  if (active(now)) {
    let end = (minute + 1) * 60000;
    // At most one week of consecutive windows; there is no wall-clock wait here.
    for (let i = 0; i < 7 * 1440 && active(end); i++) end += 60000;
    result = {until: new Date(end).toISOString(), policy};
  }
  cache.set(agent, {minute, signature, result});
  return result;
}
export function peakHold(config: GlobalConfig, order: {agent: AgentName; class?: string; peakOk?: boolean}, now: number): string | undefined {
  const peak = peakState(config, order.agent, now);
  if (!peak || peak.policy === 'short_only' && (order.peakOk || ['report', 'simple', 'smoke', 'gate'].includes(order.class ?? ''))) return undefined;
  return `${order.agent}: szczyt do ${formatLocalTime(peak.until).slice(-5)}${peak.policy === 'short_only' ? ' (tylko report/simple/smoke/gate lub peak_ok: true)' : ''}`;
}
export function peakLines(config: GlobalConfig, now: number): string[] {
  return config.providers.flatMap(agent => { const peak = peakState(config, agent, now); return peak ? [`${agent}: szczyt do ${formatLocalTime(peak.until).slice(-5)} (${peak.policy})`] : []; });
}
