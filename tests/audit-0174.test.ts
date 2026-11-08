import { planResume, resumeTasks } from '../src/core/resume.ts';
import { deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { it } from 'node:test';
import YAML from 'yaml';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { RealRunner, RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { atomicWriteFile, stateWriteFailure } from '../src/core/atomic-file.ts';
import { withFileLock, taskLock } from '../src/core/file-lock.ts';
import { setHeaderFields, taskFile, readTaskRecord } from '../src/core/taskstore.ts';
import { collectStatus } from '../src/core/status.ts';
import { checkReportPath, readReportText } from '../src/core/report-path.ts';
import { reportInfo } from '../src/core/report-detect.ts';
import { readReportFile, MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { newTasks } from '../src/core/new.ts';
import { pendingStarts } from '../src/core/start-lock.ts';
import { planQueueAdd, commitQueueAdd, queueTick, QueueMemory, retryEntry, queueDir, readQueue } from '../src/core/queue.ts';
import { useScratch, makeConfig, seedTask, FakeTmux, DiskRunner, runCli } from './helpers.ts';
const scratch = useScratch();
const enospc = () => Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
function fixture(name: string, extra = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new, queue, report_from]}\n${extra}`);
  const tmux = new FakeTmux();
  const respond = (cmd: string, args: string[], opts: ExecOptions): Partial<ExecResult> | undefined => cmd === 'git' ? { code: 0, stdout: args.includes('rev-parse') ? 'a'.repeat(40) + '\n' : '' } : tmux.respond(cmd, args, opts);
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond });
  const ctx = new Context(runner, config, () => {}), deps = { context: () => ctx, notify: async () => {} };
  const call = (name: string, args: Record<string, unknown>) => { const tool = MCP_TOOLS.find(t => t.name === name)!; return tool.run(deps, z.object(tool.input).parse(args)); };
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  const spec = (task: string, report?: string) => `---\n${YAML.stringify({ task, agent: 'claude', model: 'sonnet', effort: 'high', repos: [{ path: repo, worktree: `${repo}-${task}`, branch: task, base: 'a'.repeat(40) }], ...(report ? { report } : {}) })}---\nDo fixture.\n`;
  return { root, config, tmux, runner, respond, ctx, call, repo, spec };
}
it('K1/S3: concurrent header changes and body appends use the prompt-delivery task lock without lost updates or deadlock', async () => {
  const f = fixture('concurrent'), r = seedTask(f.config, 'STATE'), file = taskFile(f.config, r.window);
  const dryFile = path.join(f.root, 'dry-run', 'TASK.md'); await setHeaderFields(new RecordingRunner(), dryFile, { closed: true }); assert.equal(fs.existsSync(path.dirname(dryFile)), false);
  class SlowRunner extends RealRunner { override async writeFile(file: string, text: string) { await new Promise(resolve => setTimeout(resolve, 1)); return super.writeFile(file, text); } }
  const runner = new SlowRunner();
  await withFileLock(taskLock(file), () => setHeaderFields(runner, file, { report_candidate: 'candidate', report_complete_hash: 'hash' }));
  await Promise.all([...Array.from({ length: 24 }, (_, n) => setHeaderFields(runner, file, { [`field_${n}`]: n })), runner.appendFile(file, '\nAPPENDED BODY\n')]);
  const text = fs.readFileSync(file, 'utf8'), header = YAML.parse(text.split('---')[1]!);
  for (let n = 0; n < 24; n++) assert.equal(header[`field_${n}`], n);
  assert.equal(header.report_candidate, 'candidate'); assert.equal(header.report_complete_hash, 'hash'); assert.match(text, /APPENDED BODY/);
});
for (const phase of ['write', 'fsync', 'rename'] as const) it(`K1 ${phase}: failure preserves old TASK.md, returns ENOSPC and exposes durable needs-attention`, async t => {
  const f = fixture(`failure-${phase}`), r = seedTask(f.config, 'STATE', { pendingPrompt: 'Do not paste after a write failure', promptDelivery: 'pending' }), file = taskFile(f.config, r.window);
  class SandboxRunner extends RealRunner { override async exec(cmd: string, args: string[], opts: ExecOptions = {}) { return { code: 0, stdout: '', stderr: '', ...f.respond(cmd, args, opts) }; } }
  const runner = new SandboxRunner(); await runner.writeFile(file, fs.readFileSync(file, 'utf8')); const old = fs.readFileSync(file, 'utf8'); f.tmux.add('state', '❯ \n');
  let fail = true;
  if (phase === 'write') { const opened = new Set<number>(), open = fs.openSync; t.mock.method(fs, 'openSync', function(file: fs.PathLike, ...args: unknown[]) { const fd = Reflect.apply(open, fs, [file, ...args]); if (String(file).includes('.TASK.md.')) opened.add(fd); return fd; }); const original = fs.writeFileSync; t.mock.method(fs, 'writeFileSync', function(file: fs.PathLike | number, ...args: unknown[]) { if (typeof file === 'number' && opened.has(file) && fail) { fail = false; fs.writeSync(file, 'PARTIAL'); throw enospc(); } return Reflect.apply(original, fs, [file, ...args]); }); }
  if (phase === 'fsync') { const original = fs.fsyncSync; t.mock.method(fs, 'fsyncSync', function(fd: number) { if (fail) { fail = false; throw enospc(); } return original(fd); }); }
  if (phase === 'rename') { const original = fs.renameSync; t.mock.method(fs, 'renameSync', function(from: fs.PathLike, to: fs.PathLike) { if (to === file && fail) { fail = false; throw enospc(); } return original(from, to); }); }
  await assert.rejects(setHeaderFields(runner, file, { report_candidate: null, report_complete_hash: 'NEW' }), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), old); assert.match(stateWriteFailure(file)!.reason, /ENOSPC/);
  const row = (await collectStatus(new Context(runner, f.config, () => {})))[0]!; assert.equal(row.state, 'needs-attention'); assert.match(row.hint!, /ENOSPC/);
  assert.equal(await deliverPendingPrompt(new Context(runner, f.config, () => {}), r.window), 'needs-attention'); assert.ok(!f.tmux.seen.some(c => c.startsWith('paste-buffer')));
  assert.equal(fs.readdirSync(path.dirname(file)).filter(n => n.endsWith('.tmp')).length, 0);
  await setHeaderFields(runner, file, { report_complete_hash: 'RECOVERED', report_candidate: null }); assert.equal(stateWriteFailure(file), undefined); assert.equal(readTaskRecord(f.config, r.window)?.reportCompleteHash, 'RECOVERED');
});
it('K1 interrupted write: SIGKILL preserves TASK.md and a successor detects needs-attention', async () => {
  const f = fixture('crash'), r = seedTask(f.config, 'CRASH'), file = taskFile(f.config, r.window); const old = fs.readFileSync(file, 'utf8');
  await new RealRunner().writeFile(file, old); f.tmux.add('crash', '❯ \n');
  const source = `import fs from 'node:fs'; import {atomicWriteFile} from ${JSON.stringify(new URL('../src/core/atomic-file.ts', import.meta.url).href)}; fs.fsyncSync=()=>{process.stdout.write('prepared\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}; atomicWriteFile(${JSON.stringify(file)},'NEW PARTIAL JSON');`;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', source], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => { child.kill('SIGKILL'); resolve(); }); child.once('error', reject); child.once('exit', code => { if (code) reject(new Error(`child exited ${code}`)); }); });
  await new Promise(resolve => child.once('close', resolve)); assert.equal(fs.readFileSync(file, 'utf8'), old);
  const row = (await collectStatus(new Context(f.runner, f.config, () => {})))[0]!; assert.equal(row.state, 'needs-attention'); assert.match(row.hint!, /interrupted atomic write/);
});
for (const name of ['queue.json', 'cohorts.json', 'reservations.json', 'events-seen.json', 'config-state.json']) it(`K1 ${name}: a partial snapshot never replaces the old state`, t => {
  const file = path.join(scratch.sub(name), name); atomicWriteFile(file, '{"old":true}'); const original = fs.writeFileSync; let fail = true;
  t.mock.method(fs, 'writeFileSync', function(file: fs.PathLike | number, ...args: unknown[]) { if (typeof file === 'number' && fail) { fail = false; fs.writeSync(file, '{'); throw enospc(); } return Reflect.apply(original, fs, [file, ...args]); });
  assert.throws(() => atomicWriteFile(file, '{"new":true}'), /disk full/); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true });
});
it('K2 report_from refuses traversal, external absolute sources and symlinks in MCP even with force; CLI force permits only an external regular source', async () => {
  const f = fixture('report-from'), wt = path.join(f.root, 'wt'); fs.mkdirSync(wt);
  const r = seedTask(f.config, 'REPORT', { repos: [{ path: f.repo, worktree: wt }] });
  const outside = path.join(f.root, 'secret.md'); fs.writeFileSync(outside, 'fixture secret'); const link = path.join(wt, 'link.md'); fs.symlinkSync(outside, link);
  for (const from of ['../../../etc/passwd', outside, link]) { const result = await f.call('report_from', { task: r.task, from, force: true }); assert.equal(result.isError, true, result.text); assert.match(result.text, /outside|symlink/); assert.equal(fs.existsSync(r.report), false); }
  await assert.rejects(reportInfo(f.ctx, r.task, { from: outside }), /outside/);
  assert.equal((await reportInfo(f.ctx, r.task, { from: outside, force: true })).result?.action, 'copied'); assert.equal(fs.readFileSync(r.report, 'utf8'), 'fixture secret');
  await assert.rejects(reportInfo(f.ctx, r.task, { from: link, force: true }), /symlink/);
});
for (const tool of ['new', 'queue']) it(`W2 ${tool}: report outside approved roots or through a symlink is denied during MCP preview`, async () => {
  const f = fixture(`spec-${tool}`), outside = path.join(f.root, 'external.md'), alias = path.join(f.config.cache, 'alias'); fs.mkdirSync(f.config.cache); fs.symlinkSync(f.root, alias);
  for (const report of [outside, path.join(alias, 'external.md')]) { const result = await f.call(tool, { spec: f.spec('UNSAFE', report) }); assert.equal(result.isError, true, result.text); assert.match(result.text, /outside|symlink/); }
  const allowed = await f.call(tool, { spec: f.spec('SAFE', path.join(f.config.cache, 'safe.md')) }); assert.equal(allowed.isError, undefined, allowed.text);
});
it('W2 CLI preview warns about an outside report, while get_report and pull_ready refuse legacy outside/symlink reports', async () => {
  const f = fixture('legacy'), outside = path.join(f.root, 'external.md'); fs.writeFileSync(outside, 'SECRET FIXTURE\n<!-- agentctl:report-end -->');
  const input = path.join(f.root, 'spec.md'); fs.writeFileSync(input, f.spec('UNSAFE', outside)); const cli = await runCli(f.config, f.runner, ['new', input, '--dry-run', '--no-agent']); assert.match(cli.stdout, /WARNING.*outside/);
  const r = seedTask(f.config, 'LEGACY', { report: outside });
  assert.match((await f.call('get_report', { task: r.task })).text, /outside/); assert.ok(!(await f.call('pull_ready', { mode: 'full' })).text.includes('SECRET FIXTURE'));
  assert.throws(() => readReportFile(r, { config: f.config }), /outside/);
});
it('W2 double read guard rejects a directory switched to a symlink between validation and open', t => {
  const f = fixture('path-swap'), dir = path.join(f.config.cache, 'report'), moved = dir + '-old', external = path.join(f.root, 'external'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(external);
  const file = path.join(dir, 'REPORT.md'); fs.writeFileSync(file, 'APPROVED'); fs.writeFileSync(path.join(external, 'REPORT.md'), 'SECRET');
  const original = fs.openSync; let swapped = false;
  t.mock.method(fs, 'openSync', function(file_: fs.PathLike, ...args: unknown[]) { if (file_ === file && !swapped) { swapped = true; fs.renameSync(dir, moved); fs.symlinkSync(external, dir); } return Reflect.apply(original, fs, [file_, ...args]); });
  assert.throws(() => readReportText(f.config, { repos: [] }, file), /symlink|changed/);
});
it('W4 durable admission reserves the last slot before checkout and rejects a concurrent new', async () => {
  const f = fixture('admission', 'limits: {claude: 1}\n');
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let entered!: () => void; const checkout = new Promise<void>(r => { entered = r; });
  class Delayed extends DiskRunner { override async exec(cmd: string, args: string[], opts: ExecOptions = {}) { if (cmd === 'git' && args.includes('worktree') && args.includes('add')) { entered(); await gate; } return super.exec(cmd, args, opts); } }
  const runner = new Delayed({ dryRun: false, respond: f.respond, startTime: Date.now() }), ctx = new Context(runner, f.config, () => {});
  const specs = ['A', 'B'].map(task => resolveSpec(splitSpecs(f.spec(task))[0]!, { config: f.config }));
  const first = newTasks(ctx, [specs[0]!]); await checkout; assert.equal(pendingStarts(f.config).length, 1);
  await assert.rejects(newTasks(f.ctx, [specs[1]!]), /window limit/); release(); await first; assert.equal(pendingStarts(f.config).length, 0); assert.equal(f.tmux.windows.length, 1);
});
it('W4 concurrent watch tick and retry across independent watchers never exceed one slot or duplicate a claimed entry', async () => {
  const f = fixture('watch-retry', 'limits: {claude: 1}\n');
  const plan = await planQueueAdd(f.ctx, splitSpecs(f.spec('A') + f.spec('B'))); const entries = await commitQueueAdd(f.ctx, plan.items); const failed = { ...entries[1]!, status: 'failed' as const }; atomicWriteFile(path.join(queueDir(f.config), fs.readdirSync(queueDir(f.config)).find(name => name.includes('b') || name.includes('B'))!), JSON.stringify(failed));
  const first = new QueueMemory(), second = new QueueMemory(), notifier = { notify: async () => {} };
  await Promise.all([queueTick(f.ctx, first, notifier), (async () => { await retryEntry(f.ctx, 'B'); await queueTick(new Context(f.runner, f.config, () => {}), second, notifier); })()]);
  await Promise.all([first.idle(), second.idle()]);
  assert.equal(f.tmux.windows.length, 1); assert.equal(pendingStarts(f.config).length, 0); assert.equal(readQueue(f.config).length, 1); assert.equal(readQueue(f.config)[0]!.status, 'queued');
});

it('W4 a stale resume plan cannot start the same window twice even when the provider has two slots', async () => {
  const f = fixture('resume-race', 'limits: {claude: 2}\n'), wt = path.join(f.root, 'wt'); fs.mkdirSync(wt);
  seedTask(f.config, 'RESUME', { repos: [{ path: f.repo, worktree: wt }] });
  let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
  class Delayed extends DiskRunner { override async exec(cmd: string, args: string[], opts: ExecOptions = {}) { if (cmd === 'tmux' && ['new-window', 'new-session'].includes(args[0]!)) { enter(); await gate; } return super.exec(cmd, args, opts); } }
  const runner = new Delayed({ dryRun: false, respond: f.respond, startTime: Date.now() }), ctx = new Context(runner, f.config, () => {}), plan = await planResume(ctx, ['RESUME']);
  const first = resumeTasks(ctx, plan); await entered;
  assert.deepEqual(await resumeTasks(f.ctx, plan), []); release(); await first;
  assert.equal(f.tmux.windows.length, 1); assert.equal(pendingStarts(f.config).length, 0);
});
