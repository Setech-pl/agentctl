import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { queuePrompt, deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import { reportInstructions, promptWithHeader } from '../src/core/agents.ts';
import { collectStatus } from '../src/core/status.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { MCP_TOOLS, responseWireBytes } from '../src/core/mcp-tools.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { readJournal } from '../src/core/journal.ts';
import { collectCapacity } from '../src/core/capacity.ts';
import { developmentEnvironment } from '../src/core/installation.ts';
import { cohortTick, cohortsDir } from '../src/core/cohort.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
function fixture(name: string, respond?: NonNullable<ConstructorParameters<typeof DiskRunner>[0]>['respond']) {
  const root = scratch.sub(name), config = makeConfig(root, 'capacity: {codex_refresh: false}\nmcp: {allow: [mark, close, cancel, gc, archive, report_from]}\n');
  const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: respond ?? tmux.respond });
  const ctx = new Context(runner, config, () => {}), deps = { context: () => ctx, notify: async () => {} };
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args as never);
  const full = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); assert.ok(!r.isError, r.text); let page; try { page = JSON.parse(r.text); } catch { return r.text; } if (!page.response_id) return r.text; let text = page.fragment; while (page.has_more) { const next = await call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); assert.ok(!next.isError, next.text); assert.ok(responseWireBytes(next) <= 8192); page = JSON.parse(next.text); text += page.fragment; } return text; };
  return { root, config, tmux, runner, ctx, deps, call, full };
}
for (const agent of ['codex', 'claude'] as const) for (const swallowed of [1, 9]) {
  it(`0173-FIX-A ${agent}: swallowed Enter ${swallowed === 1 ? 'recovers without repaste' : 'stops after two retries, watch resolves confirmation deadline'}`, async () => {
    let draft = '', enters = 0, pastes = 0, payload = '';
    const f = fixture(`enter-${agent}-${swallowed}`, (cmd, args, opts) => {
      if (cmd !== 'tmux') return undefined;
      if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
      if (args[0] === 'load-buffer') payload = opts.input ?? '';
      if (args[0] === 'paste-buffer') { pastes++; draft = payload.split('\n')[0]!; }
      if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { enters++; if (enters > swallowed) draft = ''; }
      if (args[0] === 'capture-pane') return { stdout: draft ? `Heads up, you have less than 25% of your weekly limit left\n${agent === 'codex' ? '›' : '❯'} ${draft}\n` : enters > swallowed ? 'Working (esc to interrupt)\n' : `${agent === 'codex' ? '› Ask Codex to do anything' : '❯ Try "x"'}\n` };
      return {};
    });
    const r = seedTask(f.config, 'T1', { agent, windowId: '@1' });
    const text = promptWithHeader({ model: 'default', effort: 'low', prompt: 'ą'.repeat(600), report: r.report }, r.attemptId);
    await queuePrompt(f.ctx, r, text);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), swallowed === 1 ? 'sent' : 'confirming');
    assert.equal(pastes, 1); assert.equal(enters, swallowed === 1 ? 2 : 3);
    assert.equal(readTaskRecord(f.config, 't1')!.promptDelivery, swallowed === 1 ? 'sent' : 'confirming');
    if (swallowed > 1) { assert.equal((await collectStatus(f.ctx))[0]!.state, 'waiting'); assert.match(readTaskRecord(f.config, 't1')!.promptError!, /two retries/); await f.runner.sleep(60000); await watchTick(f.ctx, new WatchMemory(), { notify: async () => {} }); assert.equal((await collectStatus(f.ctx))[0]!.state, 'needs-attention'); }
  });
}
it('0173-FIX-B/C: canonical absolute report path survives pending trust; competing new/watch send once', async () => {
  const f = fixture('trust'), r = seedTask(f.config, 'T1');
  const pane = f.tmux.add('t1', 'Do you trust this folder?\n❯ No, exit\nYes, I trust this folder');
  const text = promptWithHeader({ model: 'opus', effort: 'low', prompt: 'Original prompt', report: r.report }, 'attempt-1');
  assert.ok(text.includes(path.resolve(r.report))); assert.ok(text.includes('T1.md'));
  assert.ok(reportInstructions('attempt-2', r.report).includes(r.report));
  await queuePrompt(f.ctx, r, text); assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'pending');
  assert.equal(f.runner.commands.filter(c => c.includes('paste-buffer')).length, 0);
  pane.screen = '❯ Try "x"\n';
  const result = await Promise.all([deliverPendingPrompt(f.ctx, 't1'), watchTick(f.ctx, new WatchMemory(), { notify: async () => {} })]);
  assert.equal(result[0], 'sent'); assert.equal(f.runner.commands.filter(c => c.includes('paste-buffer')).length, 1);
  assert.equal(f.runner.calls.find(c => c.line.includes('load-buffer'))!.input, text);
  assert.equal(readTaskRecord(f.config, 't1')!.promptDelivery, 'sent');
  await watchTick(f.ctx, new WatchMemory(), { notify: async () => {} }); assert.equal(f.runner.commands.filter(c => c.includes('paste-buffer')).length, 1);
});
it('0173-FIX-D/J: explicit report confirmation clears historical warning; preview shows source/overwrite facts and force is required', async () => {
  const f = fixture('confirm'), source = path.join(f.root, 'T1-report.md'); fs.writeFileSync(source, 'Werdykt: PASS\n');
  const r = seedTask(f.config, 'T1', { reportSource: source }); fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'original');
  assert.match((await f.call('status')).text, /sprawdź/);
  const preview = await f.full('report_from', { task: 'T1', from: source }); const scope = JSON.parse(preview.slice(0, preview.indexOf('\nNot executed.'))).scope;
  assert.equal(scope.source_exists, true); assert.equal(scope.source_bytes, fs.statSync(source).size); assert.equal(scope.would_overwrite, true); assert.equal(scope.requires_force, true);
  assert.equal((await f.call('report_from', { task: 'T1', from: source, confirm: true })).isError, true); assert.equal(fs.readFileSync(r.report, 'utf8'), 'original');
  await f.call('report_from', { task: 'T1', from: source, force: true }); await f.call('report_from', { task: 'T1', from: source, force: true, confirm: true });
  assert.doesNotMatch((await f.call('status')).text, /sprawdź/); assert.ok(JSON.parse(await f.full('status', { format: 'json' })).tasks[0].reportSource);
});
it('0173-FIX-E/K: truthful small summaries, backticked SHA, no duplicated heading; full delivery pages and marks only after contiguous EOF', async () => {
  const f = fixture('reports'), r = seedTask(f.config, 'T1'); fs.mkdirSync(path.dirname(r.report), { recursive: true });
  const small = 'Werdykt: PASS\n# Final report\nCommit `e7ef393`\n' + 'ok '.repeat(130); fs.writeFileSync(r.report, small);
  const summary = await f.full('pull_ready'); assert.match(summary, /sha: e7ef393/); assert.match(summary, /truncated: false/); assert.equal(summary.split('# Final report').length - 1, 1);
  const big = 'Werdykt: PASS\n' + 'large '.repeat(15000); fs.writeFileSync(r.report, big);
  const first = await f.call('pull_ready', { mode: 'full', all: true }); let page = JSON.parse(first.text);
  assert.equal(page.has_more, true); assert.equal(readTaskRecord(f.config, 't1')!.pulled, undefined);
  const end = await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset + 40000 }); assert.ok(!end.isError); assert.equal(readTaskRecord(f.config, 't1')!.pulled, undefined);
  let text = page.fragment; while (page.has_more) { page = JSON.parse((await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset })).text); text += page.fragment; }
  assert.ok(text.includes(big.trimEnd())); assert.ok(readTaskRecord(f.config, 't1')!.pulled); assert.doesNotMatch(text, /0 new reports|marked as pulled: \n/);
});
it('0173-FIX-F/G/H: no stale before first reading, dev identity, shell windows ignored but agent/owned windows retained', async () => {
  const f = fixture('identity'); seedTask(f.config, 'T1'); f.tmux.add('t1', 'Working (esc to interrupt)');
  await collectCapacity(f.ctx); assert.equal(readJournal(f.config).some(e => /stale/.test(e.text)), false);
  assert.equal(developmentEnvironment('/dev/.agentctl-dev/config.yaml', '/repo/bin/agentctl.ts', '/stable/bin/agentctl.ts', '/dev'), true);
  assert.equal(developmentEnvironment('/home/.agentctl/config.yaml', '/stable/bin/agentctl.ts', '/stable/bin/agentctl.ts', '/home'), false);
  const shell = f.tmux.add('shell', '❯ '); shell.role = '';
  f.tmux.add('lost', '');
  const rows = await collectStatus(f.ctx); assert.ok(!rows.some(r => r.task === 'SHELL')); assert.equal(rows.find(r => r.task === 'LOST')!.state, 'orphan');
  assert.match(await f.full('doctor'), /środowisko dev/);
});
for (const tool of ['close', 'cancel', 'archive', 'gc', 'mark'] as const) it(`0173-FIX-I scope guard: ${tool} cohort preview IDs equal executed IDs (three tasks)`, async () => {
  const f = fixture(`scope-${tool}`), closed = tool === 'archive' || tool === 'gc';
  for (const id of ['T1','T2','T3']) { seedTask(f.config, id, { cohort: 'NC', closed }); if (!closed) f.tmux.add(id.toLowerCase(), '❯ \n'); }
  seedTask(f.config, 'OTHER', { cohort: 'other', closed });
  const args = { cohort: 'NC', ...(tool === 'mark' ? { result: 'ok' } : {}) };
  const preview = await f.full(tool, args); for (const id of ['T1','T2','T3']) assert.ok(preview.includes(id), `${tool}: ${preview}`); assert.ok(!preview.includes('OTHER'));
  const executed = await f.full(tool, { ...args, confirm: true });
  if (tool === 'close' || tool === 'cancel') for (const id of ['T1','T2','T3']) assert.equal(Boolean(readTaskRecord(f.config, id.toLowerCase())![tool === 'close' ? 'closed' : 'cancelled']), true);
  else if (tool === 'mark') { for (const id of ['T1','T2','T3']) assert.ok(executed.includes(id)); assert.ok(!executed.includes('OTHER')); }
  else for (const id of ['T1','T2','T3']) { assert.ok(executed.includes(id)); assert.equal(readTaskRecord(f.config, id.toLowerCase()), undefined); }
  assert.equal(Boolean(readTaskRecord(f.config, 'other')?.cancelled), false);
});
it('0173-FIX-M: an existing finished cohort bootstraps grace from its last task change', async () => {
  const f = fixture('bootstrap'), old = new Date(f.runner.now() - 600000), r = seedTask(f.config, 'T1', { cohort: 'NC', started: new Date(old.getTime() - 1000).toISOString(), turnEndedAt: old.toISOString() });
  fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'Werdykt: PASS\n');
  for (const file of [r.report, taskFile(f.config, 't1')]) fs.utimesSync(file, old, old);
  fs.mkdirSync(cohortsDir(f.config), { recursive: true }); fs.writeFileSync(path.join(cohortsDir(f.config), 'nc.json'), JSON.stringify({ name: 'NC', created: old.toISOString() }));
  assert.equal((await cohortTick(f.ctx, { notify: async () => {} }, await collectStatus(f.ctx))).length, 1);
});

it('0173-FIX-I guard inventory: every two-stage cohort selector has a scope-equality scenario', () => {
  const selectors = MCP_TOOLS.filter(t => t.kind === 'write' && t.input.confirm && t.input.cohort && !['new','queue','cohort_add','cohort_note'].includes(t.name));
  assert.deepEqual(selectors.map(t => t.name).sort(), ['archive','cancel','close','gc','mark']);
});
it('0173-FIX-J/H: missing report source is explicit; unowned real-agent process is an orphan, plain shell is not', async () => {
  const f = fixture('missing'); seedTask(f.config, 'T1');
  const preview = await f.full('report_from', { task: 'T1', from: path.join(f.root, 'missing.md') }); assert.match(preview, /"source_exists": false/); assert.match(preview, /"source_bytes": null/);
  const tmux = new FakeTmux(); tmux.add('lost-agent', '').role = '';
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args, opts) => cmd === 'tmux' && args[0] === 'display-message' ? { stdout: 'codex' } : tmux.respond(cmd, args, opts) });
  assert.equal((await collectStatus(new Context(runner, f.config, () => {}))).find(r => r.task === 'LOST-AGENT')!.state, 'orphan');
});
it('0173-FIX-C: a launching task is never pasted into a shell before the agent is armed', async () => {
  const f = fixture('launching'), r = seedTask(f.config, 'T1'); f.tmux.add('t1', '❯ \n'); await queuePrompt(f.ctx, r, 'Original prompt', 'launching');
  await watchTick(f.ctx, new WatchMemory(), { notify: async () => {} }); assert.equal(f.runner.commands.some(c => c.includes('paste-buffer')), false);
});
it('0173-FIX-U6: role tag wins over an unrelated legacy-named window', async () => {
  const f = fixture('role'); const shell=f.tmux.add('watch'); shell.role=''; const tagged=f.tmux.add('renamed'); tagged.role='watch';
  await f.ctx.tmux.killRole('watch'); assert.deepEqual(f.tmux.windows.map(w => w.name), ['watch']);
});
