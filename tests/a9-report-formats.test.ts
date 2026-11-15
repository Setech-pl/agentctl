import assert from 'node:assert/strict';
import { it } from 'node:test';
import { dependencyVerdict, parseOutputs, reviewVerdict } from '../src/core/outputs.ts';
const report = (body: string) => `Verdict: PASS\n\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\n${body}\n\`\`\`\n<!-- agentctl:report-end -->`;
it('A9: Verdict first line gates dependencies and compact/flow output references preserve SHA text', () => {
  for (const label of ['Verdict', 'Werdykt']) {
    assert.equal(dependencyVerdict(`${label}: PASS\nDone.`), 'PASS');
    assert.equal(reviewVerdict(`${label}: PASS\nDone.`)?.first, 'PASS');
  }
  for (const body of ['commits:\n  - repo: x, branch: y, sha: 2742e697', 'commits: [{repo: x, branch: y, sha: 2742e697}]']) {
    const parsed = parseOutputs(report(body));
    assert.equal(parsed.outputs_valid, true, parsed.outputs_errors.join('; '));
    assert.deepEqual(parsed.outputs?.commits, [{repo: 'x', branch: 'y', sha: '2742e697'}]);
  }
});
it('A9: placeholder references are findings and never published while valid entries survive', () => {
  const parsed = parseOutputs(report('integrate: [{repo: x, branch: "[BRANCH-BACKEND]", sha: abcdef12}, {repo: x, branch: y, sha: "[SHA-BACKEND]"}, {repo: x, branch: good, sha: abcdef12}]'));
  assert.equal(parsed.outputs_partial, true);
  assert.match(parsed.outputs_errors.join('; '), /placeholder/);
  assert.deepEqual(parsed.outputs?.integrate, [{repo: 'x', branch: 'good', sha: 'abcdef12'}]);
});
