import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class HarnessRefusal extends Error {
  constructor(message: string) {
    super(`live harness refuses to start: ${message}`);
    this.name = 'HarnessRefusal';
  }
}

/** Resolve existing ancestors too, so an absent leaf cannot hide a symlink escape. No writes. */
function canonical(file: string): string {
  try { return fs.realpathSync(file); } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    // realpath cannot resolve a dangling symlink. Follow its recorded target before
    // falling back to an absent leaf, otherwise an outside target looks task-local.
    try {
      if (fs.lstatSync(file).isSymbolicLink()) return canonical(path.resolve(path.dirname(file), fs.readlinkSync(file)));
    } catch (linkError) {
      if (!['ENOENT', 'ENOTDIR'].includes((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError;
    }
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(canonical(parent), path.basename(file));
  }
}
const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export const historicalCacheRoots = (): string[] => [...new Set([
  path.join(os.userInfo().homedir, 'Projects', 'cache', 'agentctl-p19'),
  path.resolve(import.meta.dirname, '../../..', 'cache', 'agentctl-p19'),
])];

/** Every harness entry point requires an explicit task root, never a shared historical sandbox. */
export function liveCacheRoot(requested?: string): string {
  const configured = process.env.AGENTCTL_LIVE_CACHE;
  const refuse = (reason: string): never => {
    throw new HarnessRefusal(`AGENTCTL_LIVE_CACHE ${reason}. Example: export AGENTCTL_LIVE_CACHE="$HOME/Projects/cache/my-task"`);
  };
  if (!configured || !path.isAbsolute(configured)) refuse('must be an explicit absolute task directory');
  const root = canonical(path.resolve(configured!));
  for (const historical of historicalCacheRoots()) {
    const old = canonical(historical);
    if (inside(root, old) || inside(old, root)) refuse(`must not overlap the historical shared sandbox ${historical}`);
  }
  if (requested !== undefined && !path.isAbsolute(requested)) refuse('requires an absolute cacheRoot');
  const selected = canonical(path.resolve(requested ?? configured!));
  if (!inside(selected, root)) refuse(`requires cacheRoot inside ${configured}`);
  return selected;
}
