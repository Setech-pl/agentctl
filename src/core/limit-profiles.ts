import type { AgentName, GlobalConfig } from './config.ts';
import { checkKeys } from './config.ts';
import { validShare } from './chat-quotas.ts';
import type { ChatQuotas } from './chat-quotas.ts';
import { isObject } from './util.ts';
import type { Problems } from './util.ts';
import { WALL_CHAT_NAME } from './wall-config.ts';

export type ProviderLimit = number | 'off';
type ProviderLimits = Partial<Record<AgentName, ProviderLimit>>;
interface Profile { providers: ProviderLimits; shares: Record<string, number> }
interface Schedule { timezone: string; switches: { time: string; profile: string }[] }
interface TimedLimit { value: ProviderLimit; until: string }
interface Switch { profile: string; at: number }

export interface LimitSettings {
  changePolicy: 'owner-approve' | 'direct';
  base: GlobalConfig['limits'];
  baseQuotas?: ChatQuotas;
  profiles: Record<string, Profile>;
  schedule?: Schedule;
  manual?: { name: string; until?: string };
  overrides: Partial<Record<AgentName, TimedLimit>>;
}

export interface LimitRuntime {
  profile?: string;
  nextSwitch?: Switch;
  nextEvaluation?: number;
  timed: Partial<Record<AgentName, TimedLimit>>;
}

const dayMs = 86_400_000;
const clockTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const profileName = /^[a-z][a-z0-9_-]{0,59}$/;
const validLimit = (value: unknown): value is ProviderLimit => value === 'off' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const validUntil = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

export function parseLimitSettings(raw: unknown, ids: readonly AgentName[], base: GlobalConfig['limits'], baseQuotas: ChatQuotas | undefined, p: Problems): LimitSettings {
  const config: LimitSettings = { changePolicy: 'owner-approve', base, baseQuotas, profiles: Object.create(null), overrides: {} };
  if (!isObject(raw)) return config;
  if (raw.change_policy === 'direct') config.changePolicy = 'direct';
  else if (raw.change_policy !== undefined && raw.change_policy !== 'owner-approve') p.add('config.limits.change_policy must be owner-approve or direct');

  if (isObject(raw.profiles)) for (const [name, value] of Object.entries(raw.profiles)) {
    const where = `config.limits.profiles.${name}`;
    if (!profileName.test(name) || !isObject(value)) { p.add(`${where} must be a named profile mapping`); continue; }
    checkKeys(value, [...ids, 'shares'], where, p);
    const profile: Profile = { providers: {}, shares: Object.create(null) };
    for (const id of ids) {
      if (value[id] === undefined) continue;
      if (validLimit(value[id])) profile.providers[id] = value[id];
      else p.add(`${where}.${id} must be a nonnegative integer or off`);
    }
    if (isObject(value.shares)) for (const [chat, share] of Object.entries(value.shares)) {
      if (!WALL_CHAT_NAME.test(chat) || !validShare(share)) p.add(`${where}.shares.${chat} must name a chat and give a percentage from 0 to 100`);
      else profile.shares[chat] = share;
    }
    else if (value.shares !== undefined) p.add(`${where}.shares must be a mapping`);
    config.profiles[name] = profile;
  }
  else if (raw.profiles !== undefined) p.add('config.limits.profiles must be a mapping');

  if (isObject(raw.schedule)) {
    const { timezone, switches } = raw.schedule;
    checkKeys(raw.schedule, ['timezone', 'switches'], 'config.limits.schedule', p);
    if (typeof timezone !== 'string' || !isObject(switches) || Object.keys(switches).length === 0) p.add('config.limits.schedule needs a timezone and at least one switch');
    else {
      try { formatter(timezone); } catch { p.add('config.limits.schedule.timezone must be an IANA timezone'); }
      config.schedule = { timezone, switches: [] };
      for (const [time, profile] of Object.entries(switches)) {
        if (!clockTime.test(time) || typeof profile !== 'string' || !Object.hasOwn(config.profiles, profile)) p.add(`config.limits.schedule.switches.${time} needs an HH:MM time and a defined profile`);
        else config.schedule.switches.push({ time, profile });
      }
      config.schedule.switches.sort((a, b) => a.time.localeCompare(b.time));
    }
  }
  else if (raw.schedule !== undefined) p.add('config.limits.schedule must be a mapping');

  if (raw.active_profile !== undefined) {
    const entry = typeof raw.active_profile === 'string' ? { name: raw.active_profile } : raw.active_profile;
    if (!isObject(entry) || typeof entry.name !== 'string' || !Object.hasOwn(config.profiles, entry.name) || (entry.until !== undefined && !validUntil(entry.until))) {
      p.add('config.limits.active_profile needs a defined profile name and an optional ISO deadline');
    } else {
      checkKeys(entry, ['name', 'until'], 'config.limits.active_profile', p);
      config.manual = { name: entry.name, until: entry.until as string | undefined };
    }
  }
  if (isObject(raw.timed_overrides)) for (const [id, entry] of Object.entries(raw.timed_overrides)) {
    const where = `config.limits.timed_overrides.${id}`;
    if (!ids.includes(id as AgentName) || !isObject(entry) || !validLimit(entry.value) || !validUntil(entry.until)) p.add(`${where} needs an active provider, a limit value and an ISO deadline`);
    else {
      checkKeys(entry, ['value', 'until'], where, p);
      config.overrides[id as AgentName] = { value: entry.value, until: entry.until };
    }
  }
  else if (raw.timed_overrides !== undefined) p.add('config.limits.timed_overrides must be a mapping');
  return config;
}

const formatter = (timezone: string) => new Intl.DateTimeFormat('en-GB', {
  timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});

function localMinute(format: Intl.DateTimeFormat, time: number): number {
  const { year, month, day, hour, minute } = Object.fromEntries(format.formatToParts(time).map(p => [p.type, Number(p.value)]));
  return Date.UTC(year!, month! - 1, day!, hour!, minute!);
}

function scheduledProfile(schedule: Schedule, now: number): { previous?: Switch; next?: Switch } {
  const format = formatter(schedule.timezone);
  const midnight = Math.floor(localMinute(format, now) / dayMs) * dayMs;
  const switches: Switch[] = [];
  for (const days of [-2, -1, 0, 1, 2]) {
    const date = midnight + days * dayMs;
    const offsets = [...new Set([-1, 0, 1, 2].map(offset => {
      const sample = date + offset * dayMs;
      return localMinute(format, sample) - sample;
    }))];
    for (const { time, profile } of schedule.switches) {
      const local = date + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60_000;
      const candidates = offsets.map(offset => local - offset).sort((a, b) => a - b);
      // Earlier occurrence in the autumn fold. In the spring gap, shift forward by the gap.
      const at = candidates.find(candidate => localMinute(format, candidate) === local)
        ?? candidates.find(candidate => localMinute(format, candidate) > local);
      if (at !== undefined) switches.push({ profile, at });
    }
  }
  switches.sort((a, b) => a.at - b.at);
  return { previous: switches.findLast(s => s.at <= now), next: switches.find(s => s.at > now) };
}

export function effectiveLimitConfig(config: GlobalConfig, now: number): GlobalConfig {
  const settings = config.limitSettings;
  const schedule = settings.schedule ? scheduledProfile(settings.schedule, now) : undefined;
  const manual = settings.manual;
  const manualUntil = manual?.until ? Date.parse(manual.until) : undefined;
  const profile = manual && (manualUntil === undefined || manualUntil > now) ? manual.name : schedule?.previous?.profile;
  const selected = profile ? settings.profiles[profile] : undefined;
  const quotas = settings.baseQuotas;
  const limits = { ...settings.base };
  const apply = (id: AgentName, value: ProviderLimit) => { if (value === 0) delete limits[id]; else limits[id] = value; };
  for (const [id, value] of Object.entries(selected?.providers ?? {}) as [AgentName, ProviderLimit][]) apply(id, value);
  const timed: LimitRuntime['timed'] = {};
  const deadlines = [manualUntil, schedule?.next?.at];
  for (const [id, override] of Object.entries(settings.overrides) as [AgentName, TimedLimit][]) {
    const until = Date.parse(override.until);
    if (until <= now) continue;
    timed[id] = override;
    deadlines.push(until);
    apply(id, override.value);
  }
  let effectiveQuotas = quotas;
  if (selected && Object.keys(selected.shares).length) {
    const base = quotas ?? { chats: {}, default: {}, floor: {}, cohorts: {}, overprovision: 1.5, per_host: false, self_service: 'off' as const };
    const chats = { ...base.chats };
    for (const [chat, share] of Object.entries(selected.shares)) chats[chat] = { ...chats[chat], share };
    effectiveQuotas = { ...base, chats };
  }
  const nextEvaluation = deadlines.filter((at): at is number => at !== undefined && at > now).sort((a, b) => a - b)[0];
  return { ...config, limits, quotas: effectiveQuotas, limitRuntime: { profile, nextSwitch: schedule?.next, nextEvaluation, timed } };
}
