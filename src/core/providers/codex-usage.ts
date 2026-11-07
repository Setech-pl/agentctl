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
export const codexPlanFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(homeDir(config), 'usage', 'codex-plan.json');
function readCodexSnapshot(config: GlobalConfig): PlanSnapshot | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(codexPlanFile(config), 'utf8')) as PlanSnapshot;
    return Number.isFinite(s.at) && Array.isArray(s.windows) ? s : undefined;
  } catch { return undefined; }
}
function newestCodexSnapshot(config: GlobalConfig, log: PlanSnapshot | undefined): PlanSnapshot | undefined {
  const rpc = readCodexSnapshot(config);
  return rpc && (!log || rpc.at > log.at) ? rpc : log;
}

export function readCodexPlan(config: GlobalConfig, reader: UsageReader, now: number) {
  const home = codexHome(config);
  const plan = planState('codex', newestCodexSnapshot(config, reader.codexPlan(home, now)), now, `no Codex session log with rate limits in ${path.join(home, 'sessions')} for the last 3 days`);
  const refreshed = readCodexSnapshot(config);
  plan.source = refreshed?.at === plan.readAt ? 'codex-app-server:account/rateLimits/read' : 'codex-session-log';
  return plan;
}
export function codexHome(config: Pick<GlobalConfig, 'usage'>, env: Record<string, string | undefined> = process.env): string { return config.usage.codexDir ?? env.CODEX_HOME ?? path.join(os.homedir(), '.codex'); }

import type { Context } from '../context.ts';
import { agentHomes } from '../usage-sources.ts';
/** Read-only RPC: initialize then account/rateLimits/read. No thread/start or turn/start. */
export async function refreshCodexCapacity(ctx: Context): Promise<string | null> {
  if (!ctx.config.capacity.codexRefresh || ctx.runner.dryRun) return null;
  const r = await ctx.runner.exec('codex', ['app-server'], { readOnly: true, timeoutMs: 3000, rpc: { method: 'account/rateLimits/read' }, env: { ...process.env, CODEX_HOME: agentHomes(ctx.config).codex } });
  try {
    if (r.code !== 0) throw new Error('RPC failed');
    const result: unknown = JSON.parse(r.stdout);
    if (!isObject(result)) return 'Codex app-server returned no rate limits';
    const limits = isObject(result.rateLimitsByLimitId) && isObject(result.rateLimitsByLimitId.codex) ? result.rateLimitsByLimitId.codex : result.rateLimits;
    if (!isObject(limits)) return 'Codex app-server rate limits n/d';
    const windows = [limits.primary, limits.secondary].flatMap((w) => {
      if (!isObject(w) || typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100) return [];
      const minutes = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null;
      return [{ kind: windowKind(minutes), minutes, usedPercent: w.usedPercent, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }];
    });
    if (windows.length === 0) return 'Codex app-server rate limits n/d';
    await ctx.runner.writeFile(codexPlanFile(ctx.config), JSON.stringify({ at: ctx.runner.now(), planType: null, windows }));
    return null;
  } catch { return `Codex live reading unavailable (${r.code === 127 ? 'CLI missing' : 'RPC failed or timed out'}); using latest session reading if present`; }
}


import { emptyStats, feedText, localDay } from '../usage-parse.ts';
import { readRange } from '../usage-sources.ts';
const TAIL_BYTES = 256 * 1024;
export function codexLogPlan(reader: UsageReader, codexHome: string, now: number): PlanSnapshot | undefined {
    const files = recentCodexFiles(reader, codexHome, now, 12);
    const signature = files.map((f) => `${f.file}:${f.size}:${Math.floor(f.mtimeMs)}`).join('|');
    return reader.cachedPlan(codexHome, signature, () => {
    let best: PlanSnapshot | null = null;
    for (const f of files) {
      const probe = emptyStats('codex');
      try {
        const from = Math.max(0, f.size - TAIL_BYTES);
        const text = readRange(f.file, from, Math.min(TAIL_BYTES, f.size));
        feedText(probe, from > 0 ? text.slice(text.indexOf('\n') + 1) : text);
      } catch {
        continue;
      }
      if (probe.plan && (best === null || probe.plan.at > best.at)) best = probe.plan;
    }
    return best ?? undefined;
    });
}
function recentCodexFiles(reader: UsageReader, codexHome: string, now: number, count: number): { file: string; size: number; mtimeMs: number }[] {
    const found: { file: string; size: number; mtimeMs: number }[] = [];
    // The last three days are enough: a plan reading older than that says nothing about the window now.
    for (let back = 0; back < 3; back++) {
      const d = localDay(now - back * 86_400_000).split('-');
      const dir = path.join(codexHome, 'sessions', ...d);
      for (const name of reader.list(dir, '.jsonl')) {
        if (!name.startsWith('rollout-')) continue;
        const file = path.join(dir, name);
        try {
          const st = fs.statSync(file);
          found.push({ file, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone meanwhile
        }
      }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
}

export function codexSessions(reader: UsageReader, codexHome: string, sinceMs: number, now: number): string[] {
    const out: string[] = [];
    const days = Math.max(1, Math.min(120, Math.ceil((now - sinceMs) / 86_400_000) + 1));
    for (let back = 0; back < days; back++) {
      const d = localDay(now - back * 86_400_000).split('-');
      const dir = path.join(codexHome, 'sessions', ...d);
      for (const name of reader.list(dir, '.jsonl')) if (name.startsWith('rollout-')) out.push(path.join(dir, name));
    }
    return out;
}
