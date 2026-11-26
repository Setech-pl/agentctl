import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Context } from './context.ts';
import { readJournal } from './journal.ts';
import { listArchivedRecords, listTaskRecords } from './taskstore.ts';

export interface TrashItem {
  target: string;
  original: string;
  identity: string;
  receipt?: string;
}

interface TrashReceipt { original: string; identity: string; url?: string; purged?: boolean }

const uid = process.getuid?.() ?? 0;
const receiptDir = (ctx: Context) => path.join(ctx.config.stateDir, 'trash-receipts');

function identity(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || stat.uid !== BigInt(uid)) return undefined;
    return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
  } catch { return undefined; }
}

function trashRoots(original: string): string[] {
  const home = os.homedir();
  let mount = path.dirname(original);
  while (!fs.existsSync(mount) && mount !== path.dirname(mount)) mount = path.dirname(mount);
  while (mount !== path.dirname(mount) && fs.statSync(mount).dev === fs.statSync(path.dirname(mount)).dev) mount = path.dirname(mount);
  if (process.platform === 'darwin') return [path.join(home, '.Trash'), path.join(mount, '.Trashes', String(uid))];
  return [
    path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'Trash', 'files'),
    path.join(mount, '.Trash', String(uid), 'files'),
    path.join(mount, `.Trash-${uid}`, 'files'),
  ];
}

function safeRoot(root: string): boolean {
  try {
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && stat.uid === uid && fs.realpathSync(root) === root;
  } catch { return false; }
}

function safeItem(target: string, original: string, expected: string): boolean {
  const root = path.dirname(target);
  return trashRoots(original).includes(root) && safeRoot(root) && identity(target) === expected;
}

function findMoved(original: string, expected: string): string | undefined {
  for (const root of new Set(trashRoots(original))) {
    if (!safeRoot(root)) continue;
    const target = fs.readdirSync(root).map(name => path.join(root, name)).find(file => identity(file) === expected);
    if (target) return target;
  }
}

export async function moveToTrash(ctx: Context, original: string): Promise<TrashItem> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('Trash unsupported on this platform');
  const { runner } = ctx;
  const owned = identity(original);
  if (!owned) throw new Error('Cannot record the identity of the Trash item');
  const receipt = path.join(receiptDir(ctx), `${randomUUID()}.json`);
  await runner.mkdir(receiptDir(ctx));
  await runner.writeFile(receipt, JSON.stringify({ original, identity: owned }));
  if (identity(original) !== owned) throw new Error('Trash source changed');
  const script = 'ObjC.import("Foundation"); function run(argv) { const url = $.NSURL.fileURLWithPath(argv[0]); const moved = Ref(), error = Ref(); if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, moved, error)) throw Error(ObjC.unwrap(error[0].localizedDescription)); return ObjC.unwrap(moved[0].absoluteString); }';
  const result = process.platform === 'darwin'
    ? await runner.exec('osascript', ['-l', 'JavaScript', '-e', script, original], { timeoutMs: 30_000 })
    : await runner.exec('gio', ['trash', '--', original], { timeoutMs: 30_000 });
  if (result.code !== 0) throw new Error(`Trash unavailable: ${result.stderr.trim() || `exit ${result.code}`}`);
  const target = process.platform === 'darwin' && result.stdout.trim()
    ? fileURLToPath(result.stdout.trim()) : findMoved(original, owned);
  if (!target || !safeItem(target, original, owned)) throw new Error('Cannot verify the resulting Trash path; left in Trash');
  await runner.writeFile(receipt, JSON.stringify({ original, identity: owned, url: pathToFileURL(target).href }));
  return { target, original, identity: owned, receipt };
}

export async function purgeTrashItem(ctx: Context, item: TrashItem): Promise<void> {
  if (ctx.runner.dryRun) return;
  if (!safeItem(item.target, item.original, item.identity)) throw new Error('Trash item changed since preview; kept');
  const root = path.dirname(item.target);
  const info = path.join(path.dirname(root), 'info');
  const sidecar = path.join(info, `${path.basename(item.target)}.trashinfo`);
  const metadata = process.platform === 'linux' && item.receipt && path.basename(root) === 'files' && safeRoot(info)
    ? identity(sidecar) : undefined;
  await ctx.runner.remove(item.target);
  if (metadata && safeRoot(info) && identity(sidecar) === metadata) fs.unlinkSync(sidecar);
  if (item.receipt) await ctx.runner.writeFile(item.receipt, JSON.stringify({
    original: item.original, identity: item.identity, url: pathToFileURL(item.target).href, purged: true,
  }));
}

/** Recorded items take precedence. Legacy names match only an absent, known original on the same Trash volume. */
export function planTrashPurge(ctx: Context): TrashItem[] {
  const result = new Map<string, TrashItem>();
  const recorded = new Set<string>();
  const dir = receiptDir(ctx);
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const receipt = path.join(dir, name);
      if (!fs.lstatSync(receipt).isFile()) continue;
      const data = JSON.parse(fs.readFileSync(receipt, 'utf8')) as TrashReceipt;
      if (!path.isAbsolute(data.original) || typeof data.identity !== 'string') continue;
      recorded.add(data.original);
      if (data.purged) continue;
      const target = data.url ? fileURLToPath(data.url) : findMoved(data.original, data.identity);
      if (target && safeItem(target, data.original, data.identity)) {
        result.set(target, { target, original: data.original, identity: data.identity, receipt });
      }
    } catch { /* unreadable, replaced or disconnected */ }
  }
  const originals = new Map<string, Set<string>>();
  const add = (original: string) => {
    if (!path.isAbsolute(original) || recorded.has(original) || fs.existsSync(original)) return;
    for (const root of trashRoots(original)) {
      const target = path.join(root, path.basename(original));
      const matches = originals.get(target) ?? new Set<string>();
      matches.add(original);
      originals.set(target, matches);
    }
  };
  for (const record of [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)]) {
    if (record.host || record.pin || !record.closed && !record.cancelled) continue;
    add(path.join(ctx.config.cache, record.window));
    for (const repo of record.repos) if (!record.reviewMode && repo.worktree !== repo.path) add(repo.worktree);
  }
  for (const event of readJournal(ctx.config)) if (event.kind === 'close-cleanup' && /moved to Trash/.test(event.text)) {
    for (const { path: original } of event.cleanup?.moved ?? []) add(original);
  }
  for (const [target, matches] of originals) {
    if (matches.size !== 1 || result.has(target)) continue;
    const original = [...matches][0]!;
    const owned = identity(target);
    if (owned && safeItem(target, original, owned)) result.set(target, { target, original, identity: owned });
  }
  return [...result.values()].sort((a, b) => a.target.localeCompare(b.target));
}
