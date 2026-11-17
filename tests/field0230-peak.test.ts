import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { describeQueue, queueTick, QueueMemory, saveEntry } from '../src/core/queue.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const order = (task = 'NEXT', extra = '') => `---\ntask: ${task}\nagent: glm\n${extra}\nrepos: [{path: REPO, worktree: WORKTREE}]\n---\nFake.`;
it('F7: default Singapore peak holds winter/summer starts, excludes weekends and never interrupts running tasks', async () => {
  const config = makeConfig(scratch.sub('default'), 'providers: [claude, codex, glm]');
  const at = Date.parse('2026-11-17T06:00:00Z');
  const tmux = new FakeTmux(); tmux.add('running', 'Working (esc to interrupt)');
  const runner = new DiskRunner({dryRun: false, startTime: at, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'RUNNING', {agent: 'glm'});
  await saveEntry(ctx, {seq: 1, order: 1, task: 'NEXT', status: 'queued', agent: 'glm', model: 'default', effort: 'high', priority: 'normal', after: [], queuedAt: new Date(at).toISOString(), spec: order()});
  const entry = (await import('../src/core/queue.ts')).readQueue(config)[0]!;
  for (const time of ['2026-11-17T06:00:00Z', '2026-07-14T09:59:59Z']) {
    assert.match(describeQueue(config, [entry], [], [], Date.parse(time))[0]!.condition.text, /glm: szczyt do/);
  }
  for (const time of ['2026-11-17T05:59:59Z', '2026-11-17T10:00:00Z', '2026-11-21T07:00:00Z']) {
    assert.equal(describeQueue(config, [entry], [], [], Date.parse(time))[0]!.condition.kind, 'ready');
  }
  assert.deepEqual(await queueTick(ctx, new QueueMemory(), {notify: async () => {}}), []);
  assert.equal(tmux.windows.filter(w => w.name === 'running').length, 1);
  assert.ok(!runner.commands.some(c => /send-keys|kill-window|worktree add/.test(c)));
});
it('F7: short_only permits exact classes/peak_ok and admission rechecks the policy', async () => {
  const config = makeConfig(scratch.sub('short'), 'providers: [claude, codex, glm]\nproviders_config: {glm: {peak_policy: short_only}}');
  const {peakHold, peakState} = await import('../src/core/peak.ts');
  const now = Date.parse('2026-11-17T07:00:00Z');
  for (const name of ['report', 'simple', 'smoke', 'gate']) assert.equal(peakHold(config, {agent: 'glm', class: name}, now), undefined);
  assert.equal(peakHold(config, {agent: 'glm', peakOk: true}, now), undefined);
  assert.match(peakHold(config, {agent: 'glm', class: 'complex'}, now)!, /szczyt/);
  assert.equal(peakState(config, 'glm', now)!.until, '2026-11-17T10:00:00.000Z');
  const spec = resolveSpec(splitSpecs(order('OK', 'peak_ok: true').replace('REPO', scratch.sub('short/repo')).replace('WORKTREE', scratch.sub('short/wt')))[0]!, {config});
  assert.equal(spec.peakOk, true);
});
it('F7: Europe/Warsaw windows follow DST; overnight ranges honor their starting weekday; invalid zones/times fail', async () => {
  const {peakState} = await import('../src/core/peak.ts');
  const config = makeConfig(scratch.sub('warsaw'), 'providers_config: {glm: {peak: [{days: mon-fri, from: "07:00", to: "11:00", tz: Europe/Warsaw}]}}');
  assert.equal(peakState(config, 'glm', Date.parse('2026-11-17T07:00Z'))!.until, '2026-11-17T10:00:00.000Z');
  assert.equal(peakState(config, 'glm', Date.parse('2026-07-14T07:00Z'))!.until, '2026-07-14T09:00:00.000Z');
  const overnight = makeConfig(scratch.sub('night'), 'providers_config: {glm: {peak: [{days: fri, from: "23:00", to: "02:00", tz: Europe/Warsaw}]}}');
  assert.ok(peakState(overnight, 'glm', Date.parse('2026-11-21T00:30Z')));
  assert.equal(peakState(overnight, 'glm', Date.parse('2026-11-21T01:00Z')), null);
  for (const [key, value] of [['tz', 'Mars/Olympus'], ['from', '25:00'], ['days', 'workdays']]) assert.throws(() => makeConfig(scratch.sub(`bad-${key}`), JSON.stringify({providers_config: {glm: {peak: [{days: 'mon-fri', from: '07:00', to: '11:00', tz: 'Europe/Warsaw', [key]: value}]}}})));
});
