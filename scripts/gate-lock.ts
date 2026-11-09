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
 * A sibling tombstone of this lock whose owner is alive: a reclaimer has displaced a live lock and is about to roll it
 * back. The freed path must not be taken in that window — the rollback rename lands only on a free path, and a newcomer
 * already inside it would strand the live owner in the tombstone (L1, the three-contender interleaving).
 */
function liveTombstone(file: string): string | undefined {
  const base = path.basename(file);
  let names: string[];
  try { names = fs.readdirSync(path.dirname(file)); } catch { return undefined; }
  for (const name of names) {
    if (!name.startsWith(`${base}.tombstone-`)) continue;
    const state = lockState(path.join(path.dirname(file), name));
    if (state?.owner && alive(state.owner.pid)) return name;
  }
  return undefined;
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
  // Ownership is verified again after the rename: a lock whose owner was published (or whose pid came back) since the
  // verified read is LIVE and goes back — removing it would strand a running gate in a tombstone.
  const taken = lockState(tombstone);
  if (!taken) return false; // another waiter already restored the live directory
  const displacedLive = taken.owner !== null && alive(taken.owner.pid);
  if (taken.legacyFile !== verified.legacyFile || taken.raw !== verified.raw || displacedLive) {
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
    // A live-owned tombstone of this very lock: its reclaimer is rolling a live owner back — wait, never take the freed path.
    const displaced = liveTombstone(file);
    if (displaced) {
      // A prechecked contender may have occupied the path during rollback. Once
      // it withdraws, any waiter can restore the displaced live owner's directory.
      try { fs.renameSync(path.join(path.dirname(file), displaced), file); }
      catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      await wait(); continue;
    }
    // Publish a nonempty directory atomically. Rollback must never overwrite an
    // empty directory in the gap between mkdir and publishing its owner.
    const candidate = `${file}.candidate-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(candidate);
    fs.writeFileSync(path.join(candidate, OWNER), own);
    try {
      if (fs.existsSync(file)) throw Object.assign(new Error('lock exists'), { code: 'EEXIST' });
      fs.renameSync(candidate, file);
    } catch (error) {
      fs.rmSync(candidate, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
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
    // A contender can pass the initial scan before another reclaimer displaces
    // a live owner. Withdraw before entering the gate if that happened.
    if (liveTombstone(file)) {
      if (lockState(file)?.raw === own) fs.rmSync(file, { recursive: true, force: true });
      continue;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Only the directory whose owner is still exactly this process's record is removed — never a successor's.
      const locations = [file, ...fs.readdirSync(path.dirname(file)).filter(name => name.startsWith(`${path.basename(file)}.tombstone-`)).map(name => path.join(path.dirname(file), name))];
      for (const location of locations) {
        try { if (lockState(location)?.raw === own) fs.rmSync(location, { recursive: true, force: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    };
  }
}
