import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { eventVerdict, readVerdict } from '../src/core/verdict.ts';
import { useScratch } from './helpers.ts';

const scratch = useScratch();
const viaFile = (text: string): string | undefined => { const file = path.join(scratch.sub('verdict'), `${Math.random().toString(36).slice(2)}.md`); fs.writeFileSync(file, text); return readVerdict(file); };
const both = (text: string): string | undefined => { const a = eventVerdict(text), b = viaFile(text); assert.equal(b, a, 'readVerdict and eventVerdict agree'); return a; };

describe('FIX4 D1: every header form of the verdict is read (as before FIX3), through eventVerdict and readVerdict', () => {
  const forms: [string, string, string][] = [
    ['colon', 'Werdykt: PASS\n\nBody.\n', 'Werdykt: PASS'],
    ['English colon, lower case', 'verdict: fail\n\nBody.\n', 'Werdykt: FAIL'],
    ['hyphen', 'Verdict - FAIL\n\nBody.\n', 'Werdykt: FAIL'],
    ['en dash', 'Werdykt – PASS\n\nBody.\n', 'Werdykt: PASS'],
    ['em dash', 'Werdykt — BLOCKED\n\nBody.\n', 'Werdykt: BLOCKED'],
    ['bold', '**Werdykt:** PARTIAL\n\nBody.\n', 'Werdykt: PARTIAL'],
    ['value on the next line', 'Werdykt:\nPASS\n\nBody.\n', 'Werdykt: PASS'],
    ['bare label', 'Werdykt\nPASS\n\nBody.\n', 'Werdykt: PASS'],
    ['# heading, value below', '# Werdykt\n\nPASS\n\nBody.\n', 'Werdykt: PASS'],
    ['# heading after a title', '# Review of X\n\n# Werdykt\nFAIL\n\nBody.\n', 'Werdykt: FAIL'],
    ['## heading, value below', '# Review\n\n## Werdykt\nPASS\n', 'Werdykt: PASS'],
    ['# heading with dash', '# Verdict - PARTIAL\n\nBody.\n', 'Werdykt: PARTIAL'],
    ['under a title', '# Przegląd\n\nStatus: PASS\n\nBody.\n', 'Werdykt: PASS'],
    ['after metadata lines', 'Autor: AUTHOR\nData: 2026-11-04\nWerdykt – FAIL\n\n## Details\n', 'Werdykt: FAIL'],
  ];
  for (const [name, text, expected] of forms) it(`${name}`, () => assert.equal(both(text), expected));

  it('a label that is not a verdict label is not one ("Status raportu")', () => assert.equal(both('Status raportu: gotowy\n\nBody.\n'), undefined));
  it('outputs.verdict still wins over a header form', () => assert.equal(both('Werdykt – FAIL\n\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n'), 'Werdykt: PASS'));

  describe('N6 stays: examples and prose are not the verdict', () => {
    it('YAML example in a fenced block under a section', () => assert.equal(both('# Review\n\nNo final verdict yet.\n\n## Example of rejected data\n\n```yaml\nverdict: FAIL\n```\n'), undefined));
    it('fenced block first', () => assert.equal(both('# Review\n\n```\nWerdykt: FAIL\n```\n'), undefined));
    it('tilde fence', () => assert.equal(both('~~~\nWerdykt – FAIL\n~~~\n'), undefined));
    it('quote', () => assert.equal(both('# Review\n\n> Werdykt - FAIL\n\ntext\n'), undefined));
    it('a verdict form after a section heading is body', () => assert.equal(both('# Review\n\nWerdykt: PASS jest zgodny z treścią.\n'.replace('Werdykt: PASS jest', 'Intro.\n\n## Details\n\nWerdykt – PASS jest')), undefined));
    it('a verdict after a line of prose is body', () => assert.equal(both(['# Review', ...Array.from({ length: 20 }, (_, i) => `Line ${i} of the review.`), 'verdict: PASS jest zgodny z treścią raportu.'].join('\n')), undefined));
  });
});
