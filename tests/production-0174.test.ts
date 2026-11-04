import { setClaudePlan } from './usage-world.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import YAML from 'yaml';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { makeConfig, seedTask, useScratch, FakeTmux, DiskRunner, runCli } from './helpers.ts';
import { collectStatus } from '../src/core/status.ts';
import { classifyScreen } from '../src/core/state.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { planGc, applyGc, gcView, renderGc } from '../src/core/gc.ts';
import type { GcPlan } from '../src/core/gc.ts';
import { liveWindows } from '../src/core/plan.ts';
import { collectLimits } from '../src/core/limits.ts';
import { sendPrompts } from '../src/core/send.ts';
import { capacitySnapshot, collectCapacity, snapshotLines } from '../src/core/capacity.ts';
import { taskFile, setHeaderFields } from '../src/core/taskstore.ts';
import { planQueueAdd, commitQueueAdd } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { runDoctor } from '../src/core/doctor.ts';
const scratch = useScratch();
function fixture(name: string, yaml = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new, queue, gc, send, close]}\n${yaml}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    if (cmd === 'git') return args.includes('--porcelain') ? { stdout: '' } : args.includes('rev-parse') ? { stdout: args.includes('--abbrev-ref') ? 'feature\n' : 'a'.repeat(40) + '\n' } : { code: 0 };
    return tmux.respond(cmd, args, opts);
  } });
  const ctx = new Context(runner, config, () => {}), notices: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  const deps = { context: () => ctx, notify: async () => {} };
  const call = (name: string, args: Record<string, unknown> = {}) => { const t = MCP_TOOLS.find(t => t.name === name)!; return t.run(deps, z.object(t.input).parse(args)); };
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const spec = (task: string, extra: Record<string, unknown> = {}) => `---\n${YAML.stringify({ task, agent: 'claude', model: 'sonnet', effort: 'high', repos: [{ path: repo, worktree: `${repo}-${task}`, branch: task, base: 'a'.repeat(40) }], ...extra })}---\nDo the work.\n`;
  return { root, config, tmux, runner, ctx, notices, notifier, deps, call, repo, spec };
}
function report(r: ReturnType<typeof seedTask>) { fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n'); }
const token = (text: string) => /preview_token: ([\da-f-]+)/.exec(text)![1]!;
const screen = fs.readFileSync(new URL('./fixtures/screen-claude-sonnet-high-running.txt', import.meta.url), 'utf8');
for (const symbol of ['✽', '✶', '✻', '✢', '·', '*']) it(`P1 sonnet/high spinner ${symbol} and running tool remain working`, () => {
  assert.equal(classifyScreen(screen.replace('✽', symbol), DEFAULT_AGENT_SETTINGS.claude), 'working');
  assert.equal(classifyScreen('⏺ Running npm test…\n❯ \n', DEFAULT_AGENT_SETTINGS.claude), 'working');
  assert.equal(classifyScreen('Running …\n❯ \n', DEFAULT_AGENT_SETTINGS.claude), 'working');
});
it('P1 confirms consecutive idle reads, resets after work and lets Stop end only an idle screen', async () => {
  const f = fixture('idle', 'watch: {idle_confirm_ticks: 3}\n'), r = seedTask(f.config, 'P1'); const pane = f.tmux.add('p1', screen);
  const state = async () => (await collectStatus(f.ctx))[0]!.state;
  assert.equal(await state(), 'working'); pane.screen = '❯ \n'; assert.equal(await state(), 'working'); assert.equal(await state(), 'working'); assert.equal(await state(), 'waiting');
  pane.screen = screen; assert.equal(await state(), 'working'); pane.screen = '❯ \n'; assert.equal(await state(), 'working'); pane.screen = screen; assert.equal(await state(), 'working');
  await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), { task: r.task, agent: 'claude', kind: 'stop', payload: { stop_hook_active: false } });
  assert.equal(await state(), 'working'); assert.equal(f.notices.length, 0);
  pane.screen = '❯ \n'; await f.runner.sleep(1); await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), { task: r.task, agent: 'claude', kind: 'stop', payload: { stop_hook_active: false } }); assert.equal(await state(), 'waiting');
});
for (const mode of ['fresh', 'guide', 'parallel'] as const) it(`P3 ${mode}: identical preview survives unrelated reads/starts and canonical spec formatting`, async () => {
  const f = fixture(`confirm-${mode}`), args = { spec: f.spec('P3'), no_agent: true };
  const preview = await f.call('new', args); assert.equal(preview.isError, undefined, preview.text);
  if (mode === 'guide') await f.call('guide');
  if (mode === 'parallel') { await Promise.all([f.call('capacity'), f.call('status'), (async () => { const other = { spec: f.spec('OTHER'), no_agent: true }; await f.call('new', other); assert.equal((await f.call('new', { ...other, confirm: true })).isError, undefined); })()]); }
  const raws = splitSpecs(args.spec); const canonicalVariant = `---\n${YAML.stringify(Object.fromEntries(Object.entries(raws[0]!.header).reverse()))}---\n\nDo the work.  \r\n`;
  const result = await f.call('new', { ...args, spec: canonicalVariant, confirm: true, preview_token: token(preview.text) }); assert.equal(result.isError, undefined, result.text);
});
it('P3 gives precise TTL, argument field and session errors; failed mismatch keeps the valid token usable', async () => {
  const f = fixture('confirm-errors', 'preview: {ttl_s: 2}\n');
  const args = { spec: f.spec('P3'), no_agent: true }, preview = await f.call('new', args), preview_token = token(preview.text);
  const mismatch = await f.call('new', { ...args, no_agent: false, preview_token, confirm: true }); assert.match(mismatch.text, /different argument hash: no_agent/);
  const otherDeps = { ...f.deps }; const t = MCP_TOOLS.find(t => t.name === 'new')!; const other = await t.run(otherDeps, { ...args, preview_token, confirm: true }); assert.match(other.text, /different session/);
  f.config.preview.ttlS = 600; // a reload cannot extend an already-issued token
  await f.runner.sleep(2001); assert.match((await f.call('new', { ...args, preview_token, confirm: true })).text, /TTL expired \(2s/);
});
for (const tool of ['new', 'queue']) it(`P2 ${tool}: preview warns about every missing project/spec link and confirm leaves no task`, async () => {
  const f = fixture(`links-${tool}`), projectTarget = path.join(f.root, 'missing-project'), specTarget = path.join(f.root, 'missing-spec');
  fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), YAML.stringify({ links: [{ from: 'backend', to: projectTarget }] }));
  const args = { spec: f.spec('P2', { links: [{ from: 'client', to: specTarget }] }), ...(tool === 'new' ? { no_agent: true } : {}) };
  const preview = await f.call(tool, args); assert.equal(preview.isError, undefined, preview.text); assert.ok(preview.text.includes(projectTarget) && preview.text.includes(specTarget));
  const rejected = await f.call(tool, { ...args, confirm: true }); assert.equal(rejected.isError, true); assert.match(rejected.text, /link targets are missing/); assert.match(rejected.text, /Create\/check out the target first/); assert.equal(fs.existsSync(`${f.repo}-P2`), false);
  const doctor = await runDoctor(f.runner, () => f.config, f.repo); assert.ok(doctor.some(c => c.name === 'project links' && c.status === 'fail' && c.detail.includes(projectTarget)));
  fs.mkdirSync(path.join(f.config.cache, 'shared'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), 'links: [{from: deps, to: "{cache}/shared"}]\n');
  assert.ok(!(await runDoctor(f.runner, () => f.config, f.repo)).some(c => c.name === 'project links' && c.status === 'fail'));
});
for (const source of ['project', 'active-spec'] as const) it(`P2 GC protects a worktree used by ${source} links, including nested target and CLI-only force`, async () => {
  const f = fixture(`protect-${source}`), wt = path.join(f.root, 'finished'); fs.mkdirSync(path.join(wt, 'packages'), { recursive: true });
  seedTask(f.config, 'OLD', { closed: true, repos: [{ path: f.repo, worktree: wt }] });
  if (source === 'project') fs.writeFileSync(path.join(f.repo, '.agentctl.yaml'), YAML.stringify({ links: [{ from: 'deps', to: path.join(wt, 'packages/*') }] }));
  else seedTask(f.config, 'ACTIVE', { links: [{ from: 'deps', to: path.join(wt, 'packages') }] });
  const plan = await planGc(f.ctx); assert.ok(plan.skipped.some(s => s.target === wt && /links target used/.test(s.reason))); assert.equal(plan.items.some(i => i.target === wt), false);
  assert.match((await f.call('gc_preview', { detail: true })).text, /links target/);
  assert.ok((await planGc(f.ctx, { forceLinks: true })).items.some(i => i.target === wt)); assert.equal('force_links' in MCP_TOOLS.find(t => t.name === 'gc')!.input, false);
});
it('P2 apply rechecks new link references after preview', async () => {
  const f = fixture('protect-race'), wt = path.join(f.root, 'wt'); fs.mkdirSync(wt); seedTask(f.config, 'OLD', { closed: true, repos: [{ path: f.repo, worktree: wt }] });
  const plan = await planGc(f.ctx); seedTask(f.config, 'LIVE', { links: [{ from: 'dep', to: wt }] }); const result = await applyGc(f.ctx, plan); assert.ok(result.failed.some(i => /links target/.test(i.reason))); assert.ok(fs.existsSync(wt));
});
it('P5 displaced canonical report yields one state across doctor/status/list/get/pull_ready', async () => {
  const f = fixture('report'), r = seedTask(f.config, 'REPORT', { reportSource: path.join(f.root, 'source.md') }); report(r); fs.copyFileSync(r.report, r.reportSource!);
  fs.renameSync(r.report, path.join(f.root, 'displaced.md'));
  assert.equal((await collectStatus(f.ctx))[0]!.report, 'missing'); assert.match((await f.call('get_report', { task: r.task })).text, /no report yet: no report/); assert.match((await f.call('list_reports', { all: true })).text, /No reports/); assert.match((await f.call('pull_ready')).text, /No reports ready/);
  const checks = await runDoctor(f.runner, () => f.config, null); assert.match(checks.find(c => c.name === 'report REPORT')!.detail, /^no report:/); assert.ok(!checks.some(c => /raport pochodzi z kopii/.test(c.detail)));
});
it('P8 gc aliases do not write and help states default preview; apply cannot override preview', async () => {
  const f = fixture('aliases'); seedTask(f.config, 'CLOSED', { closed: true });
  const baseline = await runCli(f.config, f.runner, ['gc', '--json']);
  for (const flag of ['--preview', '--dry-run']) assert.equal((await runCli(f.config, f.runner, ['gc', flag, '--json'])).stdout, baseline.stdout);
  assert.match((await runCli(f.config, f.runner, ['gc', '--help'])).stdout, /Bez flag = podgląd, --apply wykonuje/);
  assert.equal((await runCli(f.config, f.runner, ['gc', '--preview', '--apply', '-y'])).code, 1); assert.ok(fs.existsSync(taskFile(f.config, 'closed')));
});
it('P9 160 tasks / 16000 files: compact default, exact byte/category/cohort totals, task grouping and paginated detail', async () => {
  const plan: GcPlan = { items: [], skipped: [], freeBytes: 0, olderThanMs: 604800000, unknownCacheDirs: 0 };
  for (let task = 0; task < 160; task++) { plan.items.push({ task: `TASK-${task}`, kind: 'worktree', cohort: `C-${task % 4}`, target: `/private-fixture/${task}`, bytes: 1000000000, detail: 'closed' }); for (let i = 0; i < 100; i++) plan.skipped.push({ task: `TASK-${task}`, cohort: `C-${task % 4}`, kind: 'cache', target: `/private-fixture/${task}/file-${i}.log`, bytes: 10, reason: 'newer than 7d' }); }
  plan.freeBytes = 160000000000;
  const view = gcView(plan); assert.ok(Buffer.byteLength(JSON.stringify(view)) < 8192); assert.ok(Buffer.byteLength(renderGc(plan).join('\n')) < 8192); assert.equal(view.freeBytes, 160000000000); assert.equal(view.categories[0]!.count, 160); assert.equal(view.skipped.bytes, 160000); assert.equal(view.newer.total, 160); assert.equal(view.newer.items[0]!.files, 100); assert.equal(view.cohorts.items[0]!.bytes, 40000000000); assert.equal('details' in view, false);
  const detail = gcView(plan, { detail: true, offset: 157, limit: 5 }); assert.equal(detail.details!.items.length, 5); assert.equal(detail.details!.items[0]!.task, 'TASK-157'); assert.equal(detail.details!.next_offset, 162);
});
it('P10 ready idle windows release slots; new/queue hint; send cannot exceed a full provider limit and resumes counting', async () => {
  const f = fixture('slots', 'limits: {claude: 1}\n'), r = seedTask(f.config, 'READY'); report(r); const ready = f.tmux.add('ready', '❯ \n');
  let load = collectLimits(f.config, await liveWindows(f.ctx)).providers[0]!; assert.equal(load.used, 0); assert.deepEqual(load.reportReady, ['ready']); assert.equal(load.free, 1);
  const preview = await f.call('new', { spec: f.spec('NEXT'), no_agent: true }); assert.match(preview.text, /1 okien report-ready/);
  const q = await planQueueAdd(f.ctx, splitSpecs(f.spec('QUEUED'))); assert.match(q.summary.join('\n'), /1 okien report-ready/);
  seedTask(f.config, 'BUSY'); const busy = f.tmux.add('busy', screen); const sent = await sendPrompts(f.ctx, [{ task: r.task, window: r.window, prompt: 'more' }]); assert.match(sent[0]!.warning!, /limit.*reached/); assert.equal(f.runner.commands.some(c => c.startsWith('tmux paste-buffer')), false);
  f.tmux.windows.splice(f.tmux.windows.indexOf(busy), 1); const accepted = await sendPrompts(f.ctx, [{ task: r.task, window: r.window, prompt: 'continue working' }]); assert.ok(!accepted[0]!.warning?.includes('limit'));
  ready.screen = screen; load = collectLimits(f.config, await liveWindows(f.ctx)).providers[0]!; assert.equal(load.used, 1); assert.equal(load.reportReady.length, 0);
  ready.screen = '❯ \n'; assert.equal(collectLimits(f.config, await liveWindows(f.ctx)).providers[0]!.used, 1, 'old report cannot release a resumed task');
});
it('P10 count_report_ready true preserves window counting', async () => {
  const f = fixture('count-ready', 'limits: {claude: 1, count_report_ready: true}\n'), r = seedTask(f.config, 'READY'); report(r); f.tmux.add('ready', '❯ \n'); const load = collectLimits(f.config, await liveWindows(f.ctx)).providers[0]!; assert.equal(load.used, 1); assert.equal(load.free, 0); assert.equal(load.reportReady.length, 1);
});
it('P11 stale capacity explains elapsed hours and local reading time without changing stale facts', async () => {
  const f = fixture('stale'); setClaudePlan(f.config.path, f.runner.now(), { session: 20, week: 30 }, 7200000);
  const data = await collectCapacity(f.ctx); const p = data.providers[0]!; assert.equal(p.ageSeconds, 7200);
  const text = snapshotLines(capacitySnapshot(data)).join('\n'); assert.match(text, /Claude: brak aktywnej sesji od 2.0 h \(odczyt z \d{2}:\d{2}\)/); assert.equal(capacitySnapshot(data)[0]!.stale, true);
});
it('new config values validate types and defaults', () => {
  const f = fixture('defaults'); assert.equal(f.config.preview.ttlS, 600); assert.equal(f.config.watch.idleConfirmTicks, 2); assert.equal(f.config.countReportReady, false);
  for (const yaml of ['preview: {ttl_s: 0}', 'preview: {ttl_s: nope}', 'limits: {count_report_ready: 1}', 'watch: {idle_confirm_ticks: 1.5}', 'watch: {idle_confirm_ticks: 0}']) assert.throws(() => makeConfig(scratch.sub(`invalid-${Math.random()}`), yaml));
});

it('P3 receipt reads do not invalidate destructive previews with unchanged targets', async () => {
  const f = fixture('receipt-scope'), r = seedTask(f.config, 'READY'); report(r); f.tmux.add('ready', '❯ \n');
  const preview = await f.call('close', { tasks: ['READY'] }); assert.equal(preview.isError, undefined, preview.text);
  await f.call('get_report', { task: 'READY' });
  assert.equal((await f.call('close', { tasks: ['READY'], confirm: true })).isError, undefined);
});
it('P10 concurrent sends serialize admission to the last free slot', async () => {
  const f = fixture('concurrent-slots', 'limits: {claude: 1}\n');
  for (const task of ['A', 'B']) { report(seedTask(f.config, task)); f.tmux.add(task.toLowerCase(), '❯ \n'); }
  const results = await Promise.all(['A', 'B'].map(task => sendPrompts(f.ctx, [{ task, window: task.toLowerCase(), prompt: 'continue' }])));
  assert.equal(results.filter(r => r[0]?.warning?.includes('limit')).length, 1);
  assert.equal(collectLimits(f.config, await liveWindows(f.ctx)).providers[0]!.used, 1);
});
it('P1 a fresh task with no Stop needs two idle reads', async () => {
  const f = fixture('fresh-idle'); seedTask(f.config, 'FRESH', { turnEndedAt: undefined }); f.tmux.add('fresh', '❯ \n');
  assert.equal((await collectStatus(f.ctx))[0]!.state, 'working'); assert.equal((await collectStatus(f.ctx))[0]!.state, 'waiting');
});

it('P1 idle confirmation survives a new CLI context and an old Stop cannot override later work', async () => {
  const f = fixture('durable-idle'); const r = seedTask(f.config, 'PERSIST', { turnEndedAt: undefined }); const pane = f.tmux.add('persist', screen);
  const sample = () => collectStatus(new Context(f.runner, f.config, () => {}));
  assert.equal((await sample())[0]!.state, 'working');
  await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), { task: r.task, agent: 'claude', kind: 'stop', payload: { stop_hook_active: false } });
  assert.equal((await sample())[0]!.state, 'working'); pane.screen = '❯ \n';
  assert.equal((await sample())[0]!.state, 'working'); assert.equal((await sample())[0]!.state, 'waiting');
});
