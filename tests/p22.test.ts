import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { findCandidates, syncReport } from '../src/core/report-detect.ts';
import { collectStatus } from '../src/core/status.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
import { Context } from '../src/core/context.ts';
const scratch = useScratch();
it('P22 nearby reports are hints in status and events, never adopted', async () => {
  const root = scratch.sub('nearby'), config = makeConfig(root, 'watch: {idle_confirm_ticks: 1}\n');
  const wt = scratch.sub('nearby/wt'), tmux = new FakeTmux();
  const ctx = new Context(new DiskRunner({ dryRun: false, respond: tmux.respond }), config, () => {});
  const r = seedTask(config, 'P22', { repos: [{ path: wt, worktree: wt }], report: path.join(root, 'cache/reports/FINAL.md') });
  fs.mkdirSync(path.dirname(r.report), { recursive: true });
  const nearby = path.join(path.dirname(r.report), 'P22-result.md');
  fs.writeFileSync(nearby, 'Werdykt: PASS\n');
  fs.writeFileSync(path.join(wt, 'FINAL.md'), 'Werdykt: PASS\n');
  fs.writeFileSync(path.join(wt, 'README.md'), 'unrelated');
  const stale = path.join(wt, 'P22-stale.md');
  fs.writeFileSync(stale, 'old');
  fs.utimesSync(stale, new Date('2020-01-01'), new Date('2020-01-01'));
  fs.symlinkSync(nearby, path.join(wt, 'P22-link.md'));
  assert.equal(findCandidates(ctx, r).length, 2);
  for (const alive of [false, true]) {
    if (alive) tmux.add('p22', '❯ \n');
    const row = (await collectStatus(ctx))[0]!;
    assert.ok(row.reportCandidate);
    assert.match(row.hint ?? '', /report_from.*(?:P22-result|FINAL)\.md/);
    const events = await collectEvents(ctx, { client: 'cli', since: '1d' });
    assert.match(JSON.stringify(events), /report_from/);
  }
  await syncReport(ctx, r);
  assert.equal(fs.existsSync(r.report), false);
});
