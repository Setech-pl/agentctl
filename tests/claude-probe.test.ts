import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { makeConfig, makeContext, useScratch } from './helpers.ts';
import { claudeProbeFile, claudeProbeLaunch, claudeReset, parseClaudeUsage, refreshClaudePlan } from '../src/core/providers/claude-probe.ts';
import { claudePlanFile, readClaudePlan } from '../src/core/providers/claude-usage.ts';
import { UsageReader } from '../src/core/usage-sources.ts';
import { readPlans } from '../src/core/usage.ts';
import { collectUsage } from '../src/core/usage-report.ts';
import { claude } from '../src/core/providers/claude.ts';

const scratch = useScratch();
const fixture = fs.readFileSync(new URL('./fixtures/screen-claude-usage-2.1.311.txt', import.meta.url), 'utf8');
const now = Date.parse('2026-11-05T21:00:00Z');
const enabled = 'capacity: {claude_usage_probe: true, codex_refresh: false}\n';
const reader = () => new UsageReader(undefined);
function fake(name: string, screen = fixture) {
  const config = makeConfig(scratch.sub(name), enabled);
  const pasted: string[] = [], calls: { args: string[]; input?: string }[] = [];
  let submitted = false;
  const { ctx, runner } = makeContext(config, { startTime: now, respond(cmd, args, opts) {
    if (cmd !== 'tmux') return;
    calls.push({ args, input: opts.input });
    if (args[0] === 'load-buffer') pasted.push(opts.input ?? '');
    if (args[0] === 'send-keys' && args.at(-1) === 'C-m') submitted = true;
    if (args[0] === 'capture-pane') return { stdout: submitted ? screen : pasted.includes('/usage') ? '────────────────────\n❯ /usage\n────────────────────\n' : '────────────────────\n❯ \n────────────────────\n? for shortcuts\n' };
  } });
  return { config, ctx, runner, calls, pasted };
}
it('parses the single real 2.1.311 capture, excludes model-specific week, preserves exact zone resets', () => {
  const p = parseClaudeUsage(fixture, now)!;
  assert.deepEqual(p.windows, [
    { kind: 'session', minutes: 300, usedPercent: 4, resetsAt: Date.parse('2026-11-06T01:00:00Z') / 1000 },
    { kind: 'week', minutes: 10080, usedPercent: 87, resetsAt: Date.parse('2026-11-07T22:00:00Z') / 1000 },
  ]);
  assert.deepEqual(parseClaudeUsage('\x1b[32m' + fixture + '\x1b[0m', now), p);
  assert.equal(parseClaudeUsage('Current week (Fable)\n99% used\nResets 2am (UTC)', now), undefined);
  assert.equal(parseClaudeUsage(fixture.replace('87% used', '101% used'), now), undefined);
  assert.equal(parseClaudeUsage('Current session\n4% used', now), undefined);
  const weekOnly = fixture.slice(fixture.indexOf('   Current week (all models)'));
  assert.equal(parseClaudeUsage(weekOnly, now)!.windows.length, 1);
  assert.equal(parseClaudeUsage(weekOnly.replace('Resets Nov 7 at 11pm (Europe/Warsaw)', 'Resets unknown'), now)!.windows[0]!.resetsAt, null);
});
it('reset parsing handles noon, midnight, year rollover, DST and rejects unknown zones/formats', () => {
  assert.equal(claudeReset('Resets Jan 2 at 12am (UTC)', Date.parse('2026-12-31Z')), Date.parse('2027-01-02Z') / 1000);
  assert.equal(claudeReset('Resets 12pm (UTC)', now), Date.parse('2026-11-06T12:00Z') / 1000);
  assert.equal(claudeReset('Resets Jul 7 at 11pm (Europe/Warsaw)', now), Date.parse('2027-07-07T21:00Z') / 1000);
  for (const value of ['Resets 13pm (UTC)', 'Resets 2:99am (UTC)', 'Resets soon', 'Resets 2am (Unknown/Zone)']) assert.equal(claudeReset(value, now), null);
});
it('defaults off, validates interval >=15, and fixes argv independently of task flags/prompts', async () => {
  const config = makeConfig(scratch.sub('off'));
  assert.equal(config.capacity.claudeUsageProbe, false);
  assert.equal(config.capacity.claudeUsageProbeIntervalMinutes, 15);
  const { ctx, runner } = makeContext(config);
  assert.equal(await refreshClaudePlan(ctx), null); assert.equal(runner.calls.length, 0);
  for (const value of ['14', '0', '15.5', '"15"']) assert.throws(() => makeConfig(scratch.sub(`invalid-${value.replaceAll('"', '')}`), `capacity: {claude_usage_probe_interval_minutes: ${value}}`), /15 to 10080/);
  assert.throws(() => makeConfig(scratch.sub('bad-bool'), 'capacity: {claude_usage_probe: yes}'), /must be boolean/);
  config.agents.claude.flags = ['--print', 'never submit this'];
  config.agents.claude.env = { CLAUDE_CONFIG_DIR: '/isolated/claude', PRIVATE_TEST_SECRET: 'secret-value' };
  config.usage.claudeDir = null;
  const launch = claudeProbeLaunch(config);
  assert.deepEqual(launch.argv, ['claude', '--settings', '{"disableAllHooks":true,"statusLine":{"type":"command","command":"true"}}']);
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, '/isolated/claude');
});
it('slash-only probe uses neutral private script and unique detached session, without touching active windows', async () => {
  const { config, ctx, runner, calls, pasted } = fake('success');
  config.agents.claude.env = { PRIVATE_TEST_SECRET: 'secret-value' };
  await Promise.all([refreshClaudePlan(ctx), refreshClaudePlan(ctx)]);
  assert.deepEqual(pasted, ['/usage']);
  const data = JSON.parse(fs.readFileSync(claudeProbeFile(config), 'utf8'));
  assert.equal(data.windows[1].usedPercent, 87);
  assert.ok(!JSON.stringify(data).includes('Total cost'));
  const start = calls.find(c => c.args[0] === 'new-session')!.args;
  assert.ok(start.includes('-d')); assert.match(start[start.indexOf('-c') + 1]!, /claude-usage-probe$/);
  const session = start[start.indexOf('-s') + 1]!;
  assert.match(session, /^agentctl-claude-probe-/); assert.notEqual(session, config.session);
  assert.ok(calls.some(c => c.args[0] === 'kill-session' && c.args.includes(`=${session}`)));
  assert.ok(calls.filter(c => c.args.includes('-t')).every(c => c.args[c.args.indexOf('-t') + 1]!.startsWith(`=${session}`)));
  assert.ok(!runner.commands.join('\n').includes('secret-value'));
  assert.ok(runner.commands.some(c => c.includes('chmod 0700')));
  assert.ok([...runner.written.values()].some(v => v.includes('export PRIVATE_TEST_SECRET=')));
  assert.equal(readClaudePlan(config, reader(), runner.now()).source, 'claude-usage-probe');
  assert.equal(await refreshClaudePlan(ctx), null);
  assert.equal(calls.filter(c => c.args[0] === 'new-session').length, 1);
  await runner.sleep(15 * 60_000);
  await refreshClaudePlan(ctx);
  assert.equal(calls.filter(c => c.args[0] === 'new-session').length, 2);
});
it('configured interval throttles failures; trust waits persist without dialog answers and close own session', async () => {
  const { config, ctx, runner, calls, pasted } = fake('trust');
  config.capacity.claudeUsageProbeIntervalMinutes = 30;
  // Replace every capture, before any slash command can be sent.
  const trust = makeContext(config, { startTime: now, respond: (_cmd, args) => args.includes('capture-pane') ? { stdout: 'Quick safety check\n❯ 1. Yes, I trust this folder' } : undefined });
  const note = await refreshClaudePlan(trust.ctx);
  assert.match(note!, /one-time wait for Marcin/);
  assert.equal(await refreshClaudePlan(ctx), note);
  assert.equal(calls.length, 0); assert.deepEqual(pasted, []);
  assert.ok(!trust.runner.calls.some(c => /tmux (?:send-keys|load-buffer)/.test(c.line)));
  assert.ok(trust.runner.calls.some(c => c.line.includes('kill-session')));
  await runner.sleep(29 * 60_000); assert.equal(await refreshClaudePlan(ctx), note);
  await runner.sleep(60_000); assert.equal(await refreshClaudePlan(ctx), null);
});
it('unparseable output preserves the old reading, marks stale, and rate-limits failed attempts', async () => {
  const { config, ctx, runner, calls } = fake('failure', 'Usage unavailable\nEsc to cancel');
  fs.mkdirSync(path.dirname(claudeProbeFile(config)), { recursive: true });
  fs.writeFileSync(claudeProbeFile(config), JSON.stringify(parseClaudeUsage(fixture, now - 3600_000)));
  assert.match((await refreshClaudePlan(ctx))!, /no plan percentages/);
  assert.equal(await refreshClaudePlan(ctx), null);
  assert.equal(calls.filter(c => c.args[0] === 'new-session').length, 1);
  const p = readPlans(config, reader(), runner.now()).claude;
  assert.equal(p.stale, true); assert.equal(p.source, 'claude-usage-probe');
  assert.equal(p.windows[1]!.usedPercent, 87);
});
it('newest source wins; disabled probe ignores cached probe; reset windows expire; dry run never launches', async () => {
  const { config, ctx, runner } = fake('sources');
  await refreshClaudePlan(ctx);
  fs.writeFileSync(claudePlanFile(config), JSON.stringify(parseClaudeUsage(fixture.replace('87% used', '88% used'), runner.now() + 1)));
  assert.equal(readClaudePlan(config, reader(), runner.now()).source, 'claude-statusline');
  config.capacity.claudeUsageProbe = false;
  fs.rmSync(claudePlanFile(config));
  assert.equal(readClaudePlan(config, reader(), runner.now()).available, false);
  config.capacity.claudeUsageProbe = true;
  assert.equal(readClaudePlan(config, reader(), Date.parse('2026-11-08Z')).available, false);
  const dry = makeContext(config, { dryRun: true });
  assert.equal(await refreshClaudePlan(dry.ctx), null); assert.equal(dry.runner.calls.length, 0);
});
it('usage refreshes opt-in probe and doctor describes off, one-time trust wait, fresh and stale', async () => {
  const { config, ctx } = fake('usage');
  const detection = { found: true, version: '2.1.311', raw: '2.1.311', features: { effortFlag: true, remoteControl: true, appendSystemPromptFile: true } };
  const line = () => claude.doctor(detection, {}, config).find(l => l.name === 'claude usage probe')!;
  assert.match(line().text, /one-time wait for Marcin/);
  const report = await collectUsage(ctx, { rows: [] });
  assert.equal(report.plans.claude.source, 'claude-usage-probe');
  assert.match(line().text, /last read/);
  config.capacity.claudeUsageProbe = false; assert.match(line().text, /off/);
});
it('refuses Enter if a dialog opens after paste, and cleans up on a failed capture', async () => {
  for (const mode of ['dialog', 'capture-error']) {
    const config = makeConfig(scratch.sub(mode), enabled);
    let pasted = false;
    const keys: string[] = [];
    const { ctx, runner } = makeContext(config, { startTime: now, respond(_cmd, args) {
      if (args[0] === 'load-buffer') pasted = true;
      if (args[0] === 'send-keys') keys.push(args.at(-1)!);
      if (args[0] === 'capture-pane') {
        if (pasted && mode === 'capture-error') throw new Error('capture failed');
        return { stdout: pasted ? '❯ /usage\nEnter to select · Esc to cancel' : '❯ \n' };
      }
    } });
    if (mode === 'capture-error') await assert.rejects(refreshClaudePlan(ctx), /capture failed/);
    else assert.match((await refreshClaudePlan(ctx))!, /never answers dialogs/);
    assert.deepEqual(keys, []);
    assert.ok(runner.commands.some(c => c.includes('kill-session')));
    assert.ok(!fs.existsSync(claudeProbeFile(config)));
  }
});
it('non-ready startup and launch failure do not paste anything and remain rate-limited', async () => {
  for (const mode of ['not-ready', 'launch-failed']) {
    const config = makeConfig(scratch.sub(mode), enabled);
    const { ctx, runner } = makeContext(config, { startTime: now, respond(_cmd, args) {
      if (args[0] === 'capture-pane') return { stdout: 'Choose a login method' };
      if (args[0] === 'new-session' && mode === 'launch-failed') return { code: 1 };
    } });
    assert.match((await refreshClaudePlan(ctx))!, mode === 'not-ready' ? /did not become idle/ : /could not start/);
    await refreshClaudePlan(ctx);
    assert.equal(runner.commands.filter(c => c.includes('new-session')).length, 1);
    assert.ok(!runner.commands.some(c => c.includes('load-buffer') || c.includes('send-keys')));
  }
});
