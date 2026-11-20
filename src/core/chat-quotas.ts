import type { LiveWindow } from './checks.ts';
import type { AgentName, GlobalConfig } from './config.ts';
import { activeProviders } from './providers/registry.ts';
import { PROVIDER_IDS } from './providers/types.ts';
import { cohortKey, cohortNameProblem, isObject } from './util.ts';
import type { Problems } from './util.ts';
import { WALL_CHAT_NAME } from './wall-config.ts';

type Shares = Partial<Record<AgentName, number>>;
export interface ChatQuotas {
  overprovision: number;
  chats: Record<string, Shares>;
  default: Shares;
  floor: Shares;
  cohorts: Record<string, string>;
  per_host: boolean;
  self_service: 'off' | 'within_overprovision';
}

export const DEFAULT_OWNER = 'default';

export function chatOwner(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === DEFAULT_OWNER) return DEFAULT_OWNER;
  const name = value.replace(/^chat:/, '');
  return WALL_CHAT_NAME.test(name) ? `chat:${name}` : undefined;
}

export function parseChatQuotas(raw: unknown, p: Problems): ChatQuotas | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) { p.add('config.quotas must be a mapping'); return undefined; }
  const shares = (value: unknown, key: string): Shares => {
    const result: Shares = {};
    if (value === undefined) return result;
    if (!isObject(value)) { p.add(`${key} must be a mapping`); return result; }
    for (const [id, count] of Object.entries(value)) {
      if (!PROVIDER_IDS.includes(id as AgentName) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        p.add(`${key}.${id} must name a provider and have a nonnegative integer value`);
      } else result[id as AgentName] = count;
    }
    return result;
  };
  const chats: ChatQuotas['chats'] = Object.create(null);
  const cohorts: ChatQuotas['cohorts'] = Object.create(null);
  const quotas: ChatQuotas = { overprovision: 1.5, chats, cohorts, default: shares(raw.default, 'config.quotas.default'),
    floor: shares(raw.floor, 'config.quotas.floor'), per_host: false, self_service: 'off' };
  for (const key of Object.keys(raw)) if (!Object.hasOwn(quotas, key)) p.add(`unknown config.quotas key "${key}"`);
  if (raw.overprovision !== undefined) {
    if (typeof raw.overprovision === 'number' && Number.isFinite(raw.overprovision) && raw.overprovision >= 1) quotas.overprovision = raw.overprovision;
    else p.add('config.quotas.overprovision must be a finite number >= 1');
  }
  if (raw.per_host !== undefined) {
    if (typeof raw.per_host === 'boolean') quotas.per_host = raw.per_host;
    else p.add('config.quotas.per_host must be a boolean');
  }
  if (raw.self_service !== undefined) {
    if (raw.self_service === 'off' || raw.self_service === 'within_overprovision') quotas.self_service = raw.self_service;
    else p.add('config.quotas.self_service must be off or within_overprovision');
  }
  if (isObject(raw.chats)) {
    for (const [name, value] of Object.entries(raw.chats)) {
      if (!WALL_CHAT_NAME.test(name)) p.add(`config.quotas.chats.${name} is not a valid WALL chat name`);
      else chats[name] = shares(value, `config.quotas.chats.${name}`);
    }
  } else if (raw.chats !== undefined) p.add('config.quotas.chats must be a mapping');
  if (isObject(raw.cohorts)) {
    for (const [name, value] of Object.entries(raw.cohorts)) {
      const owner = chatOwner(value);
      const key = cohortKey(name);
      if (cohortNameProblem(name) || !owner || Object.hasOwn(cohorts, key)) p.add(`config.quotas.cohorts.${name} must map a unique cohort to a chat or default`);
      else cohorts[key] = owner;
    }
  } else if (raw.cohorts !== undefined) p.add('config.quotas.cohorts must be a mapping');
  return quotas;
}

export function taskOwner(config: GlobalConfig, cohort?: string): string | undefined {
  return config.quotas ? config.quotas.cohorts[cohortKey(cohort ?? '')] ?? DEFAULT_OWNER : undefined;
}

interface QuotaTask { agent: AgentName; owner?: string; host?: string }
interface Slot { agent?: AgentName; owner?: string; host?: string; counted?: boolean; kind?: LiveWindow['kind'] }
export interface ChatLoad { chat: string; host?: string; used: number; share: number | null; floor: number; floorUsed?: number }

const buckets = (q: ChatQuotas): string[] => [...Object.keys(q.chats).sort().map(name => `chat:${name}`), DEFAULT_OWNER];
function bucket(q: ChatQuotas, owner = DEFAULT_OWNER): string {
  return owner.startsWith('chat:') && Object.hasOwn(q.chats, owner.slice(5)) ? owner : DEFAULT_OWNER;
}

function sharesFor(config: GlobalConfig, agent: AgentName) {
  const q = config.quotas!;
  return buckets(q).map(chat => {
    const named = chat !== DEFAULT_OWNER;
    const configured = (named ? q.chats[chat.slice(5)]?.[agent] : undefined) ?? q.default[agent];
    const share = configured ?? null;
    const floor = Math.min(share ?? Infinity, q.floor[agent] ?? (named && share !== null && share > 0 ? 1 : 0));
    return { chat, share, floor };
  });
}

export function quotaBudget(config: GlobalConfig, agent: AgentName) {
  const limit = config.limits[agent];
  const cap = limit === 'off' ? 0 : limit ?? Infinity;
  const shares = sharesFor(config, agent);
  return {
    shares: shares.reduce((sum, chat) => sum + (chat.share ?? 0), 0),
    floors: shares.reduce((sum, chat) => sum + chat.floor, 0),
    cap,
    budget: cap * config.quotas!.overprovision,
  };
}

export function quotaWarnings(config: GlobalConfig): string[] {
  if (!config.quotas) return [];
  return activeProviders(config).flatMap(agent => {
    const { shares, floors, cap, budget } = quotaBudget(config, agent);
    return [
      ...(shares > budget ? [`quotas.${agent}: sum of shares ${shares} exceeds overprovision × global limit (${budget})`] : []),
      ...(floors > cap ? [`quotas.${agent}: sum of floors ${floors} exceeds global limit ${cap}; floors are capped`] : []),
    ];
  });
}

export function chatLoads(config: GlobalConfig, agent: AgentName, slots: readonly Slot[], host?: string): ChatLoad[] {
  const q = config.quotas;
  if (!q) return [];
  const limit = config.limits[agent];
  let floorRoom = limit === 'off' ? 0 : limit ?? Infinity;
  const counts = new Map<string, number>();
  const global = new Map<string, number>();
  for (const slot of slots) {
    if (slot.agent !== agent || slot.counted === false || slot.kind === 'reserved' || slot.kind === 'external') continue;
    const chat = bucket(q, slot.owner);
    global.set(chat, (global.get(chat) ?? 0) + 1);
    if (!q.per_host || slot.host === host) counts.set(chat, (counts.get(chat) ?? 0) + 1);
  }
  return sharesFor(config, agent).map(chat => {
    const floor = Math.min(floorRoom, chat.floor);
    floorRoom -= floor;
    return { ...chat, floor, used: counts.get(chat.chat) ?? 0, ...(q.per_host ? {host: host ?? 'local', floorUsed: global.get(chat.chat) ?? 0} : {}) };
  });
}

function chatLoad(config: GlobalConfig, task: QuotaTask, slots: readonly Slot[]): ChatLoad | undefined {
  const q = config.quotas;
  if (!q) return undefined;
  return chatLoads(config, task.agent, slots, task.host).find(chat => chat.chat === bucket(q, task.owner));
}

export function chatQuotaWait(config: GlobalConfig, task: QuotaTask, slots: readonly Slot[]): string | undefined {
  const load = chatLoad(config, task, slots);
  if (load?.share != null && load.used >= load.share) return `czeka na kwotę ${load.chat} (${task.agent} ${load.used}/${load.share})`;
  return undefined;
}

export function globalQuotaWait(config: GlobalConfig, agent: AgentName, used: number): string | undefined {
  const limit = config.limits[agent];
  if (limit === 'off') return `${agent} jest wyłączony (limits.${agent}: off)`;
  if (limit !== undefined && used >= limit) return config.quotas ? `czeka na miejsce globalne (${agent} ${used}/${limit})` : `czeka na miejsce: ${agent} ${used}/${limit}`;
  return undefined;
}

/** Providers do not compete with one another. For the first eligible provider, select its best contender. */
export function nextQuotaTask<T extends QuotaTask>(config: GlobalConfig, candidates: readonly T[], slots: readonly Slot[]): T | undefined {
  const first = candidates[0];
  if (!first || !config.quotas) return first;
  const global = config.limits[first.agent];
  const ratio = (r: ChatLoad): number => r.used / (r.share ?? (typeof global === 'number' && global > 0 ? global : Infinity));
  const below = (r: ChatLoad): number => Number((r.floorUsed ?? r.used) < r.floor);
  let best = first;
  let bestRank = chatLoad(config, first, slots)!;
  for (const task of candidates.slice(1)) {
    if (task.agent !== first.agent) continue;
    const rank = chatLoad(config, task, slots)!;
    const floorPriority = below(rank) - below(bestRank);
    if (floorPriority > 0 || (floorPriority === 0 && ratio(rank) < ratio(bestRank))) {
      best = task;
      bestRank = rank;
    }
  }
  return best;
}

export const renderChatLoad = (load: ChatLoad): string =>
  `${load.host ? `${load.host} ` : ''}${load.chat} ${load.used}/${load.share ?? '∞'} (floor ${load.floorUsed === undefined ? load.floor : `${load.floorUsed}/${load.floor} global`})`;
