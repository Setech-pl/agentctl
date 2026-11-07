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
      // A gate that was SIGKILLed never releases its lock: a lock whose holder pid is gone is broken, not waited on.
      let pid: number | null = null;
      try { const h: unknown = JSON.parse(holder); if (typeof h === 'object' && h !== null && Number.isSafeInteger((h as { pid?: unknown }).pid) && Number((h as { pid: number }).pid) > 0) pid = (h as { pid: number }).pid; } catch { /* not a JSON holder */ }
      if (pid !== null) {
        let dead = false;
        try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; } // EPERM: someone else's live process — wait.
        if (dead) {
          // F2: serialize reclamation through a reclaim lock. The verifying re-read and the unlink happen under it, so a
          // second reclaimer cannot unlink the live successor lock the winner of the first reclamation just created.
          const reclaim = `${file}.reclaim`;
          let fd: number | undefined;
          try {
            fd = fs.openSync(reclaim, 'wx');
            fs.writeFileSync(fd, String(process.pid));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            // Another reclaimer is at it. Its lock outliving its pid means it died inside the synchronous section below:
            // that section either never ran or already finished, so breaking the reclaim lock cannot lose an unlink.
            let rpid = NaN;
            try { rpid = Number(fs.readFileSync(reclaim, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
            let rdead = false;
            if (Number.isSafeInteger(rpid) && rpid > 0) { try { process.kill(rpid, 0); } catch (e) { rdead = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
            if (rdead) { try { fs.unlinkSync(reclaim); } catch { /* raced away */ } }
            await wait();
            continue;
          }
          try {
            // Under the reclaim lock the lock file cannot change: only a reclaimer unlinks it, creation needs it gone.
            const current = fs.readFileSync(file, 'utf8');
            if (current === holder) { fs.unlinkSync(file); console.log(`gate lock of dead pid ${pid} removed`); }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          finally { fs.closeSync(fd); try { fs.unlinkSync(reclaim); } catch { /* already gone */ } }
          continue;
        }
      }
      if (holder !== printed) { onWait(holder); printed = holder; }
      await wait();
    }
  }
}
