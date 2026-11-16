import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { GcItem, GcOptions, GcPlan, GcSkip } from './gc.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';
import { cohortKey, errorMessage } from './util.ts';

/** Serialized into a bounded Node program executed by HostRunner; no dispatcher paths or secrets. */
export function remoteGcProgram(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const p = require('node:path').posix as typeof import('node:path').posix;
  const cp = require('node:child_process') as typeof import('node:child_process');
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const root = p.resolve(input.root.replace(/^~(?=\/|$)/, process.env.HOME!));
  input.repos = Object.fromEntries(Object.entries(input.repos).map(([k, v]) => [k, p.resolve(String(v).replace(/^~(?=\/|$)/, process.env.HOME!))]));
  const realRoot = fs.realpathSync(root);
  const deadline = Date.now() + 5000;
  let visited = 0;
  const bounded = () => { if (++visited > 100_000 || Date.now() > deadline) throw Error('host GC measurement budget exceeded; target kept, retry later'); };
  const run = (cmd: string, args: string[]) => cp.spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 2 * 1024 * 1024 });
  const git = (repo: string, args: string[]) => {
    bounded(); const r = run('git', ['-C', repo, ...args]);
    if (r.error || r.status !== 0) throw Error((r.stderr || r.error?.message || 'git failed').trim());
    return r.stdout.trim();
  };
  const inside = (target: string) => {
    if (!p.isAbsolute(target) || target === root || !target.startsWith(root + '/')) throw Error('outside host work_dir');
    // Refuse symlink aliases, including symlink parents, before any recursive operation.
    if (fs.realpathSync(target) !== p.join(realRoot, p.relative(root, target))) throw Error('symlink path is not a GC target');
  };
  const measure = (target: string, preserveMd = false): { bytes: number; newest: number } => {
    bounded(); const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw Error('symlink is not a GC target');
    let bytes = st.size, newest = st.mtimeMs;
    if (st.isDirectory()) for (const name of fs.readdirSync(target)) {
      if (preserveMd && /\.md$/i.test(name)) throw Error('directory contains a report (*.md), kept');
      const child = measure(p.join(target, name), preserveMd); bytes += child.bytes; newest = Math.max(newest, child.newest);
    }
    return { bytes, newest };
  };
  const listing = run('tmux', ['list-windows', '-t', '=agentctl-' + input.host, '-F', '#{window_id}\t#{window_name}\t#{@agentctl-role}']);
  if (listing.error || listing.status !== 0 && !/can't find session|no server running|no sessions|error connecting to.*No such file/i.test(listing.stderr)) throw Error('cannot verify remote tmux windows: ' + listing.stderr);
  const live = listing.stdout.split('\n').filter(Boolean).map(line => line.split('\t'));
  const finished = (r: any) => (r.closed || r.cancelled || r.archived) && !live.some(w => w[2] === r.window || w[1] === r.window || w[1]?.endsWith(' ' + r.window));
  const records = input.records as any[];
  const mine = records.filter(r => finished(r) && r.selected);
  const others = records.filter(r => !finished(r));
  const items: GcItem[] = [], skipped: GcSkip[] = [];
  const seen = new Set<string>();
  const add = (r: any, kind: 'worktree' | 'cache', target: string, repo?: string) => {
    if (input.item && (target !== input.item.target || kind !== input.item.kind)) return;
    if (seen.has(target)) return; seen.add(target);
    const base = { host: input.host, task: r.task, kind, target, ...(r.cohort ? { cohort: r.cohort } : {}), ...(repo ? { repo } : {}) };
    try {
      if (!fs.existsSync(target)) return;
      inside(target);
      const shared = others.find(o => o.repos.some((x: any) => x.worktree === target) || o.remoteDir && (target === o.remoteDir || target.startsWith(o.remoteDir + '/')) || o.remoteReport && target.startsWith(p.dirname(o.remoteReport) + '/'));
      if (shared) throw Error('also used by unfinished task ' + shared.task);
      if (records.some(o => o.links.some((l: any) => l.to === target || l.to.startsWith(target + '/')))) throw Error('links target in use');
      if (kind === 'worktree') {
        if (Object.values(input.repos).includes(target) || target === repo) throw Error('main checkout is protected');
        if (!Object.values(input.repos).includes(repo)) throw Error('repository is not configured on host');
        const registered = git(repo!, ['worktree', 'list', '--porcelain']);
        if (!registered.split('\n').includes('worktree ' + target)) throw Error('not a registered worktree');
        if (['main', 'master'].includes(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']))) throw Error('main/master are protected');
        if (git(target, ['status', '--porcelain'])) throw Error('uncommitted changes');
      }
      const measured = measure(target, kind === 'cache');
      if (kind === 'cache' && Date.now() - measured.newest < input.olderThanMs) throw Error('newer than requested age');
      items.push({ ...base, bytes: measured.bytes, detail: 'finished task; verified on host' });
    } catch (e) { skipped.push({ ...base, reason: String((e as Error).message), bytes: 0 }); }
  };
  for (const r of mine) {
    for (const repo of r.repos) add(r, 'worktree', repo.worktree, repo.path);
    // Task metadata/settings and files alongside remote reports; reports themselves stay.
    for (const dir of [r.remoteDir, r.remoteReport && p.dirname(r.remoteReport)].filter(Boolean)) {
      try {
        inside(dir);
        const expected = dir === p.join(root, '.agentctl', r.window) || dir === p.join(root, 'reports', r.window);
        if (!expected) throw Error('not a canonical remote task directory');
        for (const name of fs.readdirSync(dir)) if (!/\.md$/i.test(name)) add(r, 'cache', p.join(dir, name));
      } catch (e) { skipped.push({ host: input.host, task: r.task, kind: 'cache', target: dir, reason: (e as Error).message }); }
    }
  }
  if (input.item) {
    const wanted = input.item;
    const item = items.find(i => i.kind === wanted.kind && i.task === wanted.task && i.target === wanted.target && i.repo === wanted.repo);
    if (!item) throw Error(skipped.find(s => s.target === wanted.target)?.reason ?? 'item no longer eligible');
    if (item.kind === 'worktree') git(item.repo!, ['worktree', 'remove', item.target]);
    else fs.rmSync(item.target, { recursive: true });
    process.stdout.write(JSON.stringify(item));
  } else process.stdout.write(JSON.stringify({ items, skipped }));
}

const fingerprint = (ctx: Context, host: string) => { const h = ctx.config.hosts[host]!; return createHash('sha256').update(JSON.stringify({ssh: h.ssh, port: h.port, identityFile: h.identityFile, workDir: h.workDir, repos: h.repos})).digest('hex'); };

const script = () => `(${remoteGcProgram.toString()})()`;
const cacheFile = (ctx: Context, host: string) => path.join(ctx.config.stateDir, 'hosts', host + '-gc.json');
function payload(ctx: Context, host: string, olderThanMs: number, cohort?: string) {
  const archived = listArchivedRecords(ctx.config);
  const current = listTaskRecords(ctx.config);
  return { host, hostFingerprint: fingerprint(ctx, host), root: ctx.config.hosts[host]!.workDir, repos: ctx.config.hosts[host]!.repos, olderThanMs,
    records: [...current, ...archived.filter(a => !current.some(r => r.window === a.window))].filter(r => r.host === host).map(r => ({ task: r.task, window: r.window, repos: r.repos, links: r.links, remoteDir: r.remoteDir, remoteReport: r.remoteReport, closed: r.closed, cancelled: r.cancelled, archived: archived.some(a => a.window === r.window), cohort: r.cohort, selected: cohort === undefined || !!r.cohort && cohortKey(r.cohort) === cohortKey(cohort) })) };
}

export async function planRemoteGc(ctx: Context, opts: GcOptions, olderThanMs: number): Promise<Pick<GcPlan, 'items' | 'skipped'>> {
  const plans = await Promise.all(Object.keys(ctx.config.hosts).map(async host => {
    try {
      const data = payload(ctx, host, olderThanMs);
      if (!data.records.length) return { items: [], skipped: [] };
      if (opts.cachedSizes) {
        const cached = JSON.parse(fs.readFileSync(cacheFile(ctx, host), 'utf8'));
        if (ctx.runner.now() - cached.at > 60_000 || cached.key !== JSON.stringify(data)) throw Error('remote GC cache missing/stale; run agentctl gc --preview');
        return cached.plan;
      }
      const r = await ctx.hosts.forHost(host).checked('node', ['-e', script()], { input: JSON.stringify(data), readOnly: true, timeoutMs: 10_000 });
      const plan = JSON.parse(r.stdout);
      for (const item of plan.items) item.hostFingerprint = data.hostFingerprint;
      await ctx.runner.writeFile(cacheFile(ctx, host), JSON.stringify({ at: ctx.runner.now(), key: JSON.stringify(data), plan }));
      return plan;
    } catch (e) { return { items: [], skipped: [{ host, task: '-', kind: 'cache', target: ctx.config.hosts[host]!.workDir, reason: errorMessage(e) }] }; }
  }));
  const selected = (i: GcItem | GcSkip) => opts.cohort === undefined || i.task === '-' || !!i.cohort && cohortKey(i.cohort) === cohortKey(opts.cohort);
  return { items: plans.flatMap(p => p.items).filter(selected), skipped: plans.flatMap(p => p.skipped).filter(selected) };
}

export async function applyRemoteGc(ctx: Context, item: GcItem, olderThanMs: number): Promise<GcItem> {
  if (!item.host || !ctx.config.hosts[item.host]) throw Error('host removed from configuration');
  if (item.hostFingerprint !== fingerprint(ctx, item.host)) throw Error('Host target changed since preview; preview GC again');
  const r = await ctx.hosts.forHost(item.host).checked('node', ['-e', script()], { input: JSON.stringify({ ...payload(ctx, item.host, olderThanMs), item }), timeoutMs: 10_000 });
  return { ...JSON.parse(r.stdout), hostFingerprint: item.hostFingerprint };
}
