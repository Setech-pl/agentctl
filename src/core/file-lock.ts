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
      try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => fs.unlinkSync(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      recoverDeadOwner(file);
    }
  }
  return undefined;
}

/** Short, process-shared critical section. A dead owner's lock can be recovered; a live owner is never evicted. */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000;
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(file))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  try { return await action(); } finally { release(); }
}
