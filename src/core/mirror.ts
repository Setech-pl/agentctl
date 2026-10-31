import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';

export interface MirrorResult {
  dir: string;
  /** Reports copied (new or changed) during this call. */
  copied: string[];
  statusJson: string;
}

function needsCopy(src: string, dest: string): boolean {
  try {
    const a = fs.statSync(src);
    const b = fs.statSync(dest);
    return a.size !== b.size || a.mtimeMs > b.mtimeMs;
  } catch {
    return true;
  }
}

/**
 * Optional mirror: with `mirror_dir` set, copy every report that exists to `<mirror_dir>/<task>/` and write
 * `<mirror_dir>/status.json`. Called by status and pull. Without `mirror_dir` it does nothing.
 */
export async function syncMirror(ctx: Context, rows: StatusRow[]): Promise<MirrorResult | undefined> {
  const dir = ctx.config.mirrorDir;
  if (!dir) return undefined;
  const { runner } = ctx;
  const copied: string[] = [];
  for (const row of rows) {
    if (row.report !== 'yes') continue;
    const dest = path.join(dir, row.task.toLowerCase(), path.basename(row.reportPath));
    if (!needsCopy(row.reportPath, dest)) continue;
    await runner.mkdir(path.dirname(dest));
    await runner.copyFile(row.reportPath, dest);
    copied.push(dest);
  }
  const statusJson = path.join(dir, 'status.json');
  const payload = { generated: new Date(runner.now()).toISOString(), session: ctx.config.session, tasks: rows };
  await runner.mkdir(dir);
  await runner.writeFile(statusJson, `${JSON.stringify(payload, null, 2)}\n`);
  for (const c of copied) ctx.info(`mirror: copied report to ${c}`);
  return { dir, copied, statusJson };
}
