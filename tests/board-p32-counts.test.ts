import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadBoard, ProgressCache } from '../src/core/board.ts';
import { archiveDir, renderTaskMd } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { countsLine, installFsCounter } from './fs-counter.ts';
import { FakeTmux, makeConfig, makeContext, useScratch } from './helpers.ts';

/*
 * The deterministic P32 proof: per board tick, the number of TASK.md parses, report body reads and fs.stat calls on a
 * fixture of 230 archived tasks with reports. It imports nothing that did not exist at the rc1 base, so the same file
 * runs against the pre-fix code (where every assertion fails) and against the fix (where they hold).
 */

const scratch = useScratch();
const TASKS = 230;

const REPORT = [
  '# Report',
  '',
  'Done.',
  '',
  '```agentctl-outputs',
  'version: 1',
  'verdict: PASS',
  'commits: []',
  'integrate: []',
  'decisions: []',
  'actions: []',
  'checks: []',
  'notes: []',
  '```',
  '',
  '<!-- agentctl:report-end -->',
  '',
].join('\n');

function buildFixture(root: string): ReturnType<typeof makeConfig> {
  const config = makeConfig(root);
  for (let i = 0; i < TASKS; i++) {
    const task = `P32-${String(i + 1).padStart(3, '0')}`;
    const window = task.toLowerCase();
    const report = path.join(config.cache, window, `${task}.md`);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, REPORT);
    const record: TaskRecord = {
      task,
      window,
      session: config.session,
      agent: 'claude',
      model: 'opus',
      effort: 'high',
      repos: [],
      links: [],
      env: {},
      report,
      started: new Date(Date.UTC(2026, 9, 31, 11, 0, 0)).toISOString(),
      closed: true,
      closedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
      turnEndedAt: new Date(Date.UTC(2026, 10, 1, 11, 0, 0)).toISOString(),
      requested: { agent: 'claude', model: 'opus', effort: 'high' },
    };
    const dir = path.join(archiveDir(config), window);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd(record, `Do ${task}.`));
  }
  return config;
}

describe('p32: per-tick file counts on 230 archived tasks', () => {
  it('cold tick, unchanged tick, tick after one TASK.md changed', async () => {
    const root = scratch.sub('p32-counts-230');
    const config = buildFixture(root);
    const { ctx } = makeContext(config, { respond: new FakeTmux().respond });
    const cache = new ProgressCache();
    const counter = installFsCounter(root);
    try {
      await loadBoard(ctx, null, cache);
      const cold = counter.snap();
      counter.reset();
      await loadBoard(ctx, null, cache);
      const unchanged = counter.snap();
      fs.appendFileSync(path.join(archiveDir(config), 'p32-007', 'TASK.md'), '\nmore prompt text\n');
      counter.reset();
      await loadBoard(ctx, null, cache);
      const oneChanged = counter.snap();
      console.log(`  cold tick:          ${countsLine(cold)}`);
      console.log(`  unchanged tick:     ${countsLine(unchanged)}`);
      console.log(`  one TASK.md changed: ${countsLine(oneChanged)}`);
      assert.equal(unchanged.taskMdReads, 0, 'an unchanged tick parses no TASK.md');
      assert.equal(unchanged.reportReads, 0, 'an unchanged tick reads no report body');
      assert.equal(oneChanged.taskMdReads, 1, 'exactly the changed TASK.md is parsed again');
      assert.equal(oneChanged.reportReads, 0, 'no report body is re-read for a TASK.md change');
      assert.ok(unchanged.statCalls < cold.statCalls, 'an unchanged tick stats less than a cold tick');
    } finally {
      counter.restore();
    }
  });
});
