import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { makeConfig, makeContext, seedTask, useScratch, FakeTmux } from './helpers.ts';
import { eventVerdict, readVerdict } from '../src/core/verdict.ts';
import { OUTPUT_PROTOCOL, journalOutputs, parseOutputs } from '../src/core/outputs.ts';
import { promptWithHeader, reportInstructions } from '../src/core/agents.ts';
import { collectStatus } from '../src/core/status.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';

/*
 * P70 (POP-E1-REVIEW, Neon City 2026-11-08): the review's report started "Werdykt: NO-GO — …" but the agent wrote
 * verdict: PASS in the outputs block meaning "task done"; events, status, get_report and pull_ready said PASS and the
 * chat nearly merged a blocked change. For a task with review_of the first report line carries the verdict
 * (GO / GO-WITH-CHANGES / NO-GO; PASS / PASS with findings / FAIL accepted); a disagreement with outputs.verdict is a
 * needs-attention event and both values are shown.
 */
const scratch = useScratch();

const POP_E1_REPORT = `Werdykt: NO-GO — the change must not be merged

## Findings
The migration drops the sessions table.

\`\`\`agentctl-outputs
version: 1
verdict: PASS
decisions: []
actions: []
\`\`\`
<!-- agentctl:report-end -->
`;

function fixture(name: string) {
  const config = makeConfig(scratch.sub(name));
  const tmux = new FakeTmux();
  const { ctx, runner } = makeContext(config, { dryRun: false, respond: tmux.respond });
  const deps = { context: () => ctx, notify: async () => {} };
  const call = (toolName: string, args: Record<string, unknown> = {}) => {
    const tool = MCP_TOOLS.find((t) => t.name === toolName)!;
    return tool.run(deps, z.object(tool.input).parse(args));
  };
  const review = seedTask(config, 'POP-E1-REVIEW', { reviewOf: 'POP-E1' });
  fs.mkdirSync(path.dirname(review.report), { recursive: true });
  fs.writeFileSync(review.report, POP_E1_REPORT);
  return { config, ctx, call, review };
}

describe('P70: the verdict of a review report is its first line', () => {
  it('the POP-E1 shape: first line NO-GO, outputs PASS — the first line wins and both are shown', () => {
    const shown = eventVerdict(POP_E1_REPORT, undefined, true);
    assert.match(shown ?? '', /NO-GO/);
    assert.match(shown ?? '', /outputs: PASS/, 'the disagreement shows both values');
    assert.equal(eventVerdict(POP_E1_REPORT), 'Werdykt: PASS', 'without the review flag the declared outputs verdict still wins');
  });

  it('every accepted first-line form is recognised (labelled or bare, any case)', () => {
    for (const [line, token] of [
      ['Werdykt: GO', 'GO'],
      ['Werdykt: GO-WITH-CHANGES', 'GO-WITH-CHANGES'],
      ['Werdykt: NO-GO — reason', 'NO-GO'],
      ['Verdict: GO', 'GO'],
      ['NO-GO', 'NO-GO'],
      ['Werdykt: PASS', 'PASS'],
      ['Werdykt: PASS with findings', 'PASS with findings'],
      ['Werdykt: FAIL', 'FAIL'],
      ['# Werdykt: GO', 'GO'],
    ] as const) {
      const shown = eventVerdict(`${line}\n\nBody.\n`, undefined, true);
      assert.ok(shown?.includes(tokenOf(line)), `${line} -> ${shown}`);
    }
    function tokenOf(line: string): string {
      return /NO-GO/.test(line) ? 'NO-GO' : /GO-WITH-CHANGES/.test(line) ? 'GO-WITH-CHANGES' : /PASS with findings/.test(line) ? 'PASS with findings' : /PASS/.test(line) ? 'PASS' : /FAIL/.test(line) ? 'FAIL' : 'GO';
    }
  });

  it('a consistent review (GO + outputs PASS) shows the first line and flags nothing', () => {
    const text = 'Werdykt: GO\n\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n<!-- agentctl:report-end -->\n';
    const shown = eventVerdict(text, undefined, true);
    assert.equal(shown, 'Werdykt: GO');
    assert.doesNotMatch(shown ?? '', /outputs:/);
  });

  it('a first line without a review verdict falls back to the ordinary verdict rules', () => {
    const text = '# Review\n\nSome prose.\n\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n';
    assert.equal(eventVerdict(text, undefined, true), 'Werdykt: PASS');
  });

  it('status, get_report and pull_ready of the POP-E1 shape take the first line', async () => {
    const f = fixture('p70-surfaces');
    const row = (await collectStatus(f.ctx))[0]!;
    assert.equal(row.verdict, 'FAIL', 'NO-GO counts as FAIL; the declared PASS does not stand');
    const report = await f.call('get_report', { task: 'POP-E1-REVIEW' });
    assert.match(report.text, /verdict: NO-GO/);
    assert.match(report.text, /outputs: PASS/);
    const pulled = await f.call('pull_ready');
    assert.match(pulled.text, /verdict: NO-GO/);
    assert.match(pulled.text, /outputs: PASS/);
  });

  it('a consistent review keeps its mapped verdict in status (GO = PASS, GO-WITH-CHANGES = PARTIAL)', async () => {
    const f = fixture('p70-consistent');
    fs.writeFileSync(f.review.report, 'Werdykt: GO-WITH-CHANGES\n\n```agentctl-outputs\nversion: 1\nverdict: PARTIAL\n```\n<!-- agentctl:report-end -->\n');
    assert.equal((await collectStatus(f.ctx))[0]!.verdict, 'PARTIAL');
  });

  it('the inconsistent review emits one needs-attention event per attempt', async () => {
    const f = fixture('p70-event');
    await journalOutputs(f.ctx, f.review);
    await journalOutputs(f.ctx, f.review);
    const events = readJournal(f.config).filter((e) => e.kind === 'needs-attention');
    assert.equal(events.length, 1);
    assert.match(events[0]!.text, /inconsistent verdict: first line NO-GO, outputs PASS/);
  });

  it('readVerdict of a review report file reads the first line', () => {
    const f = fixture('p70-readverdict');
    assert.match(readVerdict(f.review.report, undefined, true) ?? '', /NO-GO/);
    assert.equal(readVerdict(f.review.report), 'Werdykt: PASS', 'legacy callers keep the old rule');
  });

  it('the report protocol of a review task says verdict: GO|GO-WITH-CHANGES|NO-GO', () => {
    const review = reportInstructions('attempt-1', undefined, true);
    assert.match(review, /verdict: GO\|GO-WITH-CHANGES\|NO-GO/);
    assert.doesNotMatch(reportInstructions('attempt-1'), /GO-WITH-CHANGES/, 'ordinary tasks keep PASS|PARTIAL|FAIL|BLOCKED');
    assert.match(OUTPUT_PROTOCOL, /verdict: PASS\|PARTIAL\|FAIL\|BLOCKED/);
    const prompt = promptWithHeader({ model: 'opus', effort: 'high', prompt: 'Review.', reviewOf: 'POP-E1' }, 'attempt-1');
    assert.match(prompt, /verdict: GO\|GO-WITH-CHANGES\|NO-GO/);
  });

  it('the outputs block of a review accepts the review verdicts and maps them', () => {
    const block = (v: string) => `\`\`\`agentctl-outputs\nversion: 1\nverdict: ${v}\n\`\`\``;
    assert.equal(parseOutputs(block('GO'), { review: true }).outputs?.verdict, 'PASS');
    assert.equal(parseOutputs(block('GO-WITH-CHANGES'), { review: true }).outputs?.verdict, 'PARTIAL');
    assert.equal(parseOutputs(block('NO-GO'), { review: true }).outputs?.verdict, 'FAIL');
    assert.equal(parseOutputs(block('GO')).outputs, null, 'a non-review report keeps the strict verdict enum');
  });
});
