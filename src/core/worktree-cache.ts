import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { TaskRecord } from './taskstore.ts';
import { inspectReport } from './report-state.ts';
import { withFileLock } from './file-lock.ts';

const ledgerPath = (ctx: Context, record: TaskRecord) => path.join(ctx.config.stateDir, record.window, 'cache-clean.json');
interface Ledger { bytes: number; cleaned: string[] }
function ledger(ctx: Context, record: TaskRecord): Ledger {
  try { return JSON.parse(fs.readFileSync(ledgerPath(ctx, record), 'utf8')); } catch { return { bytes: 0, cleaned: [] }; }
}
export function worktreeCacheFreed(ctx: Context, record: TaskRecord): number { return ledger(ctx, record).bytes; }
const inside = (child: string, root: string) => child === root || child.startsWith(`${root}${path.sep}`);

/** Validate the entire tree before deleting anything. Symlinks are measured/unlinked, never traversed. */
function safeSize(target: string, root: string): number {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    // Reject dangling links too: their destination cannot establish containment.
    if (!inside(fs.realpathSync(target), root)) throw new Error(`symlink escapes worktree: ${target}`);
    return stat.size;
  }
  if (!inside(fs.realpathSync(target), root)) throw new Error(`path escapes worktree: ${target}`);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((sum, name) => sum + safeSize(path.join(target, name), root), 0);
}

/** Provider-independent cleanup; legacy settled reports without an explicit report-end never authorize deletion. */
export async function cleanWorktreeCache(ctx: Context, record: TaskRecord): Promise<void> {
  if (ctx.runner.dryRun || !ctx.config.cleanWorktreeCache) return;
  const report = inspectReport(ctx.config, record, ctx.runner.now(), false);
  if (!report.ready || !report.sentinel || !report.signature || (ctx.config.reportSettleS > 0 && report.mtime !== undefined && ctx.runner.now() - report.mtime < ctx.config.reportSettleS * 1000)) return;
  const file = ledgerPath(ctx, record);
  await withFileLock(`${file}.lock`, async () => {
    const saved = ledger(ctx, record);
    for (const repo of record.repos) {
      const root = path.resolve(repo.worktree), target = path.join(root, '.cache');
      const identity = `${record.attemptId ?? record.started}:${root}`;
      if (saved.cleaned.includes(identity)) continue;
      try {
        // An aliased ancestor must not turn a recorded task path into another checkout.
        if (fs.realpathSync(root) !== root || fs.realpathSync(repo.path) === root) continue;
        if (inside(path.resolve(record.report), target)) throw new Error('report is inside .cache');
        if (!fs.existsSync(target) && !fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        const bytes = safeSize(target, root);
        // Recheck the root after the walk, immediately before the runner's deletion boundary.
        if (fs.realpathSync(root) !== root) throw new Error('worktree path changed during cleanup');
        await ctx.runner.remove(target);
        saved.bytes += bytes;
        saved.cleaned.push(identity);
        await ctx.runner.writeFile(file, JSON.stringify(saved));
        ctx.info(`${record.task}: .cache cleanup: ${bytes} bytes freed (${target})`);
      } catch (error) {
        ctx.info(`${record.task}: .cache cleanup skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}
