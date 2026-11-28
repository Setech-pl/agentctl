import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { withCommandStage } from '../src/core/command-stage.ts';
import { deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { readQueue, saveEntry, validateAccepted } from '../src/core/queue.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier = {notify: async () => {}};

it('REVIEW0263-F1: accepted start probes do not hold the shared admission lock', async () => {
  const root = scratch.sub('lock-validation');
  const config = makeConfig(root);
  const repo = scratch.sub('lock-validation/repo');
  const tmux = new FakeTmux(config.session);
  const locks: boolean[] = [];
  const runner = new DiskRunner({dryRun: false, respond(cmd, args, opts) {
    if (cmd === 'tmux' && args.includes('list-windows')) locks.push(fs.existsSync(path.join(config.stateDir, 'start.lock')));
    return tmux.respond(cmd, args, opts);
  }});
  const ctx = new Context(runner, config, () => {});
  await saveEntry(ctx, {task: 'CHECK-1', seq: 1, order: 1, status: 'accepted', direct: true, agent: 'claude', model: 'opus', effort: 'high',
    priority: 'high', after: [], queuedAt: new Date().toISOString(), spec: `---\ntask: CHECK-1\nagent: claude\nrepos: [{path: ${repo}, worktree: ${repo}-target}]\n---\nFixture.\n`});
  await validateAccepted(ctx, notifier);
  assert.ok(locks.length > 0, 'validation inspected live windows');
  assert.ok(locks.every(locked => !locked));
  assert.notEqual(readQueue(config)[0]?.status, 'accepted');
});

it('REVIEW0263-F2: a nearing deadline leaves the pending prompt untouched for another tick', async () => {
  const config = makeConfig(scratch.sub('lock-paste'));
  const tmux = new FakeTmux(config.session);
  const pane = tmux.add('paste-1', '❯ ');
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  const record = seedTask(config, 'PASTE-1', {windowId: pane.id});
  await queuePrompt(ctx, record, 'A follow-up in the fixture.', 'pending', {kind: 'followup'});
  const outcome = await withCommandStage(2000, undefined, () => deliverPendingPrompt(ctx, record.window));
  assert.equal(outcome, 'pending');
  assert.ok(!runner.commands.some(line => /paste-buffer|send-keys.*Enter/.test(line)));
});
