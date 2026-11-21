import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
export function gcFixture(name: string, count: number, dirty: boolean, onGit = () => {}) {
  const root = scratch.sub(name);
  const config = makeConfig(root, 'mcp: {allow: [gc]}\n');
  const repo = scratch.sub(name + '/repo');
  const trees = Array.from({length: count}, (_, i) => {
    const worktree = scratch.sub(name + '/wt-' + i);
    seedTask(config, 'GC-' + i, {closed: true, repos: [{path: repo, worktree, base: 'main', branch: 'agent/gc-' + i}]});
    return worktree;
  });
  const gitCalls: string[][] = [];
  const runner = new DiskRunner({dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'git') return cmd === 'tmux' ? {code: 1} : undefined;
    gitCalls.push(args);
    onGit();
    if (args[2] === 'worktree' && args[3] === 'list') return {stdout: trees.map((wt, i) => `worktree ${wt}\nbranch refs/heads/agent/gc-${i}\n`).join('\n')};
    if (args[2] === 'status') return {stdout: dirty ? ' M one\n?? two\n' : ''};
    if (args[2] === 'rev-list') return {stdout: '0\n'};
    return {};
  }});
  const ctx = new Context(runner, config, () => {});
  return {config, runner, ctx, gitCalls};
}
