import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { world, scratch } from './hotfix-0194-fixture.ts';
import { seedTask } from './helpers.ts';
import { announceBlocked, commitQueueAdd, planQueueAdd, queueTick, queueViews, QueueMemory, readQueue, unblockEntry, moveToFront } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { readJournal } from '../src/core/journal.ts';
for (const verdict of ['BLOCKED', 'FAIL', 'NO-GO', 'nonsense', '', 'PASS', 'pass with findings', 'PARTIAL', 'go']) it(`P89: after gates verdict ${JSON.stringify(verdict)}`, async () => {
  const w = world(`after-${verdict || 'missing'}`);
  const repo = scratch.sub(`repo-${verdict || 'missing'}`);
  const author = seedTask(w.config, 'AUTHOR', { closed: true, repos: [{ path: repo, worktree: repo }] });
  fs.mkdirSync(path.dirname(author.report), { recursive: true });
  fs.writeFileSync(author.report, `Werdykt: ${verdict}\n<!-- agentctl:report-end -->\n`);
  const raw = splitSpecs(`---\ntask: NEXT\nagent: claude\nafter: AUTHOR\nrepos:\n - path: ${repo}\n   worktree: ${repo}-next\n---\nContinue.`, 'test');
  const plan = await planQueueAdd(w.ctx, raw);
  await commitQueueAdd(w.ctx, plan.items);
  const allowed = ['PASS', 'pass with findings', 'PARTIAL', 'go'].includes(verdict);
  const notifications: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notifications.push(text); } };
  const memory = new QueueMemory();
  const began = await queueTick(w.ctx, memory, notifier, {}); await memory.idle();
  assert.deepEqual(began, allowed ? ['NEXT'] : []);
  if (!allowed) {
    assert.match((await queueViews(w.ctx))[0]!.condition.text, /waiting: AUTHOR verdict/);
    await announceBlocked(w.ctx, notifier, await (await import('../src/core/status.ts')).collectStatus(w.ctx, { archived: true, cachedOnly: true }));
    assert.ok(notifications.length > 0);
    assert.ok(readJournal(w.config).some(e => e.kind === 'blocked'));
    await unblockEntry(w.ctx, 'NEXT');
    assert.deepEqual((await queueViews(w.ctx))[0]!.entry.after, []);
  }
});
it('P89: after_verdict overrides defaults; queue up releases a rejected verdict manually', async () => {
  const w = world('override'); const repo = scratch.sub('override-repo');
  const author = seedTask(w.config, 'AUTHOR', { closed: true });
  fs.mkdirSync(path.dirname(author.report), { recursive: true }); fs.writeFileSync(author.report, 'Verdict: BLOCKED\n<!-- agentctl:report-end -->\n');
  const spec = (task: string, extra = '') => splitSpecs(`---\ntask: ${task}\nagent: claude\nafter: AUTHOR\n${extra}repos:\n - path: ${repo}\n   worktree: ${repo}-${task}\n---\nContinue.`, 'test');
  await commitQueueAdd(w.ctx, (await planQueueAdd(w.ctx, spec('OVERRIDE', 'after_verdict: [blocked]\n'))).items);
  assert.equal((await queueViews(w.ctx))[0]!.condition.kind, 'ready');
  await commitQueueAdd(w.ctx, (await planQueueAdd(w.ctx, spec('MANUAL'))).items);
  await moveToFront(w.ctx, 'MANUAL');
  assert.deepEqual(readQueue(w.config).find(e => e.task === 'MANUAL')!.after, []);
});
