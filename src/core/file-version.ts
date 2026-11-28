import type fs from 'node:fs';

/**
 * Within this window after a change the metadata of a file does not identify its content. On Linux the file clock is coarse (one
 * scheduler tick, 1–10 ms), and an atomic replace (write a temporary file, rename it over the old one) can get the freed inode
 * number back, so two different contents of the same size can share dev, inode, size, mtime and ctime (REL0272-RACY-VERSION).
 * As in git's "racily clean" rule, a version is only reusable once the file is older than the window, so any later write must
 * produce a newer ctime.
 */
export const RACY_WINDOW_NS = 100_000_000n;

/** A metadata fingerprint, or no reusable version on filesystems with coarse change times or for a racily recent change.
 * mtime alone can be restored by writers; inode detects replacement and ctime detects in-place changes.
 * A millisecond-aligned ctime is conservatively treated as coarse: read again rather than assume equal bytes.
 */
export function fileVersion(st: fs.BigIntStats, nowNs: bigint = BigInt(Date.now()) * 1_000_000n): string | undefined {
  if (st.ctimeNs % 1_000_000n === 0n) return undefined;
  if (st.ctimeNs > nowNs - RACY_WINDOW_NS) return undefined;
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}
