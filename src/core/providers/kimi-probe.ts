import { refreshUsageProbe } from './usage-probe.ts';
import path from 'node:path';
import { Context } from '../context.ts';
import type { PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { homeDir } from '../usage-sources.ts';
import { kimiPlanFile, readKimiSnapshot } from './kimi-usage.ts';
import { kimiSettings } from './kimi-settings.ts';
import { assertSafeArgs } from '../safety.ts';
import { kimiEnvironmentProblem, qualifiedModel, resolvedKimiHome } from './kimi-config.ts';
import { AgentctlError, shellLine } from '../util.ts';

/** Real 2.5.0 /usage text. Only percentages and reset times are persisted. */
export function parseKimiUsage(screen: string, now: number): PlanSnapshot | undefined {
  const windows: PlanWindow[] = [];
  for (const line of screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const m = /\b(5h|Weekly|Monthly) limit\b.*?\b(\d+(?:\.\d+)?)% used\b/i.exec(line);
    if (!m || Number(m[2]) > 100) continue;
    const reset = /resets in\s+(.+?)(?:│|$)/i.exec(line)?.[1];
    let duration = 0;
    if (reset) for (const t of reset.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m|s)\b/g)) duration += Number(t[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 }[t[2]!] ?? 0);
    const kind = m[1]!.toLowerCase();
    windows.push({ kind: kind === '5h' ? 'session' : kind === 'weekly' ? 'week' : 'other', minutes: kind === '5h' ? 300 : kind === 'weekly' ? 10080 : 43200, usedPercent: Number(m[2]), resetsAt: duration ? Math.floor(now / 1000 + duration) : null });
  }
  return windows.length ? { at: now, planType: null, windows } : undefined;
}

export const kimiProbeDir = (config: Context['config']): string => path.join(homeDir(config), 'kimi-usage-probe');

/** Slash-command-only process: no task effort validation or inherited thinking override. */
export function kimiProbeLaunch(config: Context['config'], processEnv: Record<string, string | undefined> = process.env): { env: Record<string, string>; command: string; argv: string[] } {
  const settings = config.agents.kimi;
  const env = { ...settings.env, KIMI_CODE_HOME: resolvedKimiHome(config, processEnv), KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_DISABLE_TELEMETRY: '1', AGENTCTL_TASK: 'usage-probe' };
  const problem = kimiEnvironmentProblem({ ...processEnv, ...env });
  if (problem) throw new AgentctlError(`usage-probe: kimi: ${problem}`);
  const model = config.capacity.kimiUsageProbeModel ?? 'k3';
  const args = [...(model === 'default' ? [] : ['-m', qualifiedModel(model)]), ...settings.flags];
  assertSafeArgs('kimi', args);
  // env -u also removes an override inherited by the tmux server, not just settings.env.
  delete (env as Record<string, string>).KIMI_MODEL_THINKING_EFFORT;
  const argv = ['env', '-u', 'KIMI_MODEL_THINKING_EFFORT', 'kimi', ...args];
  return { env, command: `exec ${shellLine(argv[0]!, argv.slice(1))}`, argv };
}

/** Opt-in behaviour and five-minute cadence remain unchanged. */
export async function refreshKimiPlan(ctx: Context): Promise<string | null> {
  if (!ctx.config.capacity.kimiUsageProbe || ctx.runner.dryRun) return null;
  return refreshUsageProbe(ctx, {
    id: 'kimi', label: 'Kimi', file: kimiPlanFile(ctx.config), dir: kimiProbeDir(ctx.config),
    intervalMs: 300_000, settings: kimiSettings(), readSnapshot: () => readKimiSnapshot(ctx.config),
    parse: parseKimiUsage, launch: () => kimiProbeLaunch(ctx.config),
  });
}
