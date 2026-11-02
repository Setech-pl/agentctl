import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultCacheRoot, withHarness } from './live-harness.ts';
import type { Harness } from './live-harness.ts';

/*
 * The live checks of milestone 0.12.0, all inside the sandbox of live-harness.ts (isolated tmux, fake agents, own AGENTCTL_HOME):
 *   1. a limit raised from 1 to 2 while `watch` runs: the second task leaves the queue without a restart
 *   2. `events` after those events
 *   3. `gc` dry run and --apply on a test repository
 *   4. `resume` after the tmux server was killed
 * Run: node --experimental-strip-types --no-warnings scripts/live-scenarios.ts   Results: ~/Projects/cache/agentctl-12/live-results.json
 */

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
async function until(what: string, fn: () => boolean, timeoutMs = 40_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(500);
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

const windows = (h: Harness): string[] => h.tmux(['list-windows', '-t', `=${h.session}`, '-F', '#{window_name}']).stdout.split('\n').filter(Boolean);

async function limitsAndEvents(): Promise<void> {
  current = 'limits+events';
  await withHarness({ name: 'limits', config: 'watch:\n  interval: 2\nlimits:\n  claude: 1\n' }, async (h) => {
    const repo = makeRepo(h, 'repo');
    const a = h.agentctl(['new', spec(h, repo, 'LV-1'), '-y']);
    check('LV-1 starts on the fake claude', a.code === 0 && windows(h).includes('lv-1'), a.stderr);
    check('the fake agent was started, not a real one', h.agentStarts().some((l) => l.startsWith('claude --model opus')));
    const q = h.agentctl(['queue', spec(h, repo, 'LV-2'), '-y']);
    check('LV-2 is queued (limit 1 is full)', q.code === 0 && /waits for a free claude window/.test(q.stdout), q.stdout + q.stderr);
    const watch = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.out'));
    await sleep(5000);
    check('LV-2 still waits while the limit is 1', !windows(h).includes('lv-2'));
    const lim = h.agentctl(['limits']);
    check('limits shows 1/1 used and one queued', /claude\s+1\s+1\s+0\s+1\s+0\s+off\s+1/.test(lim.stdout), lim.stdout);
    const set = h.agentctl(['limits', 'set', 'claude=2', '-y']);
    check('limits set claude=2 writes the config and keeps a .bak', set.code === 0 && fs.existsSync(path.join(h.agentctlHome, 'config.yaml.bak')), set.stdout + set.stderr);
    const started = await until('LV-2 starts', () => windows(h).includes('lv-2'));
    check('LV-2 left the queue and started, with the same watcher process (no restart)', started && watch.exitCode === null);
    const log = fs.readFileSync(path.join(h.root, 'cache', 'agentctl-watch.log'), 'utf8');
    check('the watch log says the config was reloaded', /config: reloaded \(limits\)/.test(log), log.slice(-400));
    check('queue list is empty', /The queue is empty/.test(h.agentctl(['queue', 'list']).stdout));
    // a broken config: the watcher keeps the old settings and says so
    fs.writeFileSync(path.join(h.agentctlHome, 'config.yaml.keep'), fs.readFileSync(path.join(h.agentctlHome, 'config.yaml'), 'utf8'));
    fs.appendFileSync(path.join(h.agentctlHome, 'config.yaml'), 'queue: [broken\n');
    const warned = await until('warning', () => /previous settings stay in force/.test(fs.readFileSync(path.join(h.root, 'cache', 'agentctl-watch.log'), 'utf8')), 15_000);
    check('a broken config is not applied: warning in the log, the watcher lives on', warned && watch.exitCode === null);
    const configRejected = await until('config state', () => {
      try { return JSON.parse(fs.readFileSync(path.join(h.agentctlHome, 'config-state.json'), 'utf8')).ok === false; } catch { return false; }
    }, 5000);
    const doctor = h.agentctl(['doctor']);
    check('doctor reports the config problem', configRejected && doctor.code !== 0 && /✗ config\s+Cannot parse/.test(doctor.stdout), doctor.stdout);
    fs.copyFileSync(path.join(h.agentctlHome, 'config.yaml.keep'), path.join(h.agentctlHome, 'config.yaml'));
    // events
    const ev = h.agentctl(['events', '--json', '--keep']);
    const report = JSON.parse(ev.stdout) as { events: { kind: string; task?: string; text: string }[]; summary: { active: number } };
    const kinds = report.events.map((e) => e.kind);
    check('events has the limit change and the start from the queue', kinds.includes('limits-changed') && kinds.includes('queue-start'), JSON.stringify(report.events));
    check('events summary counts the two active tasks', report.summary.active === 2, JSON.stringify(report.summary));
    const text = h.agentctl(['events']);
    check('events prints START LV-2 and moves the marker (second call: no news)', /START {2}LV-2/.test(text.stdout) && /brak zmian/.test(h.agentctl(['events']).stdout), text.stdout);
    // the fakes took the notifications, not the desktop
    check('notifications went to the fake notifier', fs.existsSync(h.notifyLog), '');
  });
}

async function gcScenario(): Promise<void> {
  current = 'gc';
  await withHarness({ name: 'gc' }, async (h) => {
    const repo = makeRepo(h, 'repo');
    check('LG-1 starts', h.agentctl(['new', spec(h, repo, 'LG-1'), '-y']).code === 0);
    check('LG-2 starts', h.agentctl(['new', spec(h, repo, 'LG-2'), '-y']).code === 0);
    const wt1 = `${repo}-lg-1`;
    const wt2 = `${repo}-lg-2`;
    // LG-1: closed and clean. LG-2: closed with an uncommitted file. A file of the task's cache is old.
    check('close LG-1 and LG-2', h.agentctl(['close', 'LG-1', 'LG-2', '-y']).code === 0);
    fs.writeFileSync(path.join(wt2, 'wip.txt'), 'not committed');
    const shots = path.join(h.root, 'cache', 'lg-1', 'shots.log');
    fs.mkdirSync(path.dirname(shots), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(shots), 'LG-1.md'), '# LG-1\n');
    fs.writeFileSync(shots, 'old output');
    const old = new Date(Date.now() - 20 * 86_400_000);
    fs.utimesSync(shots, old, old);
    const dry = h.agentctl(['gc', '--branches']);
    check('dry run lists the worktree of LG-1', new RegExp(`worktree\\s+LG-1\\s+${wt1}`).test(dry.stdout), dry.stdout);
    check('dry run skips LG-2 with "uncommitted changes"', /LG-2.*uncommitted changes/.test(dry.stdout), dry.stdout);
    check('dry run lists the old file, the archive move and the merged branch', /cache\s+LG-1.*shots\.log/.test(dry.stdout) && /archive\s+LG-1/.test(dry.stdout) && /branch\s+LG-1.*agent\/lg-1/.test(dry.stdout), dry.stdout);
    check('dry run changed nothing', fs.existsSync(wt1) && fs.existsSync(shots));
    const refused = h.agentctl(['gc', '--apply', '--branches'], { input: '' });
    check('--apply without a terminal and without -y refuses', refused.code === 1 && /no terminal to ask on/.test(refused.stderr), refused.stderr);
    const applied = h.agentctl(['gc', '--apply', '--branches', '-y']);
    check('--apply succeeds', applied.code === 0 && /Freed/.test(applied.stdout), applied.stdout + applied.stderr);
    check('the clean worktree is gone, the dirty one stays', !fs.existsSync(wt1) && fs.existsSync(path.join(wt2, 'wip.txt')));
    check('the old file is gone, the report stays', !fs.existsSync(shots) && fs.existsSync(path.join(path.dirname(shots), 'LG-1.md')));
    check('the merged branch of LG-1 was deleted with -d; the unfinished one stays', !git(h, repo, ['branch', '--list', 'agent/lg-1']).includes('agent/lg-1') && git(h, repo, ['branch', '--list', 'agent/lg-2']).includes('agent/lg-2'));
    check('main is intact', git(h, repo, ['branch', '--list', 'main']).includes('main'));
    check('the history stays', fs.existsSync(path.join(h.agentctlHome, 'history.jsonl')));
    const again = h.agentctl(['gc']);
    check('a second dry run has nothing left for LG-1', !/LG-1/.test(again.stdout.split('Skipped')[0] ?? ''), again.stdout);
  });
}

async function resumeScenario(): Promise<void> {
  current = 'resume';
  await withHarness({ name: 'resume' }, async (h) => {
    const repo = makeRepo(h, 'repo');
    check('LR-1 starts', h.agentctl(['new', spec(h, repo, 'LR-1'), '-y']).code === 0);
    check('LR-2 starts', h.agentctl(['new', spec(h, repo, 'LR-2'), '-y']).code === 0);
    const before = h.agentStarts().length;
    h.killServer(); // a restart of the Mac
    h.restartServer();
    check('no window is left after the restart', windows(h).length === 0);
    const status = h.agentctl(['status']);
    check('status shows both as dead (no window)', /LR-1.*dead/.test(status.stdout) && /LR-2.*dead/.test(status.stdout), status.stdout);
    const dry = h.agentctl(['resume', '--dry-run']);
    check('resume --dry-run lists both and starts nothing', /Resume 2 tasks/.test(dry.stdout) && windows(h).length === 0, dry.stdout);
    const r = h.agentctl(['resume', '-y']);
    check('resume -y brings the windows back', r.code === 0 && windows(h).sort().join() === 'lr-1,lr-2', r.stdout + r.stderr);
    await sleep(1500);
    const starts = h.agentStarts().slice(before);
    check('the agents started in resume mode with the same model and effort', starts.filter((l) => /^claude --model opus --effort high .*--continue$/.test(l)).length === 2, starts.join('\n'));
    check('the prompt was not pasted again', !windows(h).some((w) => /Do LR-/.test(h.tmux(['capture-pane', '-p', '-t', `=${h.session}:${w}`]).stdout)));
    check('nothing is left to resume', /Nothing to resume/.test(h.agentctl(['resume']).stdout));
    const up = h.agentctl(['up', '--no-attach']);
    check('agentctl up starts watch and board and prints the command to open the board', up.code === 0 && windows(h).includes('watch') && windows(h).includes('board') && /Open the board: tmux attach/.test(up.stdout), up.stdout + up.stderr);
    const up2 = h.agentctl(['up', '--no-attach']);
    check('a second up starts no second copy', /Window .*watch already exists/.test(up2.stdout) && windows(h).filter((w) => w === 'watch').length === 1);
  });
}

async function main(): Promise<number> {
  fs.mkdirSync(defaultCacheRoot(), { recursive: true });
  for (const run of [limitsAndEvents, gcScenario, resumeScenario]) {
    try {
      await run();
    } catch (e) {
      check(`${run.name} threw`, false, e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(defaultCacheRoot(), 'live-results.json'), `${JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2)}\n`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
