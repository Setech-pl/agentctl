import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';
import { sizeOf } from './fs-measure.ts';
import { moveToTrash } from './trash.ts';
import { recordJournal } from './journal.ts';
import { assertWorktreeVolumes, WorktreeVolumeError } from './worktree-volume.ts';
import type { Context } from './context.ts';
import type { GlobalConfig } from './config.ts';
import type { ResolvedRepo } from './spec.ts';

const hash = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex');
const storeRoot = (config: Pick<GlobalConfig, 'path'>): string => path.resolve(path.dirname(config.path), 'nm-store');
const dir = (target: string): boolean => fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
const present = (target: string): boolean => Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
const entryName = /^[a-f0-9]{64}-[a-f0-9]{16}$/;
const repoName = /^.+-[a-f0-9]{16}$/;
const lockfiles = ['npm-shrinkwrap.json', 'package-lock.json'];
const npmCi = /^npm[ \t]+ci(?:[ \t]+--(?:no-audit|no-fund))*[ \t]*$/;
const lease = (entry: string): string => `${entry}.lock`;
interface Entry { bytes: number; usedAt: number }
interface Counters { hits: number; misses: number }
export interface NodeModulesStore extends Counters { bytes: number; entries: number }

export function hasNpmLockfile(worktree: string): boolean {
  return lockfiles.some(name => fs.lstatSync(path.join(worktree, name), { throwIfNoEntry: false })?.isFile());
}

function key(config: GlobalConfig, repo: ResolvedRepo, command: string): string | undefined {
  const manifest = fs.readFileSync(path.join(repo.worktree, 'package.json'), 'utf8');
  const { scripts, workspaces } = JSON.parse(manifest);
  // npm can run arbitrary project lifecycle scripts, including writing outside node_modules.
  if (workspaces || ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'].some(name => scripts?.[name])) return undefined;
  const lockfile = lockfiles.map(name => path.join(repo.worktree, name)).find(file => fs.lstatSync(file, { throwIfNoEntry: false })?.isFile());
  if (!lockfile) return undefined;
  const lock = fs.readFileSync(lockfile, 'utf8');
  const packages: unknown = JSON.parse(lock).packages;
  if (!packages || typeof packages !== 'object' || Object.values(packages).some(pkg => pkg?.link || /^(?:file|link):/.test(pkg?.resolved ?? ''))) return undefined;
  const rc = path.join(repo.worktree, '.npmrc');
  if (present(rc) && !fs.lstatSync(rc).isFile()) return undefined;
  const npmEnv = Object.entries(process.env).filter(([name]) => /^(?:NODE_ENV$|NPM_CONFIG_)/i.test(name)).sort();
  const compatibility = hash(JSON.stringify([manifest, present(rc) ? fs.readFileSync(rc, 'utf8') : '', command.trim(), process.platform, process.arch, process.version, npmEnv])).slice(0, 16);
  const origin = fs.realpathSync(repo.path);
  return path.join(storeRoot(config), `${path.basename(origin)}-${hash(origin).slice(0, 16)}`, `${hash(lock)}-${compatibility}`);
}

function readEntry(target: string): Entry | undefined {
  try {
    if (!dir(target) || !dir(path.join(target, 'node_modules'))) return undefined;
    const value = JSON.parse(fs.readFileSync(path.join(target, 'entry.json'), 'utf8'));
    if ([value.bytes, value.usedAt].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return value;
  } catch { /* An incomplete entry is eligible for GC once stale. */ }
  return undefined;
}

function counters(root: string): Counters {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'stats.json'), 'utf8'));
    if (Number.isSafeInteger(value.hits) && value.hits >= 0 && Number.isSafeInteger(value.misses) && value.misses >= 0) return value;
  } catch { /* first use */ }
  return { hits: 0, misses: 0 };
}

function entries(config: Pick<GlobalConfig, 'path'>): string[] {
  const root = storeRoot(config);
  if (!dir(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(repo => repo.isDirectory() && repoName.test(repo.name)).flatMap(repo => {
    const parent = path.join(root, repo.name);
    try { return fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && entryName.test(entry.name)).map(entry => path.join(parent, entry.name)); }
    catch { return []; }
  });
}

export function nodeModulesStore(config: GlobalConfig): NodeModulesStore | undefined {
  try {
    const root = storeRoot(config);
    if (config.nodeModules !== 'clone' && !dir(root)) return undefined;
    const current = entries(config).flatMap(target => readEntry(target) ?? []);
    return { ...counters(root), entries: current.length, bytes: current.reduce((total, entry) => total + entry.bytes, 0) };
  } catch { return undefined; }
}

export async function nodeModulesEvent(ctx: Context, task: string, repo: ResolvedRepo, result: 'hit' | 'miss' | 'unsupported', bytes: number, reason?: string): Promise<void> {
  const name = path.basename(repo.path);
  if (result !== 'unsupported') {
    try {
      const root = storeRoot(ctx.config);
      if (!present(root)) fs.mkdirSync(root, { mode: 0o700, recursive: true });
      if (!dir(root)) throw Error('invalid node_modules store');
      await withFileLock(path.join(root, 'stats.lock'), async () => {
        const stats = counters(root);
        stats[result === 'hit' ? 'hits' : 'misses']++;
        atomicWriteFile(path.join(root, 'stats.json'), JSON.stringify(stats));
      });
    } catch (error) { ctx.info(`${task}: node_modules store counters unavailable: ${String(error)}`); }
  }
  const text = `${task}: node_modules ${name}: ${result}${reason ? ` (${reason})` : ''}`;
  ctx.info(text);
  await recordJournal(ctx, { kind: 'node-modules', task, text, nodeModules: { repo: name, result, bytes } });
}

async function copy(ctx: Context, from: string, to: string): Promise<boolean> {
  const args = process.platform === 'darwin' ? ['-c', '-R', '-P'] : ['--reflink=auto', '-R', '-P'];
  const result = await ctx.runner.exec('cp', [...args, from, to], { async: true, timeoutMs: ctx.config.git.timeoutS * 1000 });
  return result.code === 0 && dir(to);
}

/** Wrap the install command only. Other setup commands still run in their original order. */
export async function setupNodeModules(ctx: Context, task: string, repo: ResolvedRepo, command: string, install: () => Promise<void>): Promise<'hit' | void> {
  if (repo.nodeModules !== 'clone' || ctx.runner.dryRun || !npmCi.test(command)) return install();
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    await nodeModulesEvent(ctx, task, repo, 'unsupported', 0, process.platform);
    return install();
  }
  let entry: string | undefined;
  try { entry = key(ctx.config, repo, command); } catch { /* npm reports invalid or missing inputs */ }
  if (!entry) {
    await nodeModulesEvent(ctx, task, repo, 'miss', 0, 'install inputs not cacheable');
    return install();
  }
  const root = storeRoot(ctx.config), parent = path.dirname(entry);
  try {
    if (!present(root)) fs.mkdirSync(root, { mode: 0o700, recursive: true });
    if (!dir(root)) throw Error('invalid node_modules store');
    if (fs.statSync(root).dev !== fs.statSync(repo.worktree).dev) {
      await nodeModulesEvent(ctx, task, repo, 'miss', 0, 'store and worktree are on different filesystems');
      return install();
    }
    if (!present(parent)) fs.mkdirSync(parent, { mode: 0o700, recursive: true });
    if (!dir(parent)) throw Error('invalid repository store');
  } catch {
    await nodeModulesEvent(ctx, task, repo, 'miss', 0, 'store unavailable');
    return install();
  }
  const target = path.join(repo.worktree, 'node_modules'), cacheEntry = entry;
  let installStarted = false;
  try {
    return await withFileLock(lease(cacheEntry), async () => {
      assertWorktreeVolumes([repo], task);
      const saved = readEntry(cacheEntry);
      if (saved && !present(target)) {
        const staging = fs.mkdtempSync(path.join(repo.worktree, '.agentctl-nm-'));
        const clone = path.join(staging, 'node_modules');
        let hit = false;
        try {
          if (await copy(ctx, path.join(cacheEntry, 'node_modules'), clone) && !present(target)) {
            assertWorktreeVolumes([repo], task);
            fs.renameSync(clone, target);
            hit = true;
          }
        } finally { await ctx.runner.remove(staging).catch(() => undefined); }
        if (hit) {
          try { atomicWriteFile(path.join(cacheEntry, 'entry.json'), JSON.stringify({ ...saved, usedAt: ctx.runner.now() })); } catch { /* the clone is ready */ }
          await nodeModulesEvent(ctx, task, repo, 'hit', saved.bytes);
          return 'hit' as const;
        }
      }
      installStarted = true;
      try { await install(); }
      catch (error) { await nodeModulesEvent(ctx, task, repo, 'miss', saved?.bytes ?? 0); throw error; }
      assertWorktreeVolumes([repo], task);
      let bytes = saved?.bytes ?? 0;
      if (!present(cacheEntry) && dir(target)) {
        try {
          fs.mkdirSync(cacheEntry, { mode: 0o700 });
          if (await copy(ctx, target, path.join(cacheEntry, 'node_modules'))) {
            bytes = await sizeOf(path.join(cacheEntry, 'node_modules'));
            atomicWriteFile(path.join(cacheEntry, 'entry.json'), JSON.stringify({ bytes, usedAt: ctx.runner.now() }));
          }
        } catch { /* a partial entry is never served, and GC can send it to Trash */ }
      }
      await nodeModulesEvent(ctx, task, repo, 'miss', bytes);
    }, ctx.config.git.timeoutS * 3000 + 60_000);
  } catch (error) {
    if (installStarted || error instanceof WorktreeVolumeError) throw error;
    await nodeModulesEvent(ctx, task, repo, 'miss', 0, 'clone unavailable');
    await install();
  }
}

export function staleNodeModules(config: GlobalConfig, olderThanMs: number, now: number) {
  return entries(config).flatMap(target => {
    try {
      const entry = readEntry(target);
      if (now - (entry?.usedAt ?? fs.lstatSync(target).mtimeMs) < olderThanMs) return [];
      return [{ target, bytes: entry?.bytes ?? 0 }];
    } catch { return []; }
  });
}

export async function trashStaleNodeModules(ctx: Context, target: string, olderThanMs: number): Promise<number> {
  const root = storeRoot(ctx.config), parent = path.dirname(target);
  if (path.dirname(parent) !== root || !repoName.test(path.basename(parent)) || !entryName.test(path.basename(target)) || !dir(root) || !dir(parent)) throw Error('invalid node_modules store entry');
  if (ctx.runner.dryRun) return 0;
  return withFileLock(lease(target), async () => {
    if (!dir(target)) throw Error('node_modules store entry is missing or unsafe');
    const entry = readEntry(target);
    if (ctx.runner.now() - (entry?.usedAt ?? fs.lstatSync(target).mtimeMs) < olderThanMs) throw Error('node_modules store entry was used since preview');
    await moveToTrash(ctx.runner, target);
    return entry?.bytes ?? 0;
  });
}
