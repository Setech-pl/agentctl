import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { BUGS, NOT_BUGS } from './catalog.ts';
import { PREVIOUS_RELEASE, groupScenarios, parseSummary, renderCatalog } from '../../scripts/regression.ts';
import type { Proof } from '../../scripts/regression.ts';

const root = path.resolve(import.meta.dirname, '../..');
const titlesOf = (file: string): string[] => [...fs.readFileSync(path.join(root, 'tests', file), 'utf8').matchAll(/\b(?:it|test|describe)(?:\.\w+)?\(\s*[`'"](.*?)[`'"]\s*,/gm)].map(m => m[1]!);
const proofFile = path.join(root, 'tests/regression/prefix-proof.json');
const proof: Proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : {};

it('every catalog entry is unique, complete and names a scenario that exists', () => {
  const ids = BUGS.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate bug id');
  for (const bug of BUGS) {
    assert.ok(bug.symptom.length > 20 && !bug.symptom.includes('\n'), `${bug.id}: one-line symptom`);
    assert.ok(bug.scenarios.length > 0, `${bug.id}: no scenario`);
    assert.ok(PREVIOUS_RELEASE[bug.fixedIn], `${bug.id}: unknown fixedIn ${bug.fixedIn}`);
    for (const sc of bug.scenarios) {
      assert.ok(fs.existsSync(path.join(root, 'tests', sc.file)), `${bug.id}: ${sc.file} is missing`);
      if (sc.name) assert.ok(titlesOf(sc.file).some(t => new RegExp(sc.name!).test(t)), `${bug.id}: no test title of ${sc.file} matches /${sc.name}/`);
    }
  }
});

it('scenario files written for this suite are all referenced by the catalog', () => {
  const referenced = new Set(BUGS.flatMap(b => b.scenarios.map(sc => sc.file)));
  for (const file of fs.readdirSync(path.join(root, 'tests/regression')).filter(f => f.endsWith('.test.ts') && f !== 'catalog.test.ts')) assert.ok(referenced.has(`regression/${file}`), `${file} is not in the catalog`);
});

it('every P-number and named identifier in the 0.18.x/0.19.x CHANGELOG is a catalogued bug or an explained non-bug', () => {
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const released = log.slice(log.indexOf('## [0.19.4]'), log.indexOf('## [0.17.4]'));
  const known = new Set([...BUGS.map(b => b.id.split('-')[0]!), ...BUGS.flatMap(b => b.id.match(/^(P\d+)/) ?? []), ...Object.keys(NOT_BUGS)]);
  const mentioned = new Set(released.match(/\bP\d{1,3}\b/g) ?? []);
  const missing = [...mentioned].filter(id => !known.has(id)).sort();
  assert.deepEqual(missing, [], `identifiers without a regression scenario or a NOT_BUGS reason: ${missing.join(', ')}`);
  for (const id of ['L1', 'X1', 'X2', 'X3', 'X4']) assert.ok(BUGS.some(b => b.id === id), `${id} missing`);
  for (const id of Object.keys(NOT_BUGS)) assert.ok(!BUGS.some(b => b.id === id), `${id} is both a bug and a non-bug`);
});

it('no scenario passes on the release before its fix; the rest are measured or explained in CATALOG.md', () => {
  for (const bug of BUGS) {
    const record = proof[bug.id];
    if (record) assert.notEqual(record.outcome, 'PASSES', `${bug.id} passes on ${record.rev}: it does not reproduce the bug`);
    if (record) assert.equal(record.rev, PREVIOUS_RELEASE[bug.fixedIn], `${bug.id}: proof was taken on ${record.rev}`);
  }
});

it('CATALOG.md is the rendering of the catalog and the proof file (npm run regression -- --catalog)', () => {
  assert.equal(fs.readFileSync(path.join(root, 'tests/regression/CATALOG.md'), 'utf8'), renderCatalog(proof));
});

it('AGENTS.md and CONTRIBUTING-level rules require a scenario and a catalog line for every bug fix', () => {
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agents, /tests\/regression\/CATALOG\.md/);
  assert.match(agents, /every bug fix/i);
});

it('scenario runs are grouped per file and a scenario without a name selects the whole file', () => {
  const runs = groupScenarios([
    { id: 'A', symptom: '', fixedIn: '0.19.4', scenarios: [{ file: 'x.test.ts', name: 'one' }] },
    { id: 'B', symptom: '', fixedIn: '0.19.4', scenarios: [{ file: 'x.test.ts', name: 'two' }, { file: 'y.test.ts' }] },
    { id: 'C', symptom: '', fixedIn: '0.19.4', scenarios: [{ file: 'y.test.ts', name: 'three' }] },
  ]);
  assert.deepEqual(runs, [{ file: 'x.test.ts', name: '(?:one)|(?:two)' }, { file: 'y.test.ts' }]);
  assert.deepEqual(parseSummary('ℹ tests 5\nℹ pass 4\nℹ fail 1\nℹ skipped 2\n'), { pass: 4, fail: 1, skipped: 2 });
});
