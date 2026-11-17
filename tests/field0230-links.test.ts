import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('F11: closed project defaults error with actionable hint unless disabled or the spec supplies that repo', () => {
  const root = scratch.sub('links'), config = makeConfig(root), app = scratch.sub('links/app'), backend = scratch.sub('links/backend'), old = scratch.sub('links/old');
  seedTask(config, 'CLOSED', {closed: true, repos: [{path: backend, worktree: old}]});
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), `links: [{from: pkg, to: '${old}/packages/sim'}]`);
  const raw = splitSpecs(`---\ntask: NEXT\nagent: claude\nrepos: [{path: '${app}', worktree: '${app}-wt'}]\n---\nFake.`)[0]!;
  assert.throws(() => resolveSpec(raw, {config}), (e: Error & {hint?: string}) => /closed task CLOSED/.test(e.message) && /own backend worktree/.test(e.hint ?? '') && /links: \[\]/.test(e.hint ?? ''));
  raw.header.links = [];
  assert.deepEqual(resolveSpec(raw, {config}).links, []);
  delete raw.header.links;
  raw.header.repos = [{path: app, worktree: `${app}-wt`}, {path: backend, worktree: `${backend}-new`}];
  assert.deepEqual(resolveSpec(raw, {config}).links, []);
});
