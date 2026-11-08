import fs from 'node:fs';
import { canonical } from './live-cache.ts';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export class CleanRefusal extends Error {
  constructor(message: string) {
    super(`gate clean refuses: ${message}`);
    this.name = 'CleanRefusal';
  }
}

/** Top-level entries the gate itself creates: per-run work dirs and live-harness sandboxes. */
const GATE_WORK = /^gate-work-\d+$/;
const SANDBOX = /^live-[a-z0-9-]+$/;
export const isGateMade = (name: string): boolean => GATE_WORK.test(name) || SANDBOX.test(name);

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Total size of the regular files under dir; symlinks count as their own link, never followed. */
export function dirSize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) total += dirSize(p);
    else total += fs.lstatSync(p).size;
  }
  return total;
}

export interface CleanDeps {
  /** Stops the tmux server of a sandbox socket. Default: `tmux -S <socket> kill-server`, failure ignored (it may be dead already). */
  killServer?: (socket: string) => void;
}

export interface CleanSummary {
  before: number;
  after: number;
  /** Top-level entry names that were removed. */
  removed: string[];
  /** Top-level entry names that were left alone (logs, gate-results, reports, everything not gate-made). */
  kept: string[];
  /** Sockets of the sandbox tmux servers that were stopped. */
  stoppedServers: string[];
}

/** The sandbox tmux socket of a live-* entry (the same layout live-harness.ts builds). */
export function sandboxSocket(entry: string, uid: number = process.getuid?.() ?? 0): string {
  return path.join(entry, 'tmx', `tmux-${uid}`, 'default');
}

/**
 * P54: the only permitted cleanup. Removes what the gate created inside the cache root (gate-work-*, live-* sandboxes,
 * with their npm caches, prefixes and tmp dirs; leftover sandbox tmux servers are stopped first) and keeps everything
 * else (logs, gate-results, reports). Every candidate is validated before anything is removed: a symlink escaping the
 * root, or any resolved path outside it, refuses the whole run. A symlink pointing inside is unlinked, never followed.
 */
export function cleanLiveCache(root: string, deps: CleanDeps = {}): CleanSummary {
  if (!path.isAbsolute(root)) throw new CleanRefusal(`the cache root must be absolute: ${root}`);
  if (!fs.existsSync(root)) throw new CleanRefusal(`the cache root does not exist: ${root}`);
  const canonicalRoot = fs.realpathSync(root);
  const killServer = deps.killServer ?? ((socket: string) => {
    try { execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* dead already */ }
  });
  const entries = fs.readdirSync(canonicalRoot);
  const candidates = entries.filter(isGateMade);

  // Phase 1: validate every candidate before anything is touched.
  for (const name of candidates) {
    const p = path.join(canonicalRoot, name);
    const stat = fs.lstatSync(p);
    const resolved = canonical(p);
    if (!inside(resolved, canonicalRoot)) {
      throw new CleanRefusal(stat.isSymbolicLink()
        ? `${p} is a symlink whose target escapes the cache root ${canonicalRoot}`
        : `${p} resolves outside the cache root ${canonicalRoot}`);
    }
    // Nested socket-directory symlinks must never redirect kill-server outside this sandbox.
    if (stat.isDirectory()) {
      const socket = sandboxSocket(p);
      if (!inside(canonical(socket), resolved)) throw new CleanRefusal(`${socket} resolves outside its sandbox ${resolved}`);
    }
  }

  // Phase 2: stop leftover sandbox servers, then remove.
  const removed: string[] = [];
  const stoppedServers: string[] = [];
  const before = dirSize(canonicalRoot);
  for (const name of candidates) {
    const p = path.join(canonicalRoot, name);
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(p); // the link only; the (validated, internal) target stays
    } else {
      const socket = sandboxSocket(p);
      if (fs.existsSync(socket)) {
        killServer(socket);
        stoppedServers.push(socket);
      }
      fs.rmSync(p, { recursive: true, force: true });
    }
    removed.push(name);
  }
  const after = dirSize(canonicalRoot);
  return { before, after, removed, kept: entries.filter((e) => !candidates.includes(e)), stoppedServers };
}

/** `12 MB` / `300 KB` for the before/after line. */
export function humanSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(1)} KB`;
  return `${bytes} B`;
}
