import { spawnSync } from 'node:child_process';
import type { ResolvedRepo } from './spec.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadProjectConfig } from './config.ts';
import type { Link, GlobalConfig } from './config.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import { fillPlaceholders, resolvePath } from './util.ts';
import type { Runner } from './runner.ts';
import { AgentctlError, Problems } from './util.ts';

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

/** Resolve existing parents too, so aliases cannot hide recursive links before creation. */
function resolvedLocation(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(resolvedLocation(parent), path.basename(absolute));
  }
}

export function validateLink(from: string, to: string, worktree: string): void {
  const absoluteSource = path.resolve(worktree, from);
  const source = path.join(resolvedLocation(path.dirname(absoluteSource)), path.basename(absoluteSource));
  const target = resolvedLocation(to);
  const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${parent}${path.sep}`);
  if (inside(source, target) || inside(target, source)) {
    throw new AgentctlError(`links: recursive self-link ${source} -> ${target}`, 'Choose a target outside the link and its ancestors. Nothing was started.');
  }
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
    validateLink(from, to, worktree);
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
        validateLink(link, path.join(targetDir, name), worktree);
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
    if (matches.length === 0) {
      warnings.push(
        `link ${from} -> ${to}: no match for "${from}" in ${worktree}. ` +
          `A "from" without glob characters is a literal path and is linked even if it does not exist yet (parent directories are created), e.g. from: node_modules/@scope/name`,
      );
    }
    for (const match of matches) {
      const link = path.join(worktree, match);
      validateLink(link, to, worktree);
      ops.push({ link, target: to, existing: lstatKind(link) });
    }
  }
  return { ops, warnings };
}

/**
 * `to` is always something that exists outside the worktree (another checkout): check it before anything is created,
 * so a typo does not leave a half-built worktree. For `dir/*` the directory must exist (an empty one only warns later).
 */
export function checkLinkTargets(links: Link[], task: string): void {
  const p = new Problems();
  for (const { from, to } of links) {
    const target = to.endsWith('/*') ? path.dirname(to) : to;
    if (!fs.existsSync(target)) p.add(`link ${from} -> ${path.resolve(target)}: links.to does not exist (the link side, links.from, is created for you)`);
  }
  p.throwIfAny(`${task}: link targets are missing:`, 'Create/check out the target first (for example the backend worktree), or fix the "to" path. Nothing was started.');
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

/** Missing targets are warnings in previews and errors at the write boundary. */
export function missingLinkTargets(links: Link[], primary?: string): string[] {
  return links.flatMap(({ from, to }) => {
    const target = path.resolve(to.endsWith('/*') ? path.dirname(to) : to);
    const warnings = path.isAbsolute(from) && !fs.existsSync(from.endsWith('/*') ? path.dirname(from) : from) ? [`links.from ${from} does not exist; check the source worktree path`] : [];
    if (fs.existsSync(target)) return warnings;
    let missing = target;
    // The first path component that is not there: the thing to create or to fix.
    for (let dir = path.dirname(missing); !fs.existsSync(dir) && dir !== path.dirname(dir); dir = path.dirname(dir)) missing = dir;
    const place = primary ? path.join(primary, from) : from;
    return [...warnings, `link ${place} -> ${target}: links.to points at a path that does not exist (first missing: ${missing}); create/check out ${missing === target ? 'it' : 'that directory'} first, or correct links.to (the link side, links.from, is created for you)`];
  });
}

/** Cross-task link targets use recorded worktrees, including retained closed/archived ones. */
export function fillTaskLinkTargets(text: string, config: GlobalConfig): string {
  return text.replace(/\{task:([^,{}]+),repo:([^{}]+)\}/g, (_match, task: string, repo: string) => {
    const wanted = task.toLowerCase();
    const record = listTaskRecords(config).find(r => r.task.toLowerCase() === wanted)
      ?? listArchivedRecords(config).filter(r => r.task.toLowerCase() === wanted).map(r => ({ ...r, closed: true }))[0];
    if (!record) throw new AgentctlError(`links: ${task}: unknown task`);
    const state = record.closed || record.cancelled ? 'closed task' : 'task';
    if (!record.repos.length) throw new AgentctlError(`links: ${task}: ${state} has no recorded worktree`);
    const matches = record.repos.filter(r => path.basename(r.path) === repo);
    if (matches.length > 1) throw new AgentctlError(`links: ${task}: ambiguous repository "${repo}"`);
    const match = matches[0];
    if (!match) throw new AgentctlError(`links: ${task}: no repository "${repo}" in recorded worktrees`);
    if ((record.closed || record.cancelled) && !fs.existsSync(match.worktree)) {
      throw new AgentctlError(`links: ${task}: ${state} worktree ${match.worktree} does not exist`);
    }
    return match.worktree;
  });
}

/** Preview inherited project defaults explicitly: retained closed worktrees are stale too. */
export function staleProjectLinkWarnings(links: Link[], config: GlobalConfig): string[] {
  if (!links.length) return [];
  const current = listTaskRecords(config);
  const records = [...current, ...listArchivedRecords(config).filter(r => !current.some(c => c.task === r.task)).map(r => ({ ...r, closed: true }))];
  return links.flatMap(({ from, to }) => {
    const target = to.endsWith('/*') ? path.dirname(to) : to;
    const resolved = resolvedLocation(target);
    const owners = records.filter(r => (r.closed || r.cancelled) && r.repos.some(repo => {
      const root = resolvedLocation(repo.worktree);
      return resolved === root || resolved.startsWith(`${root}${path.sep}`);
    }));
    const reasons = [...(!fs.existsSync(target) ? ['target does not exist'] : []), ...owners.map(r => `target belongs to closed task ${r.task}`)];
    return reasons.length ? [`stale project link ${from} -> ${to}: ${reasons.join('; ')}. Set links explicitly using {task:TASK-ID,repo:REPO-NAME}/sub/path or {worktree:repo|fallback}; check the target before starting.`] : [];
  });
}

/** Compare only repositories sharing Git's common directory; never compare unrelated SHAs. */
export function linkBaseWarnings(links: Link[], repos: ResolvedRepo[]): string[] {
  const git = (cwd: string, ...args: string[]): string | undefined => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  return links.flatMap(({ from, to }) => {
    let dir = to.endsWith('/*') ? path.dirname(to) : to;
    while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (!common) return [];
    const repo = repos.find(r => r.base && git(r.path, 'rev-parse', '--path-format=absolute', '--git-common-dir') === common);
    if (!repo?.base) return [];
    const base = git(repo.path, 'rev-parse', '--verify', `${repo.base}^{commit}`);
    const head = git(dir, 'rev-parse', 'HEAD');
    if (!base || !head) return [`link ${from} -> ${to}: cannot compare target with task base ${repo.base}`];
    const ancestor = git(repo.path, 'merge-base', head, base);
    return ancestor === base ? [] : [`link ${from} -> ${to}: target worktree is older than task base ${repo.base} or diverged (merge-base ${ancestor ?? 'none'}); use {worktree:${path.basename(repo.path)}} or update the target`];
  });
}

export function projectLinks(repo: string, task = '', cache = repo): Link[] {
  return (loadProjectConfig(repo)?.links ?? []).filter(link => !/\{(?:worktree:|task:[^}]*,repo:)/.test(link.to)).map(link => ({ ...link, to: resolvePath(fillPlaceholders(link.to, { task, cache }), repo) }));
}

/** Known projects come from current and archived task records; active tasks can also supply spec-only links. */
export function knownLinkReferences(config: GlobalConfig): { target: string; source: string }[] {
  const active = listTaskRecords(config).filter(r => !r.closed && !r.cancelled);
  const records = [...listTaskRecords(config), ...listArchivedRecords(config)];
  const refs = active.flatMap(r => r.links.map(l => ({ target: l.to, source: `active task ${r.task}` })));
  for (const repo of new Set(records.flatMap(r => r.repos.map(repo => repo.path)))) {
    try {
      for (const record of records.filter(r => r.repos.some(x => x.path === repo))) {
        refs.push(...projectLinks(repo, record.task, config.cache).map(l => ({ target: l.to, source: `${repo}/.agentctl.yaml` })));
      }
    } catch (error) {
      // An unreadable known config cannot prove that a candidate is unused.
      refs.push({ target: '*', source: `${repo}/.agentctl.yaml: ${String(error)}` });
    }
  }
  return refs;
}

export function linkUsers(worktree: string, refs: ReturnType<typeof knownLinkReferences>): string[] {
  const root = path.resolve(worktree);
  const real = (file: string) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const roots = [root, real(root)];
  return [...new Set(refs.filter(ref => {
    if (ref.target === '*') return true;
    const target = ref.target.endsWith('/*') ? path.dirname(ref.target) : ref.target;
    return [path.resolve(target), real(target)].some(p => roots.some(w => p === w || p.startsWith(`${w}${path.sep}`)));
  }).map(ref => ref.source))];
}
