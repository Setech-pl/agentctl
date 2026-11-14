import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { CLAUDE_COMPOSER_BORDER } from './composer-fixture.ts';
import { PATTERN_FLAGS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { newTasks } from '../src/core/new.ts';
import type { Notifier } from '../src/core/notify.ts';
import { peekTask } from '../src/core/peek.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory, readQueue, retryEntry } from '../src/core/queue.ts';
import { runDoctor } from '../src/core/doctor.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { launchEnvironment } from '../src/core/safety.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { classifyScreen, inputVisible } from '../src/core/state.ts';
import { inspectField } from '../src/core/input-field.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord, taskDir } from '../src/core/taskstore.ts';
import { waitForReady } from '../src/core/ready.ts';
import { Tmux } from '../src/core/tmux.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();

/** Where a failed start saves its last screen (P96). Spelled out here, so this scenario also runs against the release before the fix. */
const startFailureScreenFile = (config: ReturnType<typeof makeConfig>, window: string): string => path.join(taskDir(config, window), 'start-failure-screen.txt');

// The screens of the incident (MAP-SEARCH-BTN-1, 14.11, first glm task on prod), in the order the manual reproduction of its start.sh showed them.
const THEME = ` ▐▛███▜▌   Claude Code v2.1.311

 Let's get started.

 Choose the text style that looks best with your terminal
 To change this later, run /theme

 ❯ ✔ Dark mode
   Light mode
   Dark mode (colorblind-friendly)
   Light mode (colorblind-friendly)

 Syntax theme: Monokai Extended (ctrl+t to disable)
`;
const SECURITY = ` Security notes:

 1. Claude can make mistakes
    You should always review Claude's responses, especially when running code.

 2. Due to prompt injection risks, only use it with code you trust

 Press Enter to continue…
`;
const TRUST = ` Accessing workspace:

 /Users/me/wt/map-search-btn-1

 Quick safety check: Is this a project you created or one you trust?

 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
`;
/** The main screen: the auto-mode banner above the box, the MCP warning under the footer (both informational). */
const MAIN = [' ▐▛███▜▌   Claude Code v2.1.311', '', " Auto mode is now Claude Code's default permission mode.", '', CLAUDE_COMPOSER_BORDER, '❯ Try "how does <filepath> work?"', CLAUDE_COMPOSER_BORDER, '  ▸▸ auto mode on (shift+tab to cycle)', '  ⚠ 1 MCP server needs authentication · run /mcp', ''].join('\n');
const AUTO_MODE_PROMPT = ' Enable auto mode?\n\n ❯ 1. Yes, enable auto mode\n   2. No, keep the current mode\n\n Enter to confirm · Esc to cancel\n';
const LOADING = ' ▐▛███▜▌   Claude Code v2.1.311\n  Loading...\n';

const YAML = 'providers: [claude, codex, glm]\nlimits: {claude: 1, codex: 1, glm: 1}\ncapacity: {snapshot: false, codex_refresh: false}\n';

interface Setup {
  config: ReturnType<typeof makeConfig>;
  repo: string;
  tmux: FakeTmux;
  runner: DiskRunner;
  ctx: Context;
  notified: string[];
  notifier: Notifier;
  memory: QueueMemory;
  tick(): Promise<string[]>;
}

function setup(name: string, extraYaml = ''): Setup {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, `${YAML}${extraYaml}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => tmux.respond(cmd, args, opts) });
  const ctx = new Context(runner, config, () => {});
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const memory = new QueueMemory();
  return { config, repo, tmux, runner, ctx, notified, notifier, memory, async tick() { const began = await queueTick(ctx, memory, notifier, {}); await memory.idle(); return began; } };
}

const specOf = (repo: string, task: string, agent: string): string =>
  `---\ntask: ${task}\nagent: ${agent}\n${agent === 'glm' ? 'model: glm-5.3\n' : ''}repos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n---\nPrompt of ${task}.\n`;

async function add(s: Setup, text: string): Promise<void> {
  const plan = await planQueueAdd(s.ctx, splitSpecs(text, 'test'));
  await commitQueueAdd(s.ctx, plan.items);
}

const pastes = (s: Setup): number => s.runner.commands.filter(c => c.includes('paste-buffer')).length;

describe('P95: first-run onboarding of a fresh Claude config (glm wrapper) is a wait for the owner, not a failed start', () => {
  for (const agent of ['glm', 'claude']) {
    it(`${agent}: theme picker → needs-input with a clear line, notified, window kept; the owner finishes it, trust and the prompt follow by themselves`, async () => {
      const s = setup(`onboarding-${agent}`);
      const task = `ONB-${agent.toUpperCase()}`, window = task.toLowerCase();
      s.tmux.newWindowScreen = THEME;
      // The watcher is up (baseline tick) before the task arrives, as on prod: the transition then notifies.
      const memory = new WatchMemory();
      await watchTick(s.ctx, memory, s.notifier);
      await add(s, specOf(s.repo, task, agent));
      assert.deepEqual(await s.tick(), [task]);

      // Not a failed start: no failed queue entry, no failure journal, the window stays, nothing was pasted into the picker.
      assert.deepEqual(readQueue(s.config), []);
      assert.ok(!readJournal(s.config).some(e => e.kind === 'queue-failed' && e.task === task));
      assert.ok(s.tmux.windows.some(w => w.name === window), 'the window stays for the owner');
      assert.equal(pastes(s), 0);
      const record = readTaskRecord(s.config, window)!;
      assert.equal(record.promptDelivery, 'needs-input');
      assert.match(record.promptError ?? '', new RegExp(`${agent} first-run onboarding – finish it once in the window, F12 back to board`));
      const row = (await collectStatus(s.ctx, { progress: false })).find(r => r.task === task)!;
      assert.equal(row.state, 'needs-input');
      assert.match(row.question ?? '', /first-run onboarding – finish it once in the window, F12 back to board/);
      assert.ok(fs.existsSync(startFailureScreenFile(s.config, window)), 'the screen is saved for the owner');

      await watchTick(s.ctx, memory, s.notifier);
      assert.ok(s.notified.some(m => m.startsWith(`${task}: `) && /first-run onboarding – finish it once in the window, F12 back to board/.test(m)), JSON.stringify(s.notified));
      assert.equal(pastes(s), 0, 'the picker line "❯ ✔ Dark mode" is not the input box');

      // Screen 2: "Security notes … Press Enter to continue…": still the owner's.
      const pane = s.tmux.windows.find(w => w.name.endsWith(window))!;
      pane.screen = SECURITY;
      await watchTick(s.ctx, memory, s.notifier);
      assert.equal(readTaskRecord(s.config, window)?.promptDelivery, 'needs-input');
      assert.equal(pastes(s), 0);

      // Screen 3: folder trust. Onboarding is over, the ordinary start takes over (needs-trust), still nothing pasted.
      pane.screen = TRUST;
      await watchTick(s.ctx, memory, s.notifier);
      assert.equal(readTaskRecord(s.config, window)?.promptDelivery, 'pending');
      assert.equal((await collectStatus(s.ctx, { progress: false })).find(r => r.task === task)?.state, 'needs-trust');
      assert.equal(pastes(s), 0);

      // Screen 4: the main screen (banner + MCP warning are informational): the prompt is delivered once.
      pane.screen = MAIN;
      await watchTick(s.ctx, memory, s.notifier);
      assert.equal(readTaskRecord(s.config, window)?.promptDelivery, 'sent');
      assert.equal(pastes(s), 1);
    });
  }

  it('the theme list line "❯ ✔ Dark mode" is not the ready prompt; the trust and numbered menus never were', () => {
    const { config } = setup('ready-line');
    const claude = config.agents.claude;
    const ready = new RegExp(claude.readyPattern, PATTERN_FLAGS);
    assert.ok(!ready.test(THEME), 'theme picker');
    assert.ok(!ready.test('❯ 1. Dark mode ✔\n  2. Light mode'));
    assert.ok(ready.test(MAIN), 'the real input box still is');
    assert.ok(ready.test('❯ \n'));
    assert.equal(inputVisible(THEME, claude), false);
  });

  it('a start at the picker returns "dialog" from waitForReady at once, and not after ready_timeout', async () => {
    const { config } = setup('wait-ready');
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, a) => cmd === 'tmux' && a[0] === 'capture-pane' ? { stdout: THEME } : undefined });
    const t0 = runner.now();
    const r = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'w', { pattern: config.agents.glm.readyPattern, trustPattern: config.agents.glm.trustPattern, dialogPattern: config.agents.glm.dialogPattern!, timeoutMs: 60_000 });
    assert.deepEqual([r.ready, r.dialog], [false, true]);
    assert.equal(runner.now() - t0, 0);
  });
});

describe('P95/G5: banners are informational, an auto-mode prompt that waits is needs-input', () => {
  it('the auto-mode banner and the MCP authentication warning do not block readiness', async () => {
    const { config } = setup('banners');
    const claude = config.agents.glm;
    assert.equal(classifyScreen(MAIN, claude), 'idle');
    assert.equal(inspectField(MAIN, 'glm').readable, true);
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, a) => cmd === 'tmux' && a[0] === 'capture-pane' ? { stdout: MAIN } : undefined });
    const r = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'w', { pattern: claude.readyPattern, emptyInput: true, structuralComposer: true, agent: 'glm', trustPattern: claude.trustPattern, dialogPattern: claude.dialogPattern!, timeoutMs: 5000 });
    assert.equal(r.ready, true);
  });

  it('an auto-mode selection prompt that waits for input reports needs-input', () => {
    const { config } = setup('auto-prompt');
    assert.equal(classifyScreen(AUTO_MODE_PROMPT, config.agents.glm), 'needs-input');
  });
});

describe('P96: a failed start keeps its window and saves the last screen', () => {
  it('ready timeout: the window stays, start-failure-screen.txt is saved, the failure line, queue_list and peek name it; queue_retry closes the window and starts again', async () => {
    const s = setup('failed-start');
    s.tmux.newWindowScreen = LOADING;
    await add(s, specOf(s.repo, 'FAIL-1', 'glm'));
    assert.deepEqual(await s.tick(), ['FAIL-1']);

    const file = startFailureScreenFile(s.config, 'fail-1');
    const [entry] = readQueue(s.config);
    assert.equal(entry?.status, 'failed');
    assert.match(entry?.error ?? '', /glm did not show its input prompt within 60s/);
    assert.ok((entry?.error ?? '').includes(file), `the failure names the capture: ${entry?.error}`);
    assert.match(entry?.error ?? '', /stays open for diagnosis/);
    assert.ok(s.tmux.windows.some(w => w.name === 'fail-1'), 'the window was NOT closed');
    assert.match(fs.readFileSync(file, 'utf8'), /Loading\.\.\./);
    assert.ok(fs.readFileSync(file, 'utf8').split('\n').length <= 201, 'about the last 200 lines');
    const record = readTaskRecord(s.config, 'fail-1')!;
    assert.equal(record.promptDelivery, 'needs-attention');
    assert.ok((record.promptError ?? '').includes(file), record.promptError ?? '');
    assert.ok(s.notified.some(m => m.includes('FAIL-1') && m.includes(file)), JSON.stringify(s.notified));
    assert.ok(readJournal(s.config).some(e => e.kind === 'queue-failed' && e.task === 'FAIL-1' && e.text.includes('did not show its input prompt')));
    const peek = await peekTask(s.ctx, 'FAIL-1', 10) as Awaited<ReturnType<typeof peekTask>> & { startFailureScreen?: string };
    assert.equal(peek.startFailureScreen, file);

    // queue_retry copes with the still-open window: it closes it (capture kept) and the fresh start gets the name.
    s.tmux.newWindowScreen = MAIN;
    await retryEntry(s.ctx, 'FAIL-1');
    assert.ok(!s.tmux.windows.some(w => w.name === 'fail-1'), 'the failed window was closed by the retry');
    assert.ok(fs.existsSync(file), 'its capture is kept');
    assert.deepEqual(await s.tick(), ['FAIL-1']);
    assert.deepEqual(readQueue(s.config), []);
    assert.equal(readTaskRecord(s.config, 'fail-1')?.promptDelivery, 'sent');
    assert.equal(pastes(s), 1);
  });

  it('start_failure.keep_window: false closes the window at once, the capture stays and peek reads it', async () => {
    const s = setup('failed-close', 'start_failure: {keep_window: false}\n');
    s.tmux.newWindowScreen = LOADING;
    await add(s, specOf(s.repo, 'FAIL-2', 'claude'));
    await s.tick();
    assert.equal(readQueue(s.config)[0]?.status, 'failed');
    assert.ok(!s.tmux.windows.some(w => w.name === 'fail-2'), 'closed');
    const file = startFailureScreenFile(s.config, 'fail-2');
    assert.match(fs.readFileSync(file, 'utf8'), /Loading\.\.\./);
    const peek = await peekTask(s.ctx, 'FAIL-2', 10) as Awaited<ReturnType<typeof peekTask>> & { startFailureScreen?: string };
    assert.equal(peek.startFailureScreen, file);
    assert.ok(peek.lines.some(l => /Loading\.\.\./.test(l)));
  });

  it('keep_window defaults to true and rejects a non-boolean', () => {
    assert.equal(setup('keep-default').config.startFailure, undefined);
    assert.throws(() => makeConfig(scratch.sub('keep-bad'), 'start_failure: {keep_window: maybe}\n'), /start_failure\.keep_window must be a boolean/);
    assert.equal(makeConfig(scratch.sub('keep-off'), 'start_failure: {keep_window: false}\n').startFailure?.keepWindow, false);
  });
});

describe('P95/G3: glm tasks get CLAUDE_CODE_AUTO_MODE_SERVER=0, claude tasks never', () => {
  const launch = async (name: string, agent: 'glm' | 'claude', extraYaml = '') => {
    const s = setup(name, extraYaml);
    s.tmux.newWindowScreen = MAIN;
    const spec = resolveSpec(splitSpecs(specOf(s.repo, 'ENV-1', agent), 'test')[0]!, { config: s.config });
    await newTasks(s.ctx, [spec], { waitTrust: false, noSwitch: true });
    return fs.readFileSync(path.join(taskDir(s.config, 'env-1'), 'start.sh'), 'utf8');
  };

  it('the launch script of a glm task exports it by default; the claude one does not', async () => {
    assert.match(await launch('env-glm', 'glm'), /^export CLAUDE_CODE_AUTO_MODE_SERVER='?0'?$/m);
    assert.doesNotMatch(await launch('env-claude', 'claude'), /CLAUDE_CODE_AUTO_MODE_SERVER/);
  });

  it('providers_config.glm.env overrides it and adds more; the Z.ai endpoint and token stay refused', async () => {
    assert.match(await launch('env-override', 'glm', 'providers_config: {glm: {env: {CLAUDE_CODE_AUTO_MODE_SERVER: "1", OTHER: x}}}\n'), /^export CLAUDE_CODE_AUTO_MODE_SERVER='?1'?$/m);
    assert.throws(() => makeConfig(scratch.sub('env-secret'), 'providers_config: {glm: {env: {ANTHROPIC_AUTH_TOKEN: x}}}\n'), /never sets ANTHROPIC_AUTH_TOKEN/);
  });

  it('launchEnvironment: glm only, in no settings file', () => {
    const { config } = setup('env-unit');
    assert.equal(launchEnvironment(config, { agent: 'glm', model: 'glm-5.3', effort: 'high', task: 'T' }, {}).CLAUDE_CODE_AUTO_MODE_SERVER, '0');
    assert.equal(launchEnvironment(config, { agent: 'claude', model: 'opus', effort: 'high', task: 'T' }, {}).CLAUDE_CODE_AUTO_MODE_SERVER, undefined);
    // The spec's own env wins over the default.
    assert.equal(launchEnvironment(config, { agent: 'glm', model: 'glm-5.3', effort: 'high', task: 'T' }, { CLAUDE_CODE_AUTO_MODE_SERVER: '1' }).CLAUDE_CODE_AUTO_MODE_SERVER, '1');
    // Never persisted into the user's Claude settings.
    assert.ok(!fs.existsSync(path.join(process.env.HOME ?? '', '.claude', 'settings.json')) || !fs.readFileSync(path.join(process.env.HOME ?? '', '.claude', 'settings.json'), 'utf8').includes('CLAUDE_CODE_AUTO_MODE_SERVER'));
  });
});

describe('P95/G4: doctor warns when the glm Claude config dir has not completed onboarding', () => {
  const wrapper = (root: string, body: string): string => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude-glm'), body, { mode: 0o755 });
    return bin;
  };
  const doctor = async (name: string, script: string | undefined, extraYaml = '') => {
    const root = scratch.sub(name);
    const config = makeConfig(root, `${YAML}${extraYaml}`);
    const env = { HOME: root, PATH: script === undefined ? '' : wrapper(root, script) };
    const runner = new RecordingRunner({ respond: (cmd, args) => cmd === 'claude-glm' ? (args[0] === '--version' ? { code: 0, stdout: '2.1.311\n' } : { code: 0, stdout: '--effort' }) : cmd === 'security' ? { code: 0, stdout: 'ok' } : undefined });
    const checks = await runDoctor(runner, () => config, null, process.versions.node, process.platform, root, env);
    return { root, config, line: checks.find(c => c.name === 'glm onboarding')! };
  };

  it('warns with the fix when the wrapper\'s config dir has no completed onboarding', async () => {
    const { line, root: home } = await doctor('doctor-warn', '#!/bin/sh\nexport CLAUDE_CONFIG_DIR="$HOME/.claude-glm"\nexec claude "$@"\n');
    assert.equal(line.status, 'warn');
    assert.ok(line.detail.includes(path.join(home, '.claude-glm')), line.detail);
    assert.match(line.detail, /run claude-glm once in a terminal/);
  });

  it('is ok once .claude.json records hasCompletedOnboarding', async () => {
    const root = scratch.sub('doctor-done');
    fs.mkdirSync(path.join(root, '.claude-glm'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude-glm', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark' }));
    const { line } = await doctor('doctor-done', '#!/bin/sh\nCLAUDE_CONFIG_DIR=$HOME/.claude-glm exec claude "$@"\n');
    assert.equal(line.status, 'ok');
    assert.match(line.detail, /onboarding completed/);
  });

  it('says n/d when the config dir is not determinable, and honours usage.glm_dir', async () => {
    const nd = await doctor('doctor-nd', '#!/bin/sh\nexec claude "$@"\n');
    assert.equal(nd.line.status, 'ok');
    assert.match(nd.line.detail, /^n\/d/);
    const dir = scratch.sub('doctor-glm-dir');
    const configured = await doctor('doctor-glm-dir-cfg', '#!/bin/sh\nexec claude "$@"\n', `usage: {glm_dir: ${dir}}\n`);
    assert.equal(configured.line.status, 'warn');
    assert.ok(configured.line.detail.includes(dir));
  });
});
