import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { withHarness } from './live-harness.ts';
import type { Harness } from './live-harness.ts';

/*
 * The live checks of milestone 0.13.0 (phone notifications), all inside the sandbox of live-harness.ts. Network requests go only to localhost:
 *   1. a mock ntfy server on 127.0.0.1 (a separate process: the harness runs agentctl with spawnSync) - a report-ready event of a
 *      fake agent while away is on gives exactly one request; away off gives none; a dead server queues the request and the
 *      watcher delivers it after the first backoff
 *   2. notify-test --phone to a mock ntfy server (HTTP 200); the temporary topic is removed
 *      from the test config afterwards
 * Run: node --experimental-strip-types --no-warnings scripts/live-phone.ts   Results: ~/Projects/cache/agentctl-15/live-phone-results.json
 */

const CACHE = path.join(os.homedir(), 'Projects', 'cache', 'agentctl-15');

interface Check {
  scenario: string;
  name: string;
  ok: boolean;
  detail?: string;
}
const checks: Check[] = [];
let current = '';
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push({ scenario: current, name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${current}] ${name}${!ok && detail ? `\n      ${detail.split('\n').slice(0, 6).join('\n      ')}` : ''}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeoutMs = 40_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(300);
  }
  return false;
}

const SERVER = `
const http = require('node:http'); const fs = require('node:fs');
const [port, log] = process.argv.slice(1);
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + '\\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
}).listen(Number(port), '127.0.0.1');
`;

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

class MockNtfy {
  private child: ChildProcess | undefined;
  readonly port: number;
  readonly log: string;
  constructor(port: number, log: string) {
    this.port = port;
    this.log = log;
  }
  start(): void {
    this.child = spawn(process.execPath, ['-e', SERVER, String(this.port), this.log], { stdio: 'ignore' });
  }
  stop(): void {
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }
  seen(): Seen[] {
    try {
      return fs.readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Seen);
    } catch {
      return [];
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function spec(h: Harness, repo: string, task: string): string {
  const file = path.join(h.root, `${task}.md`);
  fs.writeFileSync(file, `---\ntask: ${task}\nagent: claude\nmodel: opus\neffort: high\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n    branch: agent/${task.toLowerCase()}\n    base: main\n---\nDo ${task}.\n`);
  return file;
}

function makeRepo(h: Harness): string {
  const repo = path.join(h.root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args: string[]): void => {
    if (spawnSync('git', args, { cwd: repo, env: h.env, encoding: 'utf8' }).status !== 0) throw new Error(`git ${args.join(' ')} failed`);
  };
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  return repo;
}

const STOP = JSON.stringify({ last_assistant_message: 'ok' });
const REPORT = '# Raport LP-1\n\nWerdykt: PASS – 12 testów\n\nZmieniłem /Users/marcin/Projects/secret-app/src/token.ts i sekret hunter2.\n';

async function mockServer(): Promise<void> {
  current = 'mock ntfy';
  const port = await freePort();
  const topic = `agentctl-${randomBytes(12).toString('hex')}`;
  await withHarness(
    { name: 'phone', cacheRoot: CACHE, config: `watch:\n  interval: 2\nnotify:\n  ntfy:\n    server: http://127.0.0.1:${port}\n    topic: ${topic}\n    token: tk_live\n    click_url: https://chat.example.com/\n` },
    async (h) => {
      const mock = new MockNtfy(port, path.join(h.root, 'ntfy-requests.jsonl'));
      mock.start();
      try {
        await sleep(800);
        const repo = makeRepo(h);
        check('LP-1 starts on the fake claude', h.agentctl(['new', spec(h, repo, 'LP-1'), '-y']).code === 0);
        const watch = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.out'));
        await sleep(3500);

        const off = h.agentctl(['away', 'status']);
        check('away starts off and the phone is quiet', /away: off/.test(off.stdout) && /quiet while you are here/.test(off.stdout), off.stdout);
        fs.mkdirSync(path.join(h.root, 'cache', 'lp-1'), { recursive: true });
        fs.writeFileSync(path.join(h.root, 'cache', 'lp-1', 'LP-1.md'), REPORT);
        const quiet = h.agentctl(['event', '--task', 'LP-1', '--agent', 'claude', '--kind', 'stop'], { input: STOP });
        check('an event with away off: exit 0 and no request to the phone', quiet.code === 0 && mock.seen().length === 0, JSON.stringify(mock.seen()));

        // a new report-ready moment: a second task, so that the first event of the phone is a clean one
        check('away on', h.agentctl(['away', 'on']).code === 0 && /ON/.test(h.agentctl(['away', 'status']).stdout));
        check('LP-2 starts', h.agentctl(['new', spec(h, repo, 'LP-2'), '-y']).code === 0);
        fs.mkdirSync(path.join(h.root, 'cache', 'lp-2'), { recursive: true });
        fs.writeFileSync(path.join(h.root, 'cache', 'lp-2', 'LP-2.md'), REPORT.replace(/LP-1/g, 'LP-2'));
        const ev = h.agentctl(['event', '--task', 'LP-2', '--agent', 'claude', '--kind', 'stop'], { input: STOP });
        check('report-ready of the fake agent with away on: exit 0', ev.code === 0, ev.stderr);
        const got = await until(() => mock.seen().length >= 1, 10_000);
        check('exactly one request reached the mock ntfy server', got && mock.seen().length === 1, JSON.stringify(mock.seen()));
        await sleep(7000); // the watcher also sees LP-2 report-ready: a duplicate of the event, so still one request
        const requests = mock.seen();
        check('the watcher\'s own look at the same report added no second request', requests.length === 1, `${requests.length} requests`);
        const r = requests[0];
        check('POST /<topic>', r?.method === 'POST' && r.url === `/${topic}`, `${r?.method} ${r?.url}`);
        check('Bearer token, Priority, Tags and Click headers', r?.headers.authorization === 'Bearer tk_live' && r.headers.priority === 'default' && r.headers.tags === 'white_check_mark' && r.headers.click === 'https://chat.example.com/', JSON.stringify(r?.headers));
        check('the body is the task ID and the verdict line only', r?.body === 'LP-2: raport gotowy – Werdykt: PASS – 12 testów', r?.body);
        const all = JSON.stringify(requests);
        check('no report text, path or file name in the request', !/hunter2|secret-app|token\.ts|\/Users|LP-2\.md|cache/.test(all), all);
        const evs = JSON.parse(h.agentctl(['events', '--json', '--keep']).stdout) as { events: { kind: string; task?: string; phone?: string }[]; away: { on: boolean } };
        const entry = evs.events.find((e) => e.kind === 'report-ready' && e.task === 'LP-2');
        check('the journal says the event went to the phone; events shows 📱', entry?.phone === 'sent' && evs.away.on && /LP-2.*📱/.test(h.agentctl(['events', '--since', '1h']).stdout), JSON.stringify(entry));
        check('the board header and the tmux line know about away', /📱/.test(h.agentctl(['status', '--tmux-line']).stdout), h.agentctl(['status', '--tmux-line']).stdout);
        check('the desktop notification still went to the fake notifier', fs.existsSync(h.notifyLog) && /LP-2/.test(fs.readFileSync(h.notifyLog, 'utf8')));

        check('away off', h.agentctl(['away', 'off']).code === 0);
        fs.mkdirSync(path.join(h.root, 'cache', 'lp-3'), { recursive: true });
        check('LP-3 starts', h.agentctl(['new', spec(h, repo, 'LP-3'), '-y']).code === 0);
        fs.writeFileSync(path.join(h.root, 'cache', 'lp-3', 'LP-3.md'), 'Werdykt: PASS\n');
        h.agentctl(['event', '--task', 'LP-3', '--agent', 'claude', '--kind', 'stop'], { input: STOP });
        await sleep(1500);
        check('away off: the third report did not go to the phone', mock.seen().length === 1);

        // the server goes down: the request is queued; it comes back after the first pause (30 s) through the watcher
        mock.stop();
        check('away on again', h.agentctl(['away', 'on']).code === 0);
        check('LP-4 starts', h.agentctl(['new', spec(h, repo, 'LP-4'), '-y']).code === 0);
        fs.mkdirSync(path.join(h.root, 'cache', 'lp-4'), { recursive: true });
        fs.writeFileSync(path.join(h.root, 'cache', 'lp-4', 'LP-4.md'), 'Werdykt: FAIL\n');
        const down = h.agentctl(['event', '--task', 'LP-4', '--agent', 'claude', '--kind', 'stop'], { input: STOP });
        check('a dead server does not fail the event command (exit 0)', down.code === 0, down.stderr);
        const queued = fs.existsSync(path.join(h.agentctlHome, 'phone-queue.json')) && /"attempts": 1/.test(fs.readFileSync(path.join(h.agentctlHome, 'phone-queue.json'), 'utf8'));
        check('the request is queued and phone.log has the reason', queued && /first try failed, queued/.test(fs.readFileSync(path.join(h.agentctlHome, 'phone.log'), 'utf8')));
        check('the watcher survived the dead server', watch.exitCode === null);
        mock.start();
        const retried = await until(() => mock.seen().length === 2, 60_000);
        check('after the first pause the watcher delivered the queued request (same text)', retried && mock.seen()[1]?.body === 'LP-4: raport gotowy – Werdykt: FAIL', JSON.stringify(mock.seen()[1]));
        check('phone.log says it was sent after 2 tries', await until(() => /sent after 2 tries/.test(fs.readFileSync(path.join(h.agentctlHome, 'phone.log'), 'utf8')), 5000));
        const warned = /did not take the notification/.test(fs.readFileSync(path.join(h.root, 'watch.out'), 'utf8'));
        check('the watcher warned once about the unreachable server', warned);
      } finally {
        mock.stop();
      }
    },
  );
}

async function phoneTest(): Promise<void> {
  current = 'notify-test mock ntfy';
  const topic = `agentctl-live-${randomBytes(16).toString('hex')}`;
  await withHarness({ name: 'phone-notify-test', cacheRoot: CACHE, config: `notify:\n  ntfy:\n    topic: ${topic}\n` }, async (h) => {
    const configFile = path.join(h.agentctlHome, 'config.yaml');
    const setup = h.agentctl(['doctor']);
    check('doctor sees the phone: public server, long topic, no warning', /phone\s+ntfy\.sh|✓ phone/.test(setup.stdout) && !/! phone/.test(setup.stdout), setup.stdout.split('\n').filter((l) => /phone/.test(l)).join('\n'));
    const port = await freePort();
    const mock = new MockNtfy(port, path.join(h.root, 'ntfy-test-requests.jsonl'));
    mock.start();
    try {
      await sleep(500);
      fs.appendFileSync(configFile, `    server: http://127.0.0.1:${port}\n`);
      const r = h.agentctl(['notify-test', '--phone'], { timeoutMs: 30_000 });
      check('ONE request to mock ntfy: HTTP 200', r.code === 0 && /Phone: {2}ntfy {2}ok {2}HTTP 200/.test(r.stdout) && mock.seen().length === 1, r.stdout + r.stderr);
      check('the output does not print the whole topic', !r.stdout.includes(topic));
    } finally { mock.stop(); }
    // remove the temporary topic from the test config
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/notify:\n[\s\S]*$/, ''));
    check('the temporary topic is removed from the test config', !fs.readFileSync(configFile, 'utf8').includes(topic));
    check('notify-test --phone now says the phone is not set up (no request)', /not set up/.test(h.agentctl(['notify-test', '--phone']).stdout));
  });
}

async function main(): Promise<number> {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const run of [mockServer, phoneTest]) {
    try {
      await run();
    } catch (e) {
      check(`${run.name} threw`, false, e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(CACHE, 'live-phone-results.json'), `${JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2)}\n`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
