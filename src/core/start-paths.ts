import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { withStartLock } from './start-lock.ts';
import { AgentctlError } from './util.ts';

interface PathClaim { pid: number; kind: 'start' | 'gc'; paths: string[] }

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
      throw new AgentctlError(kind === 'gc' ? 'Worktree or cache is in use by a start or another GC' : 'wstrzymane: trwa GC worktree lub cache');
    }
  }
  const file = path.join(dir, `${randomUUID()}.json`);
  await ctx.runner.writeFile(file, JSON.stringify({ pid: process.pid, kind, paths }));
  return () => { fs.unlinkSync(file); };
}

export function claimGcPath(ctx: Context, target: string, check: () => Promise<void>): Promise<() => void> {
  return withStartLock(ctx, async () => {
    await check();
    return claimStartPaths(ctx, 'gc', [target]);
  });
}
