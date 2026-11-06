import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { resolveSpec } from '../src/core/spec.ts';
import { archiveDir, taskDir } from '../src/core/taskstore.ts';
import { summarizeSpecs } from '../src/core/summary.ts';
import { makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('cross-task links resolve recorded repository worktrees alongside local placeholders and P18', () => {
  const root = scratch.sub('resolve'), config = makeConfig(root), repo = path.join(root, 'app');
  const target = scratch.sub('recorded/backend-wt');
  seedTask(config, 'BACK', { repos: [{ path: path.join(root, 'backend'), worktree: target }] });
  const raw = { index: 1, prompt: 'Go.', header: { task: 'FRONT', agent: 'claude', repos: [{ path: repo, worktree: `${repo}-wt` }], links: [
    { from: '{worktree:app}/pkg', to: '{task:BACK,repo:backend}/packages/sim' },
    { from: 'fallback', to: '{worktree:missing|{task:BACK,repo:backend}}/other' },
  ] } };
  const spec = resolveSpec(raw, { config, loadProject: () => undefined });
  assert.deepEqual(spec.links, [{ from: 'pkg', to: `${target}/packages/sim` }, { from: 'fallback', to: `${target}/other` }]);
  raw.header.links = [{ from: 'local', to: '{worktree:app|{task:UNKNOWN,repo:backend}}/sibling' }];
  assert.equal(resolveSpec(raw, { config }).links[0]?.to, `${repo}-wt/sibling`);
  assert.ok(summarizeSpecs([spec]).join('\n').includes(`${target}/packages/sim`));
  seedTask(config, 'SELF', { repos: [{ path: repo, worktree: `${repo}-wt` }] });
  raw.header.links = [{ from: 'pkg', to: '{task:SELF,repo:app}' }];
  assert.throws(() => resolveSpec(raw, { config }), /recursive self-link/);
});
it('cross-task preview errors name unknown tasks, missing repos, ambiguity and removed worktrees', () => {
  const root = scratch.sub('errors'), config = makeConfig(root), repo = path.join(root, 'app');
  const resolve = (task: string, name = 'backend') => resolveSpec({ index: 1, prompt: 'Go.', header: { task: 'FRONT', agent: 'claude', repos: [{ path: repo, worktree: `${repo}-wt` }], links: [{ from: 'pkg', to: `{task:${task},repo:${name}}/pkg` }] } }, { config });
  assert.throws(() => resolve('UNKNOWN'), /UNKNOWN.*unknown task/);
  seedTask(config, 'EMPTY', { closed: true });
  assert.throws(() => resolve('EMPTY'), /EMPTY.*closed.*no.*worktree/);
  const target = scratch.sub('closed-retained');
  seedTask(config, 'CLOSED', { closed: true, repos: [{ path: '/repo/backend', worktree: target }] });
  assert.equal(resolve('CLOSED').links[0]?.to, `${target}/pkg`);
  assert.throws(() => resolve('CLOSED', 'other'), /CLOSED.*no repository "other"/);
  fs.mkdirSync(archiveDir(config), { recursive: true });
  fs.renameSync(taskDir(config, 'closed'), path.join(archiveDir(config), 'closed'));
  assert.equal(resolve('CLOSED').links[0]?.to, `${target}/pkg`);
  fs.rmSync(target, { recursive: true });
  assert.throws(() => resolve('CLOSED'), /CLOSED.*closed.*worktree.*does not exist/);
  seedTask(config, 'DUPE', { repos: [{ path: '/a/backend', worktree: root }, { path: '/b/backend', worktree: root }] });
  assert.throws(() => resolve('DUPE'), /DUPE.*ambiguous.*backend/);
});
