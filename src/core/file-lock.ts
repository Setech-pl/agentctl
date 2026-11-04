import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

/** Recover only a dead process owner. Never expire a lock held by a slow live sender. */
function recoverDeadOwner(file: string): void {
  try {
    const original = fs.statSync(file);
    const owner = Number(fs.readFileSync(file, 'utf8'));
    let dead = owner <= 0 && Date.now() - original.mtimeMs > 5000;
    if (owner > 0) {
      try { process.kill(owner, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    }
    if (dead && fs.statSync(file).ino === original.ino) fs.unlinkSync(file);
  } catch { /* owner released it */ }
}

/** Non-blocking variant for synchronous sampling. A skipped competing read can be sampled on the next look. */
export function tryFileLock(file: string): (() => void) | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); } catch (error) { try { fs.unlinkSync(file); } catch { /* already gone */ } throw error; } finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      recoverDeadOwner(file);
    }
  }
  return undefined;
}

const ownership = new AsyncLocalStorage<Map<string, { active: boolean }>>();
export const taskLock = (file: string): string => path.join(path.dirname(path.resolve(file)), 'prompt-delivery.lock');

/** Short, process-shared critical section. A dead owner's lock can be recovered; a live owner is never evicted. */
export async function withFileLock<T>(file: string, action: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  file = path.resolve(file);
  if (ownership.getStore()?.get(file)?.active) return action();
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(file))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const lease = { active: true };
  const owned = new Map(ownership.getStore()); owned.set(file, lease);
  try { return await ownership.run(owned, action); } finally { lease.active = false; release(); }
}

/** Synchronous state migration uses the same per-task lock as asynchronous writers. */
export function withFileLockSync<T>(file: string, action: () => T, timeoutMs = 2000): T {
  file = path.resolve(file);
  if (ownership.getStore()?.get(file)?.active) return action();
  const deadline = Date.now() + timeoutMs;
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(file))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const lease = { active: true }, owned = new Map(ownership.getStore()); owned.set(file, lease);
  try { return ownership.run(owned, action); } finally { lease.active = false; release(); }
}
