import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import type { ExecOptions } from '../src/core/runner.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, ToolResult } from '../src/core/mcp-tools.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { taskFile, readTaskRecord } from '../src/core/taskstore.ts';
import { tryFileLock, taskLock } from '../src/core/file-lock.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
it('READFAST0269-CLI: CLI pull waits for its acknowledgement after a slow filesystem syscall', async t => {
  const f = fixture('cli-ack');
  f.release();
  const { markPulled } = await import('../src/core/pull.ts');
  const { reportFingerprint } = await import('../src/core/report-state.ts');
  const lock = taskLock(taskFile(f.config, 'fast'));
  const open = fs.openSync;
  let delayed = false;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (!delayed && args[0] === lock) {
      delayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
    return open(...args);
  });
  await markPulled(f.ctx, [{task: 'FAST', windowName: 'fast', reportPath: f.record.report, reportSignature: reportFingerprint(f.record.report)} as import('../src/core/status.ts').StatusRow]);
  assert.ok(delayed);
  assert.ok(readTaskRecord(f.config, 'fast')?.pulled, 'CLI must persist the acknowledgement before returning');
});
const drain = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(name: string, yaml = '', extra: Partial<TaskRecord> = {}) {
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
  const record = seedTask(config, 'FAST', extra);
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
it('READFAST0269-ACK: a slow lock syscall defers acknowledgement without replacing the report with an error', async t => {
  const f = fixture('slow-lock-syscall');
  f.release();
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', ((file: fs.PathLike, ...args: unknown[]) => {
    const fd = (open as Function)(file, ...args);
    // Deliberately block one filesystem syscall past the private 100 ms write deadline.
    // Assert delivered content and the durable request, never elapsed wall time.
    if (String(file) === taskLock(taskFile(f.config, 'fast'))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    return fd;
  }) as typeof fs.openSync);
  const result = await f.call('get_report', {task: 'FAST'});
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /Small direct report/);
  assert.ok(fs.readdirSync(path.join(path.dirname(f.config.path), 'report-delivery-requests')).length > 0);
});

it('READFAST0269: a held outputs journal lock records watch work and still returns the report', async () => {
  const f = fixture('journal-lock'); f.release();
  const text = 'Werdykt: PASS\nSmall direct report.\n```agentctl-outputs\nversion: 1\nverdict: PASS\ndecisions: []\n```\n<!-- agentctl:report-end -->';
  fs.writeFileSync(f.record.report, text);
  const unlock = tryFileLock(path.join(f.config.stateDir, 'fast', 'outputs-seen.json.lock'))!;
  let result: ToolResult | undefined;
  const pending = f.call('get_report', {task: 'FAST', mode: 'full', mark_pulled: false}).then(r => { result = r; });
  try {
    await drain(); f.advance(9000); await drain();
    assert.ok(result, 'the journal must not hold the read');
    assert.equal(result.isError, undefined, result.text);
    assert.doesNotMatch(result.text, /Partial result|Durable queue/);
    assert.match(result.text, /Small direct report/);
    assert.ok(fs.readdirSync(path.join(path.dirname(f.config.path), 'report-delivery-requests')).length > 0);
  } finally { unlock(); await pending; }
});
it('READFAST0269: declared Git references are returned without running Git and journaling is requested for watch', async () => {
  const repo = scratch.sub('refs-repo');
  const f = fixture('refs', '', {repos: [{name: 'agentctl', path: repo, worktree: repo, branch: 'pending'}]});
  fs.writeFileSync(f.record.report, `Werdykt: PASS\nSmall direct report.\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ncommits: [{repo: agentctl, branch: pending, sha: ${'a'.repeat(40)}}]\n\`\`\`\n<!-- agentctl:report-end -->`);
  let result: ToolResult | undefined;
  const pending = f.call('get_report', {task: 'FAST', mode: 'full', mark_pulled: false}).then(r => { result = r; });
  await drain(); f.advance(9000); await drain();
  const direct = result; f.release(); await pending;
  assert.ok(direct); assert.equal(direct.isError, undefined, direct.text);
  assert.doesNotMatch(direct.text, /Partial result|Durable queue/);
  assert.match(direct.text, /Small direct report/);
  assert.equal(f.calls(), 0);
  const requests = fs.readdirSync(path.join(path.dirname(f.config.path), 'report-delivery-requests'));
  assert.ok(requests.some(name => JSON.parse(fs.readFileSync(path.join(path.dirname(f.config.path), 'report-delivery-requests', name), 'utf8')).journal));
});
