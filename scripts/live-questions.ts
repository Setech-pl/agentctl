import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultCacheRoot, withHarness } from './live-harness.ts';
import type { Harness } from './live-harness.ts';

/*
 * The live checks of milestone 0.14.0 (the manager and Remote Control), all inside the sandbox of live-harness.ts (isolated tmux, fake agents,
 * own AGENTCTL_HOME). The fake claude answers --help with the Remote Control flags and prints "/rc active" when it is started with
 * --remote-control; every start is logged to agent.log, which is where the arguments are checked. The real claude is never started.
 *   1. agentctl manager: the window, the exact command line, the files, the project left alone, no second copy, --url, stop, doctor
 *   2. remote_control: true in a spec: the flags of the agent, TASK.md, the flag again after a resume
 *   3. agentctl up with manager.autostart
 * Run: node --experimental-strip-types --no-warnings scripts/live-manager.ts   Results: ~/Projects/cache/agentctl-14/live-results.json
 */

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

const windows = (h: Harness): string[] => h.tmux(['list-windows', '-t', `=${h.session}`, '-F', '#{window_name}']).stdout.split('\n').filter(Boolean);
/** The starts of the fake claude, without the --version / --help probes of agentctl. */
const starts = (h: Harness): string[] => h.agentStarts().filter((l) => !/^claude --(?:version|help)$/.test(l));

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
async function main(): Promise<number> {
  try { await questions(); } catch (e) { check('questions threw', false, String(e)); }
  const failed = checks.filter(c => !c.ok);
  fs.writeFileSync(path.join(ROOT, 'live-questions-results.json'), JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
  return failed.length ? 1 : 0;
}
process.exitCode = await main();
