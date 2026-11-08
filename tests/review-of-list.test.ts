import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planBatch } from '../src/core/plan.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { assertAgentSpawnAllowed } from '../src/core/window-guard.ts';
import fs from 'node:fs';
import path from 'node:path';
import { makeConfig, makeContext, specText, useScratch } from './helpers.ts';

const scratch = useScratch();
const config = makeConfig(scratch.sub('reviewlist'), 'providers: [claude, codex, kimi]\n');
const repo = scratch.sub('reviewlist/repo');

const resolve = (header: Record<string, unknown>, prompt = 'Review the work.') =>
  splitSpecs(`---\n${Object.entries(header).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n---\n${prompt}\n`)
    .map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));

const seedAuthor = (task: string, agent: 'claude' | 'codex' | 'kimi', model: string) => {
  const [spec] = resolve({ task, agent, model });
  fs.mkdirSync(path.dirname(taskFile(config, spec.window)), { recursive: true });
  fs.writeFileSync(taskFile(config, spec.window), renderTaskMd(recordFromSpec(spec, config, 0), 'x'));
  return spec;
};

describe('review_of accepts a list (P66)', () => {
  it('parses one ID or a list; the first is the primary reviewed task', () => {
    const [one] = resolve({ task: 'R-1', agent: 'codex', review_of: 'NC-1' });
    assert.equal(one.reviewOf, 'NC-1');
    assert.deepEqual(one.reviewOfAll, ['NC-1']);
    const [many] = resolve({ task: 'R-2', agent: 'codex', review_of: ['NC-1', 'NC-2', 'NC-1'] });
    assert.equal(many.reviewOf, 'NC-1');
    assert.deepEqual(many.reviewOfAll, ['NC-1', 'NC-2']);
  });

  it('rejects a bad element and an empty list', () => {
    assert.throws(() => resolve({ task: 'R-3', agent: 'codex', review_of: ['NC-1', 'lowercase'] }), /review_of must be a task ID or a list of task IDs/);
    assert.throws(() => resolve({ task: 'R-3', agent: 'codex', review_of: [] }), /review_of.*empty/);
  });

  it('every reviewed task is validated; the preview warns when the reviewer shares the author provider', async () => {
    seedAuthor('NC-1', 'claude', 'claude-opus-5-5');
    seedAuthor('NC-2', 'codex', 'gpt-6.1-sol');
    const [reviewer] = resolve({ task: 'R-4', agent: 'claude', model: 'claude-sonnet-5-5', review_of: ['NC-1', 'NC-2'] });
    const { ctx } = makeContext(config);
    const [planned] = await planBatch(ctx, [reviewer], { ignoreLimits: true });
    assert.equal(planned.warnings?.length, 1);
    assert.match(planned.warnings[0]!, /reviewer provider claude equals the author provider of NC-1/);
    assert.match(planned.warnings[0]!, /different provider/);
  });

  it('no warning when every author is on another provider', async () => {
    seedAuthor('NC-3', 'codex', 'gpt-6.1-sol');
    seedAuthor('NC-4', 'kimi', 'k3');
    const [reviewer] = resolve({ task: 'R-5', agent: 'claude', model: 'claude-sonnet-5-5', review_of: ['NC-3', 'NC-4'] });
    const [planned] = await planBatch(makeContext(config).ctx, [reviewer], { ignoreLimits: true });
    assert.deepEqual(planned.warnings ?? [], []);
  });

  it('the hard rule still holds per task: same provider AND model anywhere in the list is an error', async () => {
    seedAuthor('NC-5', 'claude', 'claude-opus-5-5');
    seedAuthor('NC-6', 'claude', 'claude-sonnet-5-5');
    const [reviewer] = resolve({ task: 'R-6', agent: 'claude', model: 'claude-sonnet-5-5', review_of: ['NC-5', 'NC-6'] });
    await assert.rejects(planBatch(makeContext(config).ctx, [reviewer], { ignoreLimits: true }), /R-6 reviews NC-6 but uses the same agent and model/);
  });

  it('an unknown author anywhere in the list is an error', async () => {
    seedAuthor('NC-7', 'codex', 'gpt-6.1-sol');
    const [reviewer] = resolve({ task: 'R-7', agent: 'claude', model: 'claude-sonnet-5-5', review_of: ['NC-7', 'NC-77'] });
    await assert.rejects(planBatch(makeContext(config).ctx, [reviewer], { ignoreLimits: true }), /review_of NC-77: no record of that task/);
  });

  it('the review isolation invariant covers every listed author, not only the first', () => {
    const author = seedAuthor('NC-8', 'codex', 'gpt-6.1-sol');
    const [reviewer] = resolve({ task: 'R-8', agent: 'claude', model: 'claude-sonnet-5-5', review_of: ['NC-3', 'NC-8'] });
    const { ctx } = makeContext(config);
    assert.throws(
      () => assertAgentSpawnAllowed(ctx, { task: reviewer.task, report: reviewer.report, repos: author.repos, reviewOf: reviewer.reviewOf, reviewOfAll: reviewer.reviewOfAll, origin: 'new' }),
      /R-8.*NC-8|author/i,
    );
  });
});
