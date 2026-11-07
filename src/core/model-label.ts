import { provider, PROVIDERS, PROVIDER_IDS } from './providers/registry.ts';
export { EFFORT_LABELS } from './providers/model-label.ts';

export const modelLabel: typeof import('./providers/model-label.ts').modelLabel = (...args) => provider(PROVIDER_IDS[0]).models.label(...args);
export const providerLabel = (id: string): string => PROVIDERS[id as keyof typeof PROVIDERS]?.boardLabel ?? id.slice(0, 2).toLowerCase();
