import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface StateWriteFailure { file: string; reason: string; at: string }
const failures = new Map<string, StateWriteFailure>();
const marker = (file: string) => `${file}.write-error.json`;
const reserve = (file: string) => path.join(path.dirname(file), '.state-write-reserve');

/** The destination is never opened for writing: a failed/crashed write leaves the old inode intact. */
function replace(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    let mode = 0o600;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* first write */ }
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* renamed or process died before cleanup */ }
  }
}

export function stateWriteFailure(file: string): StateWriteFailure | undefined {
  const key = path.resolve(file);
  try {
    const value = JSON.parse(fs.readFileSync(marker(file), 'utf8')) as StateWriteFailure;
    if (value.file === key && typeof value.reason === 'string') return value;
  } catch { /* memory remains available even if the disk cannot hold an error marker */ }
  const known = failures.get(key);
  if (known) return known;
  if (path.basename(file) === 'TASK.md') {
    try {
      const prefix = `.${path.basename(file)}.`;
      for (const name of fs.readdirSync(path.dirname(file)).filter(n => n.startsWith(prefix) && n.endsWith('.tmp'))) {
        const pid = Number(name.slice(prefix.length).split('.')[0]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try { process.kill(pid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue; }
        noteStateWriteFailure(file, new Error(`interrupted atomic write from dead PID ${pid}; old TASK.md preserved`));
        fs.unlinkSync(path.join(path.dirname(file), name));
        return failures.get(key);
      }
    } catch { /* unreadable directory: callers still see the last complete snapshot */ }
  }
  return undefined;
}

export function noteStateWriteFailure(file: string, error: unknown): void {
  const reason = `${(error as NodeJS.ErrnoException)?.code ?? 'write error'}: ${error instanceof Error ? error.message : String(error)}`;
  const task = path.join(path.dirname(file), 'TASK.md');
  const affected = [file, ...(path.resolve(file) !== path.resolve(task) && fs.existsSync(task) ? [task] : [])];
  for (const target of affected) {
    const failure = { file: path.resolve(target), reason, at: new Date().toISOString() };
    failures.set(failure.file, failure);
    // Release preallocated emergency space to persist attention without changing the old task snapshot.
    try { fs.unlinkSync(reserve(target)); } catch { /* no reserve yet */ }
    try { replace(marker(target), JSON.stringify(failure)); } catch { /* caller still receives the original error */ }
  }
}

export function atomicWriteFile(file: string, content: string | Buffer): void {
  try { replace(file, content); }
  catch (error) { noteStateWriteFailure(file, error); throw error; }
  failures.delete(path.resolve(file));
  try { if (JSON.parse(fs.readFileSync(marker(file), 'utf8')).file === path.resolve(file)) fs.unlinkSync(marker(file)); } catch { /* no failure */ }
  if (path.basename(file) === 'TASK.md' && !fs.existsSync(reserve(file))) {
    try { replace(reserve(file), Buffer.alloc(8192)); } catch { /* a successful state update is not undone by optional emergency space */ }
  }
}

/** For callers holding their journal/state lock. */
export function atomicAppendFile(file: string, content: string): void {
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  atomicWriteFile(file, old + content);
}
