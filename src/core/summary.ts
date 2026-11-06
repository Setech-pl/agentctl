import path from 'node:path';
import { missingLinkTargets } from './links.ts';
import type { ResolvedSpec } from './spec.ts';

/** Human-readable summary of what `new` is about to start (shown before the y/N question). */
export function summarizeSpecs(specs: ResolvedSpec[], extra: string[] = []): string[] {
  const lines: string[] = [];
  for (const spec of specs) {
    const primary = spec.repos[0];
    lines.push(`${spec.task}  ${spec.agent}/${spec.model}/${spec.effort}${spec.switchedBy ? ` (ordered ${spec.requested.agent} ${spec.requested.model}/${spec.requested.effort})` : ''}`);
    for (const repo of spec.repos) {
      lines.push(`  worktree: ${repo.worktree}${repo === primary ? '' : '  (extra repo)'}`);
      lines.push(`  branch:   ${repo.branch ?? '(none, detached HEAD)'}${repo.base ? `  from ${repo.base}${repo.baseTask ? ` (${repo.baseTask})` : ''}` : ''}`);
    }
    if (spec.review) lines.push(`  review:   auto -> ${spec.task}-REV after the confirmed author report; another provider, else another configured model; rerun=${Boolean(spec.review.rerun)}`);
    const withSetup = spec.repos.filter((r) => (r.setup?.length ?? 0) > 0);
    lines.push(`  setup:    ${withSetup.length === 0 ? '-' : withSetup.length === 1 && spec.repos.length === 1 ? withSetup[0]!.setup!.join(' && ') : withSetup.map((r) => `${path.basename(r.path)} ${r.setup!.length}/${r.setup!.length} (${r.setup!.join(' && ')})`).join(', ')}`);
    lines.push(`  links:    ${spec.links.length ? spec.links.map((l) => `${spec.repos[0] ? path.join(spec.repos[0].worktree, l.from) : l.from} -> ${l.to}`).join(', ') : '-'}`);
    lines.push(...(spec.linkWarnings ?? []).map(w => `  WARNING: ${w}`));
    lines.push(...missingLinkTargets(spec.links, primary?.worktree).map(w => `  WARNING: ${w}`));
    lines.push(`  prompt:   ${spec.prompt.length} characters`);
  }
  return [...lines, ...extra];
}
