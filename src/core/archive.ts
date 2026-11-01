import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { archiveDir, listTaskRecords, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError } from './util.ts';

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 } as const;

/** "7d", "12h", "2w", "30m" in milliseconds. */
export function parseAge(text: string): number {
  const m = /^(\d+)([mhdw])$/.exec(text.trim());
  if (!m || Number(m[1]) === 0) throw new AgentctlError(`cannot read the age "${text}"`, 'Use a number and a unit: 30m, 12h, 7d, 2w.');
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

export interface ArchiveItem {
  task: string;
  from: string;
  to: string;
}

export interface ArchiveResult {
  moved: ArchiveItem[];
  /** Closed tasks that stay: too recent for --older-than, or the archive already has a folder of that name. */
  kept: { task: string; reason: string }[];
}

/**
 * `agentctl archive [--older-than 7d]`: move the state folder of closed tasks (`<state_dir>/<task>/`) to the archive
 * (`<state_dir>/../archive/<task>/`). Only tasks that `agentctl close` marked closed and that have no window; the report in the cache
 * and the worktree are not touched. `status --all` and the board (key a) still list archived tasks as closed.
 */
export async function archiveClosed(ctx: Context, opts: { olderThanMs?: number | undefined } = {}): Promise<ArchiveResult> {
  const { config, runner } = ctx;
  const live = new Set(await ctx.tmux.listWindows());
  const dest = archiveDir(config);
  const result: ArchiveResult = { moved: [], kept: [] };
  for (const record of listTaskRecords(config)) {
    if (!record.closed || live.has(record.window)) continue;
    if (opts.olderThanMs !== undefined) {
      let closedMs = record.closedAt ? Date.parse(record.closedAt) : Number.NaN;
      if (Number.isNaN(closedMs)) {
        try {
          closedMs = fs.statSync(taskFile(config, record.window)).mtimeMs;
        } catch {
          closedMs = runner.now();
        }
      }
      if (runner.now() - closedMs < opts.olderThanMs) {
        result.kept.push({ task: record.task, reason: 'closed less than the given age ago' });
        continue;
      }
    }
    const to = path.join(dest, record.window);
    if (fs.existsSync(to)) {
      result.kept.push({ task: record.task, reason: `${to} already exists` });
      continue;
    }
    await runner.rename(taskDir(config, record.window), to);
    result.moved.push({ task: record.task, from: taskDir(config, record.window), to });
  }
  return result;
}
