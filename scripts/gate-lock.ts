import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** A lock directory without a readable owner counts as dead only past this age: its creator may still be publishing it. */
export const RECLAIM_GRACE_MS = 10_000;

const OWNER = 'owner';

interface Owner { token: string; pid: number; cwd?: string; started: string }

/** The lock as it is on disk: the parsed owner record, its exact bytes (null: no owner file yet) and the form it is in. */
interface LockState { raw: string | null; owner: Owner | null; legacyFile: boolean; mtimeMs: number }

function parseOwner(raw: string): Owner | null {
  try {
    const h: unknown = JSON.parse(raw);
    if (typeof h === 'object' && h !== null && typeof (h as Owner).token === 'string' && Number.isSafeInteger((h as Owner).pid) && (h as Owner).pid > 0) return h as Owner;
  } catch { /* not a JSON owner record */ }
  return null;
}

/** The state of the lock path; undefined when there is no lock. Builds before lock directories locked with a plain file. */
function lockState(file: string): LockState | undefined {
  let st: fs.Stats;
  try { st = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!st.isDirectory()) {
    let raw: string | null = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { /* unreadable: no known owner */ }
    return { raw, owner: raw === null ? null : parseOwner(raw), legacyFile: true, mtimeMs: st.mtimeMs };
  }
  let raw: string | null = null;
  try { raw = fs.readFileSync(path.join(file, OWNER), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { raw, owner: raw === null ? null : parseOwner(raw), legacyFile: false, mtimeMs: st.mtimeMs };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } // EPERM: someone else's live process.
}

/**
 * Take a stale lock away, atomically: the lock (directory or legacy file) is renamed to a unique tombstone — exactly one
 * reclaimer wins a rename, and only a path this process created is ever removed. The tombstone is deleted only when it
 * still holds exactly the owner this process verified as dead; a live successor installed since that read is put back
 * untouched, so a preempted reclaimer can never destroy a successor's ownership.
 */
function reclaim(file: string, verified: LockState): boolean {
  const tombstone = `${file}.tombstone-${process.pid}-${randomUUID()}`;
  try { fs.renameSync(file, tombstone); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  const taken = lockState(tombstone)!;
  if (taken.legacyFile !== verified.legacyFile || taken.raw !== verified.raw) {
    try { fs.renameSync(tombstone, file); } catch { /* a newcomer took the slot in between: the tombstone stays for its live owner's recovery */ }
    return false;
  }
  fs.rmSync(tombstone, { recursive: true, force: true });
  return true;
}

export async function acquireLock(file: string, onWait = (owner: string) => console.log(`gate lock held by ${owner}; waiting`), wait = () => new Promise<void>(r => setTimeout(r, 1000))): Promise<() => void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const own = JSON.stringify({ token: randomUUID(), pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() });
  let printed = '';
  for (;;) {
    try {
      fs.mkdirSync(file); // atomic acquisition: the lock directory either appears for us or not
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const state = lockState(file);
      if (state === undefined) continue; // it raced away: try to create it again
      // A gate that was SIGKILLed never releases its lock: a lock whose holder pid is gone is broken, not waited on.
      if (state.owner !== null && alive(state.owner.pid)) {
        if (state.raw !== null && state.raw !== printed) { onWait(state.raw); printed = state.raw; }
        await wait();
        continue;
      }
      if (state.owner === null) {
        // An unparsable legacy lock file is waited on, never broken.
        if (state.legacyFile) { await wait(); continue; }
        // A directory without an owner file is a creator mid-publish (or SIGKILLed in it): dead only past the grace.
        if (Date.now() - state.mtimeMs <= RECLAIM_GRACE_MS) { await wait(); continue; }
      }
      // The owner is dead, or its publish never finished past the grace. The rename is the claim: whoever wins it owns
      // the tombstone exclusively, and a lock replaced since the verified read is put back instead of removed.
      if (reclaim(file, state)) console.log(`gate lock of dead pid ${state.owner?.pid ?? '(never published)'} removed`);
      continue;
    }
    // Ownership is published atomically: a complete temp file renamed into place inside the lock directory. A SIGKILL
    // can leave an ownerless directory or a temp orphan (both reclaimed past the grace), never a torn owner file.
    const tmp = path.join(file, `.owner-${process.pid}-${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, own);
    fs.renameSync(tmp, path.join(file, OWNER));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only the directory whose owner is still exactly this process's record is removed — never a successor's.
      try { if (fs.readFileSync(path.join(file, OWNER), 'utf8') === own) fs.rmSync(file, { recursive: true, force: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  }
}
