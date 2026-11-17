import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { planBatch } from '../src/core/plan.ts';
import { makeConfig, DiskRunner, FakeTmux, useScratch } from './helpers.ts';
const scratch = useScratch();
it('F10: Kimi medium maps to high with a warning in spec and translated planning, preserving requested effort', async () => {
  const root = scratch.sub('effort'), config = makeConfig(root, 'providers: [claude, codex, kimi]');
  const spec = resolveSpec(splitSpecs(`---\ntask: KIMI\nagent: kimi\nmodel: k3\neffort: medium\nrepos: [{path: '${root}', worktree: '${root}/wt'}]\n---\nFake.`)[0]!, {config});
  assert.equal(spec.effort, 'high'); assert.equal(spec.requested.effort, 'medium');
  assert.ok(spec.warnings?.some(w => /medium mapped to high/.test(w)));
  const ctx = new Context(new DiskRunner({dryRun: true, respond: new FakeTmux().respond}), config, () => {});
  const [planned] = await planBatch(ctx, [{...spec, effort: 'medium'}], {previewOnly: true, ignoreLimits: true});
  assert.equal(planned!.effort, 'high');
  assert.ok(planned!.warnings?.some(w => /medium mapped to high/.test(w)));
});
