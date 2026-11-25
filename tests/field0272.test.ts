import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chatLoads } from '../src/core/chat-quotas.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { planSetLimits } from '../src/core/limits.ts';
import { dependencyVerdict, journalOutputs, parseOutputs } from '../src/core/outputs.ts';
import { announceBlocked, planQueueAdd, queueTick, queueViews, QueueMemory, readQueue, saveEntry } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import * as usage from '../src/core/usage.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { WatchSteps } from '../src/core/watch-steps.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier = { notify: async () => {} };
function world(name: string, yaml = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, 'capacity: {snapshot: false, codex_refresh: false}\n' + yaml);
  const tmux = new FakeTmux(config.session);
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const repo = scratch.sub(name + '/repo');
  const spec = (task: string, extra = '') => `---\ntask: ${task}\nagent: codex\n${extra}repos: [{path: ${repo}, worktree: ${root}/${task.toLowerCase()}}]\n---\nFixture.\n`;
  return { config, tmux, runner, ctx, spec };
}

const block = '\n```agentctl-outputs\nversion: 1\nverdict: PASS\n```\n';
function writeReport(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('W110-A: repeated misses are promoted and a ten-minute stall requests a restart', async () => {
  const { ctx, runner, config } = world('stage');
  const steps = new WatchSteps();
  const name = 'task delivery and reports';
  const stages = new Map([['status collection', null], [name, null]]);
  const time = runner.now();
  for (let tick = 0; tick < 4; tick++) {
    await steps.run(ctx, path.join(config.cache, 'watch.log'), name, async () => { throw Error('fixture slow filesystem'); });
  }
  assert.equal(steps.priority?.(stages), name);
  await runner.sleep(600_001);
  assert.deepEqual(steps.stalled?.(runner.now()), [name]);
  await steps.run(ctx, path.join(config.cache, 'watch.log'), name, async () => {});
  assert.deepEqual(steps.stalled?.(time + 600_001), []);
});

test('W110-B: complete report and an idle pane with an update footer become report-ready', async () => {
  const { ctx, config, tmux } = world('footer');
  const pane = tmux.add('merge', 'Update available! Run: brew upgrade claude-code');
  const record = seedTask(config, 'MERGE', { windowId: pane.id, attemptId: 'fixture-attempt', outputsProtocol: 1, turnEndedAt: '' });
  writeReport(record.report, 'Werdykt: PASS\n' + block);
  const row = async () => (await collectStatus(ctx, { progress: false }))[0];
  assert.equal((await row())?.state, 'report-ready');
  pane.screen = 'Working (esc to interrupt)';
  assert.equal((await row())?.state, 'working');
  pane.screen = 'Update available! Run: brew upgrade claude-code';
  writeReport(record.report, 'Werdykt: FAIL\n' + block + '\n<!-- agentctl:report-end -->\n');
  assert.equal((await row())?.verdict, 'FAIL');
});

test('W110-C: watch rechecks a missing window before recording loss', async () => {
  const { ctx, config, tmux, runner } = world('window');
  const pane = tmux.add('working', 'Working (esc to interrupt)');
  seedTask(config, 'WORKING', { windowId: pane.id });
  const exec = runner.exec.bind(runner);
  let statusInventory = false;
  runner.exec = async (cmd, args, opts) => {
    if (statusInventory && cmd === 'tmux' && args.includes('list-windows')) {
      statusInventory = false;
      return {code: 1, stdout: '', stderr: 'fixture inventory gap'};
    }
    return exec(cmd, args, opts);
  };
  const memory = new WatchMemory();
  const step = memory.steps.run.bind(memory.steps);
  memory.steps.run = (ctx, log, name, run, clock) => {
    if (name === 'status collection') statusInventory = true;
    return step(ctx, log, name, run, clock);
  };
  await watchTick(ctx, memory, notifier);
  assert.equal(memory.tasks.get('WORKING')?.state, 'working');
  assert.equal(readJournal(config).some(event => event.kind === 'tmux-lost'), false);
});

test('W110-D: a failed Codex version check retries three times and records the output', async () => {
  const { ctx, config, runner, spec } = world('cli-check');
  const real = runner.exec.bind(runner);
  runner.exec = (cmd, args, opts) => cmd === 'codex' && args[0] === '--version'
    ? Promise.resolve({ code: 1, stdout: '', stderr: 'fixture diagnostic' }) : real(cmd, args, opts);
  const memory = new QueueMemory();
  await saveEntry(ctx, { task: 'RETRY', seq: 1, order: 1, status: 'queued', agent: 'codex', model: 'gpt-5.5', effort: 'high', priority: 'normal', after: [], spec: spec('RETRY'), queuedAt: new Date(runner.now()).toISOString() });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await queueTick(ctx, memory, notifier);
    await memory.idle();
    const entry = readQueue(config)[0]!;
    assert.equal(entry.status, attempt <= 3 ? 'queued' : 'failed', entry.error ?? '');
    assert.equal(entry.attempts?.length, attempt);
    assert.equal(entry.attempts?.at(-1)?.transient, true);
    if (entry.retryAt) await runner.sleep(Date.parse(entry.retryAt) - runner.now());
  }
  assert.equal(readJournal(config).filter(e => e.kind === 'queue-retry' && e.text.includes('fixture diagnostic')).length, 3);
});

test('W110-E: closed dependency without a report has warnings, a queue reason and a durable event', async () => {
  const { ctx, config, runner, spec } = world('after');
  seedTask(config, 'AUTHOR', { closed: true });
  const text = spec('AFTER', 'after: AUTHOR\n');
  const preview = await planQueueAdd(ctx, splitSpecs(text, 'fixture'));
  assert.match(preview.summary.join('\n'), /WARNING: after AUTHOR.*verdict missing/);
  await saveEntry(ctx, { task: 'AFTER', seq: 1, order: 1, status: 'queued', agent: 'codex', model: 'gpt-5.5', effort: 'high', priority: 'normal', after: ['AUTHOR'], spec: text, queuedAt: new Date(runner.now()).toISOString() });
  const rows = await collectStatus(ctx, { progress: false, archived: true });
  await announceBlocked(ctx, notifier, rows);
  assert.match((await queueViews(ctx))[0]!.condition.text, /AUTHOR.*verdict missing/);
  assert.equal(readJournal(config).filter(e => e.kind === 'blocked' && e.task === 'AFTER').length, 1);
});

test('W110-F: leading verdict tokens accept trailing findings and ambiguity is journaled', async () => {
  const { ctx, config } = world('verdict');
  assert.equal(dependencyVerdict('Werdykt: PASS (with findings: inspect)'), 'PASS');
  assert.equal(dependencyVerdict('Verdict: PASS with findings(details)'), 'PARTIAL');
  const record = seedTask(config, 'AMBIGUOUS');
  writeReport(record.report, 'Werdykt: maybe PASS or FAIL\n' + block + '\n<!-- agentctl:report-end -->\n');
  await journalOutputs(ctx, record);
  await journalOutputs(ctx, record);
  assert.equal(readJournal(config).filter(e => e.kind === 'ambiguous-verdict' && e.task === record.task).length, 1);
});

test('W110-G: outputs retain deferred cells and silently ignore namespaced extensions', () => {
  const data = parseOutputs(block.replace('verdict: PASS', 'verdict: PASS\ndeferred: [{cell: smoke, where: pc}]\nx_extra: fixture'));
  assert.equal(data.outputs_valid, true, data.outputs_errors.join('\n'));
  assert.deepEqual(data.outputs?.deferred, [{cell: 'smoke', where: 'pc'}]);
});

test('W110-H: off and null erase a provider quota even with an inherited share, whereas 0 blocks', () => {
  const { config } = world('quota', 'limits: {codex: 12}\nquotas: {default: {codex: 2}, chats: {nc: {share: 20, codex: 0}}}\n');
  for (const value of ['off', null]) {
    const plan = planSetLimits(config, {}, undefined, undefined, Date.now(), {quota: {chat: 'nc', codex: value}});
    assert.match(plan.summary.join('\n'), /0 \(blocked\).*off \(no quota\)/);
  }
  const cleared = world('quota-cleared', 'limits: {codex: 12}\nquotas: {default: {codex: 2}, chats: {nc: {share: 20, codex: off}}}\n');
  assert.equal(chatLoads(cleared.config, 'codex', []).find(chat => chat.chat === 'chat:nc')?.share, null);
});

test('W110-I: short-window samples expire after two windows and disappear from the plan', () => {
  const now = Date.now();
  const w = {kind: 'session' as const, minutes: 60, resetsAt: null, usedPercent: 99};
  assert.equal(usage.planState('kimi', {at: now - 119 * 60000, windows: [w], planType: null}, now, '').maxPercent, 99);
  assert.equal(usage.planState('kimi', {at: now - 121 * 60000, windows: [w], planType: null}, now, '').maxPercent, null);
  assert.match(usage.stalePlanLabel?.(235 * 3600000) ?? '', /n\/d/);
});
