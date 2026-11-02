import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { cancelTasks, planCancel } from '../src/core/cancel.ts';
import { checkWindowLimit } from '../src/core/checks.ts';
import { Context } from '../src/core/context.ts';
import type { Notifier } from '../src/core/notify.ts';
import { liveWindows } from '../src/core/plan.ts';
import { pullReady } from '../src/core/pull.ts';
import { commitQueueAdd, planQueueAdd, readQueue, removeFromQueue } from '../src/core/queue.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus, shownRows } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  /** What the fake clock said at each tmux command, to check the order and the wait between them. */
  const timeline: { what: string; at: number }[] = [];
  const runner: DiskRunner = new DiskRunner({
    dryRun: false,
    startTime: Date.UTC(2026, 10, 2, 9, 0, 0),
    respond: (cmd, args, opts) => {
      if (cmd === 'tmux' && (args[0] === 'send-keys' || args[0] === 'kill-window')) timeline.push({ what: `${args[0]} ${args[args.indexOf('-t') + 1]} ${args[0] === 'send-keys' ? args[args.length - 1] : ''}`.trim(), at: runner.now() });
      return tmux.respond(cmd, args, opts);
    },
  });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const specOf = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const queueUp = async (text: string): Promise<void> => {
    const plan = await planQueueAdd(ctx, splitSpecs(text, 't'));
    await commitQueueAdd(ctx, plan.items);
  };
  /** A running task with a worktree directory on disk. */
  const live = (task: string, extra: Parameters<typeof seedTask>[2] = {}): string => {
    const worktree = path.join(root, `wt-${task.toLowerCase()}`);
    fs.mkdirSync(worktree, { recursive: true });
    seedTask(config, task, { repos: [{ path: repo, worktree, branch: `agent/${task.toLowerCase()}` }], ...extra });
    tmux.add(task.toLowerCase(), WORKING);
    return worktree;
  };
  return { root, repo, config, tmux, runner, ctx, out, notified, notifier, timeline, specOf, queueUp, live };
}

describe('cancel: a task at work', () => {
  it('interrupts, waits cancel.grace, closes the window: in that order; the worktree and the branch stay', async () => {
    const s = setup('live');
    const worktree = s.live('NC-1');
    const plan = await planCancel(s.ctx, ['nc-1'], { reason: 'wrong approach' });
    assert.deepEqual(plan.items.map((i) => [i.task, i.kind]), [['NC-1', 'live']]);
    assert.match(plan.summary.join('\n'), /Cancel 1 task – wrong approach/);
    assert.match(plan.summary.join('\n'), /interrupt, wait 5 s, close the window/);
    await cancelTasks(s.ctx, plan, { reason: 'wrong approach', source: 'cli' });
    assert.deepEqual(s.timeline.map((t) => t.what), ['send-keys @1 Escape', 'kill-window @1']);
    assert.equal((s.timeline[1] as { at: number }).at - (s.timeline[0] as { at: number }).at, 5000);
    assert.equal(s.tmux.windows.length, 0);
    assert.ok(fs.existsSync(worktree), 'the worktree stays');
    assert.ok(!s.runner.commands.some((c) => /worktree remove|branch -[dD]/.test(c)));
    const record = readTaskRecord(s.config, 'nc-1');
    assert.deepEqual([record?.cancelled, record?.cancelReason, record?.cancelSource, record?.closed], [true, 'wrong approach', 'cli', undefined]);
    assert.equal(record?.cancelledAt, new Date(s.runner.now()).toISOString());
    assert.match(s.out.join('\n'), /NC-1: cancelled \(worktree .*wt-nc-1 and its branch stay\)/);
  });

  it('cancel.grace comes from the config; 0 closes at once; one wait serves all the tasks of the command', async () => {
    const s = setup('grace', 'cancel: {grace: 2}\n');
    s.live('NC-1');
    s.live('NC-2');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['NC-1', 'NC-2']));
    assert.deepEqual(s.timeline.map((t) => t.what.split(' ')[0]), ['send-keys', 'send-keys', 'kill-window', 'kill-window']);
    assert.equal((s.timeline[2] as { at: number }).at - (s.timeline[0] as { at: number }).at, 2000);
    const z = setup('grace0', 'cancel: {grace: 0}\n');
    z.live('NC-1');
    await cancelTasks(z.ctx, await planCancel(z.ctx, ['NC-1']));
    assert.equal((z.timeline[1] as { at: number }).at, (z.timeline[0] as { at: number }).at);
    assert.throws(() => setup('badgrace', 'cancel: {grace: -1}\n'), /cancel.grace must be a number of seconds/);
  });

  it('--rm-worktree removes the worktree (git worktree remove, never --force) and never a branch', async () => {
    const s = setup('rmwt');
    const worktree = s.live('NC-1');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['NC-1'], { rmWorktree: true }), { rmWorktree: true });
    const cmds = s.runner.commands;
    const killAt = cmds.findIndex((c) => /kill-window/.test(c));
    const rmAt = cmds.findIndex((c) => c.includes(`worktree remove ${worktree}`));
    assert.ok(killAt >= 0 && rmAt > killAt, 'the window is closed first');
    assert.ok(!cmds.some((c) => /--force|branch -[dD]/.test(c)));
    assert.equal(readTaskRecord(s.config, 'nc-1')?.cancelled, true);
  });

  it('the CLI lists the tasks and asks y/N; no means nothing is done, and without a terminal -y is required', async () => {
    const s = setup('cli');
    s.live('NC-1');
    const asked: string[] = [];
    const no = await runCli(s.config, s.runner, ['cancel', 'NC-1'], { confirm: async (q) => (asked.push(q), false) });
    assert.match(no.stdout, /Cancel 1 task:\n {2}NC-1 {2}\(working: interrupt, wait 5 s, close the window; worktree and branch stay\)/);
    assert.match(no.stdout, /Aborted, nothing was done\./);
    assert.deepEqual(asked, ['Cancel? [y/N] ']);
    assert.equal(s.tmux.windows.length, 1);
    const none = await runCli(s.config, s.runner, ['cancel', 'NC-1']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no terminal to ask on/);
    const yes = await runCli(s.config, s.runner, ['cancel', 'nc-1', '--reason', 'obsolete'], { confirm: async () => true });
    assert.equal(yes.code, 0, yes.stderr);
    assert.equal(readTaskRecord(s.config, 'nc-1')?.cancelReason, 'obsolete');
    const again = await runCli(s.config, s.runner, ['cancel', 'NC-1', '-y']);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /NC-1 is already cancelled/);
  });

  it('a dry run prints the commands and changes nothing', async () => {
    const s = setup('dry');
    s.live('NC-1');
    const r = await runCli(s.config, s.runner, ['cancel', 'NC-1', '--dry-run'], { makeRunner: (dry, emit) => new RecordingRunner({ dryRun: dry, emit, respond: s.tmux.respond }) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /tmux send-keys -t .*Escape/);
    assert.match(r.stdout, /tmux kill-window -t /);
    assert.equal(readTaskRecord(s.config, 'nc-1')?.cancelled, undefined, 'TASK.md is not written');
  });

  it('refuses unknown, ambiguous, closed and already cancelled tasks, naming the way on', async () => {
    const s = setup('errors');
    s.live('NC-1');
    s.live('NC-10');
    seedTask(s.config, 'DONE-1', { closed: true });
    await assert.rejects(planCancel(s.ctx, ['ZZ-9']), /no task "ZZ-9"/);
    await assert.rejects(planCancel(s.ctx, ['NC-']), /fits more than one task: NC-1, NC-10/);
    await assert.rejects(planCancel(s.ctx, ['DONE-1']), /DONE-1 is closed: it finished/);
    await assert.rejects(planCancel(s.ctx, []), /give at least one task/);
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['NC-10']));
    await assert.rejects(planCancel(s.ctx, ['NC-10']), /NC-10 is already cancelled/);
  });
});

describe('cancel: a task that finished without a window', () => {
  it('is marked cancelled and its report stays readable with pull <TASK>', async () => {
    const s = setup('finished');
    const record = seedTask(s.config, 'NC-1');
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, '# partial\n');
    const plan = await planCancel(s.ctx, ['NC-1']);
    assert.equal(plan.items[0]?.kind, 'finished');
    assert.match(plan.summary.join('\n'), /no window: marked cancelled; its report stays \(agentctl pull NC-1\)/);
    await cancelTasks(s.ctx, plan);
    assert.deepEqual(s.timeline, [], 'no window: nothing to interrupt or close');
    const r = await runCli(s.config, s.runner, ['pull', 'NC-1']);
    assert.match(r.stdout, new RegExp(record.report.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('cancel: a task in the queue', () => {
  it('is taken out of the queue and becomes a cancelled task with the spec and the reason', async () => {
    const s = setup('queued');
    await s.queueUp(s.specOf('Q-1') + s.specOf('Q-2'));
    const plan = await planCancel(s.ctx, ['q-1']);
    assert.deepEqual(plan.items.map((i) => i.kind), ['queued']);
    assert.match(plan.summary.join('\n'), /in the queue: taken out, it never starts/);
    await cancelTasks(s.ctx, plan, { reason: 'not needed', source: 'cli' });
    assert.deepEqual(readQueue(s.config).map((e) => e.task), ['Q-2']);
    const record = readTaskRecord(s.config, 'q-1');
    assert.deepEqual([record?.cancelled, record?.cancelReason, record?.started], [true, 'not needed', '']);
    const rows = await collectStatus(s.ctx, { progress: false });
    const row = rows.find((r) => r.task === 'Q-1')!;
    assert.deepEqual([row.state, row.cancelled, row.hidden, row.hiddenBy, row.startedLocal, row.cancelReason], ['cancelled', true, true, 'cancelled', '-', 'not needed']);
    assert.match(fs.readFileSync(path.join(s.config.stateDir, 'q-1', 'TASK.md'), 'utf8'), /Prompt of Q-1\./);
  });

  it('queue rm is the same without a reason, in the library and in the CLI', async () => {
    const s = setup('queuerm');
    await s.queueUp(s.specOf('Q-1') + s.specOf('Q-2'));
    assert.equal((await removeFromQueue(s.ctx, 'q-1')).task, 'Q-1');
    assert.deepEqual([readTaskRecord(s.config, 'q-1')?.cancelled, readTaskRecord(s.config, 'q-1')?.cancelReason], [true, undefined]);
    const r = await runCli(s.config, s.runner, ['queue', 'rm', 'Q-2']);
    assert.match(r.stdout, /Q-2: removed from the queue \(cancelled\)/);
    assert.equal(readTaskRecord(s.config, 'q-2')?.cancelSource, 'cli');
    assert.deepEqual(readQueue(s.config), []);
  });

  it('an entry that is being started cannot be cancelled', async () => {
    const s = setup('starting');
    await s.queueUp(s.specOf('Q-1'));
    const [entry] = readQueue(s.config);
    fs.writeFileSync(path.join(s.config.path, '..', 'queue', fs.readdirSync(path.join(s.config.path, '..', 'queue'))[0] as string), JSON.stringify({ ...entry, status: 'starting' }));
    await assert.rejects(planCancel(s.ctx, ['Q-1']), /Q-1 is being started right now/);
  });
});

describe('cancel: a task that was moved to the other provider', () => {
  it('cancels both halves after one question, from either side', async () => {
    for (const asked of ['NC-1', 'NC-1-2']) {
      const s = setup(`move-${asked}`);
      s.live('NC-1', { supersededBy: 'NC-1-2' });
      s.live('NC-1-2', { continues: 'NC-1', agent: 'codex' });
      s.live('OTHER-1');
      const questions: string[] = [];
      const r = await runCli(s.config, s.runner, ['cancel', asked], { confirm: async (q) => (questions.push(q), true) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(questions.length, 1);
      assert.match(r.stdout, /Cancel 2 tasks:/);
      assert.match(r.stdout, /the other half of a move with /);
      assert.deepEqual([readTaskRecord(s.config, 'nc-1')?.cancelled, readTaskRecord(s.config, 'nc-1-2')?.cancelled, readTaskRecord(s.config, 'other-1')?.cancelled], [true, true, undefined]);
      assert.deepEqual(s.tmux.windows.map((w) => w.name), ['other-1']);
    }
  });
});

describe('cancelled tasks are out of the way', () => {
  it('leave status and the board lists, the window limits, pull --ready, the watcher and collisions; status --all lists them', async () => {
    const s = setup('away', 'limits: {claude: 1}\n');
    const record = s.live('NC-1', {});
    void record;
    const report = seedTask(s.config, 'NC-2');
    fs.mkdirSync(path.dirname(report.report), { recursive: true });
    fs.writeFileSync(report.report, '# half done\n');
    s.live('NC-3');
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['NC-1', 'NC-2']));
    const rows = await collectStatus(s.ctx, { progress: false });
    assert.deepEqual(shownRows(rows, false).map((r) => r.task), ['NC-3']);
    assert.deepEqual(shownRows(rows, true).map((r) => [r.task, r.state]), [['NC-1', 'cancelled'], ['NC-2', 'cancelled'], ['NC-3', 'working']]);
    // the window limit counts windows: the cancelled task has none, so the single claude window is NC-3's
    assert.equal(checkWindowLimit('claude', 1, await liveWindows(s.ctx), s.config.session)?.length ? true : false, true);
    assert.deepEqual((await liveWindows(s.ctx)).map((w) => w.window), ['nc-3']);
    // pull --ready: a report of a cancelled task is not handed over
    const pulled = await pullReady(s.ctx, { all: true }, 'darwin');
    assert.deepEqual(pulled.pulled, []);
    // the watcher announces nothing about a window that vanished because of a cancel
    const memory = new WatchMemory();
    await watchTick(s.ctx, memory, s.notifier);
    const events = await watchTick(s.ctx, memory, s.notifier);
    assert.deepEqual(events.filter((e) => ['NC-1', 'NC-2'].includes(e.task)), []);
    assert.deepEqual(s.notified, []);
    const all = await runCli(s.config, s.runner, ['status', '--all']);
    assert.match(all.stdout, /NC-1 \(cancelled\) +claude\/opus\/high +cancelled/);
    assert.doesNotMatch((await runCli(s.config, s.runner, ['status'])).stdout, /NC-1/);
    const json = JSON.parse((await runCli(s.config, s.runner, ['status', '--json', '--all'])).stdout) as { task: string; cancelled: boolean; cancelReason: string | null }[];
    assert.deepEqual(json.map((r) => [r.task, r.cancelled]), [['NC-1', true], ['NC-2', true], ['NC-3', false]]);
  });

  it('a cancelled task frees its provider slot for new work', async () => {
    const s = setup('slot', 'limits: {claude: 1}\n');
    s.live('NC-1');
    assert.ok(checkWindowLimit('claude', 1, await liveWindows(s.ctx), s.config.session));
    await cancelTasks(s.ctx, await planCancel(s.ctx, ['NC-1']));
    assert.equal(checkWindowLimit('claude', 1, await liveWindows(s.ctx), s.config.session), undefined);
  });

  it('cancelled is among the states of the config (window_icons) and has its own icon', () => {
    const s = setup('icons', 'watch: {window_icons: {cancelled: "x"}}\n');
    assert.equal(s.config.watch.windowIcons?.cancelled, 'x');
    assert.equal(setup('icons2').config.watch.windowIcons?.cancelled, '✕');
  });
});
