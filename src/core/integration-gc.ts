import { GcSpace } from './gc-space.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './atomic-file.ts';
import type { Context } from './context.ts';
import { sizeOf, removedMeasurement } from './fs-measure.ts';
import type { GcItem, GcPlan, GcResult } from './gc.ts';
import { knownLinkReferences, linkUsers } from './links.ts';
import { saveGcProposal } from './mcp-requests.ts';
import { commitAt, INTEGRATION_BRANCHES } from './review-freshness.ts';
import { pendingStarts, withStartLock } from './start-lock.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import { errorMessage } from './util.ts';
import { canPost, OWNER_IDENTITY, postMessage, readableChannels } from './wall.ts';
import { WALL_TOOL_CHANNEL } from './wall-config.ts';
import { insidePath } from './worktree-volume.ts';

export interface IntegrationGcScope {
  repo: string;
  branch: string;
  head: string;
  owner: string;
}

function records(ctx: Context) {
  const current = listTaskRecords(ctx.config);
  const liveNames = new Set(current.map(r => r.window));
  return [...current, ...listArchivedRecords(ctx.config).filter(r => !liveNames.has(r.window))].filter(r => !r.host);
}

function location(file: string): string {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

function git(ctx: Context, repo: string, args: string[]) {
  return ctx.runner.exec('git', ['--no-optional-locks', '-C', repo, ...args], { readOnly: true, async: true, timeoutMs: ctx.config.git.timeoutS * 1000 });
}

async function ancestor(ctx: Context, repo: string, before: string, after: string): Promise<boolean> {
  return (await git(ctx, repo, ['merge-base', '--is-ancestor', before, after])).code === 0;
}

async function registrations(ctx: Context, repo: string): Promise<string[]> {
  const list = await git(ctx, repo, ['worktree', 'list', '--porcelain', '-z']);
  if (list.code !== 0) throw Error(`Cannot verify worktree registrations in ${repo}`);
  return list.stdout.split('\0').filter(field => field.startsWith('worktree ')).map(field => location(field.slice(9)));
}

async function cleanIntegratedHead(ctx: Context, wt: string, base: string): Promise<string | undefined> {
  if (!fs.lstatSync(wt, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const branch = await git(ctx, wt, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch.code > 1 || (INTEGRATION_BRANCHES as readonly string[]).includes(branch.stdout.trim())) return undefined;
  const head = await commitAt(ctx, wt, 'HEAD');
  if (!head || !await ancestor(ctx, wt, head, base)) return undefined;
  const status = await git(ctx, wt, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
  if (status.code === 0 && !status.stdout) return head;
  return undefined;
}

/** Look for real symlinks (including ignored files) in addition to declared links. */
async function protectLinkedWorktrees(roots: Set<string>, candidates: GcItem[]): Promise<GcItem[]> {
  if (!candidates.length) return candidates;
  const targets = new Map(candidates.map(item => [location(item.target), item]));
  const protect = (from: string, to: string) => {
    for (const root of targets.keys()) if (root !== from && insidePath(root, to)) targets.delete(root);
  };
  for (const root of roots) {
    const pending = [root];
    while (targets.size && pending.length) {
      const dir = pending.pop()!;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (entry.name === '.git') continue;
        const item = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!roots.has(item)) pending.push(item);
        } else if (entry.isSymbolicLink()) {
          const link = await fs.promises.readlink(item).catch(error => {
            if (error.code === 'ENOENT' || error.code === 'EINVAL') return undefined;
            throw error;
          });
          if (link === undefined) continue;
          protect(root, path.resolve(dir, link));
          const real = await fs.promises.realpath(item).catch(error => {
            if (error.code === 'ENOENT' || error.code === 'ELOOP' || error.code === 'ENOTDIR') return undefined;
            throw error;
          });
          if (real) protect(root, real);
        }
      }
    }
  }
  return [...targets.values()];
}

async function planIntegrationGc(ctx: Context, scope: IntegrationGcScope, preview?: GcPlan): Promise<GcPlan> {
  const all = records(ctx);
  const live = new Set([...await ctx.localTmux.listWindows(), ...pendingStarts(ctx.config).map(start => start.window)]);
  const base = await commitAt(ctx, scope.repo, `refs/heads/${scope.branch}`);
  const finished = (record: typeof all[number]) => (record.closed || record.cancelled) && !live.has(record.window);
  const refs = [...knownLinkReferences(ctx.config), ...all.flatMap(record => record.links.map(link => ({ target: link.to, source: record.task })))];
  const candidates: GcItem[] = [];
  if (base && await ancestor(ctx, scope.repo, scope.head, base)) {
    const registered = await registrations(ctx, scope.repo);
    const selected = new Set(preview?.items.map(item => item.target));
    const seen = new Set<string>();
    for (const record of all) {
      if (!finished(record) || record.pin || record.reviewMode || record.owner !== scope.owner) continue;
      for (const repo of record.repos) {
        const wt = location(repo.worktree);
        if (location(repo.path) !== scope.repo || wt === scope.repo || wt === registered[0] || !registered.includes(wt) || seen.has(wt) || preview && !selected.has(wt)) continue;
        if (all.some(other => other !== record && (!finished(other) || other.pin || !other.reviewMode && other.owner !== scope.owner) && other.repos.some(entry => location(entry.worktree) === wt))) continue;
        if (linkUsers(wt, refs).length) continue;
        const head = await cleanIntegratedHead(ctx, repo.worktree, scope.head);
        if (!head) continue;
        seen.add(wt);
        candidates.push({ kind: 'worktree', task: record.task, target: wt, repo: scope.repo, base: scope.branch, head, bytes: 0, dirtyFiles: 0, unpushedCommits: 0, detail: `integrated into ${scope.branch} (${scope.head.slice(0, 12)})` });
      }
    }
    if (candidates.length) {
      const roots = new Set([...registered, ...all.flatMap(record => record.repos.map(repo => location(repo.worktree)))].filter(root => fs.existsSync(root)));
      const safe = await protectLinkedWorktrees(roots, candidates);
      candidates.splice(0, candidates.length, ...safe);
    }
  }
  const items: GcItem[] = [];
  for (const item of candidates) {
    const saved = preview?.items.find(old => old.target === item.target);
    items.push({ ...item, bytes: saved?.bytes ?? await sizeOf(item.target) });
  }
  return { integration: scope, items, skipped: [], freeBytes: items.reduce((total, item) => total + item.bytes, 0), olderThanMs: 0, unknownCacheDirs: 0 };
}

export async function recheckIntegrationGc(ctx: Context, preview: GcPlan): Promise<GcPlan> {
  if (!preview.integration) throw Error('Not an integration GC preview');
  return planIntegrationGc(ctx, preview.integration, preview);
}

export async function applyIntegrationGc(ctx: Context, plan: GcPlan, space = new GcSpace()): Promise<GcResult> {
  const result: GcResult = { done: [], failed: [], freedBytes: 0 };
  const scope = plan.integration!;
  const current = await recheckIntegrationGc(ctx, plan);
  for (const item of plan.items) {
    try {
      if (!current.items.some(candidate => candidate.target === item.target && candidate.task === item.task && candidate.head === item.head)) throw Error('Integration GC scope changed; worktree kept');
      await withStartLock(ctx, async () => {
        const all = records(ctx);
        const owner = all.find(record => record.task === item.task);
        const live = new Set([...await ctx.localTmux.listWindows(), ...pendingStarts(ctx.config).map(start => start.window)]);
        if ((!owner?.closed && !owner?.cancelled) || owner.pin || owner.owner !== scope.owner || live.has(owner.window) || !owner.repos.some(repo => location(repo.worktree) === item.target) ||
            all.some(record => record !== owner && (record.pin || live.has(record.window) || !record.closed && !record.cancelled) && record.repos.some(repo => location(repo.worktree) === item.target))) throw Error('Worktree is now active, pinned or no longer belongs to this GC plan');
        const base = await commitAt(ctx, scope.repo, `refs/heads/${scope.branch}`);
        if (!base || !await ancestor(ctx, scope.repo, scope.head, base) || await cleanIntegratedHead(ctx, item.target, scope.head) !== item.head || linkUsers(item.target, knownLinkReferences(ctx.config)).length) throw Error('Worktree or integration ref changed; kept');
        if (!ctx.runner.dryRun) await space.before(item.target);
        const removed = await ctx.runner.exec('git', ['-C', scope.repo, 'worktree', 'remove', item.target], { async: true, timeoutMs: ctx.config.git.timeoutS * 1000 });
        if (removed.code !== 0) throw Error(removed.stderr.trim() || `git exit ${removed.code}`);
      });
      removedMeasurement(item.target, ctx.runner.now());
      result.done.push(item);
    } catch (error) { result.failed.push({ item, reason: errorMessage(error) }); }
  }
  result.freedBytes = await space.freed();
  return result;
}

/** The first sighting is a baseline. Only a forward movement of a known local ref can propose deletion. */
export async function watchIntegrationGc(ctx: Context, signal?: AbortSignal, inventory?: import('./taskstore.ts').RecordScan): Promise<void> {
  if (ctx.runner.dryRun || signal?.aborted) return;
  const config = ctx.config;
  const state = path.join(config.stateDir, 'integration-gc.json');
  if (config.gc.afterIntegration === 'off') {
    if (fs.existsSync(state)) fs.unlinkSync(state);
    return;
  }
  const all = inventory ? inventory.all.filter(record => !record.host) : records(ctx);
  const candidates = new Set(all.flatMap(record => record.repos.map(repo => repo.path)));
  const repositories = new Set([...candidates].map(location));
  if (!repositories.size) return;
  let seen: Record<string, string> = {};
  try { seen = JSON.parse(fs.readFileSync(state, 'utf8')); } catch { /* first observation */ }
  const next = { ...seen };
  for (const repo of repositories) {
    if (signal?.aborted) return;
    if (!fs.existsSync(repo)) continue;
    for (const branch of INTEGRATION_BRANCHES) {
      const head = await commitAt(ctx, repo, `refs/heads/${branch}`);
      if (!head) continue;
      const ref = JSON.stringify([repo, branch]);
      const previous = seen[ref];
      if (previous === head) continue;
      if (previous && await ancestor(ctx, repo, previous, head)) {
        const owners = new Set(all.filter(r => (r.closed || r.cancelled) && r.owner?.startsWith('chat:') && r.repos.some(entry => location(entry.path) === repo)).map(r => r.owner!));
        for (const owner of owners) {
          const name = owner.slice(5);
          if (!config.wall.chats[name]) continue;
          const plan = await planIntegrationGc(ctx, { repo, branch, head, owner });
          if (signal?.aborted || ctx.config.gc.afterIntegration !== 'propose') return;
          if (!plan.items.length) continue;
          const key = `integration-gc:${createHash('sha256').update(JSON.stringify([repo, branch, previous, head, owner])).digest('hex')}`;
          const label = `${path.basename(repo)} ${branch}`;
          const request = await saveGcProposal(ctx, key, label, plan);
          const who = { kind: 'chat' as const, id: owner };
          const channel = readableChannels(config, who).includes(name) && canPost(config, name, OWNER_IDENTITY) ? name : WALL_TOOL_CHANNEL;
          await postMessage(ctx, OWNER_IDENTITY, { channel, to: owner, kind: 'info', origin: key, subject: `GC po integracji: ${label}`.slice(0, 120), body: `${branch} → ${head.slice(0, 12)}. Worktree do odzyskania: ${plan.items.length}, około ${plan.freeBytes} B.\nWywołaj gc z request_id: ${request.id}, pokaż plan właścicielowi i potwierdź wyłącznie po jego zgodzie (confirm: true, preview_token).` });
        }
      }
      next[ref] = head;
    }
  }
  if (JSON.stringify(seen) !== JSON.stringify(next)) {
    fs.mkdirSync(config.stateDir, { recursive: true });
    atomicWriteFile(state, JSON.stringify(next));
  }
}
