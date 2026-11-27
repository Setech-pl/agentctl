import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

it('FIELD0268-JOURNAL: observations from a skipped transition stage survive a restart and a later return to baseline', async () => {
  const { readJournal } = await import('../src/core/journal.ts');
  const config = makeConfig(scratch.sub('field-journal'));
  const tmux = new FakeTmux();
  const runner = new DiskRunner({dryRun: false, startTime: Date.now(), respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  const notifier = {clickable: false, notify: async () => undefined};
  const record = seedTask(config, 'RESTARTED');
  tmux.add(record.window, 'Working (esc to interrupt)');
  let skip = false;
  const memory = new WatchMemory(async (name, work) => {
    if (skip && (name === 'transitions' || name === 'journal transitions')) return undefined as Awaited<ReturnType<typeof work>>;
    return work();
  });
  await watchTick(ctx, memory, notifier);
  skip = true;
  tmux.windows[0]!.screen = '? Which color?\n  Enter to select · Esc to cancel\n';
  await runner.sleep(1000);
  await watchTick(ctx, memory, notifier);
  assert.equal(readJournal(config).filter(event => event.task === record.task && event.kind === 'needs-input').length, 0);
  tmux.windows[0]!.screen = 'Working (esc to interrupt)';
  await runner.sleep(1000);
  const recovered = new WatchMemory();
  await watchTick(ctx, recovered, notifier);
  await watchTick(ctx, new WatchMemory(), notifier);
  assert.equal(readJournal(config).filter(event => event.task === record.task && event.kind === 'needs-input').length, 1);
});
