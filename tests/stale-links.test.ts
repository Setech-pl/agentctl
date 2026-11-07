import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { summarizeSpecs } from '../src/core/summary.ts';
import { archiveDir, taskDir } from '../src/core/taskstore.ts';
import { planQueueAdd } from '../src/core/queue.ts';
import { makeConfig, makeContext, seedTask, specText, useScratch } from './helpers.ts';
const scratch = useScratch();
it('P17 new and queue previews name stale project defaults and suggest placeholders', async () => {
  for (const closed of [false, true]) {
    const root = scratch.sub(`stale-${closed}`), config = makeConfig(root), repo = scratch.sub(`stale-${closed}/app`);
    const wt = path.join(root, 'old-backend'), target = `${wt}/packages/sim`;
    if (closed) fs.mkdirSync(target, { recursive: true });
    seedTask(config, 'OLD', { closed, repos: [{ path: path.join(root, 'backend'), worktree: wt }] });
    fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${target}}\n`);
    const raw = splitSpecs(specText({ task: 'FRONT', agent: 'claude' }, repo))[0]!;
    const spec = resolveSpec(raw, { config });
    const summary = summarizeSpecs([spec]).join('\n');
    assert.ok(summary.includes(`stale project link pkg -> ${target}`), summary);
    assert.match(summary, /\{task:TASK-ID,repo:REPO-NAME\}/);
    assert.match(summary, closed ? /closed task OLD/ : /does not exist/);
    const { ctx } = makeContext(config, { dryRun: true });
    assert.ok((await planQueueAdd(ctx, [raw])).warnings.some(w => w.includes(`stale project link pkg -> ${target}`)));
    raw.header.links = [{ from: 'pkg', to: scratch.sub(`override-${closed}`) }];
    assert.doesNotMatch(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /stale project link/);
  }
});
it('P17 healthy inherited project links do not warn', () => {
  const root = scratch.sub('healthy'), config = makeConfig(root), repo = scratch.sub('healthy/app'), target = scratch.sub('healthy/backend');
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${target}}\n`);
  const spec = resolveSpec(splitSpecs(specText({ task: 'FRONT', agent: 'claude' }, repo))[0]!, { config });
  assert.doesNotMatch(summarizeSpecs([spec]).join('\n'), /WARNING/);
});

it('P17 finds archived owners through symlink aliases without matching sibling path prefixes', () => {
  const root = scratch.sub('archive'), config = makeConfig(root), repo = scratch.sub('archive/app');
  const wt = scratch.sub('archive/backend-wt'), alias = path.join(root, 'alias');
  fs.symlinkSync(wt, alias);
  seedTask(config, 'ARCHIVED', { repos: [{ path: path.join(root, 'backend'), worktree: wt }] });
  fs.mkdirSync(archiveDir(config), { recursive: true });
  fs.renameSync(taskDir(config, 'archived'), path.join(archiveDir(config), 'archived'));
  const raw = splitSpecs(specText({ task: 'FRONT', agent: 'claude' }, repo))[0]!;
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${alias}}\n`);
  assert.match(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /closed task ARCHIVED/);
  fs.mkdirSync(`${wt}-other`);
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${wt}-other}\n`);
  assert.doesNotMatch(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /WARNING/);
});
