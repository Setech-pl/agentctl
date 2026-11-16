import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import path from 'node:path';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, publishMcpSnapshot, applyMcpRequest } from '../src/core/mcp-tools.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { tryFileLock } from '../src/core/file-lock.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { saveEntry } from '../src/core/queue.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch, fakeWatcher } from './helpers.ts';
const scratch = useScratch();
it('A3: an async queue failure becomes visible on the next snapshot with its error and retry hint', async () => {
  const config = makeConfig(scratch.sub('snapshot-failure'), 'watch: {interval: 2}\n');
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  const entry = {seq: 1, order: 1, task: 'FAIL-1', direct: true, priority: 'high' as const,
    status: 'starting' as const, queuedAt: new Date(runner.now()).toISOString(),
    agent: 'claude' as const, model: 'sonnet', effort: 'high' as const, after: [], spec: '---\ntask: FAIL-1\n---\nWork.'};
  await saveEntry(ctx, entry);
  await publishMcpSnapshot(ctx, []);
  await runner.sleep(1);
  await saveEntry(ctx, {...entry, status: 'failed', failedAt: new Date(runner.now()).toISOString(), error: 'setup failed in beta (exit 3)'});
  const list = () => MCP_TOOLS.find(t => t.name === 'queue_list')!.run(deps, {format: 'json'});
  const before = JSON.parse((await list()).text);
  assert.equal(before[0].status, 'starting', 'a fresh tick snapshot is consistent even after a later journal event');
  assert.equal(before[0].retryHint, null);
  assert.equal(before[0].snapshot_age_s, 0.001);
  await runner.sleep(1999);
  await publishMcpSnapshot(ctx, []);
  const after = JSON.parse((await list()).text);
  assert.equal(after[0].status, 'failed');
  assert.match(after[0].error, /setup failed in beta \(exit 3\)/);
  assert.match(after[0].retryHint, /queue_retry task=FAIL-1/);
  assert.equal(after[0].snapshot_age_s, 0);
});
it('A3: atomic watch snapshot serves every bounded read with stalled processes and supports cohort/capacity; stale falls back', async () => {
  const config = makeConfig(scratch.sub('snapshot'), 'mcp: {allow: [set_limits]}\nwatch: {interval: 2}\n');
  seedTask(config, 'SNAP', {cohort: '62'});
  const tmux = new FakeTmux(); tmux.add('snap', 'Working (esc to interrupt)');
  let stalled = false, probes = 0; const commands: string[] = [];
  const runner = new DiskRunner({dryRun: false, respond: (cmd, args, opts) => { probes++; commands.push(cmd); if (stalled) throw new Error('stalled git/fs/process fixture'); return tmux.respond(cmd, args, opts); }});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  await publishMcpSnapshot(ctx);
  assert.equal(tmux.seen.filter(c => c.startsWith('capture-pane')).length, 1, 'snapshot publication reuses its one state sample');
  assert.deepEqual(commands.filter(cmd => ['claude', 'codex', 'kimi', 'glm', 'gh'].includes(cmd)), [], 'snapshot publication never starts provider diagnostics');
  stalled = true; const before = probes;
  const readdir = fs.readdirSync, statfs = fs.promises.statfs;
  let fsProbes = 0;
  fs.readdirSync = (() => {fsProbes++; throw new Error('stalled filesystem inventory');}) as typeof fs.readdirSync;
  fs.promises.statfs = (() => {fsProbes++; return new Promise(() => {});}) as typeof fs.promises.statfs;
  try {
  for (const name of ['status', 'queue_list', 'capacity', 'limits', 'config_show', 'doctor']) {
    const result = await MCP_TOOLS.find(t => t.name === name)!.run(deps, name === 'status' ? {cohort: '62', capacity: true} : {});
    assert.ok(!result.isError, result.text);
    assert.match(result.text, /snapshot(?: age|_age_s)/i, name);
    if (name === 'status') assert.match(result.text, /SNAP/);
  }
  assert.equal(probes, before); assert.equal(fsProbes, 0);
  } finally {fs.readdirSync = readdir; fs.promises.statfs = statfs;}
  const lock = tryFileLock(path.join(config.stateDir, 'start.lock'))!;
  try { const result = await MCP_TOOLS.find(t => t.name === 'set_limits')!.run(deps, {claude: 3, confirm: true}); assert.ok(!result.isError, result.text); } finally { lock(); }
  stalled = false; await runner.sleep(4001);
  const result = await MCP_TOOLS.find(t => t.name === 'status')!.run(deps, {});
  assert.match(result.text, /snapshot unavailable\/stale/i);
  const doctor = await MCP_TOOLS.find(t => t.name === 'doctor')!.run(deps, {});
  assert.match(doctor.text, /snapshot unavailable\/stale/i);
  assert.match(doctor.text, /per-task report\/link checks skipped/);
  assert.equal((doctor.text.match(/snapshot_note/g) ?? []).length, 1, 'one note preserves bounded diagnostics');
});
it('A3: GC preview is Accepted without slow checks and read back after watch', async () => {
  const config = makeConfig(scratch.sub('gc'), 'mcp: {allow: [gc]}\n'); fakeWatcher(config);
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  const tool = MCP_TOOLS.find(t => t.name === 'gc_preview')!;
  const accepted = await tool.run(deps, {});
  assert.match(accepted.text, /^Accepted/);
  const id = /request_id: ([a-f0-9-]{36})/.exec(accepted.text)![1];
  assert.ok(id, 'client-visible full request ID');
  await tool.run(deps, {}); assert.equal(readMcpRequests(config).length, 1, 'polling the same preview must not duplicate watch work');
  const request = readMcpRequests(config)[0]!; assert.equal(request.id, id);
  await applyMcpRequest(deps, request);
  const read = await tool.run(deps, {request_id: id});
  assert.match(read.text, /preview/);
  const gc = MCP_TOOLS.find(t => t.name === 'gc')!;
  const preview = await gc.run(deps, {});
  assert.match(preview.text, /preview_token:/);
  const token = /preview_token: (\S+)/.exec(preview.text)![1];
  const confirm = await gc.run(deps, {confirm: true, preview_token: token});
  assert.match(confirm.text, /^Accepted/);
  const different = await gc.run(deps, {branches: true});
  assert.match(different.text, /^Accepted/, 'different filters require watch to prepare a new plan');
});

it('W4: summary receipts are durable while status still serves the previous watch snapshot', async () => {
  const config = makeConfig(scratch.sub('summary-receipt'), 'watch: {interval: 2}\nmcp: {max_response_kb: 256}');
  const runner = new DiskRunner({dryRun: false, respond: new FakeTmux().respond});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  for (let i = 1; i <= 6; i++) {
    const record = seedTask(config, `NC-${i}`);
    fs.mkdirSync(path.dirname(record.report), {recursive: true});
    fs.writeFileSync(record.report, 'Verdict: PASS\nSummary receipt fixture.\n<!-- agentctl:report-end -->');
  }
  await publishMcpSnapshot(ctx);
  const summary = await MCP_TOOLS.find(t => t.name === 'pull_ready')!.run(deps, {all: true});
  assert.equal(summary.isError, undefined, summary.text);
  const cached = JSON.parse((await MCP_TOOLS.find(t => t.name === 'status')!.run(deps, {all: true, format: 'json'})).text);
  assert.ok(cached.tasks.every((r: {summary_delivered: unknown}) => !r.summary_delivered), 'the previous snapshot can legitimately predate the receipt');
  const records = Array.from({length: 6}, (_, i) => readTaskRecord(config, `nc-${i + 1}`));
  assert.ok(records.every(r => r && !r.pulled && r.summaryDelivered), 'task records prove all receipts and preserve unread full reports');
});
