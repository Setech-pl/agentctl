import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classNames } from '../src/core/matrix.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { RawSpec } from '../src/core/spec.ts';
import { makeConfig, specText, useScratch } from './helpers.ts';

const scratch = useScratch();
const config = makeConfig(scratch.sub('class'), 'providers: [claude, codex, kimi]\n');
const repo = scratch.sub('class/repo');

const resolve = (header: Record<string, string>) =>
  splitSpecs(specText(header, repo)).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }))[0]!;

describe('spec key class:', () => {
  it('takes model and effort of the agent from the matrix', () => {
    const claude = resolve({ task: 'CL-1', agent: 'claude', class: 'report' });
    assert.deepEqual([claude.agent, claude.model, claude.effort, claude.class], ['claude', 'claude-haiku-5-5', 'low', 'report']);
    const codex = resolve({ task: 'CL-2', agent: 'codex', class: 'bugfix' });
    assert.deepEqual([codex.agent, codex.model, codex.effort], ['codex', 'gpt-6.1-sol', 'medium']);
    const kimi = resolve({ task: 'CL-3', agent: 'kimi', class: 'hard' });
    assert.deepEqual([kimi.agent, kimi.model, kimi.effort], ['kimi', 'k3', 'max']);
  });

  it('wins over configured defaults but loses to an explicit model/effort', () => {
    const withDefaults = makeConfig(scratch.sub('class-defaults'), 'providers: [claude, codex, kimi]\ndefaults: {model: custom-model, effort: low}\n');
    const raw = splitSpecs(specText({ task: 'CL-4', agent: 'claude', class: 'review' }, repo))[0]!;
    const spec = resolveSpec(raw, { config: withDefaults, loadProject: () => undefined });
    assert.deepEqual([spec.model, spec.effort], ['claude-sonnet-5-5', 'medium']);

    const override = resolve({ task: 'CL-5', agent: 'claude', class: 'report', model: 'claude-opus-5-5', effort: 'high' });
    assert.deepEqual([override.model, override.effort], ['claude-opus-5-5', 'high']);
    assert.equal(override.warnings?.length, 2);
    assert.match(override.warnings?.[0] ?? '', /class report gives claude claude-haiku-5-5\/low, but the spec sets model: claude-opus-5-5/);
    assert.match(override.warnings?.[1] ?? '', /class report gives claude claude-haiku-5-5\/low, but the spec sets effort: high/);
  });

  it('warns only when the explicit value contradicts the matrix', () => {
    const same = resolve({ task: 'CL-6', agent: 'kimi', class: 'smoke', model: 'k3', effort: 'high' });
    assert.deepEqual([same.model, same.effort], ['k3', 'high']);
    assert.deepEqual(same.warnings ?? [], []);
  });

  it('an unknown class is an error listing the classes', () => {
    assert.throws(
      () => resolve({ task: 'CL-7', agent: 'claude', class: 'whatever' }),
      (e: Error) => {
        assert.match(e.message, /unknown class "whatever"/);
        assert.match(e.message, /report, simple, smoke, feature, bugfix, review, merge, hard, sim, visual, visual-compare, design, creative, escalate/);
        return true;
      },
    );
    assert.equal(classNames().length, 14, 'the list above is the whole matrix');
  });

  it('a class with "none" for the agent is an error naming the providers that have one', () => {
    assert.throws(() => resolve({ task: 'CL-8', agent: 'kimi', class: 'creative' }), /class creative has no kimi model/);
  });

  it('an explicit-only class may dispatch its restricted models (the class IS the explicit request)', () => {
    const kimi = resolve({ task: 'CL-9', agent: 'kimi', class: 'escalate' });
    assert.deepEqual([kimi.model, kimi.effort], ['k3.1-pro', 'max']);
    const codex = resolve({ task: 'CL-10', agent: 'codex', class: 'visual' });
    assert.deepEqual([codex.model, codex.effort], ['gpt-6.1-sol', 'high']);
    const escalateCodex = resolve({ task: 'CL-11', agent: 'codex', class: 'escalate' });
    assert.deepEqual([escalateCodex.model, escalateCodex.effort], ['gpt-6-astra', 'high']);
  });
});
