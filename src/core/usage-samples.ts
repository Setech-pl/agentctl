import { atomicWriteFile, atomicAppendFile } from './atomic-file.ts';
import fs from 'node:fs';
import { tryFileLock } from './file-lock.ts';
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

const RESET_DROP_POINTS = 20;
const RESET_GRACE_MS = 5 * 60_000;
export function isWindowReset(old: PlanWindowView, cur: PlanWindowView, now: number): boolean {
  const forward = old.resetsAt !== null && cur.resetsAt !== null ? cur.resetsAt - old.resetsAt : 0;
  const windowMs = Math.max(1, cur.minutes || old.minutes || 60) * 60_000;
  const dropped = old.usedPercent - cur.usedPercent >= RESET_DROP_POINTS;
  const expired = old.resetsAt !== null && old.resetsAt <= now;
  return forward >= windowMs / 2 || (dropped && (expired || forward > 0));
}

/** Synchronous, short critical section; competing readers leave sampling to the owner, never block a usage query. */
export function recordSamples(config: GlobalConfig, plans: Record<AgentName, PlanState>, totals: Record<AgentName, number>, now: number): void {
  const file = samplesPath(config);
  const lock = `${file}.lock`;
  let release: (() => void) | undefined;
  try { release = tryFileLock(lock); } catch { return; }
  if (!release) return;
  try {
    const samples = readSamples(config);
    const before = samples.length;
    let changed = false;
    const stateFile = path.join(path.dirname(file), 'capacity-events.json');
    let seen: Record<string, number> = {};
    try { seen = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Record<string, number>; } catch { /* first read */ }
    const emit = (key: string, text: string): void => {
      if (seen[key] !== undefined) return;
      atomicAppendFile(journalPath(config), `${JSON.stringify({ at: new Date(now).toISOString(), kind: 'usage', text })}\n`);
      seen[key] = now;
      changed = true;
    };
    for (const provider of ['claude', 'codex'] as const) {
      const p = plans[provider];
      const previous = samples.filter((s) => s.provider === provider).at(-1);
      // A stale source: the old deadline passed a while ago and the usage did not grow since, so the window is over even if nobody re-read it.
      for (const w of previous?.windows ?? []) {
        const cur = p.windows.find((x) => x.kind === w.kind);
        if (w.resetsAt !== null && w.resetsAt + RESET_GRACE_MS <= now && (!cur || cur.usedPercent <= w.usedPercent)) emit(`${provider}|${w.kind}|${w.resetsAt}|reset`, `${provider} ${w.label}: window reset; current usage ${cur?.usedPercent ?? 'n/d'}`);
      }
      for (const w of p.windows) for (const threshold of config.capacity.thresholds) {
        if (w.usedPercent >= threshold) emit(`${provider}|${w.kind}|${w.resetsAt ?? 'open'}|${threshold}`, `${provider} ${w.label}: usage crossed ${threshold}% (${w.usedPercent}%)`);
      }
      if (p.readAt === null || p.windows.length === 0 || (previous && p.readAt <= previous.at)) continue;
      // A reset needs evidence of a new window, not a jittering boundary: the reset time moved forward by about a window, or the usage fell
      // clearly (hysteresis) while the old deadline had passed or the boundary moved forward. Same window instance: announced once.
      for (const w of p.windows) {
        const old = previous?.windows.find((x) => x.kind === w.kind);
        if (old && isWindowReset(old, w, now)) emit(`${provider}|${w.kind}|${old.resetsAt ?? 'open'}|reset`, `${provider} ${w.label}: window reset; current usage ${w.usedPercent}%`);
      }
      samples.push({ provider, at: p.readAt, capturedAt: now, windows: p.windows, taskTokens: totals[provider] });
    }
    if (samples.length > before) {
      if (samples.length <= config.capacity.sampleLimit) atomicAppendFile(file, samples.slice(before).map((s) => JSON.stringify(s)).join('\n') + '\n');
      else {
        const tmp = `${file}.${process.pid}`;
        atomicWriteFile(tmp, samples.slice(-config.capacity.sampleLimit).map((s) => JSON.stringify(s)).join('\n') + '\n');
        fs.renameSync(tmp, file);
      }
    }
    if (changed) {
      // Keep dedup for current sampled windows even when the source has not refreshed for weeks.
      const persistent = new Set(['claude', 'codex'].flatMap((provider) => {
        const latest = samples.filter((s) => s.provider === provider).at(-1);
        return latest?.windows.map((w) => `${provider}|${w.kind}|${w.resetsAt ?? 'open'}|`) ?? [];
      }));
      seen = Object.fromEntries(Object.entries(seen).filter(([key, at]) => at >= now - 14 * 86_400_000 || [...persistent].some((p) => key.startsWith(p))).slice(-10000));
      const tmp = `${stateFile}.${process.pid}`;
      atomicWriteFile(tmp, JSON.stringify(seen)); fs.renameSync(tmp, stateFile);
    }
  } catch { /* sampling must not break usage */ }
  finally { release(); }
}
