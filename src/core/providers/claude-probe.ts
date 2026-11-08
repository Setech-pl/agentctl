import path from 'node:path';
import type { Context } from '../context.ts';
import type { GlobalConfig } from '../config.ts';
import type { PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { homeDir } from '../usage-sources.ts';
import { claudeHome } from './claude-usage.ts';
import { defaultSettings } from './settings.ts';
import { refreshUsageProbe } from './usage-probe.ts';
import { readClaudeProbeSnapshot } from './claude-usage.ts';

export const claudeProbeDir = (config: GlobalConfig): string => path.join(homeDir(config), 'claude-usage-probe');
export const claudeProbeFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(homeDir(config), 'usage', 'claude-usage-probe.json');

/** Interpret the displayed wall time in its explicit IANA zone, including DST. Unknown formats stay unknown. */
export function claudeReset(text: string, now: number): number | null {
  const match = /^Resets (?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?(am|pm) \(([^)]+)\)$/i.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[3]), minute = Number(match[4] ?? 0);
  if (hour < 1 || hour > 12 || minute > 59) return null;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: match[6], year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
    const parts = (at: number) => Object.fromEntries(fmt.formatToParts(at).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    const local = parts(now), months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = match[1] ? months.indexOf(match[1].toLowerCase()) : local.month! - 1;
    const day = match[2] ? Number(match[2]) : local.day!;
    const hours = hour % 12 + (match[5]!.toLowerCase() === 'pm' ? 12 : 0);
    for (let delta = 0; delta < 2; delta++) {
      const target = Date.UTC(local.year! + (match[1] ? delta : 0), month, day + (match[1] ? 0 : delta), hours, minute);
      let candidate = target;
      for (let i = 0; i < 3; i++) {
        const p = parts(candidate);
        candidate += target - Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
      }
      const actual = parts(candidate), wanted = new Date(target);
      if (actual.month !== wanted.getUTCMonth() + 1 || actual.day !== wanted.getUTCDate() || actual.hour !== hours || actual.minute !== minute) continue;
      if (candidate > now) return candidate / 1000;
    }
  } catch { /* unsupported zone */ }
  return null;
}

/** Real 2.1.311 quota panel. Model-specific weeks and usage-credit percentages are not the all-model plan. */
export function parseClaudeUsage(screen: string, now: number): PlanSnapshot | undefined {
  const lines = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trim());
  const windows: PlanWindow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const session = lines[i] === 'Current session';
    if (!session && lines[i] !== 'Current week (all models)') continue;
    const percent = /(?:^|\s)(\d+(?:\.\d+)?)% used\s*$/.exec(lines[i + 1] ?? '');
    if (!percent || Number(percent[1]) > 100) continue;
    windows.push({ kind: session ? 'session' : 'week', minutes: session ? 300 : 10080, usedPercent: Number(percent[1]), resetsAt: claudeReset(lines[i + 2] ?? '', now) });
  }
  return windows.some(w => w.kind === 'week') ? { at: now, planType: null, windows } : undefined;
}

/** Fixed argv: task flags, prompts, resume, plugins and task hooks are never inherited. */
export function claudeProbeLaunch(config: GlobalConfig): { env: Record<string, string>; argv: string[] } {
  const env = { ...config.agents.claude.env, CLAUDE_CONFIG_DIR: claudeHome(config, { ...process.env, ...config.agents.claude.env }), AGENTCTL_TASK: 'usage-probe', DISABLE_AUTOUPDATER: '1' };
  return { env, argv: ['claude', '--settings', JSON.stringify({ disableAllHooks: true, statusLine: { type: 'command', command: 'true' } })] };
}

export async function refreshClaudePlan(ctx: Context): Promise<string | null> {
  if (!ctx.config.capacity.claudeUsageProbe || ctx.runner.dryRun) return null;
  return refreshUsageProbe(ctx, {
    id: 'claude', label: 'Claude', file: claudeProbeFile(ctx.config), dir: claudeProbeDir(ctx.config),
    intervalMs: Math.max(15, ctx.config.capacity.claudeUsageProbeIntervalMinutes) * 60_000,
    settings: defaultSettings('claude'), readSnapshot: () => readClaudeProbeSnapshot(ctx.config),
    parse: parseClaudeUsage, launch: () => claudeProbeLaunch(ctx.config), dialogResult: true, rememberNote: true,
  });
}
