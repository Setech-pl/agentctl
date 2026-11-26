import { linkBaseWarnings } from '../src/core/links.ts';
import { RealRunner } from '../src/core/runner.ts';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { summarizeSpecs } from '../src/core/summary.ts';
import { archiveDir, taskDir } from '../src/core/taskstore.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { commitQueueAdd, planQueueAdd } from '../src/core/queue.ts';
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
    if (closed) {
      assert.throws(() => resolveSpec(raw, {config}), /closed task OLD/);
      const {ctx} = makeContext(config, {dryRun: true});
      await assert.rejects(planQueueAdd(ctx, [raw]), /closed task OLD/);
      raw.header.links = [];
      assert.equal(resolveSpec(raw, {config}).links.length, 0);
      continue;
    }
    const spec = resolveSpec(raw, { config });
    const summary = summarizeSpecs([spec]).join('\n');
    assert.ok(closed ? summary.includes('Skipped stale project links') : summary.includes(`stale project link pkg -> ${target}`), summary);
    if (closed) assert.equal(spec.links.length, 0);
    assert.match(summary, /\{task:TASK-ID,repo:REPO-NAME\}/);
    assert.match(summary, closed ? /closed task OLD/ : /does not exist/);
    const { ctx } = makeContext(config, { dryRun: true });
    assert.equal((await planQueueAdd(ctx, [raw])).warnings.some(w => w.includes('stale project link')), !closed, 'closed defaults notify once per project/day');
    raw.header.links = [{ from: 'pkg', to: scratch.sub(`override-${closed}`) }];
    assert.doesNotMatch(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /stale project link/);
  }
});
it('R6: an unrelated spec link does not silence stale project-link warnings; overriding the same from does', () => {
  const root = scratch.sub('stale-r6'), config = makeConfig(root), repo = scratch.sub('stale-r6/app');
  const target = path.join(root, 'missing-target');
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${target}}\n`);
  const raw = splitSpecs(specText({ task: 'FRONT', agent: 'claude' }, repo))[0]!;
  raw.header.links = [{ from: 'other', to: scratch.sub('stale-r6/elsewhere') }];
  assert.ok(summarizeSpecs([resolveSpec(raw, { config })]).join('\n').includes(`stale project link pkg -> ${target}`), 'an unrelated spec link keeps the project-link warning');
  raw.header.links = [{ from: 'pkg', to: scratch.sub('stale-r6/override') }];
  assert.doesNotMatch(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /stale project link/, 'an override of the same from silences it');
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
  assert.throws(() => resolveSpec(raw, {config}), /closed task ARCHIVED/);
  fs.mkdirSync(`${wt}-other`);
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${wt}-other}\n`);
  assert.doesNotMatch(summarizeSpecs([resolveSpec(raw, { config })]).join('\n'), /WARNING/);
});


it('P72 spec-derived backend links and previews compare target HEAD with its repository base', async () => {
  const root = scratch.sub('p72'), config = makeConfig(root), app = scratch.sub('p72/app'), backend = scratch.sub('p72/backend');
  const git = (...args: string[]) => execFileSync('git', ['-C', backend, ...args], { encoding: 'utf8' }).trim();
  git('init', '-b', 'trunk'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-m', 'old');
  const old = git('rev-parse', 'HEAD'), target = path.join(root, 'backend-old');
  git('worktree', 'add', '--detach', target, old);
  fs.mkdirSync(path.join(target, 'packages/sim'), { recursive: true });
  git('commit', '--allow-empty', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), `links:\n  - {from: pkg, to: '${target}/packages/sim'}\n`);
  const raw = splitSpecs(specText({ task: 'FRONT', agent: 'claude' }, app))[0]!;
  raw.header.repos = [{ path: app, worktree: `${app}-wt` }, { path: backend, worktree: `${backend}-new`, base }];
  raw.header.links = [{from: 'pkg', to: `${target}/packages/sim`}]; // explicit links still validate the chosen base
  const spec = resolveSpec(raw, { config });
  const runner = new RealRunner();
  assert.match((await linkBaseWarnings(runner, spec.links, spec.repos)).join('\n'), /older than task base/);
  const { ctx } = makeContext(config, { dryRun: true, readRunner: runner });
  assert.ok((await planQueueAdd(ctx, [raw])).warnings.some(w => w.includes('older than task base')));
  seedTask(config, 'ACTIVE', { repos: spec.repos, links: spec.links });
  const checks = await runDoctor(ctx.runner, () => config, app);
  assert.ok(checks.some(c => c.name === 'task links ACTIVE' && c.detail.includes('older than task base')));
  git('-C', target, 'checkout', '--detach', base);
  assert.doesNotMatch((await linkBaseWarnings(runner, spec.links, spec.repos)).join('\n'), /older than task base/);
  delete raw.header.links;
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), "links:\n  - {from: pkg, to: '{worktree:backend}/packages/sim'}\n");
  assert.equal(resolveSpec(raw, { config }).links[0]?.to, `${backend}-new/packages/sim`);
  await commitQueueAdd(ctx, (await planQueueAdd(ctx, [raw])).items, {});
});

it('D5: closed project defaults consistently error across specs; explicit links remain opt-in', () => {
  const root = scratch.sub('d5-day'), config = makeConfig(root), app = scratch.sub('d5-day/app');
  const backend = scratch.sub('d5-day/backend'), old = scratch.sub('d5-day/backend-old');
  seedTask(config, 'INTEGRATION-13', {closed: true, repos: [{path: backend, worktree: old}]});
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${old}/packages/sim}\n`);
  const raw = splitSpecs(specText({task: 'FIRST', agent: 'claude'}, app))[0]!;
  for (const task of ['FIRST', 'SECOND']) {raw.header.task = task; assert.throws(() => resolveSpec(raw, {config}), /closed task INTEGRATION-13/);}
  assert.ok(!fs.existsSync(path.join(config.stateDir, 'project-link-notices')), 'validation is read-only');
  raw.header.links = [{from: 'pkg', to: old}];
  assert.equal(resolveSpec(raw, {config}).links[0]!.to, old);
});

it('D5: inherited defaults to a repo supplied by the spec are skipped; explicit worktree placeholders remain', () => {
  const root = scratch.sub('d5-repo'), config = makeConfig(root), app = scratch.sub('d5-repo/app');
  const backend = scratch.sub('d5-repo/backend'), old = scratch.sub('d5-repo/backend-old');
  seedTask(config, 'LIVE-BACKEND', {repos: [{path: backend, worktree: old}]});
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), `links:\n  - {from: pkg, to: ${old}/packages/sim}\n`);
  const raw = splitSpecs(specText({task: 'MULTI', agent: 'claude'}, app))[0]!;
  raw.header.repos = [{path: app, worktree: `${app}-wt`}, {path: backend, worktree: `${backend}-new`}];
  assert.equal(resolveSpec(raw, {config}).links.length, 0);
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), "links:\n  - {from: pkg, to: '{worktree:backend}/packages/sim'}\n");
  assert.equal(resolveSpec(raw, {config}).links[0]!.to, `${backend}-new/packages/sim`);
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), "links:\n  - {from: pkg, to: '{worktree:backend|{task:UNKNOWN,repo:backend}}/packages/sim'}\n");
  assert.equal(resolveSpec(raw, {config}).links[0]!.to, `${backend}-new/packages/sim`, 'unused fallback is not resolved');
});

it('D5: inherited closed-task placeholders error even after the worktree is gone', () => {
  const root = scratch.sub('d5-gone'), config = makeConfig(root), app = scratch.sub('d5-gone/app');
  seedTask(config, 'GONE', {closed: true, repos: [{path: path.join(root, 'backend'), worktree: path.join(root, 'missing-wt')}]});
  fs.writeFileSync(path.join(app, '.agentctl.yaml'), "links:\n  - {from: pkg, to: '{task:GONE,repo:backend}/packages/sim'}\n");
  const raw = splitSpecs(specText({task: 'SAFE', agent: 'claude'}, app))[0]!;
  assert.throws(() => resolveSpec(raw, {config}), /closed task GONE/);
  raw.header.links = [{from: 'pkg', to: '{task:GONE,repo:backend}/packages/sim'}];
  assert.throws(() => resolveSpec(raw, {config}), /does not exist/);
});
