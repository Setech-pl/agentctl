import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import type { PlanState, PlanWindowView } from './usage.ts';
import { journalPath } from './journal.ts';

export interface UsageSample {
  provider: AgentName;
  at: number;
  capturedAt: number;
  windows: PlanWindowView[];
  /** Cumulative fresh tokens of agentctl tasks at capture, not a provider token counter. */
  taskTokens: number;
}
export const samplesPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'usage-samples.jsonl');
export function readSamples(config: GlobalConfig): UsageSample[] {
  try {
    return fs.readFileSync(samplesPath(config), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        const s = JSON.parse(line) as UsageSample;
        return ['claude', 'codex'].includes(s.provider) && Number.isFinite(s.at) && Number.isFinite(s.capturedAt) && Number.isFinite(s.taskTokens) && Array.isArray(s.windows) && s.windows.every((w) => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && (w.resetsAt === null || Number.isFinite(w.resetsAt))) ? [s] : [];
      } catch { return []; }
    }).slice(-config.capacity.sampleLimit);
  } catch { return []; }
}

/** Synchronous, short critical section; competing readers leave sampling to the owner, never block a usage query. */
export function recordSamples(config: GlobalConfig, plans: Record<AgentName, PlanState>, totals: Record<AgentName, number>, now: number): void {
  const file = samplesPath(config);
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(lock, 'wx');
  } catch { return; }
  try {
    const samples = readSamples(config);
    const stateFile = path.join(path.dirname(file), 'capacity-events.json');
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, number>; } catch { /* first read */ }
    const emit = (key: string, text: string): void => {
      if (seen[key] !== undefined) return;
      fs.appendFileSync(journalPath(config), `${JSON.stringify({ at: new Date(now).toISOString(), kind: 'usage', text })}\n`);
      seen[key] = now;
    };
    for (const provider of ['claude', 'codex'] as const) {
      const p = plans[provider];
      const previous = samples.filter((s) => s.provider === provider).at(-1);
      for (const w of previous?.windows ?? []) {
        if (w.resetsAt !== null && w.resetsAt <= now) emit(`${provider}|${w.kind}|${w.resetsAt}|reset`, `${provider} ${w.label}: window reset; current usage ${p.windows.find((x) => x.kind === w.kind)?.usedPercent ?? 'n/d'}`);
      }
      for (const w of p.windows) for (const threshold of config.capacity.thresholds) {
        if (w.usedPercent >= threshold) emit(`${provider}|${w.kind}|${w.resetsAt ?? 'open'}|${threshold}`, `${provider} ${w.label}: usage crossed ${threshold}% (${w.usedPercent}%)`);
      }
      if (p.readAt === null || p.windows.length === 0 || (previous && p.readAt <= previous.at)) continue;
      // A reset can be observed before the old reset deadline (provider refresh or manual reset).
      for (const w of p.windows) {
        const old = previous?.windows.find((x) => x.kind === w.kind);
        if (old && old.resetsAt !== null && old.resetsAt !== w.resetsAt) emit(`${provider}|${w.kind}|${old.resetsAt}|reset`, `${provider} ${w.label}: window reset (new reset boundary observed)`);
      }
      samples.push({ provider, at: p.readAt, capturedAt: now, windows: p.windows, taskTokens: totals[provider] });
    }
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, samples.slice(-config.capacity.sampleLimit).map((s) => JSON.stringify(s)).join('\n') + '\n');
    fs.renameSync(tmp, file);
    // Keep dedup through a weekly reset; bounded even with frequent provider refreshes.
    seen = Object.fromEntries(Object.entries(seen).filter(([, at]) => at >= now - 14 * 86_400_000).slice(-10000));
    fs.writeFileSync(stateFile, JSON.stringify(seen));
  } catch { /* sampling must not break usage */ }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
