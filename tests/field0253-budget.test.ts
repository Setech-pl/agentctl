import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { Context } from '../src/core/context.ts';
import { withResponseBudget } from '../src/core/response-budget.ts';
import { RealRunner } from '../src/core/runner.ts';
import { readTaskRecord, setHeaderField, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

test('FIELD0253-BUDGET: an expired response cannot interrupt a task state commit', async (t) => {
  const config = makeConfig(scratch.sub('budget'));
  const record = seedTask(config, 'BUDGET');
  const file = taskFile(config, record.window);
  const runner = new Context(new RealRunner(), config, () => {}).runner;
  let now = 0;
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (String(args[0]).endsWith('prompt-delivery.lock') && args[1] === 'wx') now = 8001;
    return fd;
  });
  const result = await withResponseBudget(async () => {
    await setHeaderField(runner, file, 'hidden', true);
    return 'full';
  }, () => 'partial', {now: () => now, schedule: () => () => {}});
  assert.equal(result, 'partial');
  assert.equal(readTaskRecord(config, record.window)?.hidden, true);
  assert.equal(fs.existsSync(file + '.write-error.json'), false);
});
