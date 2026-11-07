import { provider, isActive } from './providers/registry.ts';
import type { ProviderId, LaunchOrder } from './providers/types.ts';
import type { GlobalConfig } from './config.ts';
import { splitFlag } from './providers/safety.ts';
import { AgentctlError } from './util.ts';

/** Default preserves the public 0.17.4 checker; explicit calls use only the target adapter. */
export function findAutoAcceptFlag(args: string[], id: ProviderId = 'claude'): string | undefined {
  const safety = provider(id).safety;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, [flag] = splitFlag(arg);
    if (safety.forbiddenFlags.includes(flag)) return arg;
    const hit = safety.check(args.slice(i, i + 2));
    if (hit) return hit;
  }
  return undefined;
}

export function assertSafeArgs(id: ProviderId, args: string[]): void {
  const bad = findAutoAcceptFlag(args, id);
  if (bad) throw new AgentctlError(`${id}: "${bad}" enables auto-accept or non-interactive approval bypass, which agentctl never allows`);
}

/** Runs after every provider translation, and again before window creation/resume. */
export function validateLaunch(config: GlobalConfig, order: LaunchOrder & { agent: ProviderId }, env: Record<string, string>): void {
  if (!isActive(config, order.agent)) throw new AgentctlError(`provider ${order.agent} is not enabled; add it to providers: [claude, codex, kimi]`);
  const adapter = provider(order.agent), settings = config.agents[order.agent];
  assertSafeArgs(order.agent, adapter.argv(order, settings, []));
  const effective: Record<string, string> = Object.fromEntries(Object.entries({ ...process.env, ...settings.env, ...env }).filter((entry): entry is [string, string] => entry[1] !== undefined));
  if (adapter.safety.validate && adapter.usage.homeEnv) effective[adapter.usage.homeEnv] = adapter.usage.home(config, effective);
  const problem = adapter.safety.validate?.(order, settings, effective);
  if (problem) throw new AgentctlError(`${order.task}: ${order.agent}: ${problem}`);
}

export function launchEnvironment(config: GlobalConfig, order: LaunchOrder & { agent: ProviderId }, env: Record<string, string>): Record<string, string> {
  validateLaunch(config, order, env);
  const adapter = provider(order.agent), settings = config.agents[order.agent];
  const merged = { ...settings.env, ...env };
  if (adapter.safety.validate && adapter.usage.homeEnv) merged[adapter.usage.homeEnv] = adapter.usage.home(config, { ...process.env, ...merged });
  const required = adapter.launchEnv(order, settings, merged);
  return { ...merged, ...required };
}
