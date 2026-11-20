import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import { fileVersion } from './file-version.ts';

export const WATCH_STALE_MS = 120_000;
export const watchSnapshotPath = (config: GlobalConfig): string => path.join(config.stateDir, 'mcp-state-snapshot.json');

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
