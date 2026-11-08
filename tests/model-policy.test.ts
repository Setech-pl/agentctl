import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { planBatch } from '../src/core/plan.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { RawSpec } from '../src/core/spec.ts';
import { makeConfig, makeContext, specText, useScratch } from './helpers.ts';

const scratch = useScratch();
const config = makeConfig(scratch.sub('policy'), 'providers: [claude, codex, kimi]\n');
const repo = scratch.sub('policy/repo');

const resolve = (header: Record<string, string>, cfg = config) =>
  splitSpecs(specText(header, repo)).map((raw) => resolveSpec(raw, { config: cfg, loadProject: () => undefined }))[0]!;

const resolveText = (text: string, cfg = config) => resolveSpec(splitSpecs(text)[0] as RawSpec, { config: cfg, loadProject: () => undefined });

describe('preview validation: model and effort policy', () => {
  it('an unknown Kimi model is an error naming the known ones (a typo silently falls back to K2.8 Preview)', () => {
    assert.throws(
      () => resolve({ task: 'P-1', agent: 'kimi', model: 'k3-pro' }),
      (e: Error) => {
        assert.match(e.message, /unknown Kimi model "k3-pro": a typo silently falls back to K2\.8 Preview/);
        assert.match(e.message, /k3-256k/);
        assert.match(e.message, /k3\.1-pro/);
        return true;
      },
    );
    // the matrix models and the user's own catalog are known
    assert.equal(resolve({ task: 'P-1', agent: 'kimi', model: 'k3' }).model, 'k3');
    const home = scratch.sub('kimi-catalog');
    fs.writeFileSync(path.join(home, 'config.toml'), 'default_permission_mode = "manual"\n[models."kimi-code/k9"]\ndisplay_name = "K9"\nsupport_efforts = ["high"]\n');
    const viaCatalog = resolveText(`---\ntask: P-1\nagent: kimi\nmodel: k9\nenv:\n  KIMI_CODE_HOME: ${home}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt9}\n---\nX\n`);
    assert.equal(viaCatalog.model, 'k9');
  });

  it('refuses any Kimi *-highspeed model, even a registered one', () => {
    assert.throws(() => resolve({ task: 'P-2', agent: 'kimi', model: 'k3-highspeed' }), /highspeed/);
    const home = scratch.sub('kimi-highspeed');
    fs.writeFileSync(path.join(home, 'config.toml'), 'default_permission_mode = "manual"\n[models."kimi-code/k3-highspeed"]\ndisplay_name = "K3 HS"\nsupport_efforts = ["high"]\n');
    assert.throws(
      () => resolveText(`---\ntask: P-2\nagent: kimi\nmodel: k3-highspeed\nenv:\n  KIMI_CODE_HOME: ${home}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt2}\n---\nX\n`),
      /highspeed/,
    );
  });

  it('refuses effort off/none for Kimi', () => {
    assert.throws(() => resolve({ task: 'P-3', agent: 'kimi', effort: 'off' }), /effort must be one of/);
    assert.throws(() => resolve({ task: 'P-3', agent: 'kimi', effort: 'none' }), /effort must be one of/);
  });

  it('refuses Codex effort low', () => {
    assert.throws(() => resolve({ task: 'P-4', agent: 'codex', effort: 'low' }), /codex.*effort "low"/);
  });

  it('k3.1-pro* only with an explicit model: (never from defaults, another class or a translation)', async () => {
    // explicit: fine
    assert.equal(resolve({ task: 'P-5', agent: 'kimi', model: 'k3.1-pro' }).model, 'k3.1-pro');
    // explicit-only class: the class IS the explicit request
    assert.equal(resolve({ task: 'P-5', agent: 'kimi', class: 'escalate' }).model, 'k3.1-pro');
    // configured default: refused
    const cfg = makeConfig(scratch.sub('policy-pro'), 'providers: [claude, codex, kimi]\ndefaults: {model: k3.1-pro}\n');
    assert.throws(() => resolve({ task: 'P-5', agent: 'kimi' }, cfg), /k3\.1-pro.*explicit model/);
    // a non-explicit class never yields it (visual-compare uses k3/high)
    assert.equal(resolve({ task: 'P-5', agent: 'kimi', class: 'visual-compare' }).model, 'k3');
    // a translation onto it is refused
    const mapped = makeConfig(scratch.sub('policy-pro-map'), 'providers: [claude, codex, kimi]\nequivalents:\n  - {claude: "claude-opus-5-5/high", codex: "gpt-6.1-sol/high", kimi: "k3.1-pro/max"}\n');
    const spec = resolve({ task: 'P-5', agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, mapped);
    await assert.rejects(planBatch(makeContext(mapped).ctx, [spec], { agent: 'kimi', ignoreLimits: true }), /k3\.1-pro.*never come from a translation/);
  });

  it('gpt-6-astra only with an explicit model: (never from defaults or a translation)', async () => {
    assert.equal(resolve({ task: 'P-6', agent: 'codex', model: 'gpt-6-astra' }).model, 'gpt-6-astra');
    assert.equal(resolve({ task: 'P-6', agent: 'codex', class: 'escalate' }).model, 'gpt-6-astra');
    const cfg = makeConfig(scratch.sub('policy-astra'), 'defaults: {model: gpt-6-astra}\n');
    assert.throws(() => resolve({ task: 'P-6', agent: 'codex' }, cfg), /gpt-6-astra.*explicit model/);
    const mapped = makeConfig(scratch.sub('policy-astra-map'), 'equivalents:\n  - {claude: "claude-opus-5-5/high", codex: "gpt-6-astra/high"}\n');
    const spec = resolve({ task: 'P-6', agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }, mapped);
    await assert.rejects(planBatch(makeContext(mapped).ctx, [spec], { agent: 'codex' }), /gpt-6-astra.*never come from a translation/);
  });
});
