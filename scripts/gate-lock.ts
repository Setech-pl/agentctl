import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(file: string, onWait = (owner: string) => console.log(`gate lock held by ${owner}; waiting`), wait = () => new Promise<void>(r => setTimeout(r, 1000))): Promise<() => void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const owner = JSON.stringify({ token: randomUUID(), pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() });
  let printed = '';
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, owner); fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: string;
      try { holder = fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      if (holder !== printed) { onWait(holder); printed = holder; }
      await wait();
    }
  }
}
