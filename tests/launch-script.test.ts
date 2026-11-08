import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { launchScript, writeLaunchScript } from '../src/core/launch-script.ts';
import { RealRunner, RecordingRunner } from '../src/core/runner.ts';
import { planEventWiring } from '../src/core/events.ts';
import { makeConfig, useScratch, makeContext, specText, FakeTmux } from './helpers.ts';
import { splitSpecs, resolveSpec } from '../src/core/spec.ts';
import { newTasks } from '../src/core/new.ts';
const scratch = useScratch();

it('executes argv and env literally, protects the script and logs only its path', async () => {
  const values = ['', 'a b', "it's", '"quoted"', '$HOME $(exit 7)', '`exit 8`', 'first\nsecond', '\\end'];
  const dir = scratch.sub("launch space ' dollar$ `tick`");
  const argv = [process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.LAUNCH_VALUE}))', '--', ...values];
  const env = { LAUNCH_VALUE: values.join('\n') };
  const command = await writeLaunchScript(new RealRunner(), dir, argv, env);
  assert.equal(fs.statSync(path.join(dir, 'start.sh')).mode & 0o777, 0o700);
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: values, env: env.LAUNCH_VALUE });
  const recorder = new RecordingRunner();
  await writeLaunchScript(recorder, dir, argv, env);
  assert.ok(!recorder.commands.join('\n').includes('LAUNCH_VALUE'));
  assert.throws(() => launchScript(['true'], { 'BAD;exit': 'x' }), /Invalid launch environment key/);
});

it('keeps >4000-character notify and PATH out of tmux argv and output on new', async () => {
  const home = scratch.sub('long-home');
  const secret = 'private-$`\'"\n' + 'x'.repeat(5000);
  fs.writeFileSync(path.join(home, 'config.toml'), `notify = ${JSON.stringify(['notify-command', secret])}\n`);
  const config = makeConfig(scratch.sub('long-new'));
  const repo = scratch.sub('repo'); fs.mkdirSync(path.join(repo, '.git'));
  const fake = new FakeTmux();
  const w = makeContext(config, { respond: fake.respond });
  const spec = resolveSpec(splitSpecs(specText({ task: 'LONG-1', agent: 'codex' }, repo))[0]!, { config, loadProject: () => undefined });
  spec.env = { CODEX_HOME: home, PRIVATE_TOKEN: secret };
  await newTasks(w.ctx, [spec], { self: ['/usr/bin/env', `PATH=${'p'.repeat(5000)}`, process.execPath, '/agentctl.js'] });
  const typed = w.runner.commands.find(c => c.includes(' -l -- '))!;
  assert.ok(typed.includes('exec sh ') && typed.length < 1000, typed);
  assert.ok(![...w.runner.commands, ...w.out].join('\n').includes(secret));
  assert.ok(!w.runner.commands.some(c => c.includes('-e PRIVATE_TOKEN')));
  const forward = [...w.runner.written].find(([name]) => name.endsWith('codex-forward.json'))!;
  assert.deepEqual(JSON.parse(forward[1]), ['notify-command', secret]);
  assert.ok([...w.runner.written.values()].some(content => content.includes('export PRIVATE_TOKEN=')));
});

it('Codex notify wrapper preserves payload and reads forwarding from a private file', () => {
  const config = makeConfig(scratch.sub('notify-wrapper'));
  const values = ['command with spaces', "quote'$`\n" + 'x'.repeat(5000)];
  const w = planEventWiring({ agent: 'codex', task: 'LONG-2', window: 'long-2', config,
    self: ['/usr/bin/env', "WRAPPER_VALUE=it's $`\n", process.execPath, '-e', 'console.log(JSON.stringify({args:process.argv.slice(1),env:process.env.WRAPPER_VALUE}))', '--'],
    env: {}, readConfig: () => `notify=${JSON.stringify(values)}` });
  for (const file of w.files) { fs.mkdirSync(path.dirname(file.path), { recursive: true }); fs.writeFileSync(file.path, file.content, { mode: 0o600 }); }
  const notify = JSON.parse(w.args[1]!.slice(7)) as string[];
  const payload = '{"text":"literal $` quote\\\" and newline\\n"}';
  const result = spawnSync(notify[0]!, [...notify.slice(1), payload], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.env, "it's $`\n");
  assert.equal(observed.args.at(-1), payload);
  assert.ok(!observed.args.includes(values[1]));
  const forwardFile = observed.args[observed.args.indexOf('--forward-file') + 1];
  assert.deepEqual(JSON.parse(fs.readFileSync(forwardFile, 'utf8')), values);
});

it('event CLI reads the forwarding file and forwards the unchanged payload after an unknown-task event', () => {
  const home = scratch.sub('event-cli'); makeConfig(home);
  const resultFile = path.join(home, 'forwarded.json'), forwardFile = path.join(home, 'notify.json');
  const values = ["spaces quotes '$ `\n" + 'n'.repeat(5000)];
  fs.writeFileSync(forwardFile, JSON.stringify([process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', resultFile, ...values]), { mode: 0o600 });
  const payload = '{"type":"session-known", "thread-id":"literal-$`"}';
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts'), 'event', '--task', 'MISSING', '--agent', 'codex', '--forward-file', forwardFile, payload], { env: { ...process.env, AGENTCTL_HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultFile, 'utf8')), [...values, payload]);
  assert.ok(!result.stdout.includes(values[0]!) && !result.stderr.includes(values[0]!));
});
