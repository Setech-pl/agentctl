import type { GlobalConfig } from '../config.ts';
import type { ProviderAdapter, ProviderId } from './types.ts';
import { PROVIDER_IDS, DEFAULT_PROVIDERS } from './types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { kimi } from './kimi.ts';

export { PROVIDER_IDS } from './types.ts';
export type { ProviderId } from './types.ts';
export const PROVIDERS: Readonly<Record<ProviderId, ProviderAdapter>> = { claude, codex, kimi };
export function provider(id: ProviderId): ProviderAdapter { return PROVIDERS[id]; }
export function activeProviders(config: Pick<GlobalConfig, 'providers'>): ProviderId[] { return [...(config.providers ?? DEFAULT_PROVIDERS)]; }
export function isActive(config: Pick<GlobalConfig, 'providers'>, id: string): id is ProviderId { return (activeProviders(config) as string[]).includes(id); }
export function perProvider<T>(ids: readonly ProviderId[], f: (id: ProviderId) => T): Record<ProviderId, T> { return Object.fromEntries(ids.map(id => [id, f(id)])) as Record<ProviderId, T>; }
export function alternatives(config: Pick<GlobalConfig, 'providers'>, id: ProviderId): ProviderId[] { return activeProviders(config).filter(other => other !== id); }
export type ProviderMap<T> = Partial<Record<ProviderId, T>>;
export function get<T>(map: ProviderMap<T>, id: ProviderId): T {
  const value = map[id];
  if (value === undefined) throw new Error(`missing active provider ${id}`);
  return value;
}

/** Original providers are mandatory; optional registered providers may be inactive. */
export type ProviderValues<T> = Record<typeof DEFAULT_PROVIDERS[number], T> & Partial<Record<ProviderId, T>>;
