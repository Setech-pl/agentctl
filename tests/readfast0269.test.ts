import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import type { ExecOptions } from '../src/core/runner.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, ToolResult } from '../src/core/mcp-tools.ts';
import { taskFile, readTaskRecord } from '../src/core/taskstore.ts';
import { tryFileLock, taskLock } from '../src/core/file-lock.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(name: string, yaml = '') {
  const config = makeConfig(scratch.sub(name), `capacity: {snapshot: false, codex_refresh: false}\n${yaml}`);
  const tmux = new FakeTmux();
  let release!: () => void;
  const held = new Promise<void>(yes => { release = yes; });
  let calls = 0;
  class BlockedRunner extends DiskRunner {
    override async exec(cmd: string, args: string[], opts?: ExecOptions) { calls++; await held; return super.exec(cmd, args, opts); }
  }
  const runner = new BlockedRunner({dryRun: false, respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  let now = 0;
  const timers = new Map<() => void, number>();
  const deps: McpDeps = {context: () => ctx, notify: async () => {}, budgetClock: {
    now: () => now, schedule: (fn, ms) => { timers.set(fn, now + ms); return () => { timers.delete(fn); }; },
  }};
  const advance = (ms: number) => { now += ms; for (const [fn, at] of timers) if (at <= now) { timers.delete(fn); fn(); } };
  const record = seedTask(config, 'FAST');
  fs.mkdirSync(path.dirname(record.report), {recursive: true});
  fs.writeFileSync(record.report, 'Werdykt: PASS\n\n## Summary\nSmall direct report.\n<!-- agentctl:report-end -->\n');
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args);
  return {config, ctx, record, call, release, advance, calls: () => calls};
}
for (const [tool, args] of [
  ['get_report', {task: 'FAST'}], ['get_report', {task: 'FAST', mode: 'full'}],
  ['get_report', {task: 'FAST', section: 'Summary'}], ['get_report', {task: 'FAST', offset: 3, limit: 1}],
  ['get_report', {task: 'FAST', byte_offset: 16}], ['pull_ready', {}], ['pull_ready', {mode: 'full'}], ['list_reports', {}],
] as const) it(`READFAST0269: ${tool} ${JSON.stringify(args)} bypasses blocked status and expired shared clock`, async () => {
  const f = fixture(`${tool}-${JSON.stringify(args).replace(/[^a-z0-9]/gi, '')}`);
  let result: ToolResult | undefined;
  const pending = f.call(tool, {...args, mark_pulled: false}).then(r => { result = r; });
  await drain(); f.advance(9000); await drain();
  const direct = result;
  f.release(); await pending;
  assert.ok(direct, 'report must arrive while status collection is still blocked');
  assert.equal(direct.isError, undefined, direct.text);
  assert.doesNotMatch(direct.text, /Partial result|Durable queue/);
  assert.match(direct.text, tool === 'list_reports' ? /FAST/ : /Small direct report/);
  assert.equal(f.calls(), 0, 'no runtime, Git or status subprocess');
});
it('READFAST0269: contended pulled marking is durable and watch retries', async () => {
  const f = fixture('ack');
  const unlock = tryFileLock(taskLock(taskFile(f.config, 'fast')))!;
  try {
    let delivered: ToolResult | undefined;
    const pending = f.call('get_report', {task: 'FAST'}).then(r => { delivered = r; });
    await drain(); f.advance(9000); await drain();
    f.release(); await pending;
    const result = delivered!;
    assert.match(result.text, /Small direct report/);
    assert.equal(readTaskRecord(f.config, 'fast')?.pulled, undefined);
    assert.equal(fs.readdirSync(path.join(path.dirname(f.config.path), 'report-delivery-requests')).length, 1);
  } finally { unlock(); f.release(); }
  const { applyReportDeliveries } = await import('../src/core/report-delivery.ts');
  await applyReportDeliveries(f.ctx);
  assert.ok(readTaskRecord(f.config, 'fast')?.pulled);
});
it('READFAST0269: configurable status deadline retains fallback and events report count uses task files', async () => {
  const f = fixture('budget', 'mcp: {response_budget_s: 25}\n');
  assert.equal(f.config.mcp.responseBudgetS, 25);
  let result: ToolResult | undefined;
  const pending = f.call('events_since').then(r => { result = r; });
  await drain(); f.advance(8000); await drain();
  assert.equal(result, undefined);
  f.advance(17000); await drain();
  const fallback = result as ToolResult | undefined;
  f.release(); await pending;
  assert.match(fallback?.text ?? '', /25 s response budget exhausted/);
  assert.match(fallback?.text ?? '', /Reports to pull: FAST/);
});
it('READFAST0269: invalid budget falls back to 8 and maximum is 50', () => {
  const bad = makeConfig(scratch.sub('bad-budget'), 'mcp: {response_budget_s: 51}\n');
  assert.equal(bad.mcp.responseBudgetS ?? 8, 8);
  assert.match(bad.mcp.warnings.join(' '), /response_budget_s/);
  assert.equal(makeConfig(scratch.sub('max-budget'), 'mcp: {response_budget_s: 50}\n').mcp.responseBudgetS, 50);
});

it('READFAST0269: deferred acknowledgement never marks a replacement report', async () => {
  const f = fixture('replaced');
  f.release();
  const unlock = tryFileLock(taskLock(taskFile(f.config, 'fast')))!;
  const pending = f.call('get_report', {task: 'FAST'});
  try {
    await drain();
    assert.ok(fs.existsSync(path.join(path.dirname(f.config.path), 'report-delivery-requests')), 'delivery request recorded while task is locked');
  } finally { unlock(); await pending; }
  fs.appendFileSync(f.record.report, '\nChanged after delivery.\n<!-- agentctl:report-end -->');
  const { applyReportDeliveries } = await import('../src/core/report-delivery.ts');
  await applyReportDeliveries(f.ctx);
  assert.equal(readTaskRecord(f.config, 'fast')?.pulled, undefined);
});
it('READFAST0269-COUNT: events count every ready task while listing only ten names', async () => {
  const f = fixture('count');
  f.release();
  for (let i = 0; i < 12; i++) {
    const record = seedTask(f.config, `READY-${i}`);
    fs.mkdirSync(path.dirname(record.report), {recursive: true});
    fs.writeFileSync(record.report, 'Werdykt: PASS\nReady.\n<!-- agentctl:report-end -->');
  }
  const result = await f.call('events_since', {format: 'json'});
  const data = JSON.parse(result.text);
  assert.equal(data.summary.reportsToPullTotal, 13);
  assert.equal(data.summary.reportsToPull.length, 10);
});
