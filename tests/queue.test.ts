import { composerFixture } from './composer-fixture.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { liveWindows } from '../src/core/plan.ts';
import { commitQueueAdd, describeQueue, findEntry, isPaused, moveToFront, planQueueAdd, queueDir, queueLogFile, queueTick, QueueMemory, readQueue, removeFromQueue, renderQueueList, retryEntry, saveEntry, setPaused, waiting } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { checkWindowLimit } from '../src/core/checks.ts';
import { readJournal } from '../src/core/journal.ts';
import { findResumable } from '../src/core/resume.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { WatchMemory, watchLogPath, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

interface Setup {
  config: ReturnType<typeof makeConfig>;
  repo: string;
  tmux: FakeTmux;
  runner: DiskRunner;
  ctx: Context;
  out: string[];
  notified: string[];
  notifier: Notifier;
  memory: QueueMemory;
  tick(): Promise<string[]>;
}

function setup(name: string, extraYaml = 'limits: {claude: 1, codex: 1}\n', respondExtra?: (cmd: string, args: string[]) => { code: number; stderr?: string } | undefined): Setup {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => respondExtra?.(cmd, args) ?? tmux.respond(cmd, args, opts) });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const memory = new QueueMemory();
  return {
    config, repo, tmux, runner, ctx, out, notified, notifier, memory,
    async tick() {
      const began = await queueTick(ctx, memory, notifier, {});
      await memory.idle();
      return began;
    },
  };
}

const specOf = (repo: string, task: string, extra: Record<string, string> = {}, prompt = `Prompt of ${task}.`): string => {
  const header = { task, agent: 'claude', ...extra };
  const lines = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n---\n${prompt}\n`;
};

async function add(s: Setup, text: string, opts: { agent?: 'claude' | 'codex' } = {}): Promise<string[]> {
  const plan = await planQueueAdd(s.ctx, splitSpecs(text, 'test'), opts);
  return (await commitQueueAdd(s.ctx, plan.items, opts)).map((e) => e.task);
}

describe('queue: adding', () => {
  it('writes one numbered entry per task into <config dir>/queue and lists them in turn', async () => {
    const s = setup('add');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    const files = fs.readdirSync(queueDir(s.config)).sort();
    assert.deepEqual(files, ['0001-NC-1.json', '0002-NC-2.json']);
    assert.equal(queueDir(s.config), path.join(path.dirname(s.config.path), 'queue'));
    const entries = readQueue(s.config);
    assert.deepEqual(entries.map((e) => [e.task, e.status, e.priority, e.agent]), [['NC-1', 'queued', 'normal', 'claude'], ['NC-2', 'queued', 'normal', 'claude']]);
    assert.match(entries[0]!.spec, /prompt|Prompt of NC-1/i);
    // the next number goes on from the highest
    await add(s, specOf(s.repo, 'NC-3'));
    assert.ok(fs.existsSync(path.join(queueDir(s.config), '0003-NC-3.json')));
  });

  it('a full provider is no error (that is what the queue is for) and the summary says where the task stands', async () => {
    const s = setup('add-full');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    const plan = await planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-1'), 'test'));
    assert.match(plan.summary.join('\n'), /waits for a free claude window \(1 running, limit 1\)/);
    const free = await planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-2', { agent: 'codex' }), 'test'));
    assert.match(free.summary.join('\n'), /at the next watch tick/);
  });

  it('validates like new: duplicates, existing window, unknown review_of, pin with --agent, codex effort', async () => {
    const s = setup('validate');
    await add(s, specOf(s.repo, 'NC-1'));
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-1'), 'test')), /NC-1 is already in the queue/);
    s.tmux.add('nc-2');
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-2'), 'test')), /tmux window "nc-2" already exists/);
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-3', { review_of: 'NC-77', model: 'opus' }), 'test')), /review_of NC-77: no record/);
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-4', { pin: 'true' }), 'test'), { agent: 'codex' }), /pinned to claude \(pin: true\) but --agent codex/);
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-5', { effort: 'max', model: 'opus' }), 'test'), { agent: 'codex' }), /no equivalent|codex has no effort/);
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['NC-1'], 'nothing was written for the rejected specs');
  });

  it('the cross-review rule sees an author that waits in the queue', async () => {
    const s = setup('review-queued');
    await add(s, specOf(s.repo, 'NC-1', { model: 'opus' }));
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-2', { review_of: 'NC-1', model: 'opus' }), 'test')), /reviews NC-1 but uses the same agent and model/);
    const ok = await planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-2', { review_of: 'NC-1', model: 'sonnet' }), 'test'));
    assert.equal(ok.items.length, 1);
  });

  it('--agent maps the order through the equivalents table and remembers it for the start', async () => {
    const s = setup('map');
    await add(s, specOf(s.repo, 'NC-1', { model: 'opus', effort: 'high' }), { agent: 'codex' });
    const [entry] = readQueue(s.config);
    assert.deepEqual([entry!.agent, entry!.model, entry!.effort, entry!.agentOverride], ['codex', 'gpt-6-astra', 'medium', 'codex']);
  });

  it('priority must be high or normal', async () => {
    const s = setup('prio-bad');
    await assert.rejects(planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'NC-1', { priority: 'urgent' }), 'test')), /priority must be one of high, normal/);
  });
});

describe('queue: order and management', () => {
  it('priority high goes first, FIFO inside a class, up puts a task first in its class', async () => {
    const s = setup('order');
    await add(s, specOf(s.repo, 'A-1') + specOf(s.repo, 'A-2') + specOf(s.repo, 'A-3', { priority: 'high' }) + specOf(s.repo, 'A-4'));
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['A-3', 'A-1', 'A-2', 'A-4']);
    await moveToFront(s.ctx, 'a-4');
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['A-3', 'A-4', 'A-1', 'A-2']);
    await moveToFront(s.ctx, 'A-2');
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['A-3', 'A-2', 'A-4', 'A-1']);
  });

  it('rm takes a task out (a unique prefix works) and tells an unknown one', async () => {
    const s = setup('rm');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'XY-2'));
    assert.equal((await removeFromQueue(s.ctx, 'xy')).task, 'XY-2');
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['NC-1']);
    await assert.rejects(removeFromQueue(s.ctx, 'NC-9'), /NC-9 is not in the queue/);
    assert.equal(findEntry(s.config, 'nc-1').task, 'NC-1');
  });

  it('pause and resume are a marker file; they say whether anything changed', async () => {
    const s = setup('pause');
    assert.equal(isPaused(s.config), false);
    assert.equal(await setPaused(s.ctx, true), true);
    assert.equal(await setPaused(s.ctx, true), false);
    assert.equal(isPaused(s.config), true);
    assert.equal(await setPaused(s.ctx, false), true);
    assert.equal(isPaused(s.config), false);
  });

  it('queue list shows position, condition and age; a full provider is a slot wait, a free one is ready', async () => {
    const s = setup('list');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2', { agent: 'codex' }));
    const views = describeQueue(s.config, readQueue(s.config), await liveWindows(s.ctx));
    assert.deepEqual(views.map((v) => [v.position, v.entry.task, v.condition.kind]), [[1, 'NC-1', 'slot'], [2, 'NC-2', 'ready']]);
    const lines = renderQueueList(views, s.runner.now());
    assert.match(lines[0]!, /^#\s+TASK\s+AGENT\/MODEL\/EFFORT\s+PRIORITY\s+START CONDITION\s+WAITING\s+QUEUED$/);
    assert.match(lines[1]!, /NC-1\s+claude\/default\/high\s+normal\s+czeka na miejsce: claude 1\/1/);
    await setPaused(s.ctx, true);
    assert.equal(describeQueue(s.config, readQueue(s.config), []).every((v) => v.condition.kind === 'paused'), true);
  });
});

describe('queue: starting', () => {
  it('starts the first waiting task when its provider has room, by the path of new (window, TASK.md, prompt), and tells you', async () => {
    const s = setup('start');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    assert.deepEqual(await s.tick(), ['NC-1'], 'limit 1: only the first one starts');
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['NC-2']);
    assert.ok(s.tmux.windows.some((w) => w.name === 'nc-1'));
    assert.equal(readTaskRecord(s.config, 'nc-1')?.agent, 'claude');
    assert.ok(s.runner.commands.some((c) => c.includes('paste-buffer')), 'the prompt was pasted');
    assert.deepEqual(s.notified, ['Uruchomiono NC-1 z kolejki']);
    // a second tick: the provider is still full
    assert.deepEqual(await s.tick(), []);
    // the first one is closed: the second starts by itself
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'nc-1');
    assert.deepEqual(await s.tick(), ['NC-2']);
    assert.deepEqual(readQueue(s.config), []);
    assert.deepEqual(s.notified, ['Uruchomiono NC-1 z kolejki', 'Uruchomiono NC-2 z kolejki']);
  });

  it('a full provider does not hold back a task of the other provider, and it never switches the provider', async () => {
    const s = setup('no-switch');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2', { agent: 'codex' }));
    assert.deepEqual(await s.tick(), ['NC-2'], 'claude is full, codex has room');
    assert.equal(readTaskRecord(s.config, 'nc-2')?.agent, 'codex');
    // codex has room again later, claude never gets a task that was ordered on claude on another provider
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'nc-2');
    assert.deepEqual(await s.tick(), []);
    assert.equal(readTaskRecord(s.config, 'nc-1'), undefined);
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['NC-1']);
  });

  it('priority high starts before older normal tasks', async () => {
    const s = setup('start-prio');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2', { priority: 'high' }));
    assert.deepEqual(await s.tick(), ['NC-2']);
  });

  it('a paused queue and queue.enabled: false start nothing', async () => {
    const s = setup('paused');
    await add(s, specOf(s.repo, 'NC-1'));
    await setPaused(s.ctx, true);
    assert.deepEqual(await s.tick(), []);
    await setPaused(s.ctx, false);
    const off = setup('disabled', 'limits: {claude: 2}\nqueue: {enabled: false}\n');
    await add(off, specOf(off.repo, 'NC-1'));
    assert.deepEqual(await off.tick(), []);
  });

  it('parallel_starts bounds the starts in progress', async () => {
    const s = setup('parallel', 'limits: {claude: 5}\nqueue: {parallel_starts: 1}\n');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    const began = await queueTick(s.ctx, s.memory, s.notifier, {});
    assert.deepEqual(began, ['NC-1']);
    await s.memory.idle();
    assert.deepEqual(await s.tick(), ['NC-2']);
  });

  it('transient starts retry after 1/5/15 minutes, persist attempts, then fail; permanent errors do not retry', async () => {
    const s = setup('transient', 'limits: {claude: 3}\n', (cmd, args) => cmd === 'git' && args.includes('add') ? { code: 1, stderr: 'ETIMEDOUT' } : undefined);
    await add(s, specOf(s.repo, 'RETRY-1'));
    for (const [index, delay] of [60000, 300000, 900000].entries()) {
      assert.deepEqual(await s.tick(), ['RETRY-1']);
      const e = readQueue(s.config)[0]!;
      assert.equal(e.status, 'queued'); assert.equal(e.attempts!.length, index + 1);
      assert.equal(Date.parse(e.retryAt!) - s.runner.now(), delay);
      assert.deepEqual(await s.tick(), []);
      await s.runner.sleep(delay);
    }
    await s.tick();
    const e = readQueue(s.config)[0]!;
    assert.equal(e.status, 'failed'); assert.equal(e.attempts!.length, 4);
    assert.deepEqual(await s.tick(), []);
    assert.equal((await runCli(s.config, s.runner, ['queue', 'show', 'RETRY-1'])).code, 0);
  });

  it('a failed start goes to the end as failed, with a log and a notification, and is not tried again by itself', async () => {
    const s = setup('failed', 'limits: {claude: 3}\n', (cmd, args) => (cmd === 'git' && args.includes('worktree') && args.some((a) => a.endsWith('-nc-1')) ? { code: 128, stderr: 'fatal: boom' } : undefined));
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    assert.deepEqual(await s.tick(), ['NC-1', 'NC-2']);
    const entries = readQueue(s.config);
    assert.deepEqual(entries.map((e) => [e.task, e.status]), [['NC-1', 'failed']]);
    assert.match(entries[0]!.error ?? '', /git worktree add failed.*boom/);
    assert.match(fs.readFileSync(queueLogFile(s.config, entries[0]!), 'utf8'), /error: .*boom/);
    assert.ok(s.notified.some((m) => /NC-1: start z kolejki nie powiódł się – .*boom.*agentctl queue retry NC-1/.test(m)), s.notified.join('|'));
    assert.deepEqual(await s.tick(), [], 'no loop');
    assert.equal(s.notified.filter((m) => m.includes('NC-1')).length, 1);
    const view = describeQueue(s.config, entries, []);
    assert.deepEqual([view[0]!.position, view[0]!.condition.kind], [null, 'failed']);
  });

  it('a failed task stays behind the waiting ones; retry puts it back at the end of the line and reuses its worktree', async () => {
    let broken = true;
    const s = setup('retry', 'limits: {claude: 3}\n', (cmd, args) => (broken && cmd === 'git' && args.includes('worktree') ? { code: 128, stderr: 'fatal: boom' } : undefined));
    await add(s, specOf(s.repo, 'NC-1'));
    await s.tick();
    assert.equal(readQueue(s.config)[0]!.status, 'failed');
    await add(s, specOf(s.repo, 'NC-2'));
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['NC-2', 'NC-1'], 'waiting first, failed last');
    await assert.rejects(retryEntry(s.ctx, 'NC-2'), /NC-2 is queued, not failed/);
    await assert.rejects(moveToFront(s.ctx, 'NC-1'), /is failed, not waiting/);
    const again = await retryEntry(s.ctx, 'NC-1');
    assert.deepEqual([again.status, again.reuse, again.error], ['queued', true, undefined]);
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['NC-2', 'NC-1']);
    broken = false; // retry without an on-disk fixture creates a new complete worktree through the fake git adapter

    assert.deepEqual(await s.tick(), ['NC-2', 'NC-1']);
    assert.equal(readQueue(s.config).length, 0);
  });

  it('a start that its watcher did not finish is marked failed (no one is doing it), unless the task exists', async () => {
    const s = setup('stale');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    const [first, second] = readQueue(s.config);
    for (const e of [first!, second!]) fs.writeFileSync(path.join(queueDir(s.config), `${String(e.seq).padStart(4, '0')}-${e.task}.json`), JSON.stringify({ ...e, status: 'starting' }));
    seedTask(s.config, 'NC-2');
    await s.tick();
    const left = readQueue(s.config);
    assert.deepEqual(left.map((e) => [e.task, e.status]), [['NC-1', 'failed']]);
    assert.match(left[0]!.error ?? '', /interrupted/);
  });

  it('while one task waits for folder trust the others still start', async () => {
    const s = setup('trust', 'limits: {claude: 3}\n');
    const TRUST = 'Quick safety check\n ❯ 1. Yes, I trust this folder';
    let calls = 0;
    const respond = s.tmux.respond;
    const trustFor = (window: string): boolean => window === 'nc-1';
    (s.runner as unknown as { respond: unknown }).respond = (cmd: string, args: string[], opts: never) => {
      if (cmd === 'tmux' && args[0] === 'capture-pane' && trustFor(String(args[args.indexOf('-t') + 1]).split(':').pop() ?? '')) {
        // the dialog stays until the second capture round has happened for the other task
        return { stdout: ++calls < 6 ? TRUST : '❯ Try "x"' };
      }
      return respond(cmd, args, opts);
    };
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    const began = await queueTick(s.ctx, s.memory, s.notifier, {});
    assert.deepEqual(began, ['NC-1', 'NC-2'], 'both starts began in the same tick; neither blocked the loop');
    await s.memory.idle();
    assert.deepEqual(readQueue(s.config), []);
  });
});

describe('new with a full limit proposes the queue', () => {
  const startText = (repo: string): string => specOf(repo, 'NC-1');

  it('with a terminal: "add to the queue?" y queues it, the other tasks of the file still start', async () => {
    const s = setup('new-y');
    s.tmux.newWindowScreen = composerFixture('❯ \n› \n');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    const questions: string[] = [];
    const r = await runCli(s.config, s.runner, ['new', '-'], {
      readStdin: () => startText(s.repo) + specOf(s.repo, 'NC-2', { agent: 'codex' }),
      confirm: async (q) => (questions.push(q), !q.includes('Switch to')),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(questions.some((q) => /NC-1: window limit for claude reached.*Add it to the queue.*\[y\/N\]/s.test(q)), questions.join('|'));
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['NC-1']);
    assert.ok(s.tmux.windows.some((w) => w.name === 'nc-2'), 'the codex task started');
    assert.ok(s.runner.calls.some(c => c.line.includes('load-buffer') && c.input?.includes(readTaskRecord(s.config, 'nc-2')!.report)), '0173-FIX-B queue canonical path');
    assert.match(r.stdout, /NC-1: queued \(position 1\)/);
  });

  it('declined: the old error, now naming agentctl queue', async () => {
    const s = setup('new-n');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    const r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => startText(s.repo), confirm: async () => false });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /window limit for claude reached/);
    assert.match(r.stderr, /agentctl queue <file>/);
    assert.deepEqual(readQueue(s.config), []);
  });

  it('without a terminal: the error with the hint, nothing queued', async () => {
    const s = setup('new-notty');
    s.tmux.add('nc-9');
    seedTask(s.config, 'NC-9', { agent: 'claude' });
    const r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => startText(s.repo) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /window limit for claude reached/);
    assert.match(r.stderr, /queue the task: "agentctl queue <file>"/);
    assert.deepEqual(readQueue(s.config), []);
  });
});

describe('the queue command', () => {
  it('shows the summary and asks y/N; -y skips the question; no terminal and no -y is an error', async () => {
    const s = setup('cli');
    const spec = specOf(s.repo, 'NC-1');
    const asked: string[] = [];
    let r = await runCli(s.config, s.runner, ['queue', '-'], { readStdin: () => spec, confirm: async (q) => (asked.push(q), false) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /NC-1 {2}claude\/default\/high {2}priority normal/);
    assert.deepEqual(asked, ['Add to the queue? [y/N] ']);
    assert.equal(readQueue(s.config).length, 0);
    r = await runCli(s.config, s.runner, ['queue', '-'], { readStdin: () => spec });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no terminal to ask on/);
    r = await runCli(s.config, s.runner, ['queue', '-y', '-'], { readStdin: () => spec });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /NC-1: queued \(position 1 of 1\)/);
    assert.match(r.stdout, /hint: nothing starts the queue unless "agentctl watch" runs/);
  });

  it('--clip reads the clipboard; list, up, rm, pause, resume, retry work from the command line', async () => {
    const s = setup('cli-all');
    let r = await runCli(s.config, s.runner, ['queue', '--clip', '-y'], { readClipboard: async () => specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2') });
    assert.equal(r.code, 0, r.stderr);
    r = await runCli(s.config, s.runner, ['queue', 'up', 'nc-2']);
    assert.match(r.stdout, /NC-2: first in line/);
    r = await runCli(s.config, s.runner, ['queue', 'list']);
    assert.match(r.stdout, /1\s+NC-2[\s\S]*2\s+NC-1/);
    r = await runCli(s.config, s.runner, ['queue', 'list', '--json']);
    assert.deepEqual((JSON.parse(r.stdout) as { task: string; position: number }[]).map((x) => [x.task, x.position]), [['NC-2', 1], ['NC-1', 2]]);
    assert.match((await runCli(s.config, s.runner, ['queue', 'pause'])).stdout, /Queue paused\./);
    assert.match((await runCli(s.config, s.runner, ['queue', 'pause'])).stdout, /already paused/);
    assert.match((await runCli(s.config, s.runner, ['queue', 'list'])).stdout, /paused/);
    assert.match((await runCli(s.config, s.runner, ['queue', 'resume'])).stdout, /Queue resumed\./);
    assert.match((await runCli(s.config, s.runner, ['queue', 'rm', 'NC-1'])).stdout, /NC-1: removed from the queue/);
    const bad = await runCli(s.config, s.runner, ['queue', 'retry', 'NC-2']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /NC-2 is queued, not failed/);
    assert.match((await runCli(s.config, s.runner, ['queue', 'list'])).stdout, /NC-2/);
    assert.match((await runCli(s.config, s.runner, ['queue', 'rm', 'NC-2'])).stdout, /removed/);
    assert.match((await runCli(s.config, s.runner, ['queue', 'list'])).stdout, /The queue is empty\./);
  });
});

describe('watch starts the queue', () => {
  it('a watch tick starts what fits; the next tick, after a close, starts the rest; ending the loop waits for a start in progress', async () => {
    const s = setup('watch');
    await add(s, specOf(s.repo, 'NC-1') + specOf(s.repo, 'NC-2'));
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    await memory.queue.idle();
    assert.ok(s.tmux.windows.some((w) => w.name.endsWith('nc-1')));
    assert.deepEqual(waiting(readQueue(s.config)).map((e) => e.task), ['NC-2']);
    assert.match(fs.readFileSync(watchLogPath(s.ctx), 'utf8'), /queue: starting NC-1[\s\S]*queue: NC-1 started/);
    s.tmux.windows = [];
    await watchTick(s.ctx, memory, s.notifier);
    await memory.queue.idle();
    assert.deepEqual(readQueue(s.config), []);
    assert.ok(s.notified.includes('Uruchomiono NC-2 z kolejki'));
  });
});

describe('after: dependencies', () => {
  const writeReport = (s: Setup, task: string): void => {
    const record = readTaskRecord(s.config, task.toLowerCase())!;
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, `# ${task}\nVerdict: PASS\n<!-- agentctl:report-end -->`);
    const time = new Date(Math.max(Date.now(), Date.parse(record.attemptStarted ?? record.started) + 1)); fs.utimesSync(record.report, time, time);
  };

  it('a task with after waits until the named task has a report, then starts (the other tasks are not held back)', async () => {
    const s = setup('after', 'limits: {claude: 5}\n');
    await add(s, specOf(s.repo, 'NC-1'));
    await s.tick();
    assert.ok(readTaskRecord(s.config, 'nc-1'));
    await add(s, specOf(s.repo, 'NC-1R', { after: 'NC-1', model: 'sonnet', review_of: 'NC-1' }) + specOf(s.repo, 'NC-3'));
    assert.deepEqual(await s.tick(), ['NC-3'], 'the review waits, NC-3 does not');
    const views = describeQueue(s.config, readQueue(s.config), await liveWindows(s.ctx), await collectStatus(s.ctx, { progress: false, archived: true }));
    assert.deepEqual(views.map((v) => [v.entry.task, v.condition.kind, v.condition.text]), [['NC-1R', 'after', 'czeka na NC-1']]);
    assert.deepEqual(await s.tick(), []);
    writeReport(s, 'NC-1');
    assert.deepEqual(await s.tick(), ['NC-1R']);
    assert.deepEqual(readQueue(s.config), []);
  });

  it('a list of tasks: all of them need a report; a closed task with a report counts', async () => {
    const s = setup('after-list', 'limits: {claude: 5}\n');
    await add(s, specOf(s.repo, 'A-1') + specOf(s.repo, 'A-2'));
    await s.tick();
    await add(s, specOf(s.repo, 'A-3', { after: '[A-1, A-2]' }));
    writeReport(s, 'A-1');
    assert.deepEqual(await s.tick(), [], 'A-2 has no report yet');
    writeReport(s, 'A-2');
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'a-2');
    assert.deepEqual(await s.tick(), ['A-3']);
  });

  it('a task that waits in the queue can be named too; a failed one is shown as failed', async () => {
    const s = setup('after-queued', 'limits: {claude: 5}\n', (cmd, args) => (cmd === 'git' && args.includes('worktree') && args.some((a) => a.endsWith('-b-1')) ? { code: 1, stderr: 'boom' } : undefined));
    await add(s, specOf(s.repo, 'B-1') + specOf(s.repo, 'B-2', { after: 'B-1' }));
    await s.tick();
    const views = describeQueue(s.config, readQueue(s.config), [], []);
    assert.deepEqual(views.map((v) => v.condition.text.slice(0, 20)), ['czeka na B-1 (failed)', 'failed: git worktree '].map((t) => t.slice(0, 20)));
  });

  it('a circle or a task that does not exist is an error at adding', async () => {
    const fresh = setup('after-bad2');
    await assert.rejects(planQueueAdd(fresh.ctx, splitSpecs(specOf(fresh.repo, 'C-1', { after: 'C-99' }), 't')), /C-1: after C-99: there is no such task/);
    await assert.rejects(planQueueAdd(fresh.ctx, splitSpecs(specOf(fresh.repo, 'C-1', { after: 'C-1' }), 't')), /after names the task itself/);
    await assert.rejects(planQueueAdd(fresh.ctx, splitSpecs(specOf(fresh.repo, 'C-1', { after: 'C-2' }) + specOf(fresh.repo, 'C-2', { after: 'C-1' }), 't')), /after makes a circle: C-1 -> C-2 -> C-1/);
    await assert.rejects(planQueueAdd(fresh.ctx, splitSpecs(specOf(fresh.repo, 'C-1', { after: '3' }), 't')), /after must be a task ID/);
    // a circle through an entry that is in the queue already
    await add(fresh, specOf(fresh.repo, 'D-1'));
    const entry = readQueue(fresh.config)[0]!;
    fs.writeFileSync(path.join(queueDir(fresh.config), '0001-D-1.json'), JSON.stringify({ ...entry, after: ['D-2'] }));
    await assert.rejects(planQueueAdd(fresh.ctx, splitSpecs(specOf(fresh.repo, 'D-2', { after: 'D-1' }), 't')), /D-2: after makes a circle: D-2 -> D-1 -> D-2/);
    assert.deepEqual(readQueue(fresh.config).map((e) => e.task), ['D-1']);
  });

  it('new refuses a task whose after is not met and points at the queue; once the report is there it starts', async () => {
    const s = setup('after-new', 'limits: {claude: 5}\n');
    await add(s, specOf(s.repo, 'E-1'));
    await s.tick();
    const text = specOf(s.repo, 'E-2', { after: 'E-1', model: 'sonnet' });
    let r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => text });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /E-2: after E-1: czeka na E-1 \(no report yet\)\. "agentctl queue" starts the task by itself/);
    writeReport(s, 'E-1');
    r = await runCli(s.config, s.runner, ['new', '-'], { readStdin: () => text });
    assert.equal(r.code, 0, r.stderr);
  });

  it('a review without after gets a hint in the summary; with after, or when the author has a report, it does not', async () => {
    const s = setup('after-hint', 'limits: {claude: 5}\n');
    await add(s, specOf(s.repo, 'F-1', { model: 'opus' }));
    await s.tick();
    const review = (extra: Record<string, string> = {}): string => specOf(s.repo, 'F-2', { review_of: 'F-1', model: 'sonnet', ...extra });
    const hint = /hint: .*F-2 reviews F-1, which has no report yet: add "after: F-1"/;
    assert.match((await planQueueAdd(s.ctx, splitSpecs(review(), 't'))).summary.join('\n'), hint);
    const withAfter = (await planQueueAdd(s.ctx, splitSpecs(review({ after: 'F-1' }), 't'))).summary.join('\n');
    assert.doesNotMatch(withAfter, /hint:/);
    assert.match(withAfter, /after: {4}F-1 – czeka na F-1/);
    assert.match(withAfter, /start: {4}when F-1 has a report/);
    writeReport(s, 'F-1');
    assert.doesNotMatch((await planQueueAdd(s.ctx, splitSpecs(review(), 't'))).summary.join('\n'), /hint:/);
  });

  it('status prints the queue with what each task waits for', async () => {
    const s = setup('after-status', 'limits: {claude: 5}\n');
    await add(s, specOf(s.repo, 'G-1'));
    await s.tick();
    await add(s, specOf(s.repo, 'G-2', { after: 'G-1' }));
    const r = await runCli(s.config, s.runner, ['status']);
    assert.match(r.stdout, /Queue \(1\): agentctl queue list\n {2}1\. G-2 {2}czeka na G-1/);
  });
});

describe('P33: a start whose window never became ready', () => {
  const MODAL = fs.readFileSync(new URL('./fixtures/screen-codex-update-modal.txt', import.meta.url), 'utf8');

  it('a start stopped at the modal is owned by watch like a trust wait: the entry is dropped, the window and slot stay for the human', async () => {
    const s = setup('modal-start', 'limits: {codex: 1}\n');
    s.tmux.newWindowScreen = MODAL;
    await add(s, specOf(s.repo, 'UPD-1', { agent: 'codex' }));
    const began = await s.tick();
    assert.deepEqual(began, ['UPD-1']);
    assert.deepEqual(readQueue(s.config), [], 'the live task waiting at the dialog must not also be failed in the queue');
    assert.equal(readTaskRecord(s.config, 'upd-1')?.promptDelivery, 'needs-input');
    assert.ok(s.tmux.windows.some((w) => w.name === 'upd-1'), 'a human may be answering the modal: the window stays');
    assert.ok(readJournal(s.config).some((e) => e.kind === 'queue-start' && e.task === 'UPD-1' && /watch obsługuje/.test(e.text)));
    assert.ok(!readJournal(s.config).some((e) => e.kind === 'queue-failed' && e.task === 'UPD-1'));
    assert.match(checkWindowLimit('codex', 1, await liveWindows(s.ctx), s.config.session) ?? '', /window limit for codex reached/, 'a window waiting for a human holds its slot (like a trust wait)');
    // The human answers the modal; watch delivers the pending prompt by itself and the slot frees on its own.
    s.tmux.windows.find((w) => w.name === 'upd-1')!.screen = composerFixture('› Ask Codex to do anything\n');
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    assert.equal(readTaskRecord(s.config, 'upd-1')?.promptDelivery, 'sent');
  });

  it('INT4: a trust timeout keeps a live task pending without a failed queue entry; watch delivers once after trust', async () => {
    const s = setup('trust-timeout', 'limits: {claude: 1}\nagents: {claude: {trust_timeout: 1}}\n');
    s.tmux.newWindowScreen = 'Quick safety check\n ❯ 1. Yes, I trust this folder';
    await add(s, specOf(s.repo, 'TRUST-1'));
    await s.tick();
    const pane = s.tmux.windows.find(w => w.name === 'trust-1');
    assert.ok(pane, 'a human can still answer trust');
    assert.equal(readTaskRecord(s.config, 'trust-1')?.promptDelivery, 'pending');
    assert.deepEqual(readQueue(s.config), [], 'the live pending task must not also be failed in the queue');
    assert.ok(!readJournal(s.config).some(e => e.task === 'TRUST-1' && e.kind === 'queue-failed'));
    pane.screen = composerFixture('❯ \n');
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    await watchTick(s.ctx, memory, s.notifier);
    assert.equal(readTaskRecord(s.config, 'trust-1')?.promptDelivery, 'sent');
    assert.equal(s.runner.commands.filter(c => c.includes('paste-buffer')).length, 1);
    assert.deepEqual(readQueue(s.config), []);
  });

  it('INT4: an existing failed entry is reconciled with its live pending task even while the queue is paused', async () => {
    const s = setup('failed-live-trust');
    await add(s, specOf(s.repo, 'LIVE-1'));
    const entry = readQueue(s.config)[0]!;
    seedTask(s.config, 'LIVE-1', { promptDelivery: 'pending', pendingPrompt: 'Original prompt' });
    s.tmux.add('live-1', 'Quick safety check\n ❯ 1. Yes, I trust this folder');
    await saveEntry(s.ctx, { ...entry, status: 'failed', error: 'trust timed out' });
    await setPaused(s.ctx, true);
    await s.tick();
    assert.deepEqual(readQueue(s.config), []);
    assert.equal(readTaskRecord(s.config, 'live-1')?.pendingPrompt, 'Original prompt');
    assert.ok(s.tmux.windows.some(w => w.name === 'live-1'));
  });

  it('INT4: interruption after entering trust preserves the pending live task without a failed queue entry', async () => {
    const s = setup('abort-trust');
    s.tmux.newWindowScreen = 'Quick safety check\n ❯ 1. Yes, I trust this folder';
    await add(s, specOf(s.repo, 'TRUST-INT'));
    const controller = new AbortController();
    const sleep = s.runner.sleep.bind(s.runner);
    s.runner.sleep = async ms => { controller.abort(); await sleep(ms); };
    await queueTick(s.ctx, s.memory, s.notifier, { signal: controller.signal });
    await s.memory.idle();
    assert.deepEqual(readQueue(s.config), []);
    assert.equal(readTaskRecord(s.config, 'trust-int')?.promptDelivery, 'pending');
    assert.ok(s.tmux.windows.some(w => w.name === 'trust-int'));
    assert.equal(s.runner.commands.filter(c => c.includes('paste-buffer')).length, 0);
  });

  it('a watcher stopped mid-wait (Ctrl-C): the entry is dropped, the window closed, the task is to resume', async () => {
    const s = setup('abort-start');
    await add(s, specOf(s.repo, 'INT-1'));
    const controller = new AbortController();
    controller.abort();
    const began = await queueTick(s.ctx, s.memory, s.notifier, { signal: controller.signal });
    await s.memory.idle();
    assert.deepEqual(began, ['INT-1']);
    assert.deepEqual(readQueue(s.config), [], 'the entry is gone: record and queue agree');
    assert.ok(!s.tmux.windows.some((w) => w.name === 'int-1'), 'the never-ready window was closed');
    assert.ok(readTaskRecord(s.config, 'int-1'), 'the record stays');
    assert.ok(readJournal(s.config).some((e) => e.kind === 'queue-failed' && e.task === 'INT-1' && /interrupted/.test(e.text)));
    fs.mkdirSync(`${s.repo}-int-1`, { recursive: true }); // the worktree the start made
    assert.ok((await findResumable(s.ctx)).some((c) => c.task === 'INT-1'), 'the task lands in "to resume"');
  });

  it('a stale "starting" entry of a dead watcher: the never-ready window is closed and the task is to resume', async () => {
    const s = setup('stale-start');
    await add(s, specOf(s.repo, 'STALE-1'));
    const entry = readQueue(s.config)[0]!;
    seedTask(s.config, 'STALE-1', { repos: [{ path: s.repo, worktree: `${s.repo}-stale-1` }], promptDelivery: 'launching', pendingPrompt: 'Prompt of STALE-1.' });
    fs.mkdirSync(`${s.repo}-stale-1`, { recursive: true });
    s.tmux.add('stale-1', ''); // the window is up, the agent never showed its input
    await saveEntry(s.ctx, { ...entry, status: 'starting', startingPid: 99999999, startingAt: new Date().toISOString() });
    await s.tick();
    assert.deepEqual(readQueue(s.config), [], 'the entry is dropped, not failed: the record exists');
    assert.ok(!s.tmux.windows.some((w) => w.name === 'stale-1'), 'the leftover window was closed');
    assert.ok(readJournal(s.config).some((e) => e.kind === 'queue-failed' && e.task === 'STALE-1' && /interrupted/.test(e.text)));
    assert.ok((await findResumable(s.ctx)).some((c) => c.task === 'STALE-1'));
  });

  it('the intentional close of a never-ready start window is no tmux loss; a later genuine loss of the attempt still is', async () => {
    const s = setup('expected-close');
    await add(s, specOf(s.repo, 'NVR-1'));
    const entry = readQueue(s.config)[0]!;
    seedTask(s.config, 'NVR-1', { repos: [{ path: s.repo, worktree: `${s.repo}-nvr-1` }], promptDelivery: 'needs-attention', pendingPrompt: 'Prompt of NVR-1.', windowId: '@77', attemptId: 'att-1' });
    fs.mkdirSync(`${s.repo}-nvr-1`, { recursive: true });
    s.tmux.add('nvr-1', '', '@77'); // the window is up, the agent never showed its input
    await saveEntry(s.ctx, { ...entry, status: 'starting', startingPid: 99999999, startingAt: new Date().toISOString() });
    await s.tick();
    assert.ok(!s.tmux.windows.some((w) => w.name === 'nvr-1'), 'the never-ready window was closed');
    const row = (await collectStatus(s.ctx, { progress: false })).find((r) => r.task === 'NVR-1')!;
    assert.equal(row.tmuxLost ?? false, false, 'the expected closure is not a loss');
    assert.doesNotMatch(row.hint ?? '', /tmux|Utracono/i, 'no loss hint for the intentional close');
    assert.equal(readJournal(s.config).filter((e) => e.kind === 'tmux-lost' && e.task === 'NVR-1').length, 0, 'no false TMUX-lost event');
    // The same attempt loses its (reopened) window later for real: that is a loss again.
    s.tmux.add('nvr-1', '', '@77');
    await collectStatus(s.ctx, { progress: false });
    s.tmux.windows = s.tmux.windows.filter((w) => w.name !== 'nvr-1');
    await collectStatus(s.ctx, { progress: false });
    assert.equal(readJournal(s.config).filter((e) => e.kind === 'tmux-lost' && e.task === 'NVR-1').length, 1, 'a genuine loss of the same attempt is still an event');
  });
});


describe('P36: queue_rm over a leftover live window', () => {
  it('kills the cancelled task\'s window, and status shows cancelled instead of waiting', async () => {
    const s = setup('rm-window');
    await add(s, specOf(s.repo, 'RM-1'));
    // The leftover of a failed start: a live window and a record whose prompt never went out.
    seedTask(s.config, 'RM-1', { repos: [{ path: s.repo, worktree: `${s.repo}-rm-1` }], promptDelivery: 'needs-attention', pendingPrompt: 'Prompt of RM-1.' });
    s.tmux.add('rm-1', composerFixture('❯ \n'));
    await removeFromQueue(s.ctx, 'RM-1');
    assert.deepEqual(readQueue(s.config), []);
    assert.ok(!s.tmux.windows.some((w) => w.name === 'rm-1'), 'the leftover window was killed');
    assert.ok(readJournal(s.config).some((e) => e.kind === 'cancelled' && e.task === 'RM-1' && /leftover window/.test(e.text)));
    const row = (await collectStatus(s.ctx, { progress: false, archived: true })).find((r) => r.task === 'RM-1');
    assert.equal(row?.state, 'cancelled', 'not "waiting" from the idle screen of a leftover window');
  });

  it('queue_rm of a task without a window works as before (no kill attempted)', async () => {
    const s = setup('rm-plain');
    await add(s, specOf(s.repo, 'RM-2'));
    await removeFromQueue(s.ctx, 'RM-2');
    assert.deepEqual(readQueue(s.config), []);
    assert.equal(readTaskRecord(s.config, 'rm-2')?.cancelled, true);
    assert.ok(!s.runner.commands.some((c) => c.includes('kill-window')));
  });
});

describe('P50: a requeued ID starts a fresh attempt', () => {
  it('clears cancellation and old delivery/session state, unblocking existing and new dependents', async () => {
    const s = setup('p50-fresh');
    await add(s, specOf(s.repo, 'OLD-1') + specOf(s.repo, 'DEP-1', { after: 'OLD-1' }));
    await removeFromQueue(s.ctx, 'OLD-1');
    const dir = path.join(s.config.stateDir, 'old-1');
    fs.writeFileSync(path.join(dir, 'prompt-queue.json'), '[{"id":"old","text":"do not send","queuedAt":"old"}]');
    fs.writeFileSync(path.join(dir, 'sessions.json'), '{"codex":["old-session"]}');
    const listingNow = async () => renderQueueList(describeQueue(s.config, readQueue(s.config), await liveWindows(s.ctx), await collectStatus(s.ctx)), s.runner.now()).join('\n');
    assert.match(await listingNow(), /anulowane/);
    await add(s, specOf(s.repo, 'OLD-1', {}, 'Fresh prompt'));
    const fresh = readTaskRecord(s.config, 'old-1')!;
    assert.equal(fresh.cancelled, undefined);
    assert.equal(fresh.cancelledAt, undefined);
    assert.equal(fresh.deliveryId, undefined);
    assert.equal(fresh.pendingPrompt, undefined);
    assert.equal(fresh.started, '');
    assert.equal(fs.existsSync(path.join(dir, 'prompt-queue.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'sessions.json')), false);
    await add(s, specOf(s.repo, 'DEP-2', { after: 'OLD-1' }));
    const listing = await listingNow();
    assert.doesNotMatch(listing, /anulowane|zablokowane/);
    assert.match(listing, /czeka na OLD-1/);
    assert.equal((await collectStatus(s.ctx)).find(r => r.task === 'OLD-1')?.tmuxLost, undefined);
    const histories = fs.readdirSync(path.join(s.config.stateDir, '.history'));
    assert.equal(histories.length, 1);
    assert.match(fs.readFileSync(path.join(s.config.stateDir, '.history', histories[0]!, 'TASK.md'), 'utf8'), /cancelled: true/);
    await removeFromQueue(s.ctx, 'OLD-1');
    assert.match(await listingNow(), /anulowane/, 'a new cancellation still blocks dependents');
  });
});

it('heavy admission is shared across providers, visible in preview, and releases after close', async () => {
  const s = setup('heavy', 'limits: {claude: 4, codex: 1, heavy: 1}\nqueue: {parallel_starts: 4}\n');
  await add(s, specOf(s.repo, 'HV-1', {weight: 'heavy'}) + specOf(s.repo, 'HV-2', {weight: 'heavy', agent: 'codex'}) + specOf(s.repo, 'HV-3', {agent: 'codex'}));
  const views = describeQueue(s.config, readQueue(s.config), []);
  assert.match(views[1]!.condition.text, /heavy.*1\/1/);
  assert.equal(views[2]!.condition.kind, 'ready');
  const began = await s.tick();
  assert.deepEqual(began, ['HV-1', 'HV-3']);
  assert.equal(readTaskRecord(s.config, 'hv-1')?.weight, 'heavy');
  const preview = await planQueueAdd(s.ctx, splitSpecs(specOf(s.repo, 'HV-4', {weight: 'heavy'}), 'test'));
  assert.match(preview.summary.join('\n'), /heavy.*1\/1/);
  s.tmux.windows = s.tmux.windows.filter(w => w.name !== 'hv-1' && w.name !== 'hv-3');
  assert.deepEqual(await s.tick(), ['HV-2']);
});

it('R5: heavies waiting for a heavy slot stack their count instead of all showing the same', async () => {
  const s = setup('heavy-r5', 'limits: {claude: 4, heavy: 1}\nqueue: {parallel_starts: 4}\n');
  await add(s, specOf(s.repo, 'HW-1', {weight: 'heavy'}) + specOf(s.repo, 'HW-2', {weight: 'heavy'}) + specOf(s.repo, 'HW-3', {weight: 'heavy'}));
  const views = describeQueue(s.config, readQueue(s.config), []);
  assert.equal(views[0]!.condition.kind, 'ready');
  assert.match(views[1]!.condition.text, /heavy.*1\/1/);
  assert.match(views[2]!.condition.text, /heavy.*2\/1/);
});
