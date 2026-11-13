import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { loadGlobalConfig } from '../src/core/config.ts';
import { defaultEquivalents, parseEquivalents } from '../src/core/equivalents.ts';
import { classNames, deriveEquivalentRows, matrixClass, modelMatrix, parseModelMatrix } from '../src/core/matrix.ts';
import { GENERATED_MODEL_MATRIX } from '../src/core/model-matrix.ts';
import { PROVIDER_IDS } from '../src/core/providers/types.ts';
import { Problems } from '../src/core/util.ts';
import { useScratch } from './helpers.ts';

const scratch = useScratch();
const yamlText = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'data', 'model-matrix.yaml'), 'utf8');

describe('model matrix: data/model-matrix.yaml is the one source of truth', () => {
  it('the generated constant matches the YAML (run npm run gen:matrix after editing the YAML)', () => {
    const fromYaml = parseModelMatrix(YAML.parse(yamlText), 'data/model-matrix.yaml');
    assert.deepEqual(modelMatrix(), fromYaml);
    assert.deepEqual(deriveEquivalentRows(), deriveEquivalentRows(fromYaml));
  });

  it('is exactly the agreed class table', () => {
    assert.deepEqual(classNames(), ['report', 'simple', 'smoke', 'feature', 'bugfix', 'review', 'merge', 'hard', 'sim', 'visual', 'visual-compare', 'design', 'creative', 'escalate']);
    const cell = (cls: string, provider: 'claude' | 'codex' | 'kimi') => {
      const c = matrixClass(cls)?.cells[provider];
      return c ? `${c.model}/${c.effort}` : null;
    };
    assert.equal(cell('report', 'codex'), 'gpt-6-luna/medium');
    assert.equal(cell('report', 'claude'), 'claude-haiku-5-5/low');
    assert.equal(cell('report', 'kimi'), 'k3-256k/low');
    assert.equal(cell('bugfix', 'claude'), 'claude-sonnet-5-5/high');
    assert.equal(cell('hard', 'kimi'), 'k3/max');
    assert.equal(cell('visual', 'kimi'), 'k3.1-pro/high');
    assert.equal(cell('escalate', 'codex'), 'gpt-6-astra/high');
    assert.equal(cell('creative', 'kimi'), null, 'creative has no kimi model (none)');
    assert.equal(matrixClass('visual')?.explicit, true);
    assert.equal(matrixClass('escalate')?.explicit, true);
    assert.equal(matrixClass('feature')?.explicit, false);
  });

  it('config defaults equal the table derived from the matrix', () => {
    const p = new Problems();
    const parsed = parseEquivalents(deriveEquivalentRows(), 'matrix', p, PROVIDER_IDS);
    const without = (rows: typeof parsed, ...cols: ('kimi' | 'glm')[]) => rows.map((row) => {
      const rest = { ...row } as Record<string, unknown>;
      for (const col of cols) delete rest[col];
      return rest;
    });
    assert.deepEqual(defaultEquivalents(['claude', 'codex', 'kimi']), without(parsed, 'glm'));
    assert.deepEqual(defaultEquivalents(['claude', 'codex', 'kimi', 'glm']), parsed);
    const config = loadGlobalConfig(scratch.sub('matrix-config'));
    assert.deepEqual(
      config.equivalents,
      without(parsed, 'kimi', 'glm'),
      'without kimi and glm the defaults keep the same rows, minus the optional columns',
    );
  });

  it('restricted models never enter the default equivalents (explicit-only classes contribute no row)', () => {
    const written = deriveEquivalentRows().flatMap((row) => PROVIDER_IDS.map((id) => row[id] ?? ''));
    assert.ok(written.every((w) => !w.includes('gpt-6-astra')), JSON.stringify(deriveEquivalentRows()));
    assert.ok(written.every((w) => !w.startsWith('k3.1-pro')));
    assert.ok(written.every((w) => !w.includes('fable')));
  });
});
