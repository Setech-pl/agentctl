import assert from 'node:assert/strict';
import { it } from 'node:test';
import { modelLabel, providerLabel, EFFORT_LABELS } from '../src/core/model-label.ts';
import { boardLayout, boardColumns } from '../src/core/board.ts';
import { makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
for (const [model, effort, expected] of [
  ['gpt-6.1-sol', 'xhigh', 'S 6.1 XH'], ['gpt-6-luna', 'medium', 'L 6 MD'], ['gpt-6-astra', 'minimal', 'A 6 MN'],
  ['claude-sonnet-5-5', 'medium', 'S 5.5 MD'], ['sonnet', 'medium', 'S MD'], ['opus', 'high', 'O HI'], ['haiku', 'low', 'H LO'],
  ['fable', 'max', 'F MX'], ['vendor-custom', 'none', 'C NO'], ['vendor-custom3', '', 'C 3 –'],
  ['claude-opus-5-5-20261103', 'high', 'O 5.5 HI'], ['gpt-6.1-sol-2026-11-03', 'xhigh', 'S 6.1 XH'],
  ['default', 'high', '– HI'], ['', '', '– –'], ['UNKNOWN', 'new-effort', '– –'], [' GPT-6.1-SOL ', 'XHIGH', 'S 6.1 XH'],
]) it(`model label: ${model || '(missing)'} / ${effort || '(missing)'}`, () => assert.equal(modelLabel(model, effort), expected));
it('alias versions use matching observed family, then configured map; explicit versions always win', () => {
  assert.equal(modelLabel('opus', 'high', 'claude-opus-5-5', { opus: '4.5' }), 'O 5.5 HI');
  assert.equal(modelLabel('sonnet', 'medium', 'unknown', { sonnet: '5.5' }), 'S 5.5 MD');
  assert.equal(modelLabel('sonnet', 'medium', 'claude-opus-5-5'), 'S MD');
  assert.equal(modelLabel('gpt-6-luna', 'medium', 'gpt-7-luna', { 'gpt-6-luna': '8' }), 'L 6 MD');
  assert.equal(modelLabel(undefined, undefined), '– –');
  for (const [effort, short] of Object.entries(EFFORT_LABELS)) assert.equal(modelLabel('sonnet', effort), `S ${short}`);
  assert.deepEqual(['claude', 'codex', 'gemini'].map(providerLabel), ['cl', 'cx', 'ge']);
});
it('wide board fits 20-character task IDs and standard agent/state facts; width overrides leave a preview', () => {
  assert.equal(boardLayout(139).listWidth, 71);
  assert.equal(boardLayout(140).listWidth, 92);
  assert.equal(boardLayout(240).listWidth, 108);
  assert.equal(boardLayout(160, '60%').listWidth, 96);
  assert.equal(boardLayout(160, 110).listWidth, 110);
  assert.equal(boardLayout(140, '100%').previewWidth, 32);
  assert.deepEqual(boardLayout(80, '60%'), { showPreview: false, listWidth: 80, previewWidth: 0 });
  const c = boardColumns(92); assert.equal(c.task, 20); assert.ok(c.who >= 'cx S 6.1 XH'.length); assert.ok(c.state >= '⏳ report-candidate'.length);
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0) + 7, 92);
});
it('board config validates column/percentage widths and quoted versions', () => {
  const c = makeConfig(scratch.sub('valid'), 'board: {list_width: "55%", model_versions: {sonnet: "5.5"}}');
  assert.equal(c.board.listWidth, '55%'); assert.deepEqual(c.board.modelVersions, { sonnet: '5.5' });
  for (const [i, yaml] of ['list_width: 12', 'list_width: "120%"', 'model_versions: {sonnet: 5.5}', 'model_versions: {sonnet: "guess"}'].entries()) assert.throws(() => makeConfig(scratch.sub(`invalid${i}`), `board: {${yaml}}`));
});
