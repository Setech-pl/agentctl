import fs from 'node:fs';
import path from 'node:path';

/** Short, process-shared critical section. A dead owner's lock can be recovered; a live owner is never evicted. */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const owner = Number(fs.readFileSync(file, 'utf8'));
        if (owner > 0) {
          try { process.kill(owner, 0); } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(file);
          }
        } else if (Date.now() - fs.statSync(file).mtimeMs > 5000) fs.unlinkSync(file);
      } catch { /* owner released it */ }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await action(); } finally { fs.unlinkSync(file); }
}
