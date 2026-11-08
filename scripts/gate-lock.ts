import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A reclaim sidecar without a readable owner counts as dead only past this age: its creator may still be writing it. */
export const RECLAIM_GRACE_MS = 10_000;

/** The owner pid of a reclaim sidecar, whether the current JSON form or a legacy bare pid; null when unreadable. */
function reclaimPid(sidecar: string): number | null {
  try {
    const h: unknown = JSON.parse(sidecar);
    if (typeof h === 'object' && h !== null && Number.isSafeInteger((h as { pid?: unknown }).pid) && Number((h as { pid: number }).pid) > 0) return (h as { pid: number }).pid;
  } catch { /* not a JSON sidecar */ }
  const n = Number(sidecar);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

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
          // Ownership carries a unique token: a sidecar is unlinked only when a fresh re-read shows the exact bytes this
          // process verified — never a lock a live successor installed since a stale read.
          const reclaim = `${file}.reclaim`;
          const own = JSON.stringify({ token: randomUUID(), pid: process.pid, started: new Date().toISOString() });
          // Publish ownership atomically: a complete temp file hard-linked into place. A SIGKILL can no longer leave an
          // empty sidecar at the lock path — only a temp orphan nobody reads.
          const tmp = `${reclaim}.${process.pid}.${randomUUID()}.tmp`;
          fs.writeFileSync(tmp, own);
          let acquired = false;
          try { fs.linkSync(tmp, reclaim); acquired = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          finally { try { fs.unlinkSync(tmp); } catch { /* raced away */ } }
          if (!acquired) {
            // Another reclaimer is at it. Its lock outliving its pid means it died inside the synchronous section below:
            // that section either never ran or already finished, so breaking the reclaim lock cannot lose an unlink.
            let sidecar: string;
            try { sidecar = fs.readFileSync(reclaim, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
            const rpid = reclaimPid(sidecar);
            let rdead = false;
            if (rpid !== null) { try { process.kill(rpid, 0); } catch (e) { rdead = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
            else {
              // An empty or unparsable sidecar is a crashed publish by an older build; dead only past the grace.
              try { rdead = Date.now() - fs.statSync(reclaim).mtimeMs > RECLAIM_GRACE_MS; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
            }
            if (rdead) {
              // A live successor may have replaced the sidecar since the read above: re-read and delete only those exact bytes.
              let current: string | null = null;
              try { current = fs.readFileSync(reclaim, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
              if (current === sidecar) { try { fs.unlinkSync(reclaim); } catch { /* raced away */ } }
              continue;
            }
            await wait();
            continue;
          }
          try {
            // Under the reclaim lock the lock file cannot change: only a reclaimer unlinks it, creation needs it gone.
            const current = fs.readFileSync(file, 'utf8');
            if (current === holder) { fs.unlinkSync(file); console.log(`gate lock of dead pid ${pid} removed`); }
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          finally {
            // Release only the sidecar this process published: a stolen or replaced one belongs to someone else.
            try { if (fs.readFileSync(reclaim, 'utf8') === own) fs.unlinkSync(reclaim); } catch { /* already gone */ }
          }
          continue;
        }
      }
      if (holder !== printed) { onWait(holder); printed = holder; }
      await wait();
    }
  }
}
