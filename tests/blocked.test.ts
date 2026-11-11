import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { liveWindows } from '../src/core/plan.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, queueTick, QueueMemory, readQueue, unblockEntry } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const specOf = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const queueUp = async (text: string): Promise<void> => {
    const plan = await planQueueAdd(ctx, splitSpecs(text, 't'));
    await commitQueueAdd(ctx, plan.items);
  };
  const conditions = async (): Promise<Record<string, string>> => {
    const views = describeQueue(config, readQueue(config), await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true }));
    return Object.fromEntries(views.map((v) => [v.entry.task, v.condition.text]));
  };
  /** An author with a running window. */
  const author = (task: string): void => {
    seedTask(config, task);
    tmux.add(task.toLowerCase(), WORKING);
  };
  return { root, repo, config, tmux, runner, ctx, out, notified, notifier, specOf, queueUp, conditions, author };
}

describe('blocked: a queued task whose after names a cancelled task', () => {
  it('is blocked (⛓) with the cause in queue list, status and the JSON; the cancel names the tasks it blocks', async () => {
    const s = setup('block');
    s.author('A-1');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n') + s.specOf('C-3'));
    assert.equal((await s.conditions())['B-2'], 'czeka na A-1');
    const plan = await planCancel(s.ctx, ['A-1']);
    assert.deepEqual(plan.items[0]?.blocks, ['B-2']);
    assert.match(plan.summary.join('\n'), /⛓ waiting for them, they become blocked: B-2/);
    await cancelTasks(s.ctx, plan);
    assert.match(s.out.join('\n'), /⛓ B-2 is blocked: it waited for A-1\. agentctl unblock B-2 --drop-after A-1, or agentctl cancel B-2/);
    const c = await s.conditions();
    assert.equal(c['B-2'], '⛓ zablokowane – A-1 anulowane');
    assert.notEqual(c['C-3'], c['B-2']);
    const list = await runCli(s.config, s.runner, ['queue', 'list']);
    assert.match(list.stdout, /B-2 .*⛓ zablokowane – A-1 anulowane/);
    assert.match(list.stdout, /hint: B-2 is blocked: agentctl unblock B-2 \[--drop-after <task>\], or agentctl cancel B-2/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['queue', 'list', '--json'])).stdout) as { task: string; blocked: boolean; after: string[] }[];
    assert.deepEqual(json.map((j) => [j.task, j.blocked, j.after]), [['B-2', true, ['A-1']], ['C-3', false, []]]);
    const status = await runCli(s.config, s.runner, ['status', '--all']);
    assert.match(status.stdout, /Queue \(2\)[\s\S]*B-2 {2}⛓ zablokowane – A-1 anulowane/);
  });

  it('a cancelled author with a report still blocks: the report of an abandoned task is not a result to build on', async () => {
    const s = setup('report');
    const a = seedTask(s.config, 'A-1');
    fs.mkdirSync(path.dirname(a.report), { recursive: true });
    fs.writeFileSync(a.report, 'Verdict: PASS\n# result\n');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n'));
    assert.match((await s.conditions())['B-2'] ?? '', /wolne miejsce/, 'with its report A-1 would let B-2 start');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    assert.equal((await s.conditions())['B-2'], '⛓ zablokowane – A-1 anulowane');
  });

  it('a task that waits for a blocked task is blocked too; a blocked task never starts even when a window is free', async () => {
    const s = setup('transitive');
    s.author('A-1');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n') + s.specOf('C-3', 'after: B-2\n') + s.specOf('D-4'));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    const c = await s.conditions();
    assert.equal(c['B-2'], '⛓ zablokowane – A-1 anulowane');
    assert.equal(c['C-3'], '⛓ zablokowane – B-2 zablokowane');
    const memory = new QueueMemory();
    const began = await queueTick(s.ctx, memory, s.notifier, {});
    await memory.idle();
    assert.deepEqual(began, ['D-4']);
  });

  it('cancelling the blocked task is the other way out', async () => {
    const s = setup('cancelblocked');
    s.author('A-1');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n'));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['B-2']));
    assert.deepEqual(readQueue(s.config), []);
    const rows = await collectStatus(s.ctx, { progress: false, archived: true });
    assert.deepEqual(rows.map((r) => [r.task, r.state]), [['A-1', 'cancelled'], ['B-2', 'cancelled']]);
  });

  it('queue and new refuse an after that names a cancelled task', async () => {
    const s = setup('refuse');
    s.author('A-1');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(s.specOf('B-2', 'after: A-1\n'), 't')), /B-2: after A-1: A-1 was cancelled, so it never gets a report/);
    const r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => s.specOf('B-2', 'after: A-1\n') });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /A-1 was cancelled, so it never gets a report/);
  });
});

describe('blocked: the notification', () => {
  it('one notice per cancelled author, "<TASK> zablokowane – <AUTOR> anulowane", also after the watcher restarts', async () => {
    const s = setup('notice');
    s.author('A-1');
    s.author('A-2');
    await s.queueUp(s.specOf('B-3', 'after: [A-1, A-2]\n'));
    await watchTick(s.ctx, new WatchMemory(), s.notifier);
    assert.deepEqual(s.notified, []);
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    assert.deepEqual(s.notified, ['B-3 zablokowane – A-1 anulowane']);
    await watchTick(s.ctx, memory, s.notifier);
    await watchTick(s.ctx, new WatchMemory(), s.notifier);
    assert.deepEqual(s.notified, ['B-3 zablokowane – A-1 anulowane'], 'once');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-2']));
    await watchTick(s.ctx, memory, s.notifier);
    assert.deepEqual(s.notified, ['B-3 zablokowane – A-1 anulowane', 'B-3 zablokowane – A-2 anulowane'], 'a second author is news');
  });
});

describe('unblock', () => {
  it('drops the cancelled tasks from after (in the entry and in its spec); the task is back in the queue and starts', async () => {
    const s = setup('unblock');
    s.author('A-1');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n'));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    const r = await runCli(s.config, s.runner, ['unblock', 'b-2']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /B-2: no longer waits for A-1; back in the queue/);
    const [entry] = readQueue(s.config);
    assert.deepEqual(entry?.after, []);
    assert.doesNotMatch(entry?.spec ?? '', /after/);
    assert.deepEqual(splitSpecs(entry?.spec ?? '', 't')[0]?.header.after, undefined);
    assert.match((await s.conditions())['B-2'] ?? '', /wolne miejsce/);
    const memory = new QueueMemory();
    assert.deepEqual(await queueTick(s.ctx, memory, s.notifier, {}), ['B-2']);
    await memory.idle();
  });

  it('--drop-after drops one author; the task still waits for the others', async () => {
    const s = setup('dropone');
    s.author('A-1');
    s.author('A-2');
    await s.queueUp(s.specOf('B-3', 'after: [A-1, A-2]\n'));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['A-1']));
    const r = await runCli(s.config, s.runner, ['unblock', 'B-3', '--drop-after', 'a-1']);
    assert.match(r.stdout, /B-3: no longer waits for A-1; back in the queue, still waiting for A-2/);
    assert.deepEqual(readQueue(s.config)[0]?.after, ['A-2']);
    assert.deepEqual(splitSpecs(readQueue(s.config)[0]?.spec ?? '', 't')[0]?.header.after, ['A-2']);
    assert.equal((await s.conditions())['B-3'], 'czeka na A-2');
  });

  it('says why it cannot: not blocked, not in after, not in the queue', async () => {
    const s = setup('unblockerr');
    s.author('A-1');
    await s.queueUp(s.specOf('B-2', 'after: A-1\n'));
    await assert.rejects(unblockEntry(s.ctx, 'B-2'), /B-2 is not blocked/);
    await assert.rejects(unblockEntry(s.ctx, 'B-2', { dropAfter: 'ZZ-9' }), /B-2 does not wait for ZZ-9/);
    const r = await runCli(s.config, s.runner, ['unblock', 'Q-9']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Q-9 is not in the queue/);
    // dropping an after that is not cancelled works too: it is the human's call
    const dropped = await unblockEntry(s.ctx, 'B-2', { dropAfter: 'A-1' });
    assert.deepEqual(dropped.dropped, ['A-1']);
  });
});
