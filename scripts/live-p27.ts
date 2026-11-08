import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { planEventWiring } from '../src/core/events.ts';
import { buildAgentArgv } from '../src/core/agents.ts';
import { writeLaunchScript } from '../src/core/launch-script.ts';
import { RealRunner } from '../src/core/runner.ts';
import { Context } from '../src/core/context.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { openAgentWindow } from '../src/core/window-guard.ts';

const cache = defaultCacheRoot('actl-0181-b');
const results: { name: string; ok: boolean; note?: string }[] = [];
const check = (name: string, ok: unknown, note?: string) => { results.push({ name, ok: Boolean(ok), ...(note ? { note } : {}) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

await withHarness({ name: 'p27', cacheRoot: cache, config: 'providers: [claude, codex, kimi]\ncapacity: {snapshot: false, codex_refresh: false}\n' }, async h => {
  const long = 'literal quotes \'" dollar $ backtick ` newline\n' + 'p27'.repeat(1800);
  fs.writeFileSync(path.join(h.codexHome, 'config.toml'), `notify=${JSON.stringify(['notify-send', long])}\n`);
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init'], ['commit', '--allow-empty', '-m', 'fixture']]) assert.equal(spawnSync('git', ['-C', repo, ...args], { env: h.env }).status, 0);
  const spec = path.join(h.root, 'task.md');
  fs.writeFileSync(spec, `---\ntask: P27-1\nagent: codex\nrepos: [{path: ${repo}, worktree: ${repo}-wt}]\nenv: {P27_TOKEN: private-test-value}\n---\nDo nothing.\n`);
  const start = h.agentctl(['new', spec, '--no-wait-trust']);
  check('new starts Codex with >4000-character notify', start.code === 0 && h.agentStarts().some(s => /^codex --sandbox/.test(s)), start.stderr);
  const taskDir = path.join(h.root, 'state/p27-1');
  const script = fs.readFileSync(path.join(taskDir, 'start.sh'), 'utf8');
  check('script is 0700 and contains env', (fs.statSync(path.join(taskDir, 'start.sh')).mode & 0o777) === 0o700 && script.includes('export P27_TOKEN='));
  check('notify script is 0700; forwarding file is 0600', (fs.statSync(path.join(taskDir, 'codex-notify.sh')).mode & 0o777) === 0o700 && (fs.statSync(path.join(taskDir, 'codex-forward.json')).mode & 0o777) === 0o600);
  check('new output is readable and private', /running codex \(model .*effort high\) via exec sh /.test(start.stdout) && !start.stdout.includes(long) && !start.stdout.includes('private-test-value'));
  const payload = JSON.stringify({ type: 'session-known', 'thread-id': 'p27-test' });
  const forward = spawnSync('sh', [path.join(taskDir, 'codex-notify.sh'), payload], { env: h.env, encoding: 'utf8' });
  check('user notify executes after event with literal payload and long value', forward.status === 0 && fs.readFileSync(h.notifyLog, 'utf8').includes('p27p27'));
  h.tmux(['kill-window', '-t', `=${h.session}:p27-1`]);
  const resume = h.agentctl(['resume', 'P27-1', '--yes', '--all']);
  check('resume starts Codex through same short script', resume.code === 0 && /via exec sh /.test(resume.stdout) && fs.readFileSync(path.join(taskDir, 'start.sh'), 'utf8').includes('exec codex resume '), resume.stdout + resume.stderr);
  const doctor: unknown[] = [];
  for (const [mode, guard, envGuard, allowed] of [['manual', true, undefined, true], ['yolo', true, undefined, true], ['auto', true, undefined, false], ['manual', false, undefined, false], ['yolo', true, 'false', false]] as const) {
    fs.writeFileSync(path.join(h.env.KIMI_CODE_HOME!, 'config.toml'), `default_permission_mode='${mode}'\n[permission]\ndangerous_command_guard=${guard}\n`);
    if (envGuard) h.env.KIMI_CODE_DANGEROUS_COMMAND_GUARD = envGuard; else delete h.env.KIMI_CODE_DANGEROUS_COMMAND_GUARD;
    const d = h.agentctl(['doctor']); doctor.push({ mode, guard, envGuard, allowed, code: d.code, stdout: d.stdout, stderr: d.stderr });
    check(`doctor ${mode}, guard=${guard}, env=${envGuard ?? 'unset'}`, (d.code === 0) === allowed);
  }
  fs.writeFileSync(path.join(cache, 'doctor.json'), JSON.stringify(doctor, null, 2) + '\n');
});

// Explicit opt-in: the real CLI runs only with fully isolated homes and no submitted prompt/model turn.
if (process.env.AGENTCTL_REAL_CODEX) {
  const realCodex = path.resolve(process.env.AGENTCTL_REAL_CODEX);
  const saved = { ...process.env };
  const root = path.join(cache, 'real'); fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root, { recursive: true });
  const bin = path.join(root, 'bin'), home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), agentctlHome = path.join(root, 'agentctl'), tmuxDir = path.join(root, 'tmx');
  for (const dir of [bin, home, codexHome, agentctlHome, tmuxDir]) fs.mkdirSync(dir, { recursive: true });
  const long = 'p27-live-'.repeat(600);
  const forwarded = path.join(root, 'forwarded.json');
  const notify = [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', forwarded, long];
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `notify=${JSON.stringify(notify)}\nmodel_provider="p27"\nmodel="p27"\n[model_providers.p27]\nname="P27 isolated no-inference test"\nbase_url="http://127.0.0.1:9/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`);
  fs.writeFileSync(path.join(home, '.tmux.conf'), 'set -g default-shell /bin/sh\nset -g exit-empty off\n');
  fs.symlinkSync(realCodex, path.join(bin, 'codex'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: home, CODEX_HOME: codexHome, AGENTCTL_HOME: agentctlHome, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), KIMI_CODE_HOME: path.join(root, 'kimi'), TMUX_TMPDIR: tmuxDir, TMPDIR: root, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`, LANG: 'en_US.UTF-8', TERM: 'screen-256color' });
  fs.writeFileSync(path.join(agentctlHome, 'config.yaml'), `state_dir: ${root}/state\ncache: ${root}/tasks\nsession: p27-real\ncapacity: {snapshot: false, codex_refresh: false}\n`);
  const config = loadGlobalConfig(agentctlHome), runner = new RealRunner(), ctx = new Context(runner, config, () => {});
  try {
    const dir = path.join(config.stateDir, 'real'); await runner.mkdir(dir);
    const wiring = planEventWiring({ agent: 'codex', task: 'P27-REAL', window: 'real', config, self: [process.execPath, '--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts')], env: { CODEX_HOME: codexHome } });
    for (const file of wiring.files) { await runner.writeFile(file.path, file.content); if (file.path.endsWith('.sh')) await runner.exec('chmod', ['0700', file.path]); }
    const command = await writeLaunchScript(runner, dir, buildAgentArgv({ agent: 'codex', model: 'default', effort: 'medium' }, config.agents.codex, wiring.args), { CODEX_HOME: codexHome });
    await openAgentWindow(ctx, { task: 'P27-REAL', window: 'real', cwd: root, env: {}, report: path.join(root, 'report.md'), repos: [], origin: 'new', sessionUp: false });
    await pause(500); await ctx.tmux.typeCommand('real', command);
    let screen = '';
    for (let i = 0; i < 40; i++) { await pause(500); screen = (await ctx.tmux.capture('real')).stdout; if (/context left|for shortcuts|Ask Codex|Try "/i.test(screen)) break; }
    fs.writeFileSync(path.join(cache, 'real-codex-screen.log'), screen);
    check('real Codex TUI starts with isolated >4000-character notify', /context left|for shortcuts|Ask Codex|Try "/i.test(screen), screen);
    check('typed real start command is below 1000 chars', command.length < 1000, `${command.length} characters`);
    const payload = '{"type":"session-known","thread-id":"p27-real"}';
    const forwardedResult = await runner.exec('sh', [path.join(dir, 'codex-notify.sh'), payload]);
    check('real-home notify wrapper forwards all long arguments and raw payload', forwardedResult.code === 0 && JSON.stringify(JSON.parse(fs.readFileSync(forwarded, 'utf8'))) === JSON.stringify([long, payload]));
    const pane = await runner.exec('tmux', ['display-message', '-p', '-t', '=p27-real:real', '#{pane_current_command}']);
    check('real Codex remains alive', /codex/.test(pane.stdout));
    fs.writeFileSync(path.join(cache, 'real-codex.json'), JSON.stringify({ command, commandLength: command.length, notifyLineLength: JSON.stringify(notify).length, pane: pane.stdout.trim(), screenReady: true, noPromptSubmitted: true, isolatedHome: codexHome }, null, 2) + '\n');
  } finally {
    await runner.exec('tmux', ['kill-server']);
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved);
  }
}
fs.writeFileSync(path.join(cache, 'p27-results.json'), JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2) + '\n');
