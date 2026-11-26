import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { readQueue, saveEntry, validateAccepted } from '../src/core/queue.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';

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
