import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import path from 'node:path';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, publishMcpSnapshot, applyMcpRequest } from '../src/core/mcp-tools.ts';
import { tryFileLock } from '../src/core/file-lock.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch, fakeWatcher } from './helpers.ts';
const scratch = useScratch();
it('A3: atomic watch snapshot serves every bounded read with stalled processes and supports cohort/capacity; stale falls back', async () => {
  const config = makeConfig(scratch.sub('snapshot'), 'mcp: {allow: [set_limits]}\nwatch: {interval: 2}\n');
  seedTask(config, 'SNAP', {cohort: '62'});
  const tmux = new FakeTmux(); tmux.add('snap', 'Working (esc to interrupt)');
  let stalled = false, probes = 0;
  const runner = new DiskRunner({dryRun: false, respond: (cmd, args, opts) => { probes++; if (stalled) throw new Error('stalled git/fs/process fixture'); return tmux.respond(cmd, args, opts); }});
  const ctx = new Context(runner, config, () => {}), deps = {context: () => ctx, notify: async () => {}};
  await publishMcpSnapshot(ctx);
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
  assert.match((await MCP_TOOLS.find(t => t.name === 'doctor')!.run(deps, {})).text, /snapshot unavailable\/stale/i);
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
