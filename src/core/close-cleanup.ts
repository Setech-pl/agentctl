import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { loadProjectConfig } from './config.ts';
import { sizeOf } from './fs-measure.ts';
import { recordJournal } from './journal.ts';
import { listArchivedRecords, listTaskRecords, type TaskRecord } from './taskstore.ts';
import { moveToTrash } from './trash.ts';
import { insidePath, missingWorktreeVolume } from './worktree-volume.ts';
import { errorMessage } from './util.ts';

/** Walk only literal directory components and globs at their own depth; never follow symlinks. */
function candidates(root: string, patterns: string[], device: number): string[] {
  const found = new Set<string>();
  for (const pattern of patterns) {
    let bases = [root];
    const parts = pattern.split('/');
    for (const [index, part] of parts.entries()) {
      bases = bases.flatMap(base => {
        const glob = /[*?\[{}]/.test(part);
        const names = fs.readdirSync(base).filter(name => glob ? path.matchesGlob(name, part) : name === part);
        return names.flatMap(name => {
          const target = path.join(base, name);
          const st = fs.lstatSync(target, { throwIfNoEntry: false });
          return name.toLowerCase() !== '.git' && st && !st.isSymbolicLink() && st.dev === device && (index === parts.length - 1 || st.isDirectory()) ? [target] : [];
        });
      });
    }
    for (const target of bases) found.add(target);
  }
  return [...found].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export async function cleanupClosedWorktrees(ctx: Context, record: TaskRecord): Promise<void> {
  const { config, runner } = ctx;
  if (runner.dryRun || record.reviewMode) return;
  if (record.host) {
    if (record.repos.some(repo => repo.remoteCloseCleanup ?? Boolean(config.closeCleanup?.length))) {
      const text = `${record.task}: close.cleanup unsupported on SSH host ${record.host}`;
      ctx.info(text);
      await recordJournal(ctx, { kind: 'close-cleanup', task: record.task, text, cleanup: { moved: [], bytes: 0, unsupported: record.host } });
    }
    return;
  }
  const moved: { path: string; bytes: number }[] = [];
  let enabled = false;
  for (const repo of record.repos) {
    try {
      const patterns = loadProjectConfig(repo.path)?.closeCleanup ?? config.closeCleanup;
      if (!patterns?.length) continue;
      enabled = true;
      if (record.pin || record.keepCache || missingWorktreeVolume([repo])) continue;
      const root = path.resolve(repo.worktree);
      const shared = () => [...listTaskRecords(config), ...listArchivedRecords(config)].some(other => other.window !== record.window && !other.host && (other.pin || (!other.closed && !other.cancelled)) && other.repos.some(r => {
        try { return fs.realpathSync(r.worktree) === root; } catch { return path.resolve(r.worktree) === root; }
      }));
      const safeRoot = () => fs.realpathSync(root) === root && fs.realpathSync(repo.path) !== root && !missingWorktreeVolume([repo]);
      if (!safeRoot() || shared() || !fs.lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile()) continue;
      const top = await runner.exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], { readOnly: true });
      if (top.code !== 0 || path.resolve(top.stdout.trim()) !== root) continue;
      const device = fs.lstatSync(root).dev;
      const reports = [record.report, ...(record.reportAlt ?? [])].map(report => path.resolve(root, report));
      for (const target of candidates(root, patterns, device)) {
        if (moved.some(item => insidePath(item.path, target)) || reports.some(report => insidePath(target, report))) continue;
        const original = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!original || original.isSymbolicLink() || original.dev !== device || fs.realpathSync(target) !== target) continue;
        const bytes = await sizeOf(target, { fresh: true });
        const git = ['--no-optional-locks', '-C', root, '--literal-pathspecs'];
        const relative = path.relative(root, target);
        const tracked = await runner.exec('git', [...git, 'ls-files', '--cached', '-z', '--', relative], { readOnly: true });
        if (tracked.code !== 0 || tracked.stdout) continue;
        const status = await runner.exec('git', [...git, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', relative], { readOnly: true });
        if (status.code !== 0 || status.stdout || !safeRoot() || shared()) continue;
        const current = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!current || current.dev !== device || current.ino !== original.ino || current.isSymbolicLink() || fs.realpathSync(target) !== target) continue;
        await moveToTrash(runner, target);
        moved.push({ path: target, bytes });
      }
    } catch (error) { ctx.info(`${record.task}: close.cleanup skipped in ${repo.worktree}: ${errorMessage(error)}`); }
  }
  if (!enabled) return;
  const bytes = moved.reduce((total, item) => total + item.bytes, 0);
  const text = `${record.task}: close.cleanup: ${moved.length} moved to Trash (${bytes} bytes)`;
  ctx.info(text);
  await recordJournal(ctx, { kind: 'close-cleanup', task: record.task, text, cleanup: { moved, bytes } });
}
