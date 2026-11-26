import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteFile } from './atomic-file.ts';
import { withFileLock } from './file-lock.ts';
import { sizeOf } from './fs-measure.ts';
import { recordJournal } from './journal.ts';
import { assertWorktreeVolumes, insidePath, WorktreeVolumeError } from './worktree-volume.ts';
import { findRecordAnywhere } from './taskstore.ts';
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

async function copy(ctx: Context, from: string, to: string, strict = false): Promise<boolean> {
  const args = process.platform === 'darwin' ? ['-c', '-R', '-P'] : [strict ? '--reflink=always' : '--reflink=auto', '-R', '-P'];
  if (strict) args.push('-x');
  const result = await ctx.runner.exec('cp', [...args, from, to], { async: true, timeoutMs: ctx.config.git.timeoutS * 1000 });
  return result.code === 0 && dir(to);
}

async function installClone(ctx: Context, task: string, repo: ResolvedRepo, clone: (target: string) => Promise<boolean>): Promise<boolean> {
  const target = path.join(repo.worktree, 'node_modules');
  if (present(target)) return false;
  const staging = fs.mkdtempSync(path.join(repo.worktree, '.agentctl-nm-'));
  const staged = path.join(staging, 'node_modules');
  try {
    if (!await clone(staged) || present(target)) return false;
    assertWorktreeVolumes([repo], task);
    fs.renameSync(staged, target);
    return true;
  } finally { await ctx.runner.remove(staging).catch(() => undefined); }
}

function npmLockfile(worktree: string): [string, string] | undefined {
  for (const name of lockfiles) {
    const file = path.join(worktree, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat) return stat.isFile() ? [name, hash(fs.readFileSync(file))] : undefined;
  }
  return undefined;
}

/** macOS cp -c may fall back to a byte copy on filesystems without clones. Only use it on APFS. */
async function apfsDevice(ctx: Context, device: number): Promise<boolean> {
  const result = await ctx.runner.exec('/sbin/mount', [], { readOnly: true });
  return result.code === 0 && result.stdout.split('\n').some(line => {
    const mount = /^.+ on (.+) \(apfs(?:,|\))/.exec(line)?.[1];
    return mount && fs.statSync(mount, { throwIfNoEntry: false })?.dev === device;
  });
}

async function safeDependencyTree(root: string): Promise<boolean> {
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isSymbolicLink()) {
        const link = await fs.promises.readlink(file);
        if (path.isAbsolute(link) || !insidePath(root, path.resolve(dir, link)) || !insidePath(root, await fs.promises.realpath(file))) return false;
      } else if (!entry.isFile()) return false;
    }
  }
  return true;
}

/** Clone only file extents. A filesystem without reflinks or a link outside the dependency tree falls back to setup. */
export async function cloneTaskNodeModules(ctx: Context, task: string, repo: ResolvedRepo, command: string, fromTask: string, prepared?: ResolvedRepo[]): Promise<boolean> {
  if (ctx.runner.dryRun || !npmCi.test(command)) return false;
  if (process.platform !== 'darwin' && process.platform !== 'linux') return false;
  try {
    const author = findRecordAnywhere(ctx.config, fromTask);
    if (author?.host) return false;
    const origin = fs.realpathSync(repo.path);
    const source = (prepared ?? author?.repos)?.find(r => fs.existsSync(r.path) && fs.realpathSync(r.path) === origin);
    if (!source || !dir(source.worktree)) return false;
    const modules = path.join(fs.realpathSync(source.worktree), 'node_modules');
    if (!dir(modules)) return false;
    const device = fs.statSync(modules).dev;
    if (device !== fs.statSync(repo.worktree).dev) return false;
    const lock = npmLockfile(repo.worktree);
    const matches = () => {
      const current = npmLockfile(source.worktree);
      return current?.[0] === lock?.[0] && current?.[1] === lock?.[1];
    };
    if (!lock || !matches()) return false;
    if (process.platform === 'darwin' && !await apfsDevice(ctx, device)) return false;
    return await installClone(ctx, task, repo, async staged => {
      return await copy(ctx, modules, staged, true) && await safeDependencyTree(fs.realpathSync(staged)) && matches();
    });
  } catch (error) {
    if (error instanceof WorktreeVolumeError) throw error;
    return false;
  }
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
        const hit = await installClone(ctx, task, repo, clone => copy(ctx, path.join(cacheEntry, 'node_modules'), clone));
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

export async function removeStaleNodeModules(ctx: Context, target: string, olderThanMs: number, remove: () => Promise<void>): Promise<void> {
  const root = storeRoot(ctx.config), parent = path.dirname(target);
  if (path.dirname(parent) !== root || !repoName.test(path.basename(parent)) || !entryName.test(path.basename(target)) || !dir(root) || !dir(parent)) throw Error('invalid node_modules store entry');
  if (ctx.runner.dryRun) return;
  return withFileLock(lease(target), async () => {
    if (!dir(target)) throw Error('node_modules store entry is missing or unsafe');
    const entry = readEntry(target);
    if (ctx.runner.now() - (entry?.usedAt ?? fs.lstatSync(target).mtimeMs) < olderThanMs) throw Error('node_modules store entry was used since preview');
    await remove();
  });
}
