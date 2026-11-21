import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { atomicWriteFile } from '../src/core/atomic-file.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { collectStatus } from '../src/core/status.ts';
import { taskFile } from '../src/core/taskstore.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { watchSnapshotPath } from '../src/core/watch-snapshot.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier = { notify: async () => {} };

test('FIELD0253-ENOSPC: watch recovers task state and snapshot once space returns', async (t) => {
  const config = makeConfig(scratch.sub('enospc'));
  const record = seedTask(config, 'RECOVER');
  const file = taskFile(config, record.window);
  const snapshot = watchSnapshotPath(config);
  const tmux = new FakeTmux();
  tmux.add(record.window, 'Working (esc to interrupt)');
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  const memory = new WatchMemory();
  await watchTick(ctx, memory, notifier);
  await memory.queue.idle();
  const previous = fs.readFileSync(file, 'utf8');
  const snapshotBefore = fs.readFileSync(snapshot, 'utf8');
  let full = true;
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: string, to: string) => {
    if (full && [file, snapshot].includes(to)) throw Object.assign(new Error('fixture volume full'), {code: 'ENOSPC'});
    rename(from, to);
  });
  assert.throws(() => atomicWriteFile(file, 'incomplete'), {code: 'ENOSPC'});
  await runner.sleep(1000);
  await watchTick(ctx, memory, notifier);
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), snapshotBefore);
  assert.equal((await collectStatus(ctx))[0]?.state, 'needs-attention');

  full = false;
  await runner.sleep(1000);
  await watchTick(ctx, memory, notifier);
  await memory.queue.idle();
  assert.equal((await collectStatus(ctx))[0]?.state, 'working');
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).at, runner.now());
  assert.equal(JSON.parse(fs.readFileSync(snapshot, 'utf8')).rows[0].state, 'working');
  await watchTick(ctx, memory, notifier);
  await memory.queue.idle();
  assert.equal(readJournal(config).filter(e => e.text.includes('zapis stanu wznowiony')).length, 1);
});
