import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_VERDICT, readVerdict, reportVerdict } from '../src/core/verdict.ts';
import { reportReadyText } from '../src/core/event-command.ts';
import { useScratch } from './helpers.ts';

const scratch = useScratch();

describe('report verdict for the notification', () => {
  it('a "Werdykt" / "Verdict" / "Status" line, without markdown', () => {
    assert.equal(reportVerdict('# AGENTCTL-6\n\n**Werdykt:** PASS – 12 testów\n\nReszta.'), 'Werdykt: PASS – 12 testów');
    assert.equal(reportVerdict('# R\nVerdict: `FAIL` (see _below_)'), 'Verdict: FAIL (see below)');
    assert.equal(reportVerdict('# R\n\n- **Status** – gotowe do scalenia\n'), 'Status: gotowe do scalenia');
    assert.equal(reportVerdict('# R\n\nintro\n\nSTATUS: done'), 'STATUS: done', 'case does not matter and it need not be the first line');
  });

  it('a heading on its own takes the line under it', () => {
    assert.equal(reportVerdict('# R\n\n## Werdykt\n\nPASS: all green\n\n## Details\nx'), 'Werdykt: PASS: all green');
    assert.equal(reportVerdict('# R\n\n### Verdict\n\n\n> NEEDS WORK\n'), 'Verdict: NEEDS WORK');
  });

  it('"Status raportu" or a sentence that starts with the word is not a label', () => {
    assert.equal(reportVerdict('# R\n\nStatus raportu jest poniżej.\nDalej.'), 'Status raportu jest poniżej.', 'falls to the first line of text');
  });

  it('without a label: the first line of text after the heading, skipping YAML front matter, rules and tables', () => {
    assert.equal(reportVerdict('# AGENTCTL-6 report\n\nImplemented the events and the click.\n\n## Tests\nall pass'), 'Implemented the events and the click.');
    assert.equal(reportVerdict('---\ntask: X\n---\n# T\n---\n| a | b |\n|---|---|\nFirst real line'), 'First real line');
    assert.equal(reportVerdict('# only a heading\n\n'), undefined);
    assert.equal(reportVerdict(''), undefined);
  });

  it('notify.verdict_pattern: the first line it matches (its first group, else the whole line), before the labels', () => {
    const text = '# R\n\nWerdykt: PASS\n\nResult => MERGE IT\nResult => later';
    assert.equal(reportVerdict(text, '^Result => (.*)$'), 'MERGE IT');
    assert.equal(reportVerdict(text, '^Result'), 'Result => MERGE IT');
    assert.equal(reportVerdict(text, 'no such line'), 'Werdykt: PASS', 'a pattern that matches nothing falls back');
  });

  it('at most 100 characters', () => {
    const v = reportVerdict(`# R\n\nWerdykt: ${'ok '.repeat(80)}`) as string;
    assert.ok(v.length <= MAX_VERDICT && v.length >= MAX_VERDICT - 3, String(v.length));
    assert.ok(v.endsWith('…'));
  });

  it('reads the report file; a missing or empty one has no verdict', () => {
    const f = path.join(scratch.sub('verdict'), 'R.md');
    fs.writeFileSync(f, '# R\n\nVerdict: GO\n');
    assert.equal(readVerdict(f), 'Verdict: GO');
    assert.equal(readVerdict(path.join(path.dirname(f), 'missing.md')), undefined);
  });

  it('the notification text', () => {
    assert.equal(reportReadyText('NC-1', 'Werdykt: PASS'), 'NC-1: raport gotowy – Werdykt: PASS');
    assert.equal(reportReadyText('NC-1', undefined), 'NC-1: raport gotowy');
  });
});
