import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import { resolveSpec } from '../src/core/spec.ts';
import { newTasks } from '../src/core/new.ts';
import { provider, providerCommand, PROVIDER_IDS } from '../src/core/providers/registry.ts';
import { glm, GLM_MODELS } from '../src/core/providers/glm.ts';
import { launchEnvironment } from '../src/core/safety.ts';
import { planEventWiring } from '../src/core/events.ts';
import { parseClaudeEvent } from '../src/core/providers/claude-events.ts';
import { defaultEquivalents, translate } from '../src/core/equivalents.ts';
import { collectLimits } from '../src/core/limits.ts';
import { queueHolds } from '../src/core/usage-limits.ts';
import { openReader, collectTaskUsage, readPlans as readAllPlans } from '../src/core/usage.ts';
import { handleTap } from '../src/core/usage-tap.ts';
import { glmPlanFile } from '../src/core/providers/claude-usage.ts';
import { claudeProjectName } from '../src/core/usage-sources.ts';
import { secretRedactor } from '../src/core/secret-redaction.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { readTaskRecord, taskDir, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, seedTask, specText, useScratch, FakeTmux, DiskRunner } from './helpers.ts';

const scratch = useScratch();
const GLM_YAML = 'providers: [claude, codex, glm]\ncapacity: {snapshot: false, codex_refresh: false}\n';

function glmWorld(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, `${GLM_YAML}${extraYaml}`);
  return { root, config };
}

/** A fake claude-glm and security on the respond layer: no real binary, no real keychain. */
function fakeBinaries(respond: (cmd: string, args: string[], opts?: ExecOptions) => Partial<ExecResult> | undefined, options: { keychain?: boolean; version?: string } = {}) {
  return (cmd: string, args: string[], opts?: ExecOptions) => {
    if (cmd === 'claude-glm') {
      if (args[0] === '--version') return { code: 0, stdout: `${options.version ?? '2.1.311'}\n` };
      if (args[0] === '--help') return { code: 0, stdout: '  --effort <level>  --model <model>  -c, --config  --remote-control  --append-system-prompt-file\n' };
      return { code: 0, stdout: '' };
    }
    if (cmd === 'security') return options.keychain === false ? { code: 44 } : { code: 0, stdout: 'keychain: entry exists\n' };
    return respond(cmd, args, opts);
  };
}

describe('glm provider registration', () => {
  it('is registered with the claude adapter behaviour and its own identity', () => {
    assert.ok(PROVIDER_IDS.includes('glm'));
    assert.equal(provider('glm'), glm);
    assert.equal(glm.boardLabel, 'gl');
    assert.equal(glm.letter, 'G');
    assert.equal(glm.command, 'claude-glm');
    assert.equal(glm.usage.homeEnv, 'CLAUDE_CONFIG_DIR');
    // Same screen/trust handling as claude: the wrapper shows the Claude Code TUI.
    assert.deepEqual(provider('glm').defaultSettings(), provider('claude').defaultSettings());
    assert.equal(provider('glm').capabilities.remoteControl, false);
    assert.equal(provider('glm').capabilities.statusLineTap, true);
  });

  it('glm argv launches claude-glm with the model and effort', () => {
    const settings = glm.defaultSettings();
    assert.deepEqual(glm.argv({ model: 'glm-5.3', effort: 'high', task: 'T' }, settings, ['--settings', '/tmp/s.json']), ['claude-glm', '--model', 'glm-5.3', '--effort', 'high', '--settings', '/tmp/s.json']);
    assert.deepEqual(glm.argv({ model: 'default', effort: 'low', task: 'T' }, settings, []), ['claude-glm', '--effort', 'low']);
    assert.deepEqual(glm.resumeArgv({ model: 'glm-5.3-flash', effort: 'medium', task: 'T' }, settings, [], 'sid'), ['claude-glm', '--model', 'glm-5.3-flash', '--effort', 'medium', '--resume', 'sid']);
    // The configured command wins (providers_config.glm.command), as it does at launch.
    assert.deepEqual(glm.argv({ model: 'glm-5.3', effort: 'high', task: 'T', command: '/opt/wrapper/claude-glm' }, settings, []), ['/opt/wrapper/claude-glm', '--model', 'glm-5.3', '--effort', 'high']);
    assert.equal(providerCommand({}, 'glm'), 'claude-glm');
    assert.equal(providerCommand({ providersConfig: { glm: { command: '/opt/wrapper/claude-glm' } } }, 'glm'), '/opt/wrapper/claude-glm');
    assert.equal(providerCommand({}, 'claude'), 'claude');
  });
});

describe('glm spec resolution', () => {
  it('maps class: to the glm column of the matrix', () => {
    const { root, config } = glmWorld('class');
    const bugfix = resolveSpec({ index: 1, header: { task: 'GLM-1', agent: 'glm', class: 'bugfix', repos: [{ path: root, worktree: `${root}/wt1` }] }, prompt: 'Fix' }, { config });
    assert.equal(bugfix.model, 'glm-5.3');
    assert.equal(bugfix.effort, 'high');
    const report = resolveSpec({ index: 2, header: { task: 'GLM-2', agent: 'glm', class: 'report', repos: [{ path: root, worktree: `${root}/wt2` }] }, prompt: 'Report' }, { config });
    assert.equal(report.model, 'glm-5.3-flash');
    assert.equal(report.effort, 'low');
  });

  it('rejects a model outside the validated list', () => {
    const { root, config } = glmWorld('bad-model');
    assert.throws(
      () => resolveSpec({ index: 1, header: { task: 'GLM-3', agent: 'glm', model: 'glm-9.9', repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'x' }, { config }),
      /unknown GLM model "glm-9\.9".*glm-5\.3/,
    );
    for (const model of GLM_MODELS) {
      const spec = resolveSpec({ index: 2, header: { task: 'GLM-4', agent: 'glm', model, repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'x' }, { config });
      assert.equal(spec.model, model);
    }
  });

  it('refuses remote_control for glm (Claude-only)', () => {
    const { root, config } = glmWorld('remote');
    assert.throws(
      () => resolveSpec({ index: 1, header: { task: 'GLM-5', agent: 'glm', remote_control: true, repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'x' }, { config }),
      /remote_control: true works for Claude only/,
    );
  });

  it('translates claude <-> glm through the equivalents table', () => {
    const table = defaultEquivalents(['claude', 'codex', 'kimi', 'glm']);
    const toGlm = translate({ agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, 'glm', table);
    assert.deepEqual(toGlm, { ok: true, order: { agent: 'glm', model: 'glm-5.3-flash', effort: 'medium' } });
    const toClaude = translate({ agent: 'glm', model: 'glm-5.3-flash', effort: 'low' }, 'claude', table);
    assert.deepEqual(toClaude, { ok: true, order: { agent: 'claude', model: 'claude-haiku-5-5', effort: 'low' } });
  });
});

describe('glm isolation', () => {
  it('strips ANTHROPIC_* from a glm spec env with a warning, and writes no secret into TASK.md', async () => {
    const { root, config } = glmWorld('isolate');
    const raw = specText({ task: 'GLM-6', agent: 'glm', model: 'glm-5.3', effort: 'high', env: '{ANTHROPIC_BASE_URL: https://api.z.ai/api/anthropic, ANTHROPIC_AUTH_TOKEN: zai-secret-123, APP_X: "1"}' }, root);
    const [spec] = (await import('../src/core/spec.ts')).splitSpecs(raw);
    const resolved = resolveSpec(spec, { config });
    assert.equal(resolved.env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(resolved.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(resolved.env.APP_X, '1');
    assert.ok(resolved.warnings?.some((w) => /ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN removed/.test(w)), JSON.stringify(resolved.warnings));
    // What lands in TASK.md carries neither the names nor the values.
    const record = (await import('../src/core/taskstore.ts')).recordFromSpec(resolved, config, Date.now());
    const taskMd = (await import('../src/core/taskstore.ts')).renderTaskMd(record, resolved.prompt);
    assert.ok(!taskMd.includes('ANTHROPIC_'), taskMd);
    assert.ok(!taskMd.includes('zai-secret-123'));
  });

  it('glm launch env gets only what the wrapper does; a claude task env stays unchanged', () => {
    const { config } = glmWorld('launch-env', 'agents:\n  glm:\n    env: {ANTHROPIC_AUTH_TOKEN: from-settings, OTHER: kept}\n');
    const glmEnv = launchEnvironment(config, { agent: 'glm', model: 'glm-5.3', effort: 'high', task: 'T' }, { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_API_KEY: 'k', KEEP: 'yes' });
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) assert.equal(glmEnv[name], undefined, name);
    assert.equal(glmEnv.OTHER, 'kept');
    assert.equal(glmEnv.KEEP, 'yes');
    assert.equal(glmEnv.CLAUDE_CONFIG_DIR, provider('glm').usage.home(config, glmEnv));
    // A claude task keeps its environment exactly as configured: agentctl adds nothing, removes nothing.
    const claudeEnv = launchEnvironment(config, { agent: 'claude', model: 'opus', effort: 'high', task: 'T' }, { ANTHROPIC_BASE_URL: 'https://gateway.example' });
    assert.equal(claudeEnv.ANTHROPIC_BASE_URL, 'https://gateway.example');
  });

  it('redacts the Anthropic/Z.ai variable values from captured output', () => {
    const redact = secretRedactor([{ env: { ANTHROPIC_AUTH_TOKEN: 'zai-secret-123', ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' } }]);
    const text = 'export ANTHROPIC_AUTH_TOKEN=zai-secret-123\nbase=https://api.z.ai/api/anthropic done';
    const clean = redact(text);
    assert.ok(!clean.includes('zai-secret-123'), clean);
    assert.ok(!clean.includes('https://api.z.ai/api/anthropic'), clean);
    assert.ok(clean.includes('ANTHROPIC_AUTH_TOKEN=***'), clean);
  });
});

describe('glm launch', () => {
  it('starts claude-glm with the model and records the provider as glm', async () => {
    const { root, config } = glmWorld('launch');
    const tmux = new FakeTmux(config.session);
    const { ctx } = makeContext(config, { respond: fakeBinaries(tmux.respond) });
    const spec = resolveSpec({ index: 1, header: { task: 'GLM-7', agent: 'glm', model: 'glm-5.3', effort: 'high', repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'Work' }, { config });
    const [result] = await newTasks(ctx, [spec], { waitTrust: false, noSwitch: true, self: ['/usr/bin/node', '/agentctl.js'] });
    assert.equal(result.agentStarted, true);
    const start = fs.readFileSync(path.join(taskDir(config, 'glm-7'), 'start.sh'), 'utf8');
    assert.match(start, /exec claude-glm --model glm-5\.3 --effort high/);
    assert.ok(!start.includes('ANTHROPIC_'), start);
    const record = readTaskRecord(config, 'glm-7')!;
    assert.equal(record.agent, 'glm');
    assert.equal(record.model, 'glm-5.3');
    assert.equal(record.agentCliVersion, '2.1.311');
    // The event hooks are wired for glm, with the glm settings file and the glm event agent.
    const settingsFile = path.join(taskDir(config, 'glm-7'), 'glm-settings.json');
    const wiring = fs.readFileSync(settingsFile, 'utf8');
    assert.match(wiring, /event --task GLM-7 --agent glm --kind notification/);
    assert.match(wiring, /usage-tap --task GLM-7 --agent glm/);
    assert.ok(!wiring.includes('ANTHROPIC_'), wiring);
    // The status line tap of the glm window records the glm session under glm, never claude.
    assert.ok(fs.existsSync(settingsFile));
  });

  it('honours providers_config.glm.command', async () => {
    const { root, config } = glmWorld('custom-command', 'providers_config: {glm: {command: /opt/wrapper/claude-glm}}\n');
    const tmux = new FakeTmux(config.session);
    const { ctx } = makeContext(config, { respond: (cmd, args, opts) => cmd === '/opt/wrapper/claude-glm' ? { code: 0, stdout: '2.1.311\n' } : fakeBinaries(tmux.respond)(cmd, args, opts) });
    const spec = resolveSpec({ index: 1, header: { task: 'GLM-8', agent: 'glm', model: 'glm-5.3-flash', effort: 'low', repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'Work' }, { config });
    await newTasks(ctx, [spec], { waitTrust: false, noSwitch: true });
    const start = fs.readFileSync(path.join(taskDir(config, 'glm-8'), 'start.sh'), 'utf8');
    assert.match(start, /exec \/opt\/wrapper\/claude-glm --model glm-5\.3-flash --effort low/);
  });

  it('waits for a human at the folder-trust dialog like claude (never answers it)', async () => {
    const { root, config } = glmWorld('trust', 'agents:\n  glm:\n    trust_timeout: 1\n');
    const tmux = new FakeTmux(config.session);
    tmux.newWindowScreen = 'Quick safety check\n\nDo you trust the files in this folder?\n\n❯ 1. Yes, I trust this folder\n  2. No\n';
    const { ctx } = makeContext(config, { respond: fakeBinaries(tmux.respond) });
    const spec = resolveSpec({ index: 1, header: { task: 'GLM-9', agent: 'glm', model: 'glm-5.3', effort: 'high', repos: [{ path: root, worktree: `${root}/wt` }] }, prompt: 'Work' }, { config });
    await assert.rejects(newTasks(ctx, [spec], { noSwitch: true }), /trust/);
    // agentctl never answered the dialog: the only keys sent were the launch command itself, and no prompt was pasted.
    assert.ok(!tmux.seen.some((line) => line.startsWith('paste-buffer')), tmux.seen.join('\n'));
    assert.ok(tmux.seen.filter((line) => line.startsWith('send-keys')).every((line) => line === 'send-keys @1'), tmux.seen.join('\n'));
  });
});

describe('glm limits and usage', () => {
  it('has its own limit key, default 2, separate from the Claude account limit', () => {
    const { config } = glmWorld('limits');
    assert.equal(config.limits.glm, 2);
    assert.equal(config.limits.claude, undefined);
    assert.equal(makeConfig(scratch.sub('limits-5'), `${GLM_YAML}limits: {glm: 5}\n`).limits.glm, 5);
    assert.equal(makeConfig(scratch.sub('limits-0'), `${GLM_YAML}limits: {glm: 0}\n`).limits.glm, undefined);
    assert.equal(makeConfig(scratch.sub('limits-off'), `${GLM_YAML}limits: {glm: off}\n`).limits.glm, 'off');
    // Inactive glm produces a warning about its settings, like kimi.
    const inactive = makeConfig(scratch.sub('limits-inactive'), 'limits: {glm: 5}\nusage: {queue_hold: {glm: 90}}\n');
    assert.ok(inactive.warnings?.some((w) => /glm is not in providers/.test(w)), JSON.stringify(inactive.warnings));
  });

  it('collectLimits reports glm as its own provider row', () => {
    const { config } = glmWorld('collect');
    const report = collectLimits(config, []);
    const glmRow = report.providers.find((p) => p.agent === 'glm');
    assert.ok(glmRow);
    assert.equal(glmRow.limit, 2);
    assert.equal(glmRow.used, 0);
    assert.ok(report.providers.some((p) => p.agent === 'claude'));
  });

  it('usage.queue_hold accepts a glm key but never holds glm while its plan is n/d', () => {
    const { config } = glmWorld('hold', 'usage: {queue_hold: {glm: 90}}\n');
    assert.equal(config.usage.queueHold.glm, 90);
    const now = Date.now();
    const reader = openReader(config);
    const plans = readAllPlans(config, reader, now);
    const glmPlan = plans.glm!;
    assert.equal(glmPlan.available, false);
    assert.match(glmPlan.note, /Z\.ai exposes no documented quota endpoint/);
    assert.deepEqual(queueHolds(config, now, plans), {});
    reader.save();
  });

  it('warn/critical defaults include glm when active', () => {
    const { config } = glmWorld('warn');
    assert.equal(config.usage.warn.glm, 80);
    assert.equal(config.usage.critical.glm, 95);
  });

  it('accounts tokens separately per provider from the session logs', () => {
    const { root, config } = glmWorld('tokens');
    const now = Date.now();
    const line = (id: string, model: string, input: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(now).toISOString(), sessionId: id, cwd: `${root}/${id}`, message: { id: `m-${id}`, model, usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
    const glmHome = provider('glm').usage.home(config);
    const claudeHome = provider('claude').usage.home(config);
    assert.notEqual(glmHome, claudeHome, 'the test worlds use different homes');
    const glmRecord = seedTask(config, 'GLM-T', { agent: 'glm', model: 'glm-5.3', repos: [{ path: root, worktree: `${root}/g` }] });
    const claudeRecord = seedTask(config, 'CLAUDE-T', { agent: 'claude', model: 'opus', repos: [{ path: root, worktree: `${root}/c` }] });
    for (const [home, id, model, input] of [[glmHome, 'g', 'glm-5.3', 100], [claudeHome, 'c', 'claude-opus-5-5', 7]] as const) {
      const dir = path.join(home, 'projects', claudeProjectName(`${root}/${id}`));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${line(id, model, input)}\n`);
    }
    const usage = collectTaskUsage(config, openReader(config), [glmRecord, claudeRecord], now + 1);
    assert.equal(usage.get('GLM-T')?.total.input, 100);
    assert.equal(usage.get('CLAUDE-T')?.total.input, 7);
    assert.equal(usage.get('GLM-T')?.observed?.model, 'glm-5.3');
  });

  it('the glm statusLine tap writes glm-plan.json, never the claude plan file', async () => {
    const { config } = glmWorld('tap');
    const runner = new DiskRunner({ dryRun: false });
    const payload = JSON.stringify({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 42, resets_at: null }, seven_day: { used_percentage: 10, resets_at: null } } });
    const result = await handleTap(runner, config, { agent: 'glm', task: 'GLM-7', window: 'glm-7', raw: payload });
    assert.equal(result.stored, true);
    const glmPlan = JSON.parse(fs.readFileSync(glmPlanFile(config), 'utf8'));
    assert.equal(glmPlan.windows[0].usedPercent, 42);
    assert.ok(!fs.existsSync(path.join(path.dirname(glmPlanFile(config)), 'claude-plan.json')), 'the claude plan file is untouched');
    const { readGlmPlan } = await import('../src/core/providers/glm.ts');
    const plan = readGlmPlan(config, openReader(config), Date.now());
    assert.equal(plan.available, true);
    assert.equal(plan.source, 'glm-statusline');
    assert.equal(plan.maxPercent, 42);
  });
});

describe('glm events', () => {
  it('wires hooks that report as glm and parses them with the glm agent', () => {
    const { config } = glmWorld('events');
    const wiring = planEventWiring({ agent: 'glm', task: 'GLM-7', window: 'glm-7', config, self: ['/usr/bin/node', '/agentctl.js'], env: {} });
    assert.equal(wiring.files.length, 1);
    assert.ok(wiring.files[0]!.path.endsWith('glm-settings.json'));
    assert.match(wiring.files[0]!.content, /event --task GLM-7 --agent glm --kind session-start/);
    assert.deepEqual(wiring.args, ['--settings', wiring.files[0]!.path]);
    const event = parseClaudeEvent('stop', { last_assistant_message: 'done' }, 'glm');
    assert.equal(event.agent, 'glm');
    assert.equal(event.outcome, 'turn-complete');
    const viaAdapter = provider('glm').events.parse({ kind: 'stop', payload: { last_assistant_message: 'done' } });
    assert.equal(viaAdapter?.agent, 'glm');
    assert.equal(parseClaudeEvent('stop', { last_assistant_message: 'x' }).agent, 'claude');
  });
});

describe('glm doctor', () => {
  const run = async (name: string, options: { keychain?: boolean; wrapper?: boolean }) => {
    const { config } = glmWorld(name, options.wrapper === false ? '' : '');
    const runner = new RecordingRunner({
      respond: (cmd, args) => {
        if (cmd === 'claude-glm') return options.wrapper === false ? { code: 1, stderr: 'not found' } : fakeBinaries(() => undefined)(cmd, args);
        if (cmd === 'security') return options.keychain === false ? { code: 44 } : { code: 0, stdout: 'metadata only\n' };
        return undefined;
      },
    });
    return runDoctor(runner, () => config, null, process.versions.node, process.platform, process.env.HOME ?? '', {});
  };
  it('checks claude-glm on PATH and the Keychain item existence (never the secret)', async () => {
    const checks = await run('doctor-ok', {});
    const glmLine = checks.find((c) => c.name === 'glm');
    assert.equal(glmLine?.status, 'ok');
    assert.match(glmLine?.detail ?? '', /claude-glm/);
    if (process.platform === 'darwin') {
      const keychain = checks.find((c) => c.name === 'glm keychain');
      assert.equal(keychain?.status, 'ok');
      assert.match(keychain?.detail ?? '', /neon-city-zai/);
      assert.ok(!JSON.stringify(checks).includes('zai-secret'), 'no secret value anywhere in doctor output');
    }
  });
  it('warns when the wrapper is missing or the Keychain item does not exist', async () => {
    const noKeychain = await run('doctor-nokey', { keychain: false });
    if (process.platform === 'darwin') assert.equal(noKeychain.find((c) => c.name === 'glm keychain')?.status, 'warn');
    const noWrapper = await run('doctor-nowrapper', { wrapper: false });
    assert.equal(noWrapper.find((c) => c.name === 'glm')?.status, 'warn');
    assert.match(noWrapper.find((c) => c.name === 'glm')?.detail ?? '', /claude-glm/);
  });
  it('reports the glm plan as n/d with the Z.ai quota finding', async () => {
    const checks = await run('doctor-usage', {});
    const usage = checks.find((c) => c.name === 'glm usage');
    assert.equal(usage?.status, 'ok');
    assert.match(usage?.detail ?? '', /n\/d.*Z\.ai documents no quota endpoint/s);
  });
});
