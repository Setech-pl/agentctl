import type { ResolvedSpec } from './spec.ts';

/** Human-readable summary of what `new` is about to start (shown before the y/N question). */
export function summarizeSpecs(specs: ResolvedSpec[]): string[] {
  const lines: string[] = [];
  for (const spec of specs) {
    const primary = spec.repos[0];
    lines.push(`${spec.task}  ${spec.agent}/${spec.model}/${spec.effort}${spec.switchedBy ? ` (ordered ${spec.requested.agent} ${spec.requested.model}/${spec.requested.effort})` : ''}`);
    for (const repo of spec.repos) {
      lines.push(`  worktree: ${repo.worktree}${repo === primary ? '' : '  (extra repo)'}`);
      lines.push(`  branch:   ${repo.branch ?? '(none, detached HEAD)'}${repo.base ? `  from ${repo.base}` : ''}`);
    }
    lines.push(`  setup:    ${spec.setup.length ? spec.setup.join(' && ') : '-'}`);
    lines.push(`  links:    ${spec.links.length ? spec.links.map((l) => `${l.from} -> ${l.to}`).join(', ') : '-'}`);
    lines.push(`  prompt:   ${spec.prompt.length} characters`);
  }
  return lines;
}
