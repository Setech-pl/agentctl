import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { MCP_WRITE_TOOLS } from '../src/core/config.ts';
import { MCP_TOOLS, readReportFile, reportSection, responseWireBytes } from '../src/core/mcp-tools.ts';
import { findCandidates, syncReport } from '../src/core/report-detect.ts';
import { collectStatus } from '../src/core/status.ts';
import { sizeOf } from '../src/core/fs-measure.ts';
import { collectDisk } from '../src/core/disk.ts';
import { cohortTick, touchCohort } from '../src/core/cohort.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { commitQueueAdd, planQueueAdd, setPaused } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { stableSelfArgv } from '../src/core/mcp-install.ts';
import { buildClaudeSettings, buildCodexNotify } from '../src/core/events.ts';
import { buildTapStatusLine } from '../src/core/usage-tap.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, specText, useScratch } from './helpers.ts';
const scratch = useScratch();
const question = 'Which option?\n❯ 1. First\n  2. Second\nEnter to select · Esc to cancel';
function fixture(name: string, yaml = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {codex_refresh: false}\n${/^mcp:/m.test(yaml) ? '' : `mcp: {allow: [${MCP_WRITE_TOOLS.join(', ')}]}\n`}${yaml}`);
  const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() + 1000 });
  const ctx = new Context(runner, config, () => {}), deps = { context: () => ctx, notify: async () => {}, self: [process.execPath, path.resolve('bin/agentctl.ts')] };
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args as never);
  return { root, config, tmux, runner, ctx, deps, call };
}
it('0173-1: every MCP tool default is bounded with 160 tasks and 190 worktrees; previews contain only targets', async () => {
  const f = fixture('registry'), repo = scratch.sub('registry/repo');
  for (let i = 0; i < 160; i++) seedTask(f.config, `TASK-${i}`, { closed: i >= 10, cohort: 'NC', repos: Array.from({ length: i < 30 ? 2 : 1 }, (_, n) => ({ path: repo, worktree: path.join(f.root, `wt-${i}-${n}`) })) });
  f.tmux.add('task-1', '❯ \n');
  await commitQueueAdd(f.ctx, (await planQueueAdd(f.ctx, splitSpecs(specText({ task: 'Q1', agent: 'claude' }, repo)))).items);
  const inputs: Record<string, unknown> = { task: 'TASK-1', tasks: ['TASK-1'], cohort: 'NC', spec: specText({ task: 'NEW1', agent: 'claude' }, repo), message: 'Continue', prompt: 'Continue', result: 'ok', on: false, from: path.join(f.root, 'missing.md'), text: 'note', report: path.join(f.root, 'adopt.md'), agent: 'codex', claude: 1 };
  for (const tool of MCP_TOOLS) {
    const args = Object.fromEntries(Object.keys(tool.input).filter(k => k in inputs).map(k => [k, inputs[k]]));
    const result = await f.call(tool.name, args);
    assert.ok(responseWireBytes(result) <= 8192, `${tool.name}: ${responseWireBytes(result)}`);
  }
  for (const [name, args] of [['queue_pause', {}], ['interrupt', { task: 'TASK-1' }], ['queue_rm', { task: 'Q1' }]] as const) {
    const r = await f.call(name, args); assert.equal(r.isError, undefined, r.text);
    assert.ok(!r.text.includes('TASK-159'), r.text); assert.ok(Buffer.byteLength(r.text) < 3000);
    const scope = JSON.parse(r.text.slice(0, r.text.indexOf('\nNot executed.'))).scope;
    assert.equal(scope.tasks.length, name === 'interrupt' ? 1 : name === 'queue_pause' ? 1 : 0);
  }
  const large = await f.call('status', { all: true, format: 'json' });
  let page = JSON.parse(large.text), joined = page.fragment;
  assert.equal(page.truncated, true);
  while (page.has_more) { const next = await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); assert.ok(responseWireBytes(next) <= 8192); page = JSON.parse(next.text); joined += page.fragment; }
  assert.equal(JSON.parse(joined).tasks.length, 161);
  assert.equal(JSON.parse(joined).tasks.find((task: {task: string}) => task.task === 'Q1').state, 'registered');
  assert.equal((await f.call('response_page', { response_id: 'unknown', response_offset: 0 })).isError, true);
});
it('0173-2/3: mentioned README is ignored; glob candidate is a flag beside needs-input; explicit report_from confirms', async () => {
  const f = fixture('candidate'), wt = scratch.sub('candidate/wt');
  const r = seedTask(f.config, 'T2', { repos: [{ path: wt, worktree: wt }], reportAlt: ['*.md'] });
  f.tmux.add('t2', question);
  for (const name of ['README.md', 'CHANGELOG.md', 'CLAUDE.md', 'integration-12.md']) fs.writeFileSync(path.join(wt, name), 'Werdykt: PASS');
  await syncReport(f.ctx, r);
  assert.deepEqual(findCandidates(f.ctx, r), []);
  assert.equal((await collectStatus(f.ctx))[0]!.state, 'needs-input');
  fs.writeFileSync(path.join(wt, 'T2-final.md'), 'Werdykt: PASS\n');
  await syncReport(f.ctx, r);
  const row = (await collectStatus(f.ctx))[0]!;
  assert.equal(row.state, 'needs-input'); assert.ok(row.reportCandidate); assert.ok(row.question);
  assert.match((await f.call('status')).text, /needs-input.*\?/);
  assert.match((await f.call('events_since')).text, /Which option/);
  assert.equal(fs.existsSync(r.report), false);
  assert.equal((await f.call('report_from', { task: 'T2', from: 'T2-final.md' })).isError, undefined);
  assert.equal((await f.call('report_from', { task: 'T2', from: 'T2-final.md', confirm: true })).isError, undefined);
  assert.equal(fs.readFileSync(r.report, 'utf8'), 'Werdykt: PASS\n');
  assert.doesNotMatch((await f.call('status')).text, /raport pochodzi z kopii/);
  assert.doesNotMatch((await f.call('doctor')).text, /raport pochodzi z kopii/);
});
it('0173-4: grace persists, resets on membership/state changes, cancels for new work and announces a later cohort again', async () => {
  const f = fixture('grace'); assert.equal(f.config.cohort.doneGraceS, 300);
  await touchCohort(f.ctx, 'NC');
  const write = (id: string) => { const r = seedTask(f.config, id, { cohort: 'NC' }); fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'Werdykt: PASS\n'); };
  const tick = async () => cohortTick(f.ctx, { notify: async () => {} }, await collectStatus(f.ctx));
  write('T1'); assert.deepEqual(await tick(), []); await f.runner.sleep(299000); assert.deepEqual(await tick(), []);
  seedTask(f.config, 'T2', { cohort: 'NC' }); await touchCohort(f.ctx, 'NC'); assert.deepEqual(await tick(), []);
  await f.runner.sleep(301000); assert.deepEqual(await tick(), []);
  write('T2'); assert.deepEqual(await tick(), []); await f.runner.sleep(300000); assert.equal((await tick()).length, 1); assert.deepEqual(await tick(), []);
  write('T3'); await touchCohort(f.ctx, 'NC'); assert.deepEqual(await tick(), []); await f.runner.sleep(300000); assert.equal((await tick()).length, 1);
});
it('0173-5: paused queue preview names queue_resume instead of the next tick', async () => {
  const f = fixture('paused'), repo = scratch.sub('paused/repo'); await setPaused(f.ctx, true);
  const result = await f.call('queue', { spec: specText({ task: 'Q1', agent: 'claude' }, repo) });
  assert.match(result.text, /queue paused.*queue_resume/); assert.doesNotMatch(result.text, /next watch tick/);
});
it('0173-6: small, large and section reports expose absolute end offsets and consistent EOF', async () => {
  const f = fixture('pages');
  for (const text of ['a'.repeat(640), '# A\n' + 'ą'.repeat(15000) + '\n# B\nend']) {
    const r = seedTask(f.config, 'PAGE'); fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, text);
    for (const section of [undefined, ...(text.startsWith('#') ? ['A'] : [])]) {
      let next = 0, joined = ''; for (;;) { const page = readReportFile(r, { section, byte_offset: next, maxBytes: 1024 }); assert.equal(page.next_byte_offset, page.end_byte); assert.equal(page.has_more, page.end_byte < Buffer.byteLength(section ? reportSection(text, section) : text)); joined += page.text; next = page.next_byte_offset; if (!page.has_more) break; }
      assert.equal(joined, section ? reportSection(text, section) : text);
    }
  }
});
it('0173-7: disk defaults show totals/count/top five; detail paths paginate, including cohort JSON status', async () => {
  const f = fixture('disk');
  for (let i = 0; i < 190; i++) seedTask(f.config, `D${i}`, { cohort: 'NC', repos: [{ path: f.root, worktree: path.join(f.root, `wt${i}`) }] });
  await Promise.all(Array.from({ length: 190 }, (_, i) => sizeOf(path.join(f.root, `wt${i}`), { now: () => f.ctx.runner.now() })));
  const disk = await collectDisk(f.ctx); assert.equal(disk.worktreeCount, 190); assert.equal(disk.largestWorktrees!.length, 5); assert.deepEqual(disk.volumes[0]!.paths, []);
  let next: number | null = 0, count = 0; do { const page = await collectDisk(f.ctx, undefined, { detail: true, offset: next, limit: 7 }); count += page.volumes.flatMap(v => v.paths).length; next = page.pathsNextOffset!; } while (next !== null);
  assert.equal(count, disk.pathsTotal);
  for (const name of ['status', 'capacity']) { const response = await f.call(name, { cohort: 'NC', format: 'json' }); assert.ok(responseWireBytes(response) <= 8192); }
});
it('0173-8: guide reads explicit project overlay, warns when absent; MCP doctor has no implicit project', async () => {
  const f = fixture('project'), project = scratch.sub('project/repo');
  fs.writeFileSync(path.join(project, '.agentctl.yaml'), 'guide: rules.md\n'); fs.writeFileSync(path.join(project, 'rules.md'), 'PROJECT-OVERLAY');
  const read = async (args: Record<string, unknown>) => { const r = await f.call('guide', args); let page; try { page = JSON.parse(r.text); } catch { return r.text; } let text = page.fragment; while (page.has_more) { page = JSON.parse((await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset })).text); text += page.fragment; } return text; };
  assert.match(await read({ project }), /PROJECT-OVERLAY/); fs.writeFileSync(path.join(project, '.agentctl.yaml'), '{}\n'); assert.match(await read({ project }), /brak nakładki projektu/);
  const projectDoctor = await f.call('doctor', { project }); assert.ok(projectDoctor.text.includes(path.join(project, '.agentctl.yaml')));
  const doctor = await f.call('doctor'); assert.match(doctor.text, /bez projektu/); assert.doesNotMatch(doctor.text, /no .agentctl.yaml in/);
});
it('0173-9: all generated task callbacks normalize the same stable Node path; doctor flags active legacy wiring', async () => {
  const f = fixture('node'), prefix = scratch.sub('node/brew'), cellar = path.join(prefix, 'Cellar/node/26/bin/node');
  fs.mkdirSync(path.dirname(cellar), { recursive: true }); fs.writeFileSync(cellar, ''); fs.mkdirSync(path.join(prefix, 'bin')); fs.symlinkSync(cellar, path.join(prefix, 'bin/node'));
  const self = [cellar, '/agentctl.js'], stable = path.join(prefix, 'bin/node');
  assert.equal(stableSelfArgv(self)[0], stable); assert.equal(buildCodexNotify('T1', self, undefined)[0], stable); assert.ok(!JSON.stringify(buildClaudeSettings('T1', self)).includes('/Cellar/')); assert.ok(!JSON.stringify(buildTapStatusLine('claude', 'T1', self, f.config, undefined, {})).includes('/Cellar/'));
  seedTask(f.config, 'OLD'); fs.writeFileSync(path.join(f.config.stateDir, 'old/claude-settings.json'), JSON.stringify({ command: '/opt/homebrew/Cellar/node/26/bin/node' }));
  assert.match((await f.call('doctor')).text, /versioned Node path.*until Node is upgraded/);
  seedTask(f.config, 'OLD-CODEX', { agent: 'codex' });
  const processRunner = new DiskRunner({ dryRun: false, respond: (cmd, args, opts) => cmd === 'ps' ? { stdout: 'codex -c notify=["/opt/homebrew/Cellar/node/26/bin/node","event","--task","OLD-CODEX"]' } : f.tmux.respond(cmd, args, opts) });
  const deps = { context: () => new Context(processRunner, f.config, () => {}), notify: async () => {} };
  assert.match((await MCP_TOOLS.find(t => t.name === 'doctor')!.run(deps, {})).text, /versioned Node path in active callback argv/);
});

it('0173-1: continuation preserves Unicode and errors, isolates sessions and never reexecutes a confirmed write', async () => {
  const f = fixture('fragments', 'mcp: {max_response_kb: 1, allow: [cohort_note]}\n');
  let notifications = 0; f.deps.notify = async () => { notifications++; };
  await touchCohort(f.ctx, 'NC');
  const args = { cohort: 'NC', text: ('ą😀\n\u0000').repeat(1500) };
  await f.call('cohort_note', args);
  const result = await f.call('cohort_note', { ...args, confirm: true });
  assert.ok(responseWireBytes(result) <= 1024);
  let page = JSON.parse(result.text), joined = page.fragment;
  const other = fixture('other-session');
  assert.equal((await other.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset })).isError, true);
  while (page.has_more) { const r = await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); assert.ok(responseWireBytes(r) <= 1024); page = JSON.parse(r.text); joined += page.fragment; }
  assert.equal(JSON.parse(joined).note, args.text.trim()); assert.equal(notifications, 1);
  const error = await f.call('task_spec', { task: 'UNKNOWN'.repeat(1000) }); assert.equal(error.isError, true); assert.ok(responseWireBytes(error) <= 1024);
  page = JSON.parse(error.text); joined = page.fragment;
  while (page.has_more) { const r = await f.call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); assert.equal(r.isError, true); assert.ok(responseWireBytes(r) <= 1024); page = JSON.parse(r.text); joined += page.fragment; }
  assert.match(joined, /no task/);
});

it('0173-1/4: config validates response limits and cohort grace, while accepting legacy candidate icon config', () => {
  const f = fixture('settings', 'mcp: {max_response_kb: 2}\ncohort: {done_grace_s: 7}\nwatch: {window_icons: {report-candidate: "?"}}\n');
  assert.equal(f.config.mcp.maxResponseKb, 2); assert.equal(f.config.cohort.doneGraceS, 7);
  assert.equal('report-candidate' in f.config.watch.windowIcons!, false);
  assert.equal(fixture('bad-limit', 'mcp: {max_response_kb: 0}\n').config.mcp.maxResponseKb, 8);
  assert.throws(() => fixture('bad-grace', 'cohort: {done_grace_s: -1}\n'), /done_grace_s/);
});
