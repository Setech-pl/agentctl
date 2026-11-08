import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { ResolvedRepo } from './spec.ts';
import { AgentctlError } from './util.ts';

type ReportOwner = { repos: Pick<ResolvedRepo, 'worktree'>[] };
const inside = (file: string, root: string) => file === root || file.startsWith(`${root}${path.sep}`);
function realFuture(file: string): string {
  let ancestor = file;
  const suffix: string[] = [];
  while (!fs.existsSync(ancestor)) { const parent = path.dirname(ancestor); if (parent === ancestor) break; suffix.unshift(path.basename(ancestor)); ancestor = parent; }
  return path.join(fs.realpathSync(ancestor), ...suffix);
}

/** Both lexical and resolved boundaries must hold; no symlink component, even within an allowed root. */
export function checkReportPath(config: Pick<GlobalConfig, 'cache'>, owner: ReportOwner, file: string, opts: { existing?: boolean; allowOutside?: boolean } = {}): string {
  const absolute = path.resolve(file), roots = [config.cache, ...owner.repos.map(r => r.worktree)].filter(Boolean).map(root => path.resolve(root));
  const allowed = roots.some(root => inside(absolute, root));
  if (!allowed && !opts.allowOutside) throw new AgentctlError(`Report path outside task worktrees and cache: ${file}`, 'Use a regular file inside a task worktree or config.cache. CLI --force can explicitly select an outside regular source; MCP cannot override this boundary.');
  let part = path.parse(absolute).root;
  for (const segment of absolute.slice(part.length).split(path.sep).filter(Boolean)) {
    part = path.join(part, segment);
    try { if (fs.lstatSync(part).isSymbolicLink()) throw new AgentctlError(`Report path contains a symlink: ${part}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const real = realFuture(absolute);
  if (!opts.allowOutside && !roots.some(root => inside(real, realFuture(root)))) throw new AgentctlError(`Report realpath escapes task worktrees and cache: ${file}`);
  if (opts.existing) {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentctlError(`Report source is not a regular file: ${file}`);
  }
  return absolute;
}

/** Validate before open and again around the read; the opened inode must still be the approved regular file. */
export function readReportText(config: Pick<GlobalConfig, 'cache'>, owner: ReportOwner, file: string, opts: { allowOutside?: boolean } = {}): string {
  const approved = checkReportPath(config, owner, file, { ...opts, existing: true });
  const fd = fs.openSync(approved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const verify = () => {
      checkReportPath(config, owner, file, { ...opts, existing: true });
      const current = fs.lstatSync(approved, { bigint: true });
      if (!opened.isFile() || current.ino !== opened.ino || current.dev !== opened.dev || current.size !== opened.size || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) throw new AgentctlError(`Report path changed while reading: ${file}`);
    };
    verify();
    const text = fs.readFileSync(fd, 'utf8');
    verify();
    return text;
  } finally { fs.closeSync(fd); }
}

export function reportPathWarnings(config: Pick<GlobalConfig, 'cache'>, spec: ReportOwner & { report: string; reportAlt?: string[] }): string[] {
  const warnings: string[] = [];
  for (const file of [spec.report, ...(spec.reportAlt ?? [])]) {
    const paths = path.isAbsolute(file) ? [file] : spec.repos.map(repo => path.resolve(repo.worktree, file));
    try { for (const target of paths) checkReportPath(config, spec, target); } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  }
  return warnings;
}
