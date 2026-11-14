import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { ResolvedSpec } from './spec.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, shellQuote } from './util.ts';

const evidence = (ctx: Context, window: string) => path.join(ctx.config.stateDir, window, 'read-only.json');

/** A task-scoped Git hook, inherited by agent subprocesses, never a shared repository setting. */
export async function protectReadOnly(ctx: Context, spec: ResolvedSpec): Promise<void> {
  const hooks = path.join(spec.repos[0]!.worktree, '.agentctl-consult-hooks');
  const refused = path.join(ctx.config.stateDir, spec.window, 'commit-refused');
  const heads: Array<{ worktree: string; head: string }> = [];
  for (const repo of spec.repos) {
    const r = await ctx.runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--verify', 'HEAD'], { readOnly: true });
    if (!ctx.runner.dryRun && (r.code !== 0 || !/^[a-f0-9]{40}$/i.test(r.stdout.trim()))) throw new AgentctlError(`Cannot protect read-only worktree ${repo.worktree}`);
    heads.push({ worktree: repo.worktree, head: r.stdout.trim() });
  }
  await ctx.runner.writeFile(path.join(hooks, 'pre-commit'), `#!/bin/sh\nprintf '%s\\n' 'CONSULT commit refused' >> ${shellQuote(refused)}\necho 'CONSULT: read-only worktree; commits are forbidden' >&2\nexit 1\n`);
  const chmod = await ctx.runner.exec('chmod', ['0700', path.join(hooks, 'pre-commit')]);
  if (!ctx.runner.dryRun && chmod.code !== 0) throw new AgentctlError('Cannot install CONSULT pre-commit hook');
  await ctx.runner.writeFile(evidence(ctx, spec.window), JSON.stringify(heads));
  spec.env = { ...spec.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks };
}

/** Missing protection evidence fails closed; a bypassed/refused commit is an owner-visible finding. */
export async function readOnlyFindings(ctx: Context, record: TaskRecord): Promise<string[]> {
  let heads: Array<{ worktree: string; head: string }>;
  try { heads = JSON.parse(fs.readFileSync(evidence(ctx, record.window), 'utf8')); }
  catch { throw new AgentctlError(`${record.task}: missing read-only baseline`); }
  if (!Array.isArray(heads) || heads.length !== record.repos.length || !heads.length) throw new AgentctlError(`${record.task}: invalid read-only baseline`);
  const findings: string[] = [];
  for (const repo of heads) {
    const r = await ctx.runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--verify', 'HEAD'], { readOnly: true });
    if (r.code !== 0 || r.stdout.trim() !== repo.head) findings.push(`${record.task}: HEAD changed or unreadable in ${repo.worktree}`);
    const diff = await ctx.runner.exec('git', ['-C', repo.worktree, 'diff', 'HEAD', '--exit-code', '--quiet'], { readOnly: true });
    if (diff.code !== 0) findings.push(`${record.task}: tracked files changed or unreadable in ${repo.worktree}`);
  }
  if (fs.existsSync(path.join(ctx.config.stateDir, record.window, 'commit-refused'))) findings.push(`${record.task}: commit attempt refused by pre-commit hook`);
  return findings;
}
