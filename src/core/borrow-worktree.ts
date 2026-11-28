import type { Context } from './context.ts';
import type { ResolvedSpec } from './spec.ts';
import { findRecordAnywhere, listTaskRecords } from './taskstore.ts';
import { pendingStarts } from './start-lock.ts';
import { AgentctlError } from './util.ts';
import path from 'node:path';

export function resolveBorrowedWorktree(ctx: Context, spec: ResolvedSpec): ResolvedSpec {
  if (!spec.reuseWorktree) return spec;
  const source = findRecordAnywhere(ctx.config, spec.reuseWorktree);
  if (!source?.closed || source.host !== spec.host) throw new AgentctlError(`${spec.task}: close ${spec.reuseWorktree} on the selected host before reusing its worktree`);
  if (spec.perf || spec.readOnly || spec.reviewMode) throw new AgentctlError(`${spec.task}: reuse_worktree requires a regular writable task`);
  const starts = pendingStarts(ctx.config);
  const borrower = listTaskRecords(ctx.config).find(record => !record.closed && !record.cancelled && record.task !== spec.task && record.reuseWorktree === source.task);
  if (borrower || starts.some(start => start.task === source.task || start.task !== spec.task && start.reuseWorktree === source.task)) {
    throw new AgentctlError(`host ${spec.host ?? 'local'} limit reached: worktree ${source.task} is in use`);
  }
  const repos = spec.repos.map(repo => {
    const match = source.repos.find(r => (r.name ?? path.basename(r.path)) === (repo.name ?? path.basename(repo.path)));
    if (!match || repo.branch && repo.branch !== match.branch || repo.base) throw new AgentctlError(`${spec.task}: reuse_worktree needs the source's repository and branch without a new base`);
    return { ...match, setup: [], setupExplicit: true, nodeModules: undefined };
  });
  return { ...spec, repos, setup: [] };
}
