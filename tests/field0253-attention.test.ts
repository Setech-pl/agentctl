import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { attentionTick } from '../src/core/attention.ts';
import { Context } from '../src/core/context.ts';
import { collectStatus } from '../src/core/status.ts';
import { postMessage, readWall } from '../src/core/wall.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier = { notify: async () => {} };
const reader = { id: 'owner', kind: 'owner' } as const;

test('FIELD0253-ATTENTION: watch resolves only its own trust requests when the task leaves', async () => {
  const config = makeConfig(scratch.sub('attention'), 'notify: {attention_after_min: 15}\n');
  const tmux = new FakeTmux();
  for (const name of ['TRUST', 'CLOSED', 'CANCELLED', 'WAITING', 'UNREACHABLE']) {
    seedTask(config, name);
    tmux.add(name.toLowerCase(), 'Yes, I trust this folder');
  }
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  const rows = await collectStatus(ctx);
  await attentionTick(ctx, rows, notifier);
  await runner.sleep(16 * 60000);
  await attentionTick(ctx, rows, notifier);
  const manual = await postMessage(ctx, reader, {channel: 'agentctl', kind: 'decision-request', subject: 'Separate decision', body: 'Keep open.'});
  fs.unlinkSync(path.join(config.stateDir, 'attention.json'));
  const next = rows.map(row => row.task === 'TRUST' ? {...row, state: 'working' as const}
    : row.task === 'CLOSED' ? {...row, closed: true} : row.task === 'CANCELLED' ? {...row, cancelled: true}
    : row.task === 'UNREACHABLE' ? {...row, state: 'host-unreachable' as const, window: 'gone' as const} : row);
  const restart = new Context(runner, config, () => {});
  await attentionTick(restart, next, notifier);
  await attentionTick(restart, next, notifier);
  const headers = readWall(ctx, reader, {channel: 'agentctl', kind: 'decision-request', archive: true}).messages;
  assert.equal(headers.find(h => h.id === manual.id)?.status, 'open');
  assert.deepEqual(Object.fromEntries(headers.filter(h => h.id !== manual.id).map(h => [h.from, h.status])),
    {'task:TRUST': 'answered', 'task:CLOSED': 'superseded', 'task:CANCELLED': 'superseded', 'task:WAITING': 'open', 'task:UNREACHABLE': 'open'});
  for (const h of headers.filter(m => m.status !== 'open')) {
    assert.equal(h.history.length, 1);
    assert.ok(h.history[0]?.note);
  }
});
