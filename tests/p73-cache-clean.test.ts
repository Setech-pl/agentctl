import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { closeTask } from '../src/core/close.ts';
import { cleanWorktreeCache } from '../src/core/worktree-cache.ts';
import { journalOutputs } from '../src/core/outputs.ts';
import { planGc, renderGc } from '../src/core/gc.ts';
import { makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();

it('P73-a removes .cache only after report-end for every provider and records freed bytes in close/gc', async () => {
  for (const agent of ['claude', 'codex', 'kimi'] as const) {
    const root = scratch.sub(agent), config = makeConfig(root), wt = scratch.sub(`${agent}/wt`);
    fs.mkdirSync(`${root}/repo`);
    const { ctx, out } = makeContext(config);
    const r = seedTask(config, agent.toUpperCase(), { agent, repos: [{ path: `${root}/repo`, worktree: wt }] });
    fs.mkdirSync(path.join(wt, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(wt, '.cache/junk'), '1234567');
    fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, 'Werdykt: PASS\n');
    await journalOutputs(ctx, r);
    assert.ok(fs.existsSync(path.join(wt, '.cache')));
    fs.appendFileSync(r.report, '<!-- agentctl:report-end -->\n');
    r.turnEndedAt = new Date(Math.ceil(fs.statSync(r.report).mtimeMs)).toISOString();
    await journalOutputs(ctx, r);
    assert.equal(fs.existsSync(path.join(wt, '.cache')), false);
    await closeTask(ctx, r.task);
    assert.match(out.join('\n'), /\.cache cleanup: 7 bytes freed/);
    assert.match(renderGc(await planGc(ctx)).join('\n'), /\.cache cleanup: 7 bytes freed/);
    await journalOutputs(ctx, r);
    assert.match(renderGc(await planGc(ctx)).join('\n'), /\.cache cleanup: 7 bytes freed/);
  }
});

it('P73-a opt-out, dry run and symlink escapes retain cache and external files', async () => {
  for (const mode of ['opt-out', 'dry', 'root-link', 'nested-link', 'worktree-link']) {
    const root = scratch.sub(mode), config = makeConfig(root, mode === 'opt-out' ? 'report:\n  clean_worktree_cache: false\n' : '');
    const actual = scratch.sub(`${mode}/actual`), wt = mode === 'worktree-link' ? path.join(root, 'alias') : actual;
    if (mode === 'worktree-link') fs.symlinkSync(actual, wt);
    const external = scratch.sub(`${mode}/external`);
    fs.writeFileSync(path.join(external, 'keep'), 'precious');
    if (mode === 'root-link') fs.symlinkSync(external, path.join(actual, '.cache'));
    else {
      fs.mkdirSync(path.join(actual, '.cache'));
      fs.writeFileSync(path.join(actual, '.cache/junk'), 'junk');
      if (mode === 'nested-link') fs.symlinkSync(external, path.join(actual, '.cache/escape'));
    }
    fs.mkdirSync(`${root}/repo`);
    const { ctx } = makeContext(config, { dryRun: mode === 'dry' });
    const r = seedTask(config, 'SAFE', { repos: [{ path: `${root}/repo`, worktree: wt }] });
    fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
    r.turnEndedAt = new Date(Math.ceil(fs.statSync(r.report).mtimeMs)).toISOString();
    await journalOutputs(ctx, r);
    assert.ok(fs.existsSync(path.join(actual, '.cache')), mode);
    assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'precious');
  }
});


it('P73-a protects main checkout and waits for the current attempt and settle interval', async () => {
  const root = scratch.sub('readiness'), config = makeConfig(root, 'report: {settle_s: 30}\n');
  const wt = scratch.sub('readiness/wt'), repo = scratch.sub('readiness/repo');
  fs.mkdirSync(path.join(wt, '.cache'));
  fs.writeFileSync(path.join(wt, '.cache/junk'), 'junk');
  const now = Date.now();
  const { ctx, runner } = makeContext(config, { startTime: now });
  const r = seedTask(config, 'WAIT', { attemptId: 'current', repos: [{ path: repo, worktree: wt }] });
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:attempt previous -->\n<!-- agentctl:report-end -->\n');
  await journalOutputs(ctx, r);
  assert.ok(fs.existsSync(path.join(wt, '.cache')));
  fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:attempt current -->\n<!-- agentctl:report-end -->\n');
  await journalOutputs(ctx, r);
  assert.ok(fs.existsSync(path.join(wt, '.cache')), 'not settled');
  runner.now = () => now + 60_000;
  r.turnEndedAt = new Date(Math.ceil(fs.statSync(r.report).mtimeMs)).toISOString();
  await journalOutputs(ctx, { ...r, repos: [{ path: wt, worktree: wt }] });
  assert.ok(fs.existsSync(path.join(wt, '.cache')), 'main checkout');
  await journalOutputs(ctx, r);
  assert.equal(fs.existsSync(path.join(wt, '.cache')), false);
});

it('F1: a live turn retains cache after report-end; ended turn still waits for other open records', async () => {
  const root = scratch.sub('live-turn'), config = makeConfig(root);
  const wt = scratch.sub('live-turn/wt'), repo = scratch.sub('live-turn/repo');
  const { ctx } = makeContext(config);
  const r = seedTask(config, 'LIVE', { turnEndedAt: undefined, repos: [{ path: repo, worktree: wt }] });
  fs.mkdirSync(path.join(wt, '.cache'));
  fs.writeFileSync(path.join(wt, '.cache/junk'), 'in-use');
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  await journalOutputs(ctx, r);
  assert.ok(fs.existsSync(path.join(wt, '.cache')), 'report-end alone is not a stopped agent');
  r.turnEndedAt = new Date(Math.floor(fs.statSync(r.report).mtimeMs) - 1).toISOString();
  await cleanWorktreeCache(ctx, r);
  assert.ok(fs.existsSync(path.join(wt, '.cache')), 'old stop cannot cover a new report, even at settle_s=0');
  r.turnEndedAt = new Date(Math.ceil(fs.statSync(r.report).mtimeMs)).toISOString();
  seedTask(config, 'OTHER', { repos: r.repos });
  await cleanWorktreeCache(ctx, r);
  assert.ok(fs.existsSync(path.join(wt, '.cache')), 'another open task shares this worktree');
  seedTask(config, 'OTHER', { closed: true, repos: r.repos });
  await journalOutputs(ctx, r);
  assert.equal(fs.existsSync(path.join(wt, '.cache')), false);
});
