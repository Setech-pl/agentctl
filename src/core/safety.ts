import { provider, PROVIDER_IDS } from './providers/registry.ts';
import { splitFlag } from './providers/safety.ts';

/** First forbidden token wins across all registered adapters, regardless of active providers. */
export function findAutoAcceptFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag] = splitFlag(arg);
    for (const id of PROVIDER_IDS) {
      const safety = provider(id).safety;
      if (safety.forbiddenFlags.includes(flag)) return arg;
      const hit = safety.check(args.slice(i, i + 2));
      if (hit) return hit;
    }
  }
  return undefined;
}
