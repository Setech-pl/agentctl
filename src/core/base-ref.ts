import path from 'node:path';
import type { Context } from './context.ts';
import type { ResolvedSpec } from './spec.ts';
import { listTaskRecords, listArchivedRecords } from './taskstore.ts';
import { readOutputs } from './outputs.ts';
import { AgentctlError } from './util.ts';

/** Resolve at start, before creating any worktree. Queue specs retain @TASK until then. */
export async function resolveTaskBases(ctx: Context, spec: ResolvedSpec): Promise<ResolvedSpec> {
  const repos = [];
  for (const repo of spec.repos) {
    const raw = repo.base;
    if (!raw?.startsWith('@')) { repos.push(repo); continue; }
    const match = /^@([A-Z][A-Z0-9_-]*)(?::([^:]+))?$/.exec(raw);
    if (!match) throw new AgentctlError(`${spec.task}: invalid base ${raw}`);
    const records = [...listTaskRecords(ctx.config), ...listArchivedRecords(ctx.config)];
    const source = records.find(r => r.task === match[1]);
    if (!source) throw new AgentctlError(`${spec.task}: base ${raw}: no task ${match[1]}; start blocked`);
    const candidates = source.repos.filter(r => !match[2] || path.basename(r.path) === match[2]);
    if (candidates.length !== 1) throw new AgentctlError(`${spec.task}: base ${raw}: repository missing or ambiguous; use @TASK:repo-name; start blocked`);
    const selected = candidates[0]!;
    const data = await readOutputs(ctx, source);
    const refs = [...(data.outputs?.commits ?? []), ...(data.outputs?.integrate ?? [])].filter(r => r.repo === selected.path || r.repo === path.basename(selected.path));
    const shas = [...new Set(refs.map(r => r.sha))];
    if (shas.length > 1) throw new AgentctlError(`${spec.task}: base ${raw}: ambiguous output commits; start blocked`);
    const refErrors = data.outputs_errors.filter(e => /^(commits|integrate)\b|^repo |branch .* does not exist|commit .* does not exist/.test(e));
    if (refErrors.length) throw new AgentctlError(`${spec.task}: base ${raw}: invalid outputs: ${refErrors.join('; ')}; start blocked`);
    let ref = shas[0];
    if (!ref) {
      let branch = selected.branch;
      if (!branch) {
        const b = await ctx.runner.exec('git', ['-C', selected.worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true });
        if (b.code === 0) branch = b.stdout.trim();
      }
      if (!branch) throw new AgentctlError(`${spec.task}: base ${raw}: no outputs or author branch; start blocked`);
      ref = `refs/heads/${branch}`;
    }
    const result = await ctx.runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { readOnly: true });
    if (result.code !== 0 || !/^[a-f0-9]{40}$/i.test(result.stdout.trim())) throw new AgentctlError(`${spec.task}: base ${raw}: commit ${ref} does not exist in ${repo.path}; start blocked`);
    repos.push({ ...repo, base: result.stdout.trim(), baseTask: raw });
  }
  return { ...spec, repos };
}
