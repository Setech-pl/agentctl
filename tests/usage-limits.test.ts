import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, QueueMemory, queueTick, readQueue } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { summarizeSpecs } from '../src/core/summary.ts';
import { openReader, readPlans } from '../src/core/usage.ts';
import { alertsFile, levelOf, pendingAlerts, providerHint, queueHolds, usageSummaryLines, usageTick } from '../src/core/usage-limits.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, useScratch } from './helpers.ts';
import { makeWorld, setClaudePlan, setCodexPlan } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function setup(name: string, usageYaml = '', plan: { claude?: { session: number; week: number }; codex?: { session: number; week: number } } = {}) {
  const w = makeWorld(scratch, name, usageYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, w.config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  let codexFile = '';
  let stamp = 0;
  const setCodex = (p: { session: number; week: number }): void => {
    codexFile = codexFile || w.codexSession(w.worktree('plan-holder'), 'plan-holder', new Date(NOW - 3600_000).toISOString());
    setCodexPlan(codexFile, NOW, p);
    // a new reading is a new write: the signature of the reader's cache is the size and the time of the log
    fs.appendFileSync(codexFile, '\n');
    fs.utimesSync(codexFile, new Date(), new Date(Date.now() + (stamp += 1000)));
  };
  if (plan.claude) setClaudePlan(w.config.path, NOW, plan.claude);
  if (plan.codex) setCodex(plan.codex);
  return { ...w, tmux, runner, ctx, out, notified, notifier, setCodex };
}

const plansOf = (s: ReturnType<typeof setup>) => readPlans(s.config, openReader(s.config), NOW);

describe('thresholds', () => {
  const config = makeConfig(scratch.sub('levels'), 'usage:\n  warn: {claude: 60}\n  critical: 90\n');
  it('warn and critical per provider', () => {
    assert.deepEqual([59, 60, 89, 90].map((p) => levelOf(config, 'claude', p)), [undefined, 'warn', 'warn', 'critical']);
    assert.deepEqual([79, 80, 90].map((p) => levelOf(config, 'codex', p)), [undefined, 'warn', 'critical']);
  });
});

describe('alerts: one notification per threshold and window period', () => {
  it('a window over usage.warn alerts once; critical alerts once more; nothing repeats', () => {
    const s = setup('pending', '', { codex: { session: 85, week: 10 } });
    const plans = plansOf(s);
    const first = pendingAlerts(s.config, plans, {});
    assert.deepEqual(first.map((a) => [a.provider, a.window.kind, a.level]), [['codex', 'session', 'warn']]);
    const ledger = { [first[0]!.key]: 'warn' as const };
    assert.deepEqual(pendingAlerts(s.config, plans, ledger), []);
    s.setCodex({ session: 97, week: 10 });
    const worse = pendingAlerts(s.config, plansOf(s), ledger);
    assert.deepEqual(worse.map((a) => a.level), ['critical']);
    assert.deepEqual(pendingAlerts(s.config, plansOf(s), { [first[0]!.key]: 'critical' }), []);
  });

  it('a window that jumped over warn straight to critical gets one alert, critical', () => {
    const s = setup('jump', '', { claude: { session: 99, week: 5 } });
    assert.deepEqual(pendingAlerts(s.config, plansOf(s), {}).map((a) => a.level), ['critical']);
  });

  it('usageTick sends the text once, writes the ledger, and says again only for the next level or the next period', async () => {
    const s = setup('tick', '', { codex: { session: 85, week: 10 }, claude: { session: 20, week: 20 } });
    const sent = await usageTick(s.ctx, s.notifier);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /^Codex: 85% limitu 5h \(reset \d\d:\d\d\) – blisko limitu; claude ma zapas \(20%\): --agent claude$/);
    assert.deepEqual(s.notified, sent);
    assert.ok(fs.existsSync(alertsFile(s.config)));
    assert.deepEqual(await usageTick(s.ctx, s.notifier), []);
    assert.deepEqual(await usageTick(new Context(s.runner, s.config, () => {}), s.notifier), [], 'a new process (a restarted watcher) does not repeat it');
    s.setCodex({ session: 96, week: 10 });
    const critical = await usageTick(s.ctx, s.notifier);
    assert.match(critical[0]!, /limit prawie wyczerpany/);
    assert.deepEqual(await usageTick(s.ctx, s.notifier), []);
    // the window resets and a new period starts at 90% again: a new alert
    const ledger = JSON.parse(fs.readFileSync(alertsFile(s.config), 'utf8')) as Record<string, string>;
    const key = Object.keys(ledger)[0]!;
    fs.writeFileSync(alertsFile(s.config), JSON.stringify({ [key.replace(/\|\d+$/, '|1')]: 'critical' }));
    assert.equal((await usageTick(s.ctx, s.notifier)).length, 1);
  });

  it('no hint to the other provider when it is close too, or n/d', async () => {
    const both = setup('nohint1', '', { codex: { session: 85, week: 10 }, claude: { session: 90, week: 10 } });
    assert.equal(providerHint(both.config, plansOf(both), 'codex'), undefined);
    const alone = setup('nohint2', '', { codex: { session: 85, week: 10 } });
    assert.equal(providerHint(alone.config, plansOf(alone), 'codex'), undefined);
    assert.match((await usageTick(alone.ctx, alone.notifier))[0]!, /^Codex: 85% limitu 5h .* – blisko limitu$/);
  });

  it('watchTick runs it: one notification, not one per tick', async () => {
    const s = setup('watch', '', { codex: { session: 88, week: 10 } });
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    await watchTick(s.ctx, memory, s.notifier);
    assert.equal(s.notified.filter((m) => /Codex: 88%/.test(m)).length, 1);
  });
});

describe('hint before a task starts', () => {
  it('names the provider with room and says --agent; both plans are shown', () => {
    const s = setup('hint', '', { codex: { session: 15, week: 10 }, claude: { session: 83, week: 40 } });
    const lines = usageSummaryLines(s.config, [{ task: 'NC-1', agent: 'claude', pin: false }, { task: 'NC-2', agent: 'codex', pin: false }], NOW);
    assert.match(lines[0]!, /^plan:\s+claude 5h 83% ↻ \d\d:\d\d · week 40% ↻ \w{3} \d\d:\d\d$/);
    assert.match(lines[1]!, /^plan:\s+codex 5h 15%/);
    assert.deepEqual(lines.slice(2), ['hint:     NC-1: claude blisko limitu (83%), codex ma zapas (15%): --agent codex']);
  });

  it('a pinned task is told it stays; no switching is offered', () => {
    const s = setup('pin', '', { codex: { session: 15, week: 10 }, claude: { session: 83, week: 40 } });
    const lines = usageSummaryLines(s.config, [{ task: 'NC-1', agent: 'claude', pin: true }], NOW);
    assert.match(lines.at(-1)!, /NC-1 is pinned \(pin: true\): it stays on claude/);
    assert.equal(lines.some((l) => l.includes('--agent')), false);
  });

  it('a plan that is n/d is shown as n/d and gives no hint', () => {
    const s = setup('nd');
    const lines = usageSummaryLines(s.config, [{ task: 'NC-1', agent: 'claude', pin: false }], NOW);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^plan:\s+claude n\/d \(/);
  });

  it('is part of the summary of new --clip and of queue', async () => {
    const s = setup('summary', '', { codex: { session: 15, week: 10 }, claude: { session: 83, week: 40 } });
    const repo = s.worktree('repo');
    const text = `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-nc1}\n---\nPrompt.\n`;
    const plan = await planQueueAdd(s.ctx, splitSpecs(text, 't'));
    assert.ok(plan.summary.some((l) => /^plan:\s+claude 5h 83%/.test(l)));
    assert.ok(plan.summary.some((l) => /--agent codex/.test(l)));
    assert.deepEqual(summarizeSpecs([], ['plan: x']), ['plan: x']);
  });
});

describe('usage.queue_hold', () => {
  const queueSpec = (repo: string, task: string, agent: string): string => `---\ntask: ${task}\nagent: ${agent}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;

  it('off by default: the queue starts a task whatever the plan says', () => {
    const s = setup('hold-off', '', { claude: { session: 99, week: 5 } });
    assert.deepEqual(queueHolds(s.config, NOW), {});
  });

  it('above the limit the provider is held, with the window and its reset; the other provider is not', () => {
    const s = setup('hold-on', '  queue_hold: 90\n', { claude: { session: 96, week: 5 }, codex: { session: 20, week: 5 } });
    const holds = queueHolds(s.config, NOW);
    assert.deepEqual(Object.keys(holds), ['claude']);
    assert.match(holds.claude!, /^wstrzymane: claude 96% limitu 5h \(reset \d\d:\d\d\) > usage.queue_hold 90%$/);
  });

  it('at or below the limit nothing is held; a plan that is n/d never holds', () => {
    const s = setup('hold-edge', '  queue_hold: {claude: 90, codex: 50}\n', { claude: { session: 90, week: 5 } });
    assert.deepEqual(queueHolds(s.config, NOW), {});
  });

  it('queue list says so, and the tick does not start the task (and logs it once); another provider still starts', async () => {
    const s = setup('hold-tick', '  queue_hold: 90\n', { claude: { session: 96, week: 5 }, codex: { session: 20, week: 5 } });
    const repo = s.worktree('app');
    for (const [task, agent] of [['Q-1', 'claude'], ['Q-2', 'codex']] as const) {
      const plan = await planQueueAdd(s.ctx, splitSpecs(queueSpec(repo, task, agent), 't'));
      await commitQueueAdd(s.ctx, plan.items);
    }
    const views = describeQueue(s.config, readQueue(s.config), [], [], NOW);
    assert.equal(views.find((v) => v.entry.task === 'Q-1')?.condition.kind, 'hold');
    assert.match(views.find((v) => v.entry.task === 'Q-1')!.condition.text, /wstrzymane: claude 96%/);
    assert.equal(views.find((v) => v.entry.task === 'Q-2')?.condition.kind, 'ready');
    const memory = new QueueMemory();
    const log: string[] = [];
    const began1 = await queueTick(s.ctx, memory, s.notifier, { log: (l) => void log.push(l), rows: [] });
    await memory.idle();
    assert.deepEqual(began1, ['Q-2']);
    await queueTick(s.ctx, memory, s.notifier, { log: (l) => void log.push(l), rows: [] });
    await memory.idle();
    assert.equal(log.filter((l) => /Q-1 wstrzymane/.test(l)).length, 1);
    assert.equal(readQueue(s.config).some((e) => e.task === 'Q-1' && e.status === 'queued'), true);
    // the plan falls below the limit: the held task is released
    setClaudePlan(s.config.path, NOW, { session: 40, week: 5 });
    const began2 = await queueTick(s.ctx, memory, s.notifier, { log: (l) => void log.push(l), rows: [] });
    await memory.idle();
    assert.deepEqual(began2, ['Q-1']);
    const cli = await runCli(s.config, s.runner, ['queue', 'list']);
    assert.equal(cli.code, 0, cli.stderr);
  });
});
