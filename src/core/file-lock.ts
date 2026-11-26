import { checkResponseBudget, withoutResponseBudget } from './response-budget.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { commandStageRemaining } from './command-stage.ts';

interface LockOwner { pid: number; task: string; at: string }
interface LockRecovery { task: string; staleMs: number; recovered: (owner: Partial<LockOwner>) => void }

function parseOwner(raw: string): Partial<LockOwner> {
  if (!raw.startsWith('{')) return { pid: Number(raw) };
  try {
    const owner = JSON.parse(raw);
    const at = typeof owner.at === 'number' ? new Date(owner.at).toISOString() : owner.at;
    return { pid: Number(owner.pid), ...(typeof owner.task === 'string' ? { task: owner.task } : {}), ...(typeof at === 'string' ? { at } : {}) };
  } catch { return {}; }
}

function recoverDeadOwner(file: string, recovery?: LockRecovery): void {
  try {
    const original = fs.lstatSync(file);
    if (!original.isFile()) return;
    const now = Date.now();
    const owner = parseOwner(fs.readFileSync(file, 'utf8').trim());
    const at = Date.parse(owner.at ?? '');
    const pid = owner.pid;
    const validPid = pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
    let dead = !validPid && now - original.mtimeMs >= (recovery ? 30_000 : 5000);
    if (validPid) {
      dead = Boolean(recovery && Number.isFinite(at) && now - at >= Math.max(30_000, recovery.staleMs));
      if (!dead) {
        try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
    }
    if (dead && sameLock(file, original)) {
      fs.unlinkSync(file);
      recovery?.recovered(owner);
    }
  } catch { /* owner released it */ }
}

function sameLock(file: string, expected: fs.Stats): boolean {
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  return current?.ino === expected.ino && current.dev === expected.dev;
}

/** Non-blocking variant for synchronous sampling. A skipped competing read can be sampled on the next look. */
export function tryFileLock(file: string, recovery?: LockRecovery): (() => void) | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const identity = fs.fstatSync(fd);
      const release = () => {
        try { if (sameLock(file, identity)) fs.unlinkSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
      try {
        fs.writeFileSync(fd, recovery ? JSON.stringify({ pid: process.pid, task: recovery.task, at: new Date().toISOString() }) : String(process.pid));
      } catch (error) { release(); throw error; } finally { fs.closeSync(fd); }
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      recoverDeadOwner(file, recovery);
    }
  }
  return undefined;
}

export class FileLockTimeout extends Error {
  constructor(readonly file: string) { super(`Timed out waiting for ${file}`); }
}

const ownership = new AsyncLocalStorage<Map<string, { active: boolean }>>();
export const taskLock = (file: string): string => path.join(path.dirname(path.resolve(file)), 'prompt-delivery.lock');

/** Short, process-shared critical section. An admission lease can be recovered when its recorded timestamp expires. */
export async function withFileLock<T>(file: string, action: () => Promise<T>, timeoutMs = 60_000, stateWrite = false, recovery?: LockRecovery): Promise<T> {
  file = path.resolve(file);
  if (stateWrite) checkResponseBudget();
  if (ownership.getStore()?.get(file)?.active) return action();
  const deadline = Date.now() + Math.min(timeoutMs, commandStageRemaining());
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(file, recovery))) {
    checkResponseBudget();
    if (Date.now() >= deadline || commandStageRemaining() <= 0) throw new FileLockTimeout(file);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (stateWrite) checkResponseBudget();
  }
  const lease = { active: true };
  const owned = new Map(ownership.getStore()); owned.set(file, lease);
  try {
    // After acquiring a state writer lock, commit independently of the caller's response deadline.
    if (stateWrite) return await withoutResponseBudget(() => ownership.run(owned, action));
    checkResponseBudget();
    return await ownership.run(owned, action);
  } finally { lease.active = false; release(); }
}

export const withStateWriteLock = <T>(file: string, action: () => Promise<T>): Promise<T> =>
  withFileLock(file, action, 60_000, true);

/** Synchronous state migration uses the same per-task lock as asynchronous writers. */
export function withFileLockSync<T>(file: string, action: () => T, timeoutMs = 2000): T {
  file = path.resolve(file);
  if (ownership.getStore()?.get(file)?.active) return action();
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(file))) {
    checkResponseBudget();
    if (Date.now() >= deadline) throw new FileLockTimeout(file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const lease = { active: true }, owned = new Map(ownership.getStore()); owned.set(file, lease);
  try { checkResponseBudget(); return ownership.run(owned, action); } finally { lease.active = false; release(); }
}
