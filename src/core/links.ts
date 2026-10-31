import fs from 'node:fs';
import path from 'node:path';
import type { Link } from './config.ts';
import type { Runner } from './runner.ts';
import { AgentctlError } from './util.ts';

export interface LinkOp {
  /** Absolute path of the symlink to create inside the worktree. */
  link: string;
  /** What it points at. */
  target: string;
  /** Existing state of `link`: replaced only when it is already a symlink. */
  existing: 'none' | 'symlink' | 'other';
}

function lstatKind(p: string): 'none' | 'symlink' | 'other' {
  try {
    return fs.lstatSync(p).isSymbolicLink() ? 'symlink' : 'other';
  } catch {
    return 'none';
  }
}

function isWholeSegmentStar(p: string): boolean {
  return path.basename(p) === '*' && !path.dirname(p).includes('*');
}

/**
 * Expand `links` into concrete symlink operations for one worktree.
 *
 * - `to` without `*`: every match of the glob `from` (relative to the worktree) points at `to`.
 *   A `from` without glob characters is a single link, created even if nothing exists yet.
 * - `to` ending in `/*`: one link per entry of that directory, named after the entry;
 *   `from` must then end in `/*` too (node_modules/@scope/* -> ~/other/packages/*).
 */
export function planLinks(links: Link[], worktree: string): { ops: LinkOp[]; warnings: string[] } {
  const ops: LinkOp[] = [];
  const warnings: string[] = [];
  for (const { from, to } of links) {
    if (path.isAbsolute(from)) {
      throw new AgentctlError(`links: "from" must be relative to the worktree, got ${from}`, 'Use e.g. from: node_modules/@scope/*');
    }
    if (to.includes('*')) {
      if (!isWholeSegmentStar(to) || !isWholeSegmentStar(from)) {
        throw new AgentctlError(
          `links: a "*" must be a whole last path segment in both "from" and "to" (${from} -> ${to})`,
          'Example: from: node_modules/@scope/*  to: ~/other-checkout/packages/*',
        );
      }
      const targetDir = path.dirname(to);
      let names: string[] = [];
      try {
        names = fs.readdirSync(targetDir).filter((n) => !n.startsWith('.')).sort();
      } catch {
        // reported below as "matched nothing"
      }
      if (names.length === 0) warnings.push(`link ${from} -> ${to}: nothing found in ${targetDir}`);
      for (const name of names) {
        const link = path.join(worktree, path.dirname(from), name);
        ops.push({ link, target: path.join(targetDir, name), existing: lstatKind(link) });
      }
      continue;
    }
    if (!/[*?[\]{}]/.test(from)) {
      const link = path.join(worktree, from);
      ops.push({ link, target: to, existing: lstatKind(link) });
      continue;
    }
    const matches = fs.existsSync(worktree) ? fs.globSync(from, { cwd: worktree }).sort() : [];
    if (matches.length === 0) warnings.push(`link ${from} -> ${to}: no match for "${from}" in ${worktree}`);
    for (const match of matches) {
      const link = path.join(worktree, match);
      ops.push({ link, target: to, existing: lstatKind(link) });
    }
  }
  return { ops, warnings };
}

/** Create the symlinks; refuses to replace anything that is not already a symlink. */
export async function applyLinks(runner: Runner, ops: LinkOp[]): Promise<void> {
  const blocked = ops.filter((op) => op.existing === 'other');
  if (blocked.length > 0) {
    const first = blocked[0] as LinkOp;
    throw new AgentctlError(
      `Cannot link ${first.link}: it exists and is not a symlink${blocked.length > 1 ? ` (and ${blocked.length - 1} more)` : ''}`,
      'agentctl only replaces symlinks. Remove that path yourself or narrow the "from" glob.',
    );
  }
  for (const op of ops) await runner.symlink(op.target, op.link);
}
