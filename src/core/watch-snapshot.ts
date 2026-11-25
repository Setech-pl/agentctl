import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import { fileVersion } from './file-version.ts';

export const WATCH_STALE_MS = 120_000;
export const watchSnapshotPath = (config: GlobalConfig): string => path.join(config.stateDir, 'mcp-state-snapshot.json');
export const watchHeartbeatPath = (config: GlobalConfig): string => path.join(config.stateDir, 'watch-heartbeat.json');

export const watchProgressPath = (config: GlobalConfig): string => path.join(config.stateDir, 'watch-progress.json');
export interface WatchProgress { version: string; pid: number; tick: number; startedAt: number; at: number }

export function readWatchProgress(config: GlobalConfig): WatchProgress | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(watchProgressPath(config), 'utf8'));
    if (typeof value.version === 'string' && Number.isSafeInteger(value.pid) && Number.isSafeInteger(value.tick)
      && Number.isFinite(value.startedAt) && Number.isFinite(value.at)) return value;
  } catch { /* watch has not yet published progress */ }
  return undefined;
}

export function watchStepWarning(config: GlobalConfig, now = Date.now()): string | undefined {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(watchHeartbeatPath(config), 'utf8'));
    const skipped = Object.entries(heartbeat.skipped ?? {}).flatMap(([step, since]) =>
      typeof since === 'number' && Number.isFinite(since) ? [`${step} od ${new Date(since).toISOString()} (${Math.max(0, Math.floor((now - since) / 1000))} s)`] : []);
    if (skipped.length) return `Watch: pominięty etap – ${skipped.join(', ')}.`;
  } catch { /* missing, legacy or in the middle of a heartbeat write */ }
}

export function watchSnapshotWarning(at: number, now: number): string | undefined {
  if (now - at > WATCH_STALE_MS) return `watch nie odpowiada od ${Math.floor((now - at) / 60_000)} min – agentctl watch --tmux --restart`;
}

const cached = new Map<string, { version: string; at: number | undefined }>();

/** Read the timestamp of the last atomic publication, including snapshots from older versions. */
export function watchSnapshotTime(config: GlobalConfig): number | undefined {
  const file = watchSnapshotPath(config);
  try {
    const version = fileVersion(fs.statSync(file, { bigint: true }));
    const known = cached.get(file);
    if (known && known.version === version) return known.at;
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = snap.version === 1 && Number.isFinite(snap.at) ? snap.at as number : undefined;
    if (version) cached.set(file, { version, at });
    return at;
  } catch { return undefined; }
}
