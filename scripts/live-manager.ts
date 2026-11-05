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
const starts = (h: Harness): string[] => h.agentStarts().filter((l) => !/^(?:(?:claude|codex) --(?:version|help)|codex app-server)$/.test(l));

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

const listing = (dir: string): string => fs.readdirSync(dir).sort().join(',');

async function managerScenario(): Promise<void> {
  current = 'manager';
  await withHarness({ name: 'manager', cacheRoot: ROOT }, async (h) => {
    const project = path.join(h.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# the project\n');
    const before = listing(project);
    const guide = path.join(h.root, 'guide.md');
    fs.writeFileSync(guide, '# Spec guide\nShort prompts.\n');
    fs.appendFileSync(path.join(h.agentctlHome, 'config.yaml'), `manager:\n  guide: ${guide}\nmcp:\n  allow: [send, new]\n`);

    const r = h.agentctl(['manager', '--project', project]);
    check('agentctl manager exits 0 and says it is connected', r.code === 0 && /is connected/.test(r.stdout), r.stdout + r.stderr);
    check('window "manager" exists in the sandbox session', windows(h).includes('manager'), windows(h).join());
    const files = { role: path.join(h.agentctlHome, 'manager', 'role.md'), settings: path.join(h.agentctlHome, 'manager', 'settings.json'), mcp: path.join(h.agentctlHome, 'manager', 'mcp.json') };
    const expected = `claude --model sonnet --effort medium --mcp-config ${files.mcp} --remote-control agentctl manager --settings ${files.settings} --append-system-prompt-file ${files.role}`;
    const started = starts(h);
    check('the fake claude got exactly the expected command line', started.length === 1 && started[0] === expected, `${started.join('\n')}\n--- expected\n${expected}`);
    check('the shell line is an interactive session, not the server mode', !/^claude remote-control/.test(started[0] ?? ''));
    const role = fs.existsSync(files.role) ? fs.readFileSync(files.role, 'utf8') : '';
    check('role.md has the role, the allowed tools and the guide', /# Dispatcher guide/.test(role) && /Available write tools: send, new/.test(role) && /Short prompts\./.test(role), role.slice(0, 300));
    const settings = fs.existsSync(files.settings) ? (JSON.parse(fs.readFileSync(files.settings, 'utf8')) as { permissions: { allow: string[] } }) : { permissions: { allow: [] } };
    check('settings.json lets only the read tools through', settings.permissions.allow.includes('mcp__agentctl__status') && !settings.permissions.allow.includes('mcp__agentctl__send'), JSON.stringify(settings));
    const mcp = fs.existsSync(files.mcp) ? (JSON.parse(fs.readFileSync(files.mcp, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }) : { mcpServers: {} };
    check('mcp.json starts "agentctl mcp" under the name agentctl', mcp.mcpServers.agentctl?.args.at(-1) === 'mcp' && path.isAbsolute(mcp.mcpServers.agentctl?.command ?? ''), JSON.stringify(mcp));
    check('the project was not changed', listing(project) === before, `${before} -> ${listing(project)}`);
    const cwd = h.tmux(['display-message', '-p', '-t', `=${h.session}:manager`, '#{pane_current_path}']).stdout.trim();
    check('the window runs in the project directory', fs.realpathSync(cwd) === fs.realpathSync(project), cwd);

    const again = h.agentctl(['manager']);
    check('a second agentctl manager makes no second window and no second start', /already running/.test(again.stdout) && windows(h).filter((w) => w === 'manager').length === 1 && starts(h).length === 1, again.stdout);
    const status = h.agentctl(['status']);
    check('status does not show the manager as an orphan task (it says there are no tasks)', /No tasks yet/.test(status.stdout) && !/orphan/i.test(status.stdout), status.stdout);
    const limits = h.agentctl(['limits']);
    check('limits: the manager uses no place', /claude\s+-\s+0\s+-\s+0/.test(limits.stdout) || !/manager/.test(limits.stdout), limits.stdout);

    const noUrl = h.agentctl(['manager', '--url']);
    check('--url without an address on the screen says how to get one', noUrl.code === 0 && /\/remote-control/.test(noUrl.stdout), noUrl.stdout);
    h.tmux(['send-keys', '-t', `=${h.session}:manager`, '-l', 'https://claude.ai/code/session_FAKE0123']);
    h.tmux(['send-keys', '-t', `=${h.session}:manager`, 'Enter']);
    const shown = await until(() => h.agentctl(['manager', '--url']).stdout.includes('https://claude.ai/code/session_FAKE0123'));
    check('--url prints the address the window shows', shown, h.agentctl(['manager', '--url']).stdout);

    const doctor = h.agentctl(['doctor']);
    check('doctor exits 0 and reports Remote Control, the manager and its MCP file', doctor.code === 0 && /claude remote control/.test(doctor.stdout) && /manager .*connected to Remote Control/.test(doctor.stdout) && /manager mcp/.test(doctor.stdout), doctor.stdout);

    const stop = h.agentctl(['manager', 'stop']);
    check('manager stop closes the window', stop.code === 0 && /stopped/.test(stop.stdout) && !windows(h).includes('manager'), stop.stdout + windows(h).join());
    check('manager stop again says it is not running', /not running/.test(h.agentctl(['manager', 'stop']).stdout));
    const dry = h.agentctl(['manager', '--project', project, '--dry-run']);
    check('--dry-run changes nothing', dry.code === 0 && /exec sh .*manager\/start\.sh/.test(dry.stdout) && !windows(h).includes('manager'), dry.stdout + dry.stderr);
  });
}

async function taskScenario(): Promise<void> {
  current = 'remote_control';
  await withHarness({ name: 'task', cacheRoot: ROOT }, async (h) => {
    const repo = makeRepo(h, 'repo');
    const a = h.agentctl(['new', spec(h, repo, 'RC-1', 'remote_control: true\n'), '-y']);
    check('RC-1 (remote_control: true) starts', a.code === 0 && windows(h).includes('rc-1') && /Remote Control on: the session "RC-1"/.test(a.stdout), a.stdout + a.stderr);
    const b = h.agentctl(['new', spec(h, repo, 'RC-2'), '-y']);
    check('RC-2 (no key) starts', b.code === 0 && windows(h).includes('rc-2'), b.stderr);
    const [rc1, rc2] = [starts(h).find((l) => l.includes('Do RC-1') || /--remote-control RC-1/.test(l)), starts(h).find((l) => !/--remote-control/.test(l))];
    check('RC-1 got --model opus --effort high --remote-control RC-1 --settings <file>, in this order', /^claude --model opus --effort high --remote-control RC-1 --settings \S+$/.test(rc1 ?? ''), rc1);
    check('RC-2 got no Remote Control flag', /^claude --model opus --effort high --settings \S+$/.test(rc2 ?? ''), rc2);
    const taskMd = fs.readFileSync(path.join(h.root, 'state', 'rc-1', 'TASK.md'), 'utf8');
    check('TASK.md of RC-1 records remote_control: true; RC-2 has no such key', /^remote_control: true$/m.test(taskMd) && !/remote_control/.test(fs.readFileSync(path.join(h.root, 'state', 'rc-2', 'TASK.md'), 'utf8')));
    const codex = path.join(h.root, 'RC-3.md');
    fs.writeFileSync(codex, `---\ntask: RC-3\nagent: codex\nremote_control: true\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-rc-3\n---\nx\n`);
    const refused = h.agentctl(['new', codex, '-y']);
    check('remote_control: true on a Codex task is refused with a message, nothing starts', refused.code !== 0 && /remote_control: true works for Claude only/.test(refused.stderr) && !windows(h).includes('rc-3'), refused.stdout + refused.stderr);
    // a window lost (the Mac restarted): resume starts it again with Remote Control
    h.tmux(['kill-window', '-t', `=${h.session}:rc-1`]);
    const before = starts(h).length;
    const resumed = h.agentctl(['resume', '-y']);
    await sleep(1000);
    const after = starts(h).slice(before);
    check('resume brings RC-1 back with --remote-control RC-1 before --continue', resumed.code === 0 && after.some((l) => /^claude --model opus --effort high --remote-control RC-1 --settings \S+ --continue$/.test(l)), `${resumed.stdout}${resumed.stderr}\n${after.join('\n')}`);
  });
}

async function upScenario(): Promise<void> {
  current = 'up';
  await withHarness({ name: 'up', cacheRoot: ROOT }, async (h) => {
    const project = path.join(h.root, 'project');
    fs.mkdirSync(project, { recursive: true });
    fs.appendFileSync(path.join(h.agentctlHome, 'config.yaml'), `manager:\n  autostart: true\n  project: ${project}\n  name: Dyspozytor\n  model: opus\n  effort: high\n`);
    const up = h.agentctl(['up', '--no-attach']);
    check('up exits 0 and starts watch, board and manager', up.code === 0 && ['watch', 'board', 'manager'].every((w) => windows(h).includes(w)), up.stdout + up.stderr + windows(h).join());
    check('up says what to do in the manager window the first time', /Manager: started in window .*manager.*Enable Remote Control/.test(up.stdout), up.stdout);
    const started = await until(() => starts(h).some((l) => /--remote-control Dyspozytor /.test(l)));
    check('the manager started with the name, model and effort of the config', started && starts(h).some((l) => /^claude --model opus --effort high --mcp-config \S+ --remote-control Dyspozytor --settings /.test(l)), starts(h).join('\n'));
    const second = h.agentctl(['up', '--no-attach']);
    check('a second up starts no second manager', /Manager: already running/.test(second.stdout) && windows(h).filter((w) => w === 'manager').length === 1, second.stdout);
  });
}

async function main(): Promise<number> {
  fs.mkdirSync(ROOT, { recursive: true });
  for (const run of [managerScenario, taskScenario, upScenario]) {
    try {
      await run();
    } catch (e) {
      check(`${run.name} threw`, false, e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
  }
  const failed = checks.filter((c) => !c.ok);
  fs.writeFileSync(path.join(ROOT, 'live-manager-results.json'), `${JSON.stringify({ at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks }, null, 2)}\n`);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await main();
