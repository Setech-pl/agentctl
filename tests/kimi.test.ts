import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { provider, activeProviders } from '../src/core/providers/registry.ts';
import { buildAgentArgv, buildResumeArgv } from '../src/core/agents.ts';
import { findAutoAcceptFlag, launchEnvironment, validateLaunch } from '../src/core/safety.ts';
import { readKimiConfig } from '../src/core/providers/kimi-config.ts';
import { classifyScreen, taskState } from '../src/core/state.ts';
import { parseKimiUsage } from '../src/core/providers/kimi-probe.ts';
import { deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { feedKimiLine, kimiPlanFile } from '../src/core/providers/kimi-usage.ts';
import { emptyStats, sumBuckets } from '../src/core/usage-parse.ts';
import { resolveSpec } from '../src/core/spec.ts';
import { planBatch } from '../src/core/plan.ts';
import { planMove } from '../src/core/move.ts';
import { defaultEquivalents, translate, parseEquivalents } from '../src/core/equivalents.ts';
import { planStatusLine } from '../src/core/usage-report.ts';
import { readPlans, readTaskSessions } from '../src/core/usage.ts';
import { UsageReader } from '../src/core/usage-sources.ts';
import { Problems } from '../src/core/util.ts';
import { makeConfig, makeContext, seedTask, useScratch, REPO_ROOT, FakeTmux } from './helpers.ts';
const scratch = useScratch();
const kimi = provider('kimi');
const settings = kimi.defaultSettings();
const order = { agent: 'kimi' as const, model: 'k3', effort: 'high' as const, task: 'K-1' };
const active = 'providers: [claude, codex, kimi]\ncapacity: {codex_refresh: false}\n';
const fixture = (name: string) => fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures', `screen-kimi-${name}.txt`), 'utf8');
function world(name: string, toml = '') {
  const root = scratch.sub(name), home = path.join(root, 'kimi'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), toml);
  const config = makeConfig(root, active + `usage:\n  kimi_dir: ${home}\n`);
  return { root, home, config };
}
it('keeps default active providers and the legacy settings serialization unchanged', () => {
  const config = makeConfig(scratch.sub('default'));
  assert.deepEqual(activeProviders(config), ['claude', 'codex']);
  assert.throws(() => resolveSpec({ index: 1, header: { task: 'K', agent: 'kimi', repos: [{ path: '/repo', worktree: '/wt' }] }, prompt: 'Work' }, { config }), /providers: \[claude, codex, kimi\]/);
  assert.deepEqual(readTaskSessions(config, 'missing'), { claude: [], codex: [] });
});
for (const flag of ['-y', '--yolo', '--yes', '--auto-approve', '--auto', '-p', '--prompt']) {
  for (const args of [[flag], ...(flag.startsWith('--') ? [[`${flag}=value`]] : [])]) it(`Kimi rejects ${args[0]} while original adapters keep 0.17.4 results`, () => {
    assert.equal(findAutoAcceptFlag(args, 'kimi'), args[0]);
    const legacy = flag === '--yolo' ? args[0] : undefined;
    for (const id of ['claude', 'codex'] as const) {
      assert.equal(findAutoAcceptFlag(args, id), legacy);
      assert.equal(findAutoAcceptFlag(args), legacy);
    }
    assert.throws(() => buildAgentArgv(order, settings, args), /kimi:.*never allows/);
    assert.throws(() => buildResumeArgv(order, settings, args), /kimi:.*never allows/);
  });
}
it('uses target-provider rules for config flags, spec env, queue planning and explicit translation', async () => {
  const w = world('safety');
  const raw = { index: 1, header: { task: 'K', agent: 'kimi', model: 'k3', repos: [{ path: w.root, worktree: `${w.root}/wt` }] }, prompt: 'Work' };
  for (const env of [{ KIMI_CODE_TRUST_WORKSPACE: '0' }, { KIMI_CODE_DANGEROUS_COMMAND_GUARD: 'false' }]) {
    assert.throws(() => resolveSpec({ ...raw, header: { ...raw.header, env } }, { config: w.config }), /forbidden/);
    const claude = resolveSpec({ ...raw, header: { ...raw.header, agent: 'claude', model: 'sonnet', env } }, { config: w.config });
    await assert.rejects(planBatch(makeContext(w.config, { dryRun: true }).ctx, [claude], { agent: 'kimi', ignoreLimits: true }), /forbidden/);
  }
  assert.doesNotThrow(() => makeConfig(scratch.sub('legal-claude'), 'agents:\n  claude: {flags: [-y, --prompt, x]}\n'));
  assert.throws(() => makeConfig(scratch.sub('illegal-kimi'), active + 'agents:\n  kimi: {flags: [-y]}\n'), /config.agents.kimi.flags.*-y/);
});
it('rejects target Kimi extra flags when moving from Claude before any new window', async () => {
  const w = world('move'); const worktree = path.join(w.root, 'wt'); fs.mkdirSync(worktree);
  const from = seedTask(w.config, 'SOURCE', { agent: 'claude', model: 'sonnet', effort: 'high', repos: [{ path: w.root, worktree }] });
  const tmux = new FakeTmux(w.config.session), { ctx, runner } = makeContext(w.config, { respond: tmux.respond });
  const plan = await planMove(ctx, from.task, { agent: 'kimi' });
  assert.equal(plan.to.agent, 'kimi');
  assert.throws(() => buildAgentArgv(plan.to, settings, ['-y']), /kimi: "-y".*never allows/);
  w.config.agents.kimi.flags = ['-y'];
  await assert.rejects(planMove(ctx, from.task, { agent: 'kimi' }), /kimi: "-y".*never allows/);
  assert.ok(!runner.calls.some(c => /new-window|new-session/.test(c.line)));
});
it('reads TOML with quoted model aliases, arrays and permission rules without writing it', () => {
  const w = world('toml', `default_permission_mode = 'manual'\ndefault_model='kimi-code/k3'\n[models."kimi-code/k3"]\ndisplay_name='K3.1 Pro'\nsupport_efforts=[\n 'high', # catalog\n 'max'\n]\n[permission]\ndangerous_command_guard=true\n[[permission.rules]]\ndecision='allow'\npattern='Bash(git status)'\nreason='read'\n`);
  const before = fs.readFileSync(path.join(w.home, 'config.toml'), 'utf8');
  const config = readKimiConfig({ KIMI_CODE_HOME: w.home });
  assert.equal(config.guard, true); assert.deepEqual(config.models[0]?.efforts, ['high', 'max']);
  assert.equal(config.rules[0]?.pattern, 'Bash(git status)');
  const env = launchEnvironment(w.config, order, {});
  assert.equal(env.KIMI_CODE_NO_AUTO_UPDATE, '1'); assert.equal(env.KIMI_DISABLE_TELEMETRY, '1');
  assert.equal(env.KIMI_MODEL_THINKING_EFFORT, 'high'); assert.equal(env.AGENTCTL_TASK, 'K-1');
  assert.throws(() => validateLaunch(w.config, { ...order, effort: 'low' }, {}), /does not support effort low/);
  assert.equal(fs.readFileSync(path.join(w.home, 'config.toml'), 'utf8'), before);
  assert.deepEqual(buildAgentArgv(order, settings), ['kimi', '-m', 'kimi-code/k3']);
  assert.deepEqual(buildAgentArgv({ ...order, model: 'default' }, settings), ['kimi']);
  assert.deepEqual(buildResumeArgv(order, settings, [], 'S'), ['kimi', '--session', 'S']);
  assert.deepEqual(buildResumeArgv(order, settings), ['kimi', '--continue']);
});
for (const mode of ['auto']) it(`refuses config ${mode} in launch and doctor`, () => {
  const w = world(`mode-${mode}`, `default_permission_mode="${mode}"`);
  assert.throws(() => launchEnvironment(w.config, order, {}), /default_permission_mode=.*Never Ask/);
  const lines = kimi.doctor({ found: true, version: '2.6.0', raw: '2.6.0', features: {} }, { KIMI_CODE_HOME: w.home });
  assert.ok(lines.some(l => l.name === 'kimi permissions' && l.level === 'fail'));
  assert.ok(lines.some(l => l.name === 'kimi version' && l.level === 'warn'));
});
it('rejects malformed TOML rather than interpreting permissions and never guesses unsupported effort', () => {
  const w = world('invalid', 'default_permission_mode = "manual"\n[broken');
  assert.throws(() => validateLaunch(w.config, order, {}), /invalid TOML/);
  const noCatalog = world('no-catalog');
  assert.equal(launchEnvironment(noCatalog.config, order, {}).KIMI_MODEL_THINKING_EFFORT, undefined);
});
for (const [file, expected] of [
  ['01-zaufanie', 'needs-trust'], ['01-start', 'idle'], ['02-bezczynny', 'idle'],
  ['03-praca-1', 'working'], ['03-praca-2', 'working'], ['03-praca-3', 'working'], ['03-praca-4', 'working'],
  ['04-zgoda', 'needs-input'], ['05-pytanie', 'needs-input'], ['05-pytanie-submit', 'needs-input'],
  ['06-koniec-tury', 'idle'], ['09-przerwanie-po', 'idle'],
  ['synthetic-auth', 'needs-trust'], ['synthetic-limit', 'limited'], ['synthetic-overload', 'overloaded'], ['synthetic-background', 'background'],
] as const) it(`classifies 2.5.0 ${file} as ${expected}`, () => assert.equal(classifyScreen(fixture(file), settings), expected));
it('never infers idle from an editor while working, retrying, asking, or showing an error', () => {
  for (const screen of ['🌕 · Tip: working\n│ > │', '⠸ Working…\n│ > │', 'Retrying (1/3) · APIProviderQuotaExhaustedError\n│ > │']) assert.equal(classifyScreen(screen, settings), 'working');
  assert.equal(classifyScreen('Error: unknown failure\n│ > │', settings), 'needs-input');
  assert.equal(classifyScreen('', settings), 'needs-input');
  assert.equal(kimi.screen.draft?.('│ > [paste #2 +16 lines]        │'), '[paste #2 +16 lines]');
});
it('treats an error banner as stale once the turn resumed after a re-login (P28)', () => {
  const screen = fixture('synthetic-relogin-idle');
  assert.equal(classifyScreen(screen, settings), 'idle');
  assert.equal(taskState({ alive: true, screen, settings, reportReady: true }), 'report-ready');
  // Nothing but the banner and its continuation before the input box: still waiting for the human.
  assert.equal(classifyScreen('● Error: [internal] Stored token rejected; re-login required.\n   If this persists, run `/export-debug-zip`.\n│ > │', settings), 'needs-input');
});
it('parses only screen plan windows (5h, weekly, monthly) with no fabricated week', () => {
  const now = Date.now(), parsed = parseKimiUsage(fixture('08-usage'), now)!;
  assert.equal(parsed.windows.length, 2);
  assert.deepEqual(parsed.windows.map(w => w.minutes), [300, 43200]);
  assert.deepEqual(parsed.windows.map(w => w.usedPercent), [26, 3]);
  assert.equal(parsed.windows[0]?.resetsAt, Math.floor(now / 1000) + 4860);
  assert.equal(parseKimiUsage('Weekly limit 17% used resets in 1d 2h', now)?.windows[0]?.kind, 'week');
  const w = world('plan'); fs.mkdirSync(path.dirname(kimiPlanFile(w.config)), { recursive: true }); fs.writeFileSync(kimiPlanFile(w.config), JSON.stringify(parsed));
  const plans = readPlans(w.config, new UsageReader(undefined), now);
  assert.equal(plans.kimi?.source, 'kimi-usage-probe'); assert.equal(plans.kimi?.windows[1]?.label, 'month');
  assert.equal(planStatusLine(plans), 'K 26%');
});
it('gates synthetic wire by protocol and counts usage.record only once', () => {
  const stats = emptyStats('kimi'), feed = (o: unknown) => feedKimiLine(stats, JSON.stringify(o));
  feed({ type: 'metadata', protocol_version: '9', cwd: '/wt', session_id: 'S', timestamp: '2026-11-05T00:00:00Z' });
  feed({ type: 'usage.record', inputOther: 100 }); assert.equal(sumBuckets(stats.buckets).input, 0);
  feed({ type: 'metadata', protocol_version: '1.5', cwd: '/wt', session_id: 'S' });
  feed({ type: 'llm.request', model: 'kimi-code/k3', effort: 'high', cli_version: '2.5.0' });
  const record = { type: 'usage.record', id: 'U1', inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
  feed(record); feed(record); feed({ type: 'token_counting.context', inputOther: 999 });
  assert.deepEqual(sumBuckets(stats.buckets), { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  assert.equal(stats.observed?.effort, 'high');
});
it('translates sparse user columns and the light/medium/strong Kimi defaults without disturbing the legacy table', () => {
  assert.equal(defaultEquivalents().length, 6);
  const table = defaultEquivalents(['claude', 'codex', 'kimi']);
  assert.deepEqual(table.map(row => `${row.kimi.model}/${row.kimi.effort}`), ['k3-256k/low', 'k3-256k/low', 'k3/high', 'k3/high', 'k3/max', 'k3/max']);
  for (const row of table) {
    for (const source of ['claude', 'codex'] as const) assert.deepEqual(translate({ agent: source, ...row[source] }, 'kimi', table), { ok: true, order: { agent: 'kimi', ...row.kimi } });
    assert.equal(translate({ agent: 'kimi', ...row.kimi }, 'claude', table).ok, true);
  }
  assert.equal(translate({ agent: 'kimi', model: 'k3.1-pro', effort: 'max' }, 'claude', table).ok, false);
  assert.deepEqual(kimi.models.equivalents, { light: ['k3-256k/low'], medium: ['k3/high'], strong: ['k3/max'] });
  assert.deepEqual(translate({ agent: 'claude', model: 'sonnet', effort: 'high' }, 'kimi', table), { ok: true, order: { agent: 'kimi', model: 'k3', effort: 'high' } });
  const p = new Problems(), custom = parseEquivalents([{ claude: 'special/high', kimi: 'k3/high' }], 'pairs', p, ['claude', 'codex', 'kimi']);
  p.throwIfAny('bad');
  assert.equal(translate({ agent: 'claude', model: 'special', effort: 'high' }, 'codex', custom).ok, false);
});
it('polls synthetic wire incrementally, persists matching delivery evidence and falls back on unknown protocol', async () => {
  const w = world('passive'), wt = path.join(w.root, 'wt'); fs.mkdirSync(wt);
  const now = Date.now(), record = seedTask(w.config, 'PASSIVE', { agent: 'kimi', model: 'k3', effort: 'high', repos: [{ path: w.root, worktree: wt }], started: new Date(now - 1000).toISOString(), pendingPrompt: 'Work', deliveryId: 'D', deliveryStartedAt: new Date(now - 500).toISOString() });
  const dir = path.join(w.home, 'sessions', 'workspace', 'session_S', 'agents', 'main'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl'), at = new Date(now).toISOString();
  const records = [{ type: 'metadata', protocol_version: '1.5', cwd: wt, session_id: 'S', timestamp: at }, { type: 'turn.prompt', prompt: 'Work', timestamp: at }, { type: 'interaction.request', timestamp: at }];
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const { ctx } = makeContext(w.config);
  await kimi.events.poll!(ctx, record);
  const state = path.join(w.config.stateDir, record.window);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'delivery-evidence.json'), 'utf8')).deliveryId, 'D');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'event.json'), 'utf8')).outcome, 'needs-input');
  const cursor = fs.readFileSync(path.join(state, 'kimi-wire-cursor.json'), 'utf8');
  await kimi.events.poll!(ctx, record);
  assert.equal(fs.readFileSync(path.join(state, 'kimi-wire-cursor.json'), 'utf8'), cursor);
  fs.appendFileSync(file, JSON.stringify({ type: 'metadata', protocol_version: '99', cwd: wt, session_id: 'S', timestamp: at }) + '\n' + JSON.stringify({ type: 'turn.ended', timestamp: at }) + '\n');
  await kimi.events.poll!(ctx, record);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'kimi-wire-status.json'), 'utf8')).supported, false);
  assert.equal(fs.existsSync(path.join(state, 'event.json')), false);
});
it('records the start-time CLI version when the 2.5.1 wire omits cli_version, else keeps unknown', async () => {
  for (const [name, agentCliVersion, expected] of [['with-version', '2.5.1', '2.5.1'], ['without-version', undefined, 'unknown']] as const) {
    const w = world(name), wt = path.join(w.root, 'wt'); fs.mkdirSync(wt);
    const now = Date.now(), record = seedTask(w.config, 'CLIVER', { agent: 'kimi', model: 'k3', effort: 'high', ...(agentCliVersion ? { agentCliVersion } : {}), repos: [{ path: w.root, worktree: wt }], started: new Date(now - 1000).toISOString() });
    const dir = path.join(w.home, 'sessions', 'workspace', 'session_S', 'agents', 'main'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.5', cwd: wt, session_id: 'S', time: now },
      { type: 'llm.request', model: 'k3', modelAlias: 'kimi-code/k3', thinkingEffort: 'high', time: now },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    await kimi.events.poll!(makeContext(w.config).ctx, record);
    assert.deepEqual(record.observed, { model: 'kimi-code/k3', effort: 'high', cliVersion: expected });
  }
});
it('extends MCP provider fields only when Kimi is active', async () => {
  const { MCP_TOOLS, providerToolInput } = await import('../src/core/mcp-tools.ts');
  const { z } = await import('zod');
  const w = world('schemas'), off = makeConfig(scratch.sub('schemas-off'));
  for (const name of ['new', 'queue', 'move']) {
    const tool = MCP_TOOLS.find(t => t.name === name)!;
    const onField = providerToolInput(tool, w.config).agent as import('zod').ZodType;
    const offField = providerToolInput(tool, off).agent as import('zod').ZodType;
    assert.equal(onField.safeParse('kimi').success, true);
    assert.equal(offField.safeParse('kimi').success, false);
  }
  for (const name of ['set_limits', 'reserve', 'limits_release']) {
    const tool = MCP_TOOLS.find(t => t.name === name)!;
    assert.equal('kimi' in providerToolInput(tool, off), false);
    assert.equal(z.object(providerToolInput(tool, w.config)).safeParse({ kimi: 2 }).success, true);
  }
});

it('R2 N4: an error below the last ready line still awaits input', () => {
  const screen = fixture('synthetic-error-after-ready');
  assert.equal(classifyScreen(screen, settings), 'needs-input');
  assert.equal(taskState({ alive: true, screen, settings, reportReady: true }), 'needs-input');
  assert.equal(classifyScreen(fixture('synthetic-relogin-idle'), settings), 'idle');
});

it('P48: a trust dialog with a fresh input box below its last trace is history, not needs-trust', () => {
  assert.equal(classifyScreen(fixture('01-zaufanie'), settings), 'needs-trust', 'the open dialog still wins');
  assert.equal(classifyScreen(`${fixture('01-zaufanie')}\n${fixture('02-bezczynny')}`, settings), 'idle', 'answered: the idle screen follows the dialog');
  assert.equal(classifyScreen(`${fixture('01-zaufanie')}\n${fixture('03-praca-1')}`, settings), 'working', 'answered: work follows the dialog');
  // Claude's own dialog keeps its ❯ options above the last trust line: the order rule must not open it.
  const claude = provider('claude').defaultSettings();
  assert.equal(classifyScreen('Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm', claude), 'needs-trust');
});

it('P48 (07.11 dev case): after a trust timeout a stuck not-delivered recovers to sent once Kimi verifiably works, stale dialog text on the frame notwithstanding', async () => {
  const w = world('trust-history');
  const stale = `${fixture('01-zaufanie')}\n  🌑 · Tip: @: mention files\n${fixture('02-bezczynny')}`;
  const record = seedTask(w.config, 'DEVCASE', { agent: 'kimi', model: 'k3', pendingPrompt: 'Original prompt', promptDelivery: 'needs-attention', deliveryResult: 'not-delivered-in-field', deliveryStartedAt: new Date(Date.now() - 60_000).toISOString(), deliveryId: 'D1' });
  const tmux = new FakeTmux(w.config.session);
  tmux.add(record.window, stale);
  const { ctx } = makeContext(w.config, { respond: tmux.respond });
  assert.equal(await deliverPendingPrompt(ctx, record.window), 'sent', 'the working agent below the answered dialog proves the delivery');
  assert.equal(readTaskRecord(w.config, record.window)?.promptDelivery, 'sent');
});
