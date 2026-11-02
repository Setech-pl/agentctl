import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { defaultCacheRoot, withHarness } from './live-harness.ts';
import type { Harness } from './live-harness.ts';

/* Live question checks through live-harness.ts: isolated tmux, fake agents and localhost ntfy. */

const ROOT = defaultCacheRoot('agentctl-15');

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
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${current}] ${name}${!ok && detail ? `\n      ${detail.split('\n').slice(0, 8).join('\n      ')}` : ''}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(300);
  }
  return false;
}

function git(h: Harness, cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: h.env, encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`;
}

function makeRepo(h: Harness, name: string): string {
  const repo = path.join(h.root, name);
  fs.mkdirSync(repo, { recursive: true });
  git(h, repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  git(h, repo, ['add', '.']);
  git(h, repo, ['commit', '-qm', 'init']);
  return repo;
}

function spec(h: Harness, repo: string, task: string, extra = ''): string {
  const file = path.join(h.root, `${task}.md`);
  fs.writeFileSync(file, `---\ntask: ${task}\nagent: claude\nmodel: opus\neffort: high\n${extra}repos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n    branch: agent/${task.toLowerCase()}\n    base: main\n---\nDo ${task}.\n`);
  return file;
}


async function questions(): Promise<void> {
  current = 'collapsed questions';
  await withHarness({ name: 'questions', cacheRoot: ROOT }, async (h) => {
    const fake = path.join(h.fakeBin, 'codex');
    fs.writeFileSync(fake, `#!/bin/bash
case "$1" in
 --version) echo 'codex-cli 0.166.0 (fake)'; exit 0;;
 --help) echo '-c, --config <key=value>'; exit 0;;
esac
printf '› Ask Codex to do anything\\n'
while IFS= read -r line; do
 printf '\\033[2J\\033[H'
 case "$line" in
  *ANSWER*) printf '› Ask Codex to do anything\\n';;
  *) printf 'Working (esc to interrupt)\\nQueued follow-up inputs\\n? 2 questions\\n  ⇧↑ to answer\\n';;
 esac
done
`);
    const repo = makeRepo(h, 'repo');
    const file = spec(h, repo, 'LQ-1');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('agent: claude', 'agent: codex').replace('model: opus', 'model: gpt-5.4'));
    check('Codex fake starts', h.agentctl(['new', file, '-y']).code === 0);
    await sleep(1000);
    const status = h.agentctl(['status', '--json']);
    check('working plus question is needs-input', /needs-input/.test(status.stdout), status.stdout);
    check('status has count and shortcut', /zwinięte, 2/.test(status.stdout) && /⇧↑/.test(status.stdout), status.stdout);
    check('peek explains how to open', /Enter → okno agenta, potem ⇧↑/.test(h.agentctl(['peek', 'LQ-1']).stdout));
    check('repeated reads keep needs-input', [1,2,3].every(() => /needs-input/.test(h.agentctl(['status', '--json']).stdout)));
    h.tmux(['send-keys', '-t', `=${h.session}:lq-1`, 'ANSWER', 'Enter']);
    await sleep(500);
    check('answered question clears', !/needs-input/.test(h.agentctl(['status', '--json']).stdout));
    const doctor = h.agentctl(['doctor']);
    check('repo doctor exits zero in isolated harness', doctor.code === 0, doctor.stdout + doctor.stderr);
  });
}
async function privacy(): Promise<void> {
  current = 'ntfy question privacy';
  const port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
  await withHarness({ name: 'questions-privacy', cacheRoot: ROOT,
    config: `watch:\n  interval: 1\nnotify:\n  ntfy:\n    server: http://127.0.0.1:${port}\n    topic: agentctl-private-0123456789\n    always: true\n` }, async (h) => {
    const log = path.join(h.root, 'requests.jsonl');
    const server = spawn(process.execPath, ['-e', `
      const http = require('node:http'), fs = require('node:fs');
      http.createServer((req, res) => {
        let body = ''; req.on('data', c => body += c);
        req.on('end', () => { fs.appendFileSync(process.argv[2], JSON.stringify({ body, title: req.headers.title }) + '\\n'); res.end('{}'); });
      }).listen(Number(process.argv[1]), '127.0.0.1');
    `, String(port), log], { stdio: 'ignore', env: h.env });
    const seen = (): { body: string; title: string }[] => fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    try {
      await sleep(500);
      fs.writeFileSync(path.join(h.fakeBin, 'codex'), `#!/bin/bash
case "$1" in
 --version) echo 'codex-cli 0.166.0 (fake)'; exit 0;;
 --help) echo '-c, --config <key=value>'; exit 0;;
esac
printf '› Ask Codex to do anything\\n'
while IFS= read -r line; do
 printf '\\033[2J\\033[H'
 case "$line" in
  *OPTIN*) printf 'Czy ujawnić opt-in hunter2-private-question?\\n  1. Yes\\n  2. No\\n  Press enter to confirm or esc to cancel\\n';;
  *EXPANDED*) printf 'Czy ujawnić hunter2-private-question?\\n  1. Yes\\n  2. No\\n  Press enter to confirm or esc to cancel\\n';;
  *COLLAPSED*) printf 'Working (esc to interrupt)\\n? 2 questions\\n  ⇧↑ to answer\\n';;
  *) printf '› Ask Codex to do anything\\n';;
 esac
done
`);
      const repo = makeRepo(h, 'repo');
      const file = spec(h, repo, 'LQP-1');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('agent: claude', 'agent: codex').replace('model: opus', 'model: gpt-5.4'));
      check('privacy fake starts', h.agentctl(['new', file, '-y']).code === 0);
      const target = h.tmux(['list-windows', '-t', `=${h.session}`, '-F', '#{window_id} #{window_name}']).stdout.split('\n').find(line => line.endsWith(' lqp-1'))?.split(' ')[0];
      if (!target) throw new Error('privacy fake window not found');
      h.spawnAgentctl(['watch'], path.join(h.root, 'watch.out'));
      const send = (line: string) => h.tmux(['send-keys', '-t', target, line, 'Enter']);
      const watchLog = path.join(h.root, 'cache', 'agentctl-watch.log');
      check('watcher records an idle baseline', await until(() => fs.existsSync(watchLog) && /baseline/.test(fs.readFileSync(watchLog, 'utf8'))));
      send('EXPANDED');
      check('expanded question delivered to mock ntfy', await until(() => seen().some(r => r.body === 'LQP-1: pytanie agenta – otwórz okno')));
      const privateRequests = seen();
      check('false: no question in body or decoded title', privateRequests.length > 0 && privateRequests.every(r => {
        const title = r.title.replace(/^=\?UTF-8\?B\?(.+)\?=$/i, (_m, data) => Buffer.from(data, 'base64').toString('utf8'));
        return !/hunter2|Czy ujawnić/.test(r.body + title);
      }), JSON.stringify(privateRequests));
      check('local status and peek retain question text', /hunter2-private-question/.test(h.agentctl(['status', '--json']).stdout)
        && /hunter2-private-question/.test(h.agentctl(['peek', 'LQP-1']).stdout));
      check('local desktop notifier retains question text', fs.existsSync(h.notifyLog) && /hunter2-private-question/.test(fs.readFileSync(h.notifyLog, 'utf8')));
      send('ANSWER');
      await until(() => !/needs-input/.test(h.agentctl(['status', '--json']).stdout));
      await sleep(1500);
      send('COLLAPSED');
      check('false: collapsed question has count and binding only', await until(() => seen().some(r => r.body === 'Codex ma pytanie (2) – Enter → okno agenta, potem ⇧↑')));
      const configFile = path.join(h.agentctlHome, 'config.yaml');
      fs.appendFileSync(configFile, '    include_question: true\n');
      check('watcher reloads include_question without restart', await until(() => {
        return fs.existsSync(watchLog) && /config: reloaded \(notify\)/.test(fs.readFileSync(watchLog, 'utf8'));
      }));
      send('ANSWER');
      await sleep(1500);
      send('OPTIN');
      check('true: mock receives clipped question content after reload', await until(() => seen().some(r => /hunter2-private-question/.test(r.body))));
    } finally {
      server.kill('SIGTERM');
      await new Promise<void>(resolve => server.exitCode !== null ? resolve() : server.once('exit', () => resolve()));
    }
  });
}

async function main(): Promise<number> {
  for (const run of [questions, privacy]) {
    try { await run(); } catch (e) { check(`${run.name} threw`, false, String(e)); }
  }
  const failed = checks.filter(c => !c.ok);
  fs.writeFileSync(path.join(ROOT, 'live-questions-results.json'), JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  return failed.length ? 1 : 0;
}
process.exitCode = await main();
