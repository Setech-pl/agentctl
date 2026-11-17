import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { collectStatus } from '../src/core/status.ts';
import { autoClosePulled } from '../src/core/pulled-auto-close.ts';
import { readJournal } from '../src/core/journal.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch, runCli } from './helpers.ts';
const scratch = useScratch();
const now = Date.parse('2026-11-17T12:00:00Z');
function world(name: string, extra = '') {
  const config = makeConfig(scratch.sub(name), `mcp: {allow: [close]}\n${extra}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: now, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  const add = (task: string, age: number | null, cohort = 'wave') => {
    const record = seedTask(config, task, { cohort, turnEndedAt: new Date(now - 86400_000).toISOString(), ...(age !== null ? { pulled: new Date(now - age * 3600_000).toISOString() } : {}) });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
    fs.utimesSync(record.report, (now - 86400_000) / 1000, (now - 86400_000) / 1000);
    return record;
  };
  return { config, tmux, runner, ctx, add, deps: { context: () => ctx, notify: async () => {} } };
}
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;
it('UX0228: auto-close is opt-in, uses pull age, keeps worktrees and journals once', async () => {
  const w = world('auto'); w.add('OLD', 4); w.add('RECENT', 1); w.add('UNREAD', null);
  let rows = await collectStatus(w.ctx, { progress: false });
  assert.equal(w.config.board.pulledAutoCloseAfter, null);
  assert.equal(await autoClosePulled(w.ctx, rows), false);
  w.config.board.pulledAutoCloseAfter = 2;
  assert.equal(await autoClosePulled(w.ctx, rows), true);
  assert.equal(readTaskRecord(w.config, 'old')?.closed, true);
  assert.equal(readTaskRecord(w.config, 'recent')?.closed, undefined);
  assert.equal(readTaskRecord(w.config, 'unread')?.closed, undefined);
  assert.ok(fs.existsSync(readTaskRecord(w.config, 'old')!.report));
  assert.equal(readJournal(w.config).filter(e => e.kind === 'pulled-auto-close').length, 1);
  rows = await collectStatus(w.ctx, { progress: false });
  assert.equal(await autoClosePulled(w.ctx, rows), false);
});
it('UX0228: config validates collapse minutes and optional auto-close hours', () => {
  const w = world('config', 'board: {pulled_collapse_after: 10, pulled_auto_close_after: 2}\n');
  assert.equal(w.config.board.pulledCollapseAfter, 10);
  assert.equal(w.config.board.pulledAutoCloseAfter, 2);
  assert.equal(world('off', 'board: {pulled_auto_close_after: false}\n').config.board.pulledAutoCloseAfter, null);
  for (const value of ['-1', '"2"', '.inf']) assert.throws(() => world(`bad-${value}`, `board: {pulled_collapse_after: ${value}}\n`));
});
