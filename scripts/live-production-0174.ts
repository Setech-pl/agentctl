import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { Context } from '../src/core/context.ts';
import { RealRunner } from '../src/core/runner.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { collectStatus } from '../src/core/status.ts';
import { renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { planGc, applyGc, gcView } from '../src/core/gc.ts';
import { sendPrompts } from '../src/core/send.ts';
import { liveWindows } from '../src/core/plan.ts';
import { collectLimits } from '../src/core/limits.ts';
const cache = defaultCacheRoot('agentctl-0174');
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, value: unknown) => { results.push({ name, ok: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await withHarness({ name: 'prod-0174', cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false}\nlimits: {claude: 1}\nwatch: {idle_confirm_ticks: 2}\nmcp: {allow: [new, queue, gc, send]}\n' }, async h => {
  class SandboxRunner extends RealRunner { override exec(cmd: string, args: string[], opts: ExecOptions = {}) { h.check(); return super.exec(cmd, args, { ...opts, env: h.env }); } }
  const runner = new SandboxRunner(), config = loadGlobalConfig(h.agentctlHome), ctx = new Context(runner, config, () => {});
  const mode = path.join(h.root, 'mode'); fs.writeFileSync(mode, 'busy');
  fs.writeFileSync(path.join(h.fakeBin, 'claude'), `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')){console.log('2.1.311 (fake)');process.exit(0);}
if(process.argv.includes('--help')){console.log('--effort --remote-control --append-system-prompt-file');process.exit(0);}
if(process.argv.includes('mcp'))process.exit(1);
const mode=${JSON.stringify(mode)}; const draw=()=>process.stdout.write('\\x1b[2J\\x1b[H'+(fs.readFileSync(mode,'utf8')==='busy'?'⏺ Ran 7 shell commands (ctrl+o to expand)\\n⏺ Running npm test…\\n✽ Zigzagging… (3m 11s · still thinking with high effort)\\n':'')+'❯ \\n');
process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',()=>{fs.writeFileSync(mode,'busy');draw();});setInterval(draw,100);draw();
`, { mode: 0o755 });
  const runGit = async (cwd: string, args: string[]) => { const r = await runner.exec('git', ['-C', cwd, ...args]); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); };
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo); await runGit(repo, ['init', '-b', 'main']); fs.writeFileSync(path.join(repo, 'file.txt'), 'fixture\n'); await runGit(repo, ['add', '.']); await runGit(repo, ['commit', '-m', 'fixture']);
  const sha = await runGit(repo, ['rev-parse', 'HEAD']);
  const record = (task: string, extra: Partial<TaskRecord> = {}) => {
    const r: TaskRecord = { task, window: task.toLowerCase(), session: h.session, agent: 'claude', model: 'sonnet', effort: 'high', links: [], env: {}, repos: [{ path: repo, worktree: repo }], report: path.join(config.cache, task.toLowerCase(), `${task}.md`), started: new Date(Date.now() - 1000).toISOString(), turnEndedAt: new Date().toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'high' }, ...extra };
    fs.mkdirSync(path.dirname(taskFile(config, r.window)), { recursive: true }); fs.writeFileSync(taskFile(config, r.window), renderTaskMd(r, 'Live fixture.')); return r;
  };
  const ready = record('READY'); const spawned = h.tmux(['new-session', '-d', '-s', h.session, '-n', ready.window, path.join(h.fakeBin, 'claude')]); check('isolated real tmux starts only fake Claude', spawned.code === 0); await pause(300);
  for (let i = 0; i < 50; i++) { const pane = await ctx.tmux.capture(ready.window); if (pane.stdout.includes('Zigzagging')) break; await pause(100); }
  const firstRows = await collectStatus(ctx);
  check(`P1 production pane remains working: ${JSON.stringify(firstRows.map(r => ({ task: r.task, state: r.state, lastLine: r.lastLine })))}`, firstRows[0]?.state === 'working');
  const notices: string[] = [], notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  await handleEvent(ctx, new Alerts(ctx, notifier), { task: ready.task, agent: 'claude', kind: 'stop', payload: { stop_hook_active: false } }); check('P1 Stop while tool runs is silent and working', notices.length === 0 && (await collectStatus(ctx))[0]?.state === 'working');
  fs.writeFileSync(mode, 'idle'); await pause(250);
  // Clear the earlier Stop to test polling independently of hook completion.
  fs.rmSync(path.join(config.stateDir, ready.window, 'event.json'), { force: true });
  check('P1 first idle read retains work', (await collectStatus(ctx))[0]?.state === 'working'); const cliIdle = h.agentctl(['status', '--json']); check('P1 second idle read in a separate CLI process confirms waiting', cliIdle.code === 0 && JSON.parse(cliIdle.stdout)[0]?.state === 'waiting');
  fs.mkdirSync(path.dirname(ready.report), { recursive: true }); fs.writeFileSync(ready.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  check('P10 report-ready idle window releases slot', collectLimits(config, await liveWindows(ctx)).providers[0]?.free === 1);
  const spec = (task: string, extra: Record<string, unknown> = {}) => `---\n${YAML.stringify({ task, agent: 'claude', model: 'sonnet', effort: 'high', repos: [{ path: repo, worktree: `${repo}-${task}`, branch: task, base: sha }], ...extra })}---\nImplement fixture.\n`;
  const client = new Client({ name: 'prod-0174', version: '1' }); await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' }));
  const call = async (name: string, args = {}) => { const result = await client.callTool({ name, arguments: args }); return { error: result.isError, text: (result.content as { text: string }[]).map(c => c.text).join('\n') }; };
  // P34: every chat start goes through the watcher; confirm only registers and the watcher prepares the worktree.
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  try {
    const beat = path.join(config.stateDir, 'queue-worker.json'), beatEnd = Date.now() + 10000;
    while (!fs.existsSync(beat) && Date.now() < beatEnd) await pause(150);
    for (const scenario of ['fresh', 'guide', 'parallel']) {
      const args = { spec: spec(`NEW-${scenario.toUpperCase()}`), no_agent: true }, preview = await call('new', args); check(`P3 ${scenario} preview: ${preview.error ? preview.text : "ok"}`, !preview.error);
      if (scenario === 'guide') await call('guide');
      if (scenario === 'parallel') { const other = { spec: spec('UNRELATED'), no_agent: true }; await call('new', other); await Promise.all([call('status'), call('new', { ...other, confirm: true })]); }
      const confirmed = await call('new', { ...args, confirm: true });
      const worktree = `${repo}-NEW-${scenario.toUpperCase()}`, up = Date.now() + 20000;
      while (!confirmed.error && !fs.existsSync(worktree) && Date.now() < up) await pause(200);
      check(`P3 ${scenario} confirm on real git/MCP`, !confirmed.error && fs.existsSync(worktree));
    }
    const missing = path.join(h.root, 'missing-target'), linked = { spec: spec('LINKED', { links: [{ from: 'dep', to: missing }] }) };
    const preview = await call('queue', linked); check('P2 missing link warns in MCP preview', !preview.error && preview.text.includes(missing)); const denied = await call('queue', { ...linked, confirm: true }); check('P2 missing link blocks confirmation', denied.error && denied.text.includes('link targets are missing'));
    const wt = path.join(h.root, 'finished'); await runGit(repo, ['worktree', 'add', '-b', 'finished', wt]); record('FINISHED', { closed: true, repos: [{ path: repo, worktree: wt, branch: 'finished' }] });
    fs.writeFileSync(path.join(repo, '.agentctl.yaml'), YAML.stringify({ links: [{ from: 'dep', to: wt }] }));
    const plan = await planGc(ctx); check('P2 GC protects real worktree referenced by project', plan.skipped.some(s => s.target === wt && s.reason.includes('links target'))); const applied = await applyGc(ctx, plan); check('P2 GC apply leaves referenced worktree', !applied.failed.length && fs.existsSync(wt));
    const compact = await call('gc_preview'); check('P9 default GC is compact summary without detailed paths', Buffer.byteLength(compact.text) < 8192 && !compact.text.includes(wt) && compact.text.includes('categories'));
    const displaced = path.join(h.root, 'displaced.md'); fs.renameSync(ready.report, displaced); check('P5 get_report agrees with missing canonical', (await call('get_report', { task: 'READY' })).error && !(await call('list_reports', { all: true })).text.includes('"task":"READY"'));
    fs.renameSync(displaced, ready.report); fs.rmSync(path.join(repo, '.agentctl.yaml'));
    record('BUSY'); h.tmux(['new-window', '-d', '-t', `=${h.session}:`, '-n', 'busy', path.join(h.fakeBin, 'claude')]); await pause(250); fs.writeFileSync(mode, 'busy'); await pause(250);
    // Make READY idle independently by stopping its fake and replacing the pane command with the harness's idle fake.
    h.tmux(['respawn-pane', '-k', '-t', `=${h.session}:ready`, "printf '❯ \\n'; exec /bin/cat"]); await pause(250);
    check('P10 busy window holds the sole slot', collectLimits(config, await liveWindows(ctx)).providers[0]?.used === 1);
    const sent = await sendPrompts(ctx, [{ task: ready.task, window: ready.window, prompt: 'continue' }]); check('P10 send warns without exceeding the full limit', sent[0]?.warning?.includes('limit') && collectLimits(config, await liveWindows(ctx)).providers[0]?.used === 1);
    const aliases = ['gc', 'gc --preview', 'gc --dry-run'].map(command => h.agentctl([...command.split(' '), '--json'])); check('P8 all real CLI aliases share one preview', aliases.every(r => r.code === 0 && r.stdout === aliases[0]?.stdout));
    const summary = gcView(await planGc(ctx)); fs.writeFileSync(path.join(cache, 'fix-production-gc.json'), JSON.stringify(summary, null, 2));
  } finally { watcher.kill('SIGTERM'); await new Promise(r => watcher.once('close', r)); await client.close(); }
});
fs.writeFileSync(path.join(cache, 'fix-production-live-results.json'), JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2));
console.log(`${results.length}/${results.length} production live checks passed`);
