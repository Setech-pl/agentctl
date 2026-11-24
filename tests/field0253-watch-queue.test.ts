import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { readQueue, saveEntry } from '../src/core/queue.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { archiveDir, listArchivedRecords, taskDir } from '../src/core/taskstore.ts';
import { WatchMemory, watchTick, watchLogPath } from '../src/core/watch.ts';
import { watchSnapshotPath } from '../src/core/watch-snapshot.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

test('FIELD0253-ADMISSION: a late 1200-task status sweep cannot stop accepted or waiting starts', async () => {
  const config = makeConfig(scratch.sub('admission'), 'limits: {claude: 2, codex: 1}\nqueue: {parallel_starts: 1}\n');
  const tmux = new FakeTmux(config.session);
  const busy = tmux.add('slow', 'Working (esc to interrupt)');
  seedTask(config, 'SLOW', {agent: 'codex', windowId: busy.id});
  const archive = archiveDir(config);
  fs.mkdirSync(archive, {recursive: true});
  for (let i = 0; i < 1199; i++) {
    const record = seedTask(config, `ARCH-${i}`, {closed: true});
    fs.renameSync(taskDir(config, record.window), `${archive}/${record.window}`);
  }
  assert.equal(listArchivedRecords(config).length, 1199);

  let expire: (() => void) | undefined;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const enteredStatus = new Promise<void>(resolve => { entered = resolve; });
  let captures = 0;
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const exec = runner.exec.bind(runner);
  runner.exec = async (cmd: string, args: string[], opts?: ExecOptions) => {
    if (cmd === 'tmux' && args[0] === 'capture-pane' && args.includes(busy.id)) {
      captures++;
      if (captures === 1) {
        entered();
        await held;
      }
    }
    return exec(cmd, args, opts);
  };
  const ctx = new Context(runner, config, () => {});
  const repo = scratch.sub('admission/repo');
  for (const [seq, task, status] of [[1, 'ACCEPTED', 'accepted'], [2, 'WAITING', 'queued']] as const) {
    await saveEntry(ctx, {seq, order: seq, task, status, unvalidated: status === 'accepted', priority: 'normal',
      agent: 'claude', model: 'opus', effort: 'high', after: [], queuedAt: new Date(runner.now()).toISOString(),
      spec: `---\ntask: ${task}\nagent: claude\nrepos: [{path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}]\n---\nStart fixture.\n`});
  }
  const memory = new WatchMemory(), notifier = {notify: async () => {}};
  const stepClock = {now: () => runner.now(), schedule(fn: () => void) {
    expire = fn;
    return () => { expire = undefined; };
  }};
  const tick = () => watchTick(ctx, memory, notifier, {stepClock});
  const snapshot = () => JSON.parse(fs.readFileSync(watchSnapshotPath(config), 'utf8'));
  const first = tick();
  try {
    await enteredStatus;
    assert.ok(expire);
    expire();
    await first;
    await memory.queue.idle();
    assert.ok(tmux.windows.some(w => w.name.endsWith('accepted')), JSON.stringify(readQueue(config)));
    assert.deepEqual(readQueue(config).map(e => e.task), ['WAITING']);
    assert.equal(snapshot().degraded, 'status collection');
    const doctor = MCP_TOOLS.find(tool => tool.name === 'doctor')!;
    assert.match((await doctor.run({context: () => ctx, notify: async () => {}}, {})).text, /status collection.*od 2026-/);

    await tick();
    await memory.queue.idle();
    assert.ok(tmux.windows.some(w => w.name.endsWith('waiting')), JSON.stringify(readQueue(config)));
    assert.deepEqual(readQueue(config), []);
    assert.equal(captures, 1, 'watch must reuse the in-flight sweep');
    release();
    for (let i = 0; i < 500 && !memory.statusSweep; i++) await new Promise<void>(resolve => setImmediate(resolve));
    const firstRows = memory.statusSweep?.rows;
    assert.ok(firstRows, 'the original sweep eventually completed');
    assert.equal(firstRows.filter(row => row.archived).length, 1199);
    assert.ok(firstRows.some(row => row.task === 'SLOW'));
    assert.ok(!firstRows.some(row => row.task === 'WAITING'), 'the original sweep predates the second tick admission');
    await tick();
    const result = snapshot();
    assert.ok(result.rows?.length >= 1200, fs.readFileSync(watchLogPath(ctx), 'utf8').split('\n').slice(-7).join('\n'));
  } finally {
    release();
    await first;
  }
});
