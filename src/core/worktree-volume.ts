import fs from 'node:fs';
import path from 'node:path';
import { AgentctlError } from './util.ts';

export const insidePath = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Conventional external roots can be recognized even before their first mount. */
export function inferredWorktreeMount(target: string): string | undefined {
  return /^\/(?:Volumes|mnt)\/[^/]+/.exec(target)?.[0];
}

export function volumeMounted(mount: string): boolean {
  try {
    const entry = fs.statSync(mount);
    return entry.isDirectory() && entry.dev !== fs.statSync(path.dirname(mount)).dev;
  } catch { return false; }
}

export interface WorktreeVolume {
  worktree: string;
  worktreeMount?: string;
}

export function missingWorktreeVolume(repos: readonly WorktreeVolume[]): string | undefined {
  const mounts = new Set(repos.map(repo => repo.worktreeMount ?? inferredWorktreeMount(repo.worktree)).filter((mount): mount is string => Boolean(mount)));
  return [...mounts].find(mount => !volumeMounted(mount));
}

export class WorktreeVolumeError extends AgentctlError {
  readonly mount: string;
  readonly task?: string;
  readonly beforeStart: boolean;

  constructor(mount: string, task?: string, beforeStart = false) {
    super(`volume missing: ${mount}`, task ? `Mount the volume and run "agentctl unblock ${task}" for the blocked queue entry.` : 'Mount the volume before trying again.');
    this.mount = mount;
    this.task = task;
    this.beforeStart = beforeStart;
  }
}

export function assertWorktreeVolumes(repos: readonly WorktreeVolume[], task?: string, beforeStart = false): void {
  const missing = missingWorktreeVolume(repos);
  if (missing) throw new WorktreeVolumeError(missing, task, beforeStart);
}
