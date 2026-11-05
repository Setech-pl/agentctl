import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { pendingStarts } from '../src/core/start-lock.ts';
import { readTaskRecord, taskFile } from '../src/core/taskstore.ts';
import { atomicWriteFile } from '../src/core/atomic-file.ts';
const root = defaultCacheRoot('agentctl-0174'), checks: { name: string; ok: boolean }[] = [];
const check = (name: string, value: unknown) => { checks.push({ name, ok: !!value }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); };
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
await withHarness({ name: 'audit-0174', cacheRoot: root, config: 'limits: {claude: 1}\nwatch: {interval: 0.2}\ncapacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new, queue, report_from]}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome), repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init', '-qb', 'main'], ['commit', '--allow-empty', '-qm', 'fixture']]) { const r = h.agentctl(['version']); assert.equal(r.code, 0); const { spawnSync } = await import('node:child_process'); assert.equal(spawnSync('git', args, { cwd: repo, env: h.env }).status, 0); }
  const spec = (task: string, report?: string) => `---\ntask: ${task}\nagent: claude\nmodel: sonnet\neffort: high\nsetup: [sleep 1]\n${report ? `report: ${report}\n` : ''}repos:\n  - {path: ${repo}, worktree: ${repo}-${task}, branch: ${task}}\n---\nFake fixture only.\n`;
  const input = path.join(h.root, 'queue.md'); fs.writeFileSync(input, spec('A') + spec('B')); check('W4 two real queue entries created', h.agentctl(['queue', input, '-y']).code === 0);
  const queueDir = path.join(h.agentctlHome, 'queue'), queueB = path.join(queueDir, fs.readdirSync(queueDir).find(n => n.includes('-B.json'))!); const b = JSON.parse(fs.readFileSync(queueB, 'utf8')); atomicWriteFile(queueB, JSON.stringify({ ...b, status: 'failed' }));
  const one = h.spawnAgentctl(['watch'], path.join(h.root, 'watch-1.log')), two = h.spawnAgentctl(['watch'], path.join(h.root, 'watch-2.log'));
  const retry = h.agentctl(['queue', 'retry', 'B']); check('W4 CLI retry overlaps two independent watcher processes', retry.code === 0);
  let max = 0, sawReservation = false, windows: string[] = [];
  for (let n = 0; n < 65; n++) {
    windows = h.tmux(['list-windows', '-t', `=${h.session}`, '-F', '#{window_name}']).stdout.split('\n').filter(Boolean).filter(n => !['watch', 'board'].includes(n));
    const reservations = pendingStarts(config).filter(r => !windows.some(w => w.endsWith(r.window)));
    sawReservation ||= reservations.length > 0; max = Math.max(max, windows.length + reservations.length);
    if (n > 15 && windows.length === 1) break;
    await pause(100);
  }
  check('W4 reservation is visible before the first tmux window', sawReservation); check('W4 watch + retry never use more than one slot', max === 1 && windows.length === 1);
  // A window exists before its launch finishes; wait for the queue commit before stopping its watcher.
  for (let n = 0; n < 100 && fs.readdirSync(queueDir).filter(name => name.endsWith('.json') && !name.includes('error')).length !== 1; n++) await pause(100);
  for (const watcher of [one, two]) { if (watcher.exitCode === null) { const closed = new Promise(resolve => watcher.once('close', resolve)); watcher.kill('SIGTERM'); await closed; } }
  const records = ['a', 'b'].map(w => readTaskRecord(config, w)).filter(r => r !== undefined); check('W4 exactly one task started; the other stays queued', records.length === 1 && fs.readdirSync(queueDir).filter(n => n.endsWith('.json') && !n.includes('error')).length === 1);
  const record = records[0]!, file = taskFile(config, record.window);
  const url = (file: string) => pathToFileURL(path.resolve('src/core', file)).href;
  const run = async (source: string) => { const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', source], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] }); let stderr = ''; child.stderr.on('data', b => { stderr += b; }); const code = await new Promise<number | null>(resolve => child.once('close', resolve)); return { code, stderr }; };
  const imports = `import fs from 'node:fs'; import {RealRunner} from ${JSON.stringify(url('runner.ts'))}; import {setHeaderFields} from ${JSON.stringify(url('taskstore.ts'))}; const file=${JSON.stringify(file)}, runner=new RealRunner();`;
  const writes = await Promise.all([1, 2].map(worker => run(`${imports}for(let n=0;n<12;n++)await setHeaderFields(runner,file,{['writer_${worker}_'+n]:n});`)));
  check('K1/S3 independent processes finish shared TASK.md updates', writes.every(r => r.code === 0)); let text = fs.readFileSync(file, 'utf8'); check('K1/S3 all concurrent fields and original prompt survive', [1, 2].every(worker => Array.from({ length: 12 }, (_, n) => `writer_${worker}_${n}: ${n}`).every(field => text.includes(field))) && text.includes('Fake fixture only.'));
  const old = text;
  const fault = await run(`${imports}const open=fs.openSync,write=fs.writeFileSync,temps=new Set();fs.openSync=(p,...a)=>{const fd=open(p,...a);if(String(p).includes('.TASK.md.'))temps.add(fd);return fd;};let fail=true;fs.writeFileSync=(fd,...a)=>{if(temps.has(fd)&&fail){fail=false;fs.writeSync(fd,'PARTIAL');throw Object.assign(new Error('live ENOSPC fixture'),{code:'ENOSPC'});}return write(fd,...a);};try{await setHeaderFields(runner,file,{report_complete_hash:'WRONG',report_candidate:null});process.exitCode=1;}catch(e){process.exitCode=e.code==='ENOSPC'?42:2;}`);
  check('K1 ENOSPC is returned to the writer', fault.code === 42); check('K1 failed partial write leaves byte-identical TASK.md', fs.readFileSync(file, 'utf8') === old);
  let status = h.agentctl(['status', '--json']); check('K1 a new CLI process sees durable needs-attention and ENOSPC reason', status.code === 0 && status.stdout.includes('needs-attention') && status.stdout.includes('ENOSPC'));
  check('K1 recovery atomically clears the failure marker', (await run(`${imports}await setHeaderFields(runner,file,{recovered:true});`)).code === 0 && !h.agentctl(['status', '--json']).stdout.includes('needs-attention'));
  const client = new Client({ name: 'audit-0174', version: '1' }); await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' }));
  const call = async (name: string, args: Record<string, unknown>) => { const result = await client.callTool({ name, arguments: args }); return { error: result.isError, text: (result.content as { text: string }[]).map(c => c.text).join('\n') }; };
  try {
    const outside = path.join(h.root, 'secret.md'); fs.writeFileSync(outside, 'SECRET-FIXTURE'); const link = path.join(record.repos[0]!.worktree, 'symlink.md'); fs.symlinkSync(outside, link);
    for (const from of ['../../../etc/passwd', outside, link]) { const r = await call('report_from', { task: record.task, from, force: true }); check(`K2 MCP refuses ${from === outside ? 'absolute outside source' : from === link ? 'symlink source' : 'traversal'} even with force`, r.error && /outside|symlink/.test(r.text) && !r.text.includes('SECRET-FIXTURE')); }
    const bad = spec('BAD', outside).replace('setup: [sleep 1]\n', '').replace('agent: claude', 'agent: codex').replace('model: sonnet', 'model: gpt-6.1-sol'); for (const tool of ['new', 'queue']) { const r = await call(tool, { spec: bad }); check(`W2 ${tool} rejects outside report in preview`, r.error && /outside/.test(r.text)); }
    const source = path.join(record.repos[0]!.worktree, 'actual-report.md'); fs.writeFileSync(source, 'Werdykt: PASS\n<!-- agentctl:report-end -->');
    const preview = await call('report_from', { task: record.task, from: source }); const copied = await call('report_from', { task: record.task, from: source, confirm: true }); check('K2 approved worktree report can be previewed and copied', !preview.error && !copied.error && fs.existsSync(record.report));
    check('W2 get_report reads the approved canonical report', (await call('get_report', { task: record.task })).text.includes('Werdykt: PASS'));
  } finally { await client.close(); }
  fs.writeFileSync(path.join(root, 'audit-live-state.json'), JSON.stringify({ maximumSlots: max, concurrentWriters: 2, fields: 24, enospcExitCode: fault.code, task: record.task }, null, 2));
});
fs.writeFileSync(path.join(root, 'audit-live-results.json'), JSON.stringify({ passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks }, null, 2));
console.log(`${checks.length}/${checks.length} audit live checks passed`);
