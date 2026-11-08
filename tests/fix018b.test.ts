import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { kimiProbeLaunch, refreshKimiPlan } from '../src/core/providers/kimi-probe.ts';
import { kimiHome, resolvedKimiHome } from '../src/core/providers/kimi-config.ts';
import { provider } from '../src/core/providers/registry.ts';
import { launchEnvironment, validateLaunch } from '../src/core/safety.ts';
import { collectTaskUsage } from '../src/core/usage.ts';
import { agentHomes, UsageReader } from '../src/core/usage-sources.ts';
import { kimiPlanFile } from '../src/core/providers/kimi-usage.ts';
import { makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const kimi = provider('kimi');
const detection = { found: true, version: '2.5.0', raw: 'fake 2.5.0', features: {} };
const order = { agent: 'kimi' as const, model: 'default', effort: 'high' as const, task: 'TEST' };

for (const [name, model, efforts] of [
  ['adjustable', 'k3', "['low','high','max']"],
  ['max-only', 'kimi-for-coding', "['max']"],
  ['not-adjustable', 'kimi-for-coding-highspeed', '[]'],
] as const) it(`N-A completes a slash-only usage probe with ${name} model and no effort override`, async () => {
  const root = scratch.sub(name), home = path.join(root, 'kimi'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), `default_model='${model}'\n[models.'${model}']\nsupport_efforts=${efforts}\n`);
  const config = makeConfig(root, `providers: [claude, codex, kimi]\ncapacity: {kimi_usage_probe: true, kimi_usage_probe_model: ${model}}\nagents:\n  kimi:\n    env: {KIMI_CODE_HOME: ${home}, KIMI_MODEL_THINKING_EFFORT: high}\n`);
  const launch = kimiProbeLaunch(config, { KIMI_MODEL_THINKING_EFFORT: 'max' });
  assert.equal(launch.env.KIMI_MODEL_THINKING_EFFORT, undefined);
  assert.match(launch.command, new RegExp(`env -u KIMI_MODEL_THINKING_EFFORT kimi -m kimi-code/${model}$`));
  assert.equal(launch.env.KIMI_CODE_NO_AUTO_UPDATE, '1');
  assert.equal(launch.env.KIMI_DISABLE_TELEMETRY, '1');
  const pasted: string[] = [];
  const { ctx, runner } = makeContext(config, { respond: (cmd, args, opts) => { if (args.includes('load-buffer')) pasted.push(opts?.input ?? ''); return args.includes('capture-pane') ? { stdout: 'Welcome to Kimi Code!\n5h limit 26% used resets in 1h\nMonthly limit 3% used resets in 2d\n│ > │' } : { stdout: '' }; } });
  assert.equal(await refreshKimiPlan(ctx), null);
  assert.equal(JSON.parse(fs.readFileSync(kimiPlanFile(config), 'utf8')).windows[0].usedPercent, 26);
  assert.ok(runner.commands.some(c => c.includes('kill-session')));
  assert.ok(pasted.includes('/exit'));
  assert.ok(pasted.includes('/usage'));
  assert.ok(!runner.commands.some(c => /KIMI_MODEL_THINKING_EFFORT=/.test(c)));
});
it('N-A defaults to k3 even when the task default model is Highspeed; rejects bypass flags and unsafe config', () => {
  const root = scratch.sub('probe-default'), home = path.join(root, 'kimi'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), "default_model='kimi-for-coding-highspeed'\n");
  const config = makeConfig(root, `providers: [claude, codex, kimi]\nagents:\n  kimi:\n    env: {KIMI_CODE_HOME: ${home}}\n`);
  assert.match(kimiProbeLaunch(config).command, /-m kimi-code\/k3$/);
  config.agents.kimi.flags = ['--prompt=turn'];
  assert.throws(() => kimiProbeLaunch(config), /never allows/);
  config.agents.kimi.flags = [];
  fs.writeFileSync(path.join(home, 'config.toml'), "default_permission_mode='auto'\n");
  assert.throws(() => kimiProbeLaunch(config), /default_permission_mode=auto/);
});
it('N-B doctor, task, usage and passive sessions/wire share the configured home', async () => {
  const root = scratch.sub('custom'), home = path.join(root, 'custom-kimi'); fs.mkdirSync(home);
  const config = makeConfig(root, `providers: [claude, codex, kimi]\nagents:\n  kimi:\n    env: {KIMI_CODE_HOME: ${home}}\n`);
  const file = path.join(home, 'config.toml');
  fs.writeFileSync(file, "default_permission_mode='auto'\n");
  const lines = kimi.doctor(detection, process.env, config);
  assert.ok(lines.some(l => l.name === 'kimi home' && l.text === home));
  assert.ok(lines.some(l => l.level === 'fail' && /default_permission_mode=auto/.test(l.text)));
  assert.throws(() => validateLaunch(config, order, {}), /default_permission_mode=auto/);
  fs.writeFileSync(file, "default_permission_mode='manual'\n[[permission.rules]]\ndecision='ask'\npattern='Bash(git status)'\n");
  assert.ok(kimi.doctor(detection, process.env, config).some(l => /Bash\(git status\)/.test(l.text)));
  assert.equal(launchEnvironment(config, order, {}).KIMI_CODE_HOME, home);
  assert.equal(agentHomes(config).kimi, home);
  assert.equal(kimi.usage.taskHome!(config, process.env), home);
  const record = seedTask(config, 'CUSTOM', { agent: 'kimi', repos: [{ path: root, worktree: root }] });
  const dir = path.join(home, 'sessions', 'workspace', 'session_S', 'agents', 'main'); fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Date.parse(record.started) + 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), [{ type: 'metadata', protocol_version: '1.5', cwd: root, session_id: 'S', timestamp: at }, { type: 'interaction.request', timestamp: at }, { type: 'usage.record', id: 'U', inputOther: 10, output: 20, timestamp: at }].map(v => JSON.stringify(v)).join('\n') + '\n');
  const { ctx } = makeContext(config);
  await kimi.events.poll!(ctx, record);
  assert.equal(JSON.parse(fs.readFileSync(path.join(config.stateDir, record.window, 'event.json'), 'utf8')).outcome, 'needs-input');
  const usage = collectTaskUsage(config, new UsageReader(undefined), [record], Date.parse(at));
  assert.equal(usage.get(record.task)?.total.input, 10);
  config.agents.kimi.env!.KIMI_CODE_TRUST_WORKSPACE = '1';
  assert.ok(kimi.doctor(detection, process.env, config).some(l => l.name === 'kimi trust' && l.level === 'fail'));
});
it('N-B preserves process/default home selection and the legacy usage directory fallback', () => {
  const config = makeConfig(scratch.sub('fallbacks'));
  assert.equal(resolvedKimiHome(config, { KIMI_CODE_HOME: '/isolated/process' }), '/isolated/process');
  assert.equal(resolvedKimiHome(config, {}), path.join(os.homedir(), '.kimi-code'));
  assert.equal(kimiHome({}), path.join(os.homedir(), '.kimi-code'));
  assert.ok(kimi.doctor(detection, process.env, config).some(l => l.name === 'kimi home' && l.text === process.env.KIMI_CODE_HOME));
  config.usage.kimiDir = '/isolated/legacy';
  assert.equal(resolvedKimiHome(config), '/isolated/legacy');
  config.agents.kimi = kimi.defaultSettings();
  config.agents.kimi.env = { KIMI_CODE_HOME: '/isolated/agent' };
  assert.equal(resolvedKimiHome(config), '/isolated/agent');
});
