import assert from 'node:assert/strict';
import { it } from 'node:test';
import { dependencyVerdict, reviewVerdict } from '../src/core/outputs.ts';
import { eventVerdict } from '../src/core/verdict.ts';
import { reportInstructions } from '../src/core/agents.ts';
it('H4: comments and attempt markers before verdict do not block dependencies or review', () => {
  const prefix = '\n<!-- agentctl:attempt legacy -->\n<!-- multiline\ncomment -->\n\n';
  for (const label of ['Verdict', 'Werdykt']) {
    assert.equal(dependencyVerdict(prefix + label + ': PASS\n'), 'PASS');
    assert.equal(reviewVerdict(prefix + label + ': NO-GO\n')?.first, 'NO-GO');
    assert.equal(eventVerdict(prefix + label + ': PASS\n'), 'Werdykt: PASS');
  }
  assert.equal(dependencyVerdict('Introduction\nVerdict: PASS'), undefined);
});
it('H4: report protocol puts the attempt marker after the first verdict line', () => {
  assert.match(reportInstructions('id'), /AFTER that first line/);
});
