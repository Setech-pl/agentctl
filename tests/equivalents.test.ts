import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import { DEFAULT_EQUIVALENTS, defaultEquivalents, translate } from '../src/core/equivalents.ts';
import type { Order } from '../src/core/equivalents.ts';
import { newTasks } from '../src/core/new.ts';
import { planBatch } from '../src/core/plan.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { readTaskRecord, recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, specText, useScratch } from './helpers.ts';

const scratch = useScratch();
const table = defaultEquivalents();

describe('equivalents table', () => {
  it('translates every default pair in both directions', () => {
    for (const pair of DEFAULT_EQUIVALENTS) {
      const [cm, ce] = pair.claude.split('/') as [string, never];
      const [xm, xe] = pair.codex.split('/') as [string, never];
      const toCodex = translate({ agent: 'claude', model: cm, effort: ce }, 'codex', table);
      assert.deepEqual(toCodex.ok && toCodex.order, { agent: 'codex', model: xm, effort: xe }, pair.claude);
      const toClaude = translate({ agent: 'codex', model: xm, effort: xe }, 'claude', table);
      assert.deepEqual(toClaude.ok && toClaude.order, { agent: 'claude', model: cm, effort: ce }, pair.codex);
    }
  });

  it('has exactly the documented defaults', () => {
    assert.deepEqual(DEFAULT_EQUIVALENTS, [
      { claude: 'haiku/low', codex: 'gpt-6-luna/medium' },
      { claude: 'haiku/medium', codex: 'gpt-6-luna/high' },
      { claude: 'sonnet/medium', codex: 'gpt-6.1-sol/medium' },
      { claude: 'sonnet/high', codex: 'gpt-6.1-sol/high' },
      { claude: 'opus/high', codex: 'gpt-6-astra/medium' },
      { claude: 'opus/xhigh', codex: 'gpt-6-astra/xhigh' },
    ]);
  });

  it('returns the order unchanged for the same provider', () => {
    const order: Order = { agent: 'claude', model: 'whatever', effort: 'low' };
    assert.deepEqual(translate(order, 'claude', table), { ok: true, order });
  });

  it('a missing pair is an error naming the line to add (either direction)', () => {
    const r = translate({ agent: 'claude', model: 'opus', effort: 'low' }, 'codex', table);
    assert.ok(!r.ok);
    assert.match(r.message, /no codex equivalent for claude opus\/low/);
    assert.ok(r.hint.includes('- {claude: "opus/low", codex: "<model>/<effort>"}'));
    const back = translate({ agent: 'codex', model: 'gpt-x', effort: 'high' }, 'claude', table);
    assert.ok(!back.ok);
    assert.ok(back.hint.includes('- {claude: "<model>/<effort>", codex: "gpt-x/high"}'));
  });

  it('fable and effort max are not mapped, with their own hint', () => {
    for (const order of [
      { agent: 'claude', model: 'fable', effort: 'high' },
      { agent: 'claude', model: 'opus', effort: 'max' },
    ] as Order[]) {
      const r = translate(order, 'codex', table);
      assert.ok(!r.ok);
      assert.match(r.message, /fable and effort max are not mapped/);
      assert.match(r.hint, /pin: true/);
    }
  });

  it('user pairs from the config come first and may map what the defaults refuse', () => {
    const dir = scratch.sub('eq-config');
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'equivalents:\n  - {claude: "opus/high", codex: "my-model/high"}\n  - {claude: "fable/max", codex: "my-big/xhigh"}\n',
    );
    const config = loadGlobalConfig(dir);
    const a = translate({ agent: 'claude', model: 'opus', effort: 'high' }, 'codex', config.equivalents);
    assert.deepEqual(a.ok && a.order.model, 'my-model');
    const b = translate({ agent: 'codex', model: 'my-big', effort: 'xhigh' }, 'claude', config.equivalents);
    assert.deepEqual(b.ok && b.order, { agent: 'claude', model: 'fable', effort: 'max' });
    // the rest of the defaults is still there
    const c = translate({ agent: 'claude', model: 'haiku', effort: 'low' }, 'codex', config.equivalents);
    assert.deepEqual(c.ok && c.order.model, 'gpt-6-luna');
  });

  it('rejects malformed pairs in the config', () => {
    const dir = scratch.sub('eq-bad');
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'equivalents:\n  - {claude: "opus", codex: "x/ultra"}\n  - {claude: "a/low", gpt: "b/low"}\n');
    assert.throws(
      () => loadGlobalConfig(dir),
      (e: Error) => {
        assert.match(e.message, /equivalents\[0\]\.claude must look like "model\/effort"/);
        assert.match(e.message, /equivalents\[0\]\.codex: effort must be one of low, medium, high, xhigh, max/);
        assert.match(e.message, /equivalents\[1\]: unknown key "gpt"/);
        return true;
      },
    );
  });
});

describe('ordering a provider: --agent, limits, pin, review_of', () => {
  const root = scratch.sub('order');
  const config = makeConfig(root, 'limits: {claude: 1, codex: 2}\n');
  const repo = (n: string): string => scratch.sub(`order/repo-${n}`);
  const resolve = (header: Record<string, string>, name: string): ResolvedSpec[] =>
    splitSpecs(specText(header, repo(name))).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));

  /** Pretend NC-99 (claude) is already running in tmux, so claude's limit of 1 is used up. */
  function claudeBusy() {
    const [busy] = resolve({ task: 'NC-99', agent: 'claude', model: 'sonnet', effort: 'high' }, 'busy');
    fs.mkdirSync(path.dirname(taskFile(config, 'nc-99')), { recursive: true });
    fs.writeFileSync(taskFile(config, 'nc-99'), renderTaskMd(recordFromSpec(busy!, config, 0), 'x'));
    return (cmd: string, args: string[]) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-99\n' } : undefined);
  }

  it('--agent translates the order and keeps requested next to effective', async () => {
    const specs = resolve({ task: 'NC-1', agent: 'claude', model: 'opus', effort: 'high' }, 'a');
    const { ctx } = makeContext(config);
    const [planned] = await planBatch(ctx, specs, { agent: 'codex' });
    assert.deepEqual([planned?.agent, planned?.model, planned?.effort, planned?.switchedBy], ['codex', 'gpt-6-astra', 'medium', 'flag']);
    assert.deepEqual(planned?.requested, { agent: 'claude', model: 'opus', effort: 'high' });
    assert.equal(specs[0]?.agent, 'claude', 'the input is not mutated');
  });

  it('--agent with no pair fails with the line to add, before anything runs', async () => {
    const specs = resolve({ task: 'NC-1', agent: 'claude', model: 'opus', effort: 'low' }, 'b');
    const { ctx, runner } = makeContext(config);
    await assert.rejects(newTasks(ctx, specs, { agent: 'codex' }), (e: Error) => {
      assert.match(e.message, /NC-1: no codex equivalent for claude opus\/low/);
      assert.match(e.message, /- \{claude: "opus\/low", codex: "<model>\/<effort>"\}/);
      return true;
    });
    assert.deepEqual(runner.commands, []);
  });

  it('newTasks starts the translated agent and records requested and effective in TASK.md data', async () => {
    const specs = resolve({ task: 'NC-2', agent: 'claude', model: 'sonnet', effort: 'high' }, 'c');
    const { ctx, runner } = makeContext(config, {
      respond: (cmd, args) => {
        if (cmd === 'tmux' && (args[0] === 'has-session' || args[0] === 'list-windows')) return { code: 1 };
        if (cmd === 'tmux' && args[0] === 'capture-pane') return { stdout: '› Ask Codex to do anything' };
        return undefined;
      },
    });
    const [res] = await newTasks(ctx, specs, { agent: 'codex' });
    assert.ok(runner.commands.includes(`tmux send-keys -t =agentctl:nc-2 -l -- 'codex --sandbox danger-full-access -m gpt-6.1-sol -c model_reasoning_effort=high'`));
    assert.deepEqual(res?.requested, { agent: 'claude', model: 'sonnet', effort: 'high' });
    assert.deepEqual(res?.effective, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    assert.equal(res?.switchedBy, 'flag');
    assert.equal(runner.calls.find((c) => c.line.startsWith('tmux load-buffer'))?.input?.split('\n')[0], 'Model: gpt-6.1-sol · effort high');
  });

  it('TASK.md round-trips requested and effective', () => {
    const [spec] = resolve({ task: 'NC-3', agent: 'codex', model: 'gpt-6-astra', effort: 'medium' }, 'd');
    const switched: ResolvedSpec = { ...spec!, agent: 'claude', model: 'opus', effort: 'high', switchedBy: 'limit' };
    fs.mkdirSync(path.dirname(taskFile(config, 'nc-3')), { recursive: true });
    fs.writeFileSync(taskFile(config, 'nc-3'), renderTaskMd(recordFromSpec(switched, config, 0), 'p'));
    const record = readTaskRecord(config, 'nc-3');
    assert.deepEqual([record?.agent, record?.model, record?.effort, record?.switchedBy], ['claude', 'opus', 'high', 'limit']);
    assert.deepEqual(record?.requested, { agent: 'codex', model: 'gpt-6-astra', effort: 'medium' });
  });

  describe('when the limit of the ordered provider is full', () => {
    const order = (name: string, extra: Record<string, string> = {}) =>
      resolve({ task: 'NC-10', agent: 'claude', model: 'opus', effort: 'high', ...extra }, name);

    it('asks y/n and switches only on "y"', async () => {
      const respond = claudeBusy();
      const questions: string[] = [];
      const yes = makeContext(config, { respond }, async (q) => (questions.push(q), true));
      const [planned] = await planBatch(yes.ctx, order('y'), {});
      assert.equal(questions.length, 1);
      assert.match(questions[0] as string, /claude is full|window limit for claude reached: 1 of 1.*\(nc-99\)/);
      assert.match(questions[0] as string, /Switch to codex gpt-6-astra\/medium \(equivalent of claude opus\/high\)\? \[y\/N\]/);
      assert.deepEqual([planned?.agent, planned?.model, planned?.effort, planned?.switchedBy], ['codex', 'gpt-6-astra', 'medium', 'limit']);
      assert.deepEqual(planned?.requested, { agent: 'claude', model: 'opus', effort: 'high' });

      const no = makeContext(config, { respond }, async () => false);
      await assert.rejects(planBatch(no.ctx, order('n'), {}), /window limit for claude reached: 1 of 1 in session "agentctl" \(nc-99\).*\(switch declined\)/);
    });

    it('without a TTY or with --no-switch it fails with the list of live windows, asking nothing', async () => {
      const respond = claudeBusy();
      const noTty = makeContext(config, { respond });
      await assert.rejects(planBatch(noTty.ctx, order('t'), {}), /\(nc-99\)\. codex has room; switching needs a terminal/);

      let asked = false;
      const flagged = makeContext(config, { respond }, async () => ((asked = true), true));
      await assert.rejects(planBatch(flagged.ctx, order('f'), { noSwitch: true }), /\(nc-99\)\. codex has room; switching was disabled with --no-switch/);
      assert.equal(asked, false);
    });

    it('pin: true forbids the switch and nothing is asked', async () => {
      const respond = claudeBusy();
      let asked = false;
      const m = makeContext(config, { respond }, async () => ((asked = true), true));
      await assert.rejects(planBatch(m.ctx, order('p', { pin: 'true' }), {}), /pinned \(pin: true\)/);
      assert.equal(asked, false);
      await assert.rejects(planBatch(m.ctx, order('p2', { pin: 'true' }), { agent: 'codex' }), /is pinned to claude \(pin: true\) but --agent codex was given/);
    });

    it('a pair-less order cannot be offered a switch', async () => {
      const respond = claudeBusy();
      const m = makeContext(config, { respond }, async () => true);
      const specs = resolve({ task: 'NC-11', agent: 'claude', model: 'opus', effort: 'low' }, 'np');
      await assert.rejects(planBatch(m.ctx, specs, {}), /codex has room, but no codex equivalent for claude opus\/low/);
    });

    it('does not ask when the other provider is full too', async () => {
      const respond = claudeBusy();
      const tight = makeConfig(scratch.sub('order-tight'), 'limits: {claude: 1, codex: 1}\n');
      const [busyCodex] = splitSpecs(specText({ task: 'NC-98', agent: 'codex' }, repo('bc'))).map((raw) => resolveSpec(raw, { config: tight, loadProject: () => undefined }));
      fs.mkdirSync(path.dirname(taskFile(tight, 'nc-98')), { recursive: true });
      fs.writeFileSync(taskFile(tight, 'nc-98'), renderTaskMd(recordFromSpec(busyCodex!, tight, 0), 'x'));
      fs.mkdirSync(path.dirname(taskFile(tight, 'nc-99')), { recursive: true });
      fs.copyFileSync(taskFile(config, 'nc-99'), taskFile(tight, 'nc-99'));
      let asked = false;
      const { ctx } = makeContext(
        tight,
        { respond: (c, a) => (c === 'tmux' && a[0] === 'list-windows' ? { stdout: 'nc-98\nnc-99\n' } : respond(c, a)) },
        async () => ((asked = true), true),
      );
      const spec = splitSpecs(specText({ task: 'NC-12', agent: 'claude', model: 'opus', effort: 'high' }, repo('tt'))).map((raw) => resolveSpec(raw, { config: tight, loadProject: () => undefined }));
      await assert.rejects(planBatch(ctx, spec, {}), /codex is full too/);
      assert.equal(asked, false);
    });
  });

  it('review_of is judged on effective values, after mapping', async () => {
    const [author] = resolve({ task: 'NC-20', agent: 'claude', model: 'opus', effort: 'high' }, 'auth');
    fs.mkdirSync(path.dirname(taskFile(config, 'nc-20')), { recursive: true });
    fs.writeFileSync(taskFile(config, 'nc-20'), renderTaskMd(recordFromSpec(author!, config, 0), 'x'));
    const reviewer = resolve({ task: 'NC-21', agent: 'codex', model: 'gpt-6-astra', effort: 'medium', review_of: 'NC-20' }, 'rev');
    const { ctx } = makeContext(config);
    // as ordered: a different provider, fine
    await planBatch(ctx, reviewer, {});
    // forced onto claude it becomes claude opus/high, the author's own setting: refused
    await assert.rejects(planBatch(ctx, reviewer, { agent: 'claude' }), /NC-21 reviews NC-20 but uses the same agent and model \(claude, opus\)/);
  });
});
