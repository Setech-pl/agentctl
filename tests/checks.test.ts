import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkReviewer, checkWindowLimit, findAuthor } from '../src/checks.ts';
import { newTasks, validateBatch } from '../src/commands/new.ts';
import { resolveSpec, splitSpecs } from '../src/spec.ts';
import type { ResolvedSpec } from '../src/spec.ts';
import { recordFromSpec, renderTaskMd, taskFile } from '../src/taskstore.ts';
import { makeConfig, makeContext, specText, useScratch } from './helpers.ts';

const scratch = useScratch();

function resolveAll(config: ReturnType<typeof makeConfig>, text: string): ResolvedSpec[] {
  return splitSpecs(text).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));
}

/** Pretend `agentctl new` ran for this spec earlier: write its TASK.md into the cache. */
function seedTask(config: ReturnType<typeof makeConfig>, spec: ResolvedSpec): void {
  fs.mkdirSync(path.dirname(taskFile(config, spec.window)), { recursive: true });
  fs.writeFileSync(taskFile(config, spec.window), renderTaskMd(recordFromSpec(spec, config, 0), spec.prompt));
}

describe('review_of: the reviewer must differ from the author', () => {
  const author = { agent: 'claude', model: 'opus' } as const;
  const reviewer = (agent: 'claude' | 'codex', model: string) => ({ task: 'NC-2', reviewOf: 'NC-1', agent, model });

  it('rejects the same agent and model', () => {
    const problem = checkReviewer(reviewer('claude', 'opus'), author);
    assert.match(problem ?? '', /NC-2 reviews NC-1 but uses the same agent and model \(claude, opus\)/);
  });

  it('accepts a different agent', () => {
    assert.equal(checkReviewer(reviewer('codex', 'opus'), author), undefined);
  });

  it('accepts the same agent with a different model', () => {
    assert.equal(checkReviewer(reviewer('claude', 'sonnet'), author), undefined);
  });

  it('treats "default" as a model name of its own', () => {
    assert.ok(checkReviewer(reviewer('claude', 'default'), { agent: 'claude', model: 'default' }));
  });

  it('explains how to fix an unknown author', () => {
    assert.match(checkReviewer(reviewer('codex', 'x'), undefined) ?? '', /no record of that task/);
  });

  it('does nothing without review_of', () => {
    assert.equal(checkReviewer({ task: 'NC-2', agent: 'claude', model: 'opus' }, author), undefined);
  });

  it('end to end: the author comes from the cache (TASK.md) or from the same file', async () => {
    const root = scratch.sub('review-e2e');
    const config = makeConfig(root);
    const repo = scratch.sub('review-e2e/repo');
    for (const n of ['2', '8', '9']) scratch.sub(`review-e2e/repo${n}`);
    const [authorSpec] = resolveAll(config, specText({ task: 'NC-1', agent: 'claude', model: 'opus' }, repo));
    seedTask(config, authorSpec!);
    assert.deepEqual(findAuthor('NC-1', [], config), { agent: 'claude', model: 'opus' });

    const same = resolveAll(config, specText({ task: 'NC-2', agent: 'claude', model: 'opus', review_of: 'NC-1' }, repo + '2'));
    const { ctx } = makeContext(config);
    await assert.rejects(validateBatch(ctx, same, {}), /same agent and model/);

    const other = resolveAll(config, specText({ task: 'NC-2', agent: 'codex', model: 'gpt-x', review_of: 'NC-1' }, repo + '2'));
    await validateBatch(ctx, other, {});

    const inFile = [...resolveAll(config, specText({ task: 'NC-8', agent: 'codex', model: 'gpt-x' }, repo + '8')), ...resolveAll(config, specText({ task: 'NC-9', agent: 'codex', model: 'gpt-x', review_of: 'NC-8' }, repo + '9'))];
    await assert.rejects(validateBatch(ctx, inFile, {}), /NC-9 reviews NC-8 but uses the same agent and model/);
  });
});

describe('window limit per provider', () => {
  const live = [
    { window: 'a', agent: 'claude' as const },
    { window: 'b', agent: 'claude' as const },
    { window: 'c', agent: 'codex' as const },
    { window: 'manual' },
  ];

  it('refuses a new window at the limit and lists the live ones', () => {
    const problem = checkWindowLimit('claude', 2, live, 'agentctl');
    assert.match(problem ?? '', /limit for claude reached: 2 of 2 in session "agentctl" \(a, b\)/);
  });

  it('allows it below the limit, for another provider, or without a limit', () => {
    assert.equal(checkWindowLimit('claude', 3, live, 'agentctl'), undefined);
    assert.equal(checkWindowLimit('codex', 2, live, 'agentctl'), undefined);
    assert.equal(checkWindowLimit('claude', undefined, live, 'agentctl'), undefined);
  });

  it('counts windows started in the same file and windows already in tmux', async () => {
    const root = scratch.sub('limit-e2e');
    const config = makeConfig(root, 'limits: {claude: 2}\n');
    const specs = ['NC-1', 'NC-2', 'NC-3'].flatMap((task, i) =>
      resolveAll(config, specText({ task, agent: 'claude' }, scratch.sub(`limit-e2e/repo${i}`))),
    );
    const { ctx } = makeContext(config);
    await assert.rejects(validateBatch(ctx, specs, {}), /NC-3: window limit for claude reached: 2 of 2/);

    // one claude window is already live (known through its TASK.md): only one more fits
    seedTask(config, specs[0]!);
    const { ctx: ctx2 } = makeContext(config, {
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-1\n' } : undefined),
    });
    await assert.rejects(validateBatch(ctx2, specs.slice(1), {}), /NC-3: window limit for claude reached: 2 of 2 in session "agentctl" \(nc-1, nc-2\)/);
    await validateBatch(ctx2, specs.slice(1, 2), {});
  });

  it('newTasks stops before creating anything when the limit is exceeded', async () => {
    const root = scratch.sub('limit-none');
    const config = makeConfig(root, 'limits: {codex: 1}\n');
    const specs = ['NC-1', 'NC-2'].flatMap((task, i) => resolveAll(config, specText({ task, agent: 'codex' }, scratch.sub(`limit-none/repo${i}`))));
    const { ctx, runner } = makeContext(config);
    await assert.rejects(newTasks(ctx, specs), /limit for codex reached/);
    assert.deepEqual(runner.commands, []);
  });
});
