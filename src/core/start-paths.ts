import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFile } from './atomic-file.ts';
import type { Context } from './context.ts';
import { withStartLock } from './start-lock.ts';
import { AgentctlError } from './util.ts';

/** `at` and `pidStartedAt` (0.26.4) tell a live claim from one whose PID was reused by an unrelated process. */
interface PathClaim { pid: number; kind: 'start' | 'gc'; paths: string[]; at?: string; pidStartedAt?: number }

/** A GC claim covers one item's checks and deletion; a start claim covers checkout and setup. Older claims are stale even with a live PID. */
export const CLAIM_MAX_AGE_MS: Record<PathClaim['kind'], number> = { gc: 6 * 3600_000, start: 24 * 3600_000 };
const PID_START_SLACK_MS = 5_000;
const ownStart = Math.round(Date.now() - process.uptime() * 1000);

/** When the process with this PID started (ms), or undefined when the system cannot tell. */
export function processStartedAt(pid: number): number | undefined {
  if (pid === process.pid) return ownStart;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    const at = Date.parse(out);
    return Number.isFinite(at) ? at : undefined;
  } catch { return undefined; }
}

/** A claim whose owner is gone, too old, or whose PID now belongs to a process that started after the claim was written. */
export function staleClaim(claim: PathClaim, now = Date.now()): boolean {
  const at = Date.parse(claim.at ?? '');
  if (Number.isFinite(at) && now - at > CLAIM_MAX_AGE_MS[claim.kind === 'gc' ? 'gc' : 'start']) return true;
  if (claim.pidStartedAt === undefined && !Number.isFinite(at)) return false;
  const started = processStartedAt(claim.pid);
  if (started === undefined) return false;
  if (claim.pidStartedAt !== undefined) return Math.abs(started - claim.pidStartedAt) > PID_START_SLACK_MS;
  return started > at + PID_START_SLACK_MS;
}

export function gcLocation(target: string): string {
  try { return fs.realpathSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(target);
    return parent === target ? target : path.join(gcLocation(parent), path.basename(target));
  }
}

export const pathsOverlap = (a: string, b: string): boolean => a === b ||
  a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);

/** Call with start.lock held. Claims span setup or deletion without holding the admission lock. */
export async function claimStartPaths(ctx: Context, kind: PathClaim['kind'], targets: string[]): Promise<() => void> {
  if (ctx.runner.dryRun || !targets.length) return () => {};
  const paths = [...new Set(targets.map(target => gcLocation(path.resolve(target))))];
  const dir = path.join(ctx.config.stateDir, 'start-path-claims');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    let other: PathClaim;
    try { other = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try { process.kill(other.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(file); continue; }
      throw error;
    }
    if ((kind === 'gc' || other.kind === 'gc') && paths.some(target => other.paths.some(used => pathsOverlap(target, used)))) {
      if (staleClaim(other)) { try { fs.unlinkSync(file); } catch { /* removed meanwhile */ } continue; }
      throw new AgentctlError(kind === 'gc' ? 'Worktree or cache is in use by a start or another GC' : 'wstrzymane: trwa GC worktree lub cache');
    }
  }
  const file = path.join(dir, `${randomUUID()}.json`);
  atomicWriteFile(file, JSON.stringify({ pid: process.pid, kind, paths, at: new Date().toISOString(), pidStartedAt: ownStart } satisfies PathClaim));
  return () => {
    try { fs.unlinkSync(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
}

/** Existing claims (for checks that must see a start in progress); stale ones are ignored. */
export function activeClaims(ctx: Context): PathClaim[] {
  const dir = path.join(ctx.config.stateDir, 'start-path-claims');
  const claims: PathClaim[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return claims; }
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const claim = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as PathClaim;
      try { process.kill(claim.pid, 0); } catch { continue; }
      if (!staleClaim(claim)) claims.push(claim);
    } catch { /* removed meanwhile */ }
  }
  return claims;
}

export function claimGcPath(ctx: Context, target: string, check: () => Promise<void>): Promise<() => void> {
  return withStartLock(ctx, async () => {
    await check();
    return claimStartPaths(ctx, 'gc', [target]);
  });
}
