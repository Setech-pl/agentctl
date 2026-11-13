import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { composerFixture } from './composer-fixture.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import type { Notifier } from '../src/core/notify.ts';
import { announceBlocked, commitQueueAdd, planQueueAdd, queueTick, queueViews, QueueMemory } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P94 (prod 13.11): `after` read ZOMBIE-LOOK-0's report (report-end written, its first line not yet the verdict) while the agent was still at
 * work, took the missing verdict for a rejection and announced INTEGRATION-37 blocked; nothing announced it free again when the report said PASS,
 * and the owner unblocked it by hand. A missing or unparsable verdict is now pending while its author is alive or the report changed within
 * report.settle_s; only an explicit FAIL/BLOCKED/NO-GO, or no verdict after the author ended, blocks; a released block is announced.
 */
const scratch = useScratch();
const IDLE = composerFixture('❯ \n');

function world(name: string, settle = 0) {
  const repo = scratch.sub(`${name}/repo`);
  const config = makeConfig(scratch.sub(name), `report: {settle_s: ${settle}}\ncapacity: {snapshot: false, codex_refresh: false}\nlimits: {claude: 5, codex: 5}\n`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const memory = new QueueMemory();
  const author = (extra: Parameters<typeof seedTask>[2] = {}) => {
    const record = seedTask(config, 'AUTHOR', { repos: [{ path: repo, worktree: `${repo}-author` }], ...extra });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    return record;
  };
  const queueDependent = async () => commitQueueAdd(ctx, (await planQueueAdd(ctx, splitSpecs(`---\ntask: DEP\nagent: claude\nafter: AUTHOR\nrepos:\n  - {path: ${repo}, worktree: ${repo}-dep}\n---\nContinue.\n`, 'test'))).items);
  /** One watcher pass over the queue: start what may start, then announce blocks and releases. */
  const pass = async () => {
    const began = await queueTick(ctx, memory, notifier, {});
    await memory.idle();
    const said = await announceBlocked(ctx, notifier, await collectStatus(ctx, { progress: false, archived: true }));
    return { began, said };
  };
  const view = async () => (await queueViews(ctx)).find((v) => v.entry.task === 'DEP')?.condition;
  return { config, tmux, runner, ctx, notified, author, queueDependent, pass, view };
}
const NO_VERDICT = '# Raport AUTHOR\n\nNotatki w toku.\n<!-- agentctl:report-end -->\n';
const PASS = 'Werdykt: PASS\n\n# Raport AUTHOR\n<!-- agentctl:report-end -->\n';

it('P94: a report without a verdict line of a live author is pending, not blocking; the verdict PASS then starts the dependent', async () => {
  const w = world('alive');
  const author = w.author();
  w.tmux.add('author', IDLE);
  await w.queueDependent();
  fs.writeFileSync(author.report, NO_VERDICT); // report-end is there, the verdict line is not (yet)
  const row = (await collectStatus(w.ctx, { progress: false, archived: true })).find((r) => r.task === 'AUTHOR');
  assert.equal(row?.report, 'yes', 'the report counts as present');
  const first = await w.pass();
  assert.deepEqual(first, { began: [], said: [] }, 'nothing started, nothing announced as blocked');
  assert.equal((await w.view())?.kind, 'after');
  assert.match((await w.view())?.text ?? '', /czeka na AUTHOR \(raport AUTHOR bez werdyktu – czeka, aż autor go dopisze\)/);
  assert.equal(readJournal(w.config).some((j) => j.kind === 'blocked'), false, 'no blocked event');
  assert.deepEqual(w.notified, []);
  fs.writeFileSync(author.report, PASS);
  assert.deepEqual((await w.pass()).began, ['DEP'], 'the verdict PASS releases the dependent at the next pass');
});

it('P94: a dead author whose report changed within report.settle_s is pending; once settled without a verdict it blocks', async () => {
  const w = world('settle', 30);
  const author = w.author(); // no window: the agent is gone
  await w.queueDependent();
  fs.writeFileSync(author.report, NO_VERDICT);
  assert.deepEqual(await w.pass(), { began: [], said: [] });
  assert.match((await w.view())?.text ?? '', /bez werdyktu/);
  await w.runner.sleep(31_000);
  const settled = await w.pass();
  assert.deepEqual(settled.began, []);
  assert.match(settled.said.join('\n'), /^DEP zablokowane – AUTHOR: verdict missing/);
  assert.equal((await w.view())?.kind, 'blocked');
});

it('P94: a closed author without a verdict and an explicit FAIL block at once', async () => {
  for (const [name, text, extra] of [['closed', NO_VERDICT, { closed: true }], ['fail', 'Werdykt: FAIL\n<!-- agentctl:report-end -->\n', {}]] as const) {
    const w = world(`block-${name}`);
    const author = w.author(extra);
    if (name === 'fail') w.tmux.add('author', IDLE);
    await w.queueDependent();
    fs.writeFileSync(author.report, text);
    const done = await w.pass();
    assert.deepEqual(done.began, [], name);
    assert.match(done.said.join('\n'), /^DEP zablokowane – AUTHOR: (verdict missing|verdict FAIL)/, name);
  }
});

it('P94: an already-blocked dependent whose blocker report now passes is released automatically, with an event and a notification', async () => {
  const w = world('release');
  const author = w.author();
  w.tmux.add('author', IDLE);
  await w.queueDependent();
  fs.writeFileSync(author.report, 'Werdykt: FAIL\n<!-- agentctl:report-end -->\n');
  const blocked = await w.pass();
  assert.match(blocked.said.join('\n'), /DEP zablokowane – AUTHOR: verdict FAIL/);
  fs.writeFileSync(author.report, PASS); // the author corrected the report
  const released = await w.pass();
  assert.deepEqual(released.began, ['DEP'], 'the released task starts in the same pass');
  const journal = readJournal(w.config);
  const event = journal.find((j) => j.kind === 'unblocked');
  assert.equal(event?.task, 'DEP');
  assert.equal(event?.text, 'DEP odblokowane – AUTHOR: werdykt PASS');
  assert.ok(journal.indexOf(event!) < journal.findIndex((j) => j.kind === 'queue-start' && j.task === 'DEP'), 'the release is said before the start');
  assert.ok(w.notified.some((m) => /DEP odblokowane/.test(m)), 'the owner is notified');
  await w.pass();
  assert.equal(readJournal(w.config).filter((j) => j.kind === 'unblocked').length, 1, 'said once');
});
