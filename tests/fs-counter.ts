import fs from 'node:fs';
import path from 'node:path';

/*
 * Test-only instrumentation: counts file operations under one fixture root by wrapping the shared `node:fs` default
 * export (all of src imports it). Nothing here ships; production code has no counters. fd-based reads (readReportText)
 * are attributed through the openSync map.
 */

export interface FsCounts {
  /** Logical TASK.md reads, including bounded fd header reads (one parse per open). */
  taskMdReads: number;
  /** readFileSync of a report body (a .md file under the fixture cache). */
  reportReads: number;
  /** statSync + lstatSync calls. */
  statCalls: number;
}

export interface FsCounter {
  snap(): FsCounts;
  reset(): void;
  restore(): void;
}

export function installFsCounter(root: string): FsCounter {
  const counts: FsCounts = { taskMdReads: 0, reportReads: 0, statCalls: 0 };
  const fds = new Map<number, string>();
  const countedFds = new Set<number>();
  const fsp = fs as unknown as Record<string, unknown>;
  const original = {
    readFileSync: fs.readFileSync,
    readSync: fs.readSync,
    openSync: fs.openSync,
    closeSync: fs.closeSync,
    statSync: fs.statSync,
    lstatSync: fs.lstatSync,
  };
  const own = (p: unknown): p is string => typeof p === 'string' && p.startsWith(root);
  const countRead = (p: string): void => {
    if (p.endsWith(`${path.sep}TASK.md`)) counts.taskMdReads++;
    else if (p.startsWith(`${root}${path.sep}cache${path.sep}`) && p.endsWith('.md')) counts.reportReads++;
  };
  fsp.readFileSync = function (file: unknown, ...rest: unknown[]) {
    if (typeof file === 'number') {
      const p = fds.get(file);
      if (p && !countedFds.has(file)) { countRead(p); countedFds.add(file); }
    } else if (own(file)) countRead(file);
    return (original.readFileSync as (...a: unknown[]) => unknown).call(fs, file, ...rest);
  };
  fsp.openSync = function (p: unknown, ...rest: unknown[]) {
    const fd = (original.openSync as (...a: unknown[]) => number).call(fs, p, ...rest);
    if (own(p)) fds.set(fd, p);
    return fd;
  };
  fsp.readSync = function (fd: number, ...rest: unknown[]) {
    const p = fds.get(fd);
    if (p?.endsWith(`${path.sep}TASK.md`) && !countedFds.has(fd)) { countRead(p); countedFds.add(fd); }
    return (original.readSync as (...a: unknown[]) => number).call(fs, fd, ...rest);
  };
  fsp.closeSync = function (fd: number) {
    fds.delete(fd); countedFds.delete(fd);
    return original.closeSync.call(fs, fd);
  };
  fsp.statSync = function (p: unknown, ...rest: unknown[]) {
    if (own(p)) counts.statCalls++;
    return (original.statSync as (...a: unknown[]) => unknown).call(fs, p, ...rest);
  };
  fsp.lstatSync = function (p: unknown, ...rest: unknown[]) {
    if (own(p)) counts.statCalls++;
    return (original.lstatSync as (...a: unknown[]) => unknown).call(fs, p, ...rest);
  };
  return {
    snap: () => ({ ...counts }),
    reset(): void {
      counts.taskMdReads = 0;
      counts.reportReads = 0;
      counts.statCalls = 0;
    },
    restore(): void {
      fsp.readFileSync = original.readFileSync;
      fsp.readSync = original.readSync;
      fsp.openSync = original.openSync;
      fsp.closeSync = original.closeSync;
      fsp.statSync = original.statSync;
      fsp.lstatSync = original.lstatSync;
    },
  };
}

/** "taskMdReads/reportReads/statCalls" for logs and reports. */
export function countsLine(c: FsCounts): string {
  return `TASK.md parses=${c.taskMdReads} report reads=${c.reportReads} fs.stat calls=${c.statCalls}`;
}
