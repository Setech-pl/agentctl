import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { planLinks, missingLinkTargets } from '../src/core/links.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { makeConfig, specText, useScratch } from './helpers.ts';
const scratch = useScratch();
it('P18 rejects recursive links at spec preview and concrete planning, including symlink parents', () => {
  const root = scratch.sub('recursive'), wt = path.join(root, 'repo-wt');
  const config = makeConfig(root);
  for (const [from, to] of [['pkg', wt], ['pkg', path.join(wt, 'pkg')], ['pkg', path.join(wt, 'pkg/child')], ['pkg/child', path.join(wt, 'pkg')]]) {
    const text = specText({ task: 'P18', agent: 'claude', links: `[{from: ${from}, to: ${to}}]` }, path.join(root, 'repo'));
    assert.throws(() => resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined }), /recursive|self-link/);
    assert.throws(() => planLinks([{ from: from!, to: to! }], wt), /recursive|self-link/);
  }
  fs.mkdirSync(wt);
  fs.symlinkSync(wt, path.join(root, 'alias'));
  assert.throws(() => planLinks([{ from: 'pkg', to: path.join(root, 'alias') }], wt), /recursive|self-link/);
  const external = scratch.sub('external');
  fs.symlinkSync(external, path.join(wt, 'existing'));
  assert.equal(planLinks([{ from: 'existing', to: external }], wt).ops[0]?.existing, 'symlink');
});
it('P18 warns about a missing absolute source independently of target existence', () => {
  const root = scratch.sub('missing'), from = path.join(root, 'other-task/pkg');
  assert.match(missingLinkTargets([{ from, to: root }], path.join(root, 'mine')).join('\n'), /links.from.*does not exist/);
});
