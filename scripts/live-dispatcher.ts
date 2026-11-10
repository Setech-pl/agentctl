import { providerDispatchCases } from './provider-live-cases.ts';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
const CACHE = defaultCacheRoot();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SERVER = `const http=require('node:http'),fs=require('node:fs'); let failures=Number(process.argv[3]); http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{const status=failures-->0?503:200;fs.appendFileSync(process.argv[2],JSON.stringify({at:Date.now(),body,status})+'\\n');res.writeHead(status);res.end('{}')})}).listen(Number(process.argv[1]),'127.0.0.1')`;
async function freePort(): Promise<number> { return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); }); }
const results: unknown[] = [];
async function trial(id: number, parallel: boolean, retry = false, fallback = false): Promise<void> {
  const port = await freePort();
  await withHarness({ name: `dispatcher-race-${id}`, cacheRoot: CACHE, config: `watch:\n  interval: 1\nnotify:\n  backend: auto\n  ntfy:\n    server: http://127.0.0.1:${port}\n    topic: race-local-only\n` }, async (h) => {
    const requests = path.join(h.root, 'requests.jsonl');
    const mock = spawn(process.execPath, ['-e', SERVER, String(port), requests, retry ? '1' : '0'], { stdio: 'ignore' });
    let eventCode = -1;
    try {
      await pause(300);
      const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
      for (const args of [['init', '-q', '-b', 'main'], ['commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args, { env: h.env, cwd: repo }).status, 0);
      const task = `RACE-${id}`; const spec = path.join(h.root, 'spec.md');
      fs.writeFileSync(spec, `---\ntask: ${task}\nagent: claude\nmodel: sonnet\neffort: medium\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n    branch: race-task\n    base: main\n---\nFake work.\n`);
      const started = h.agentctl(['new', spec, '-y', '--json']); assert.equal(started.code, 0, started.stderr);
      const snapshot = JSON.parse(started.stdout).capacity; assert.equal(snapshot.length, 2);
      assert.equal(h.agentctl(['away', 'on']).code, 0);
      h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
      await pause(2000);
      const notifier = path.join(h.fakeBin, 'terminal-notifier');
      fs.writeFileSync(notifier, fs.readFileSync(notifier, 'utf8').replace('exit 0', `sleep 3\n${fallback ? 'exit 1' : 'exit 0'}`));
      const report = path.join(h.root, 'cache', task.toLowerCase(), `${task}.md`);
      fs.mkdirSync(path.dirname(report), { recursive: true }); fs.writeFileSync(report, 'Werdykt: PASS\n<!-- agentctl:report-end -->');
      h.check();
      const event = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'event', '--task', task, '--agent', 'claude', '--kind', 'stop'], { env: h.env, stdio: ['pipe', 'ignore', 'ignore'] });
      event.stdin.end(JSON.stringify({ last_assistant_message: 'ok' }));
      eventCode = await new Promise<number>((resolve) => event.once('close', (code) => resolve(code ?? 1)));
      await pause(retry ? 90_000 : 20_000);
      const posts = fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { body: string; status: number }) : [];
      const reports = posts.filter((p) => p.body.includes(task) && p.body.includes('raport gotowy'));
      const accepted = reports.filter((p) => p.status === 200);
      const local = fs.readFileSync(h.notifyLog, 'utf8').split('\n').filter((l) => l.includes(task) && l.includes('raport gotowy'));
      const counts = { eventCode, requests: reports.length, accepted: accepted.length, terminal: local.filter((l) => l.startsWith('terminal-notifier')).length, fallback: local.filter((l) => l.startsWith('osascript')).length };
      const ok = eventCode === 0 && accepted.length === 1 && reports.length === (retry ? 2 : 1) && counts.terminal === 1 && counts.fallback === (fallback ? 1 : 0);
      results.push({ id, parallel, retry, fallback, ok, counts, snapshot, posts, ledger: fs.readFileSync(path.join(h.root, 'state', task.toLowerCase(), 'notified.json'), 'utf8'), journal: fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8') });
      console.log(`${ok ? 'PASS' : 'FAIL'} race ${id}: ${JSON.stringify(counts)}`);
    } finally { mock.kill('SIGTERM'); await new Promise((resolve) => mock.once('close', resolve)); }
  });
}
for (let id = 1; id <= 3; id++) await trial(id, false);
for (let round = 0; round < 3; round++) await Promise.all(Array.from({ length: 4 }, (_, i) => trial(4 + round * 4 + i, true)));
await trial(16, false, true, true);
for (const name of await providerDispatchCases(CACHE, 'pdisp')) results.push({ name, ok: true });
const failed = results.filter((r) => !(r as { ok: boolean }).ok).length;
fs.writeFileSync(path.join(CACHE, 'live-dispatcher-results.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2) + '\n');
process.exitCode = failed ? 1 : 0;
