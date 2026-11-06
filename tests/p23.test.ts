import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { readOutputs, resolveOutputRepo } from '../src/core/outputs.ts';
import { makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('P23 worktree names and paths normalize commits/integrate to the repository name', async () => {
  const root = scratch.sub('outputs'), config = makeConfig(root);
  const { ctx } = makeContext(config, { respond: () => ({ code: 0 }) });
  const repo = { path: path.join(root, 'app'), worktree: path.join(root, 'app-task'), branch: 'task' };
  const r = seedTask(config, 'P23', { repos: [repo] });
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  for (const spelling of ['app-task', repo.worktree]) {
    fs.writeFileSync(r.report, `\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ncommits: [{repo: ${spelling}, branch: task, sha: abcdef0}]\nintegrate: [{repo: ${spelling}, branch: task, sha: abcdef0}]\n\`\`\`\n<!-- agentctl:report-end -->\n`);
    const data = await readOutputs(ctx, r);
    assert.equal(data.outputs_valid, true, data.outputs_errors.join('; '));
    assert.equal(data.outputs?.commits[0]?.repo, 'app');
    assert.equal(data.outputs?.integrate[0]?.repo, 'app');
  }
  assert.equal(resolveOutputRepo({ repos: [repo, { path: '/other', worktree: '/other/app-task' }] }, 'app-task').problem, 'ambiguous');
});
