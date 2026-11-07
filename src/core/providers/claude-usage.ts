import { claudeProbeFile } from './claude-probe.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalConfig } from '../config.ts';
import type { UsageReader } from '../usage-sources.ts';
import { homeDir } from '../usage-sources.ts';
import { planState } from '../usage.ts';
import type { PlanSnapshot, PlanWindow } from '../usage-parse.ts';
import { windowKind } from '../usage-parse.ts';
import { isObject } from '../util.ts';
export function claudePlanFile(config: Pick<GlobalConfig, 'path'>): string {
  return path.join(homeDir(config), 'usage', 'claude-plan.json');
}

export function readClaudeSnapshot(config: Pick<GlobalConfig, 'path'>): PlanSnapshot | undefined {
  return readSnapshot(claudePlanFile(config));
}
export function readClaudeProbeSnapshot(config: Pick<GlobalConfig, 'path'>): PlanSnapshot | undefined {
  return readSnapshot(claudeProbeFile(config));
}
function readSnapshot(file: string): PlanSnapshot | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(data) || typeof data.at !== 'number' || !Number.isFinite(data.at) || !Array.isArray(data.windows)) return undefined;
    const windows: PlanWindow[] = [];
    for (const w of data.windows) {
      if (!isObject(w) || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) continue;
      const minutes = typeof w.minutes === 'number' ? w.minutes : null;
      windows.push({ kind: windowKind(minutes), minutes, usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null });
    }
    return windows.length > 0 ? { at: data.at, planType: null, windows } : undefined;
  } catch {
    return undefined;
  }
}

export function readClaudePlan(config: GlobalConfig, reader: UsageReader, now: number) {
  const status = readClaudeSnapshot(config), probe = config.capacity.claudeUsageProbe ? readClaudeProbeSnapshot(config) : undefined;
  const useProbe = probe !== undefined && (!status || probe.at >= status.at);
  const plan = planState('claude', useProbe ? probe : status, now, config.usage.claudeTap ? 'no reading yet: Claude Code reports its limits only to a statusLine, which starts with the next task window (see "agentctl usage --help")' : 'usage.claude_tap is off: Claude Code gives its limits only to a statusLine');
  plan.source = useProbe ? 'claude-usage-probe' : 'claude-statusline';
  if (!plan.available && config.capacity.claudeUsageProbe) plan.note += '; Claude /usage probe enabled: neutral folder may need one-time manual trust';
  return plan;
}
export function claudeHome(config: Pick<GlobalConfig, 'usage'>, env: Record<string, string | undefined> = process.env): string { return config.usage.claudeDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'); }

export function claudeSessions(reader: UsageReader, claudeHome: string, cwd: string): string[] {
    const projects = path.join(claudeHome, 'projects');
    const wanted = claudeProjectName(cwd);
    const out: string[] = [];
    for (const name of reader.list(projects)) {
      if (name !== wanted && !name.startsWith(`${wanted}-`)) continue;
      const dir = path.join(projects, name);
      for (const f of reader.list(dir, '.jsonl')) out.push(path.join(dir, f));
    }
    return out;
}

export function claudeSubagents(reader: UsageReader, transcript: string): string[] {
    const dir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
    return reader.list(dir, '.jsonl').map((f) => path.join(dir, f));
}

export function claudeProjectName(cwd: string): string { return cwd.replace(/[^A-Za-z0-9]/g, '-'); }
