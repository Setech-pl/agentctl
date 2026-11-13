import type { GlobalConfig } from '../config.ts';
import type { ProviderAdapter, ProviderId } from './types.ts';
import { PROVIDER_IDS, DEFAULT_PROVIDERS } from './types.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { kimi } from './kimi.ts';
import { glm, glmCommand } from './glm.ts';

export { PROVIDER_IDS } from './types.ts';
export type { ProviderId } from './types.ts';
export const PROVIDERS: Readonly<Record<ProviderId, ProviderAdapter>> = { claude, codex, kimi, glm };
export function provider(id: ProviderId): ProviderAdapter { return PROVIDERS[id]; }
export function activeProviders(config: Pick<GlobalConfig, 'providers'>): ProviderId[] { return [...(config.providers ?? DEFAULT_PROVIDERS)]; }
export function isActive(config: Pick<GlobalConfig, 'providers'>, id: string): id is ProviderId { return (activeProviders(config) as string[]).includes(id); }
/** The binary that starts tasks of `id`: `providers_config.glm.command` for glm, else the adapter's own command. */
export function providerCommand(config: Pick<GlobalConfig, 'providersConfig'>, id: ProviderId): string { return id === 'glm' ? glmCommand(config) : provider(id).command; }
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

/** Includes inactive registered providers: a running process still owns its checkout/window. */
export function matchesProviderCommand(command: string, source: 'args' | 'pane'): boolean {
  return PROVIDER_IDS.some(id => provider(id).processCommands[source].test(command));
}

export function isProviderLauncher(command: string): boolean {
  return PROVIDER_IDS.some(id => provider(id).processCommands.launcher?.test(command));
}
