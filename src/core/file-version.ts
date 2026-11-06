import type fs from 'node:fs';

/** A metadata fingerprint, or no reusable version on filesystems with coarse change times.
 * mtime alone can be restored by writers; inode detects replacement and ctime detects in-place changes.
 * A millisecond-aligned ctime is conservatively treated as coarse: read again rather than assume equal bytes.
 */
export function fileVersion(st: fs.BigIntStats): string | undefined {
  if (st.ctimeNs % 1_000_000n === 0n) return undefined;
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}
