import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { newTasks } from '../src/core/new.ts';
import type { NewOptions } from '../src/core/new.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { Tmux } from '../src/core/tmux.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();

// Claude Code 2.1.309 screens, trimmed (the dialog was captured live in a fresh git worktree).
const TRUST = ` Accessing workspace:
 /Users/me/wt/app-nc-1
 Quick safety check: Is this a project you created or one you trust?
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;
const LOADING = ' ▐▛███▛█   Claude Code v2.1.309\n  Loading...';
const IDLE = ' ▐▛███▛█   Claude Code v2.1.309\n────\n❯ Try "how does <filepath> work?"\n────\n  ⏵⏵ auto mode on';

/** Answers `capture-pane` per window from a script of screens (the last one repeats); a missing session means a fresh machine. */
function machine(script: Record<string, string[]>, onCapture?: (window: string, n: number) => void) {
  const seen: Record<string, number> = {};
  return (cmd: string, a: string[]) => {
    if (cmd !== 'tmux') return undefined;
    if (a[0] === 'has-session' || a[0] === 'list-windows') return { code: 1 };
    if (a[0] !== 'capture-pane') return undefined;
    const window = a[a.indexOf('-t') + 1]!.split(':').pop()!;
    const n = (seen[window] = (seen[window] ?? 0) + 1);
    onCapture?.(window, n);
    const screens = script[window] ?? [IDLE];
    return { stdout: screens[Math.min(n - 1, screens.length - 1)] as string };
  };
}

function specsFor(config: ReturnType<typeof makeConfig>, repo: string, tasks: string[]) {
  const text = tasks
    .map((t) => `---\ntask: ${t}\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${t.toLowerCase()}}\n---\nPrompt for ${t}.\n`)
    .join('');
  return splitSpecs(text).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));
}

const pastes = (commands: string[]): string[] => commands.filter((c) => c.includes('paste-buffer'));

describe('new: waiting for folder trust', () => {
  it('prints the attach hint once, keeps polling, and pastes the prompt when the dialog is gone and the agent is ready', async () => {
    const root = scratch.sub('wait');
    const repo = scratch.sub('wait/app');
    const config = makeConfig(root);
    const { ctx, runner, out } = makeContext(config, { respond: machine({ 'nc-1': [LOADING, TRUST, TRUST, TRUST, LOADING, IDLE] }) });
    const t0 = runner.now();
    const results = await newTasks(ctx, specsFor(config, repo, ['NC-1']));
    assert.equal(results.length, 1);
    const hints = out.filter((l) => l.includes('waits for folder trust'));
    assert.deepEqual(hints, ['NC-1: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-1']);
    assert.ok(runner.now() - t0 >= 2500, 'it slept 500ms between captures instead of giving up');
    assert.equal(pastes(runner.commands).length, 1);
    assert.ok(out.includes('NC-1: prompt sent'));
    // Only the agent start command (+ its Enter) and the prompt paste (+ its Enter) were typed: the dialog was never answered.
    const keys = runner.commands.filter((c) => c.startsWith('tmux send-keys'));
    assert.deepEqual(keys, ["tmux send-keys -t =agentctl:nc-1 -l -- 'claude --effort high'", 'tmux send-keys -t =agentctl:nc-1 Enter', 'tmux send-keys -t =agentctl:nc-1 Enter']);
    assert.ok(runner.commands.indexOf(pastes(runner.commands)[0]!) > runner.commands.findIndex((c) => c.includes("'claude")));
  });

  it('gives the agent its ready timeout again once the dialog is answered', async () => {
    const root = scratch.sub('rearm');
    const config = makeConfig(root, 'agents:\n  claude: {ready_timeout: 2, trust_timeout: 10}\n');
    const runner = new RecordingRunner({ dryRun: false, respond: machine({ w: [TRUST, TRUST, TRUST, TRUST, TRUST, TRUST, LOADING] }) });
    const t0 = runner.now();
    const r = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'w', {
      pattern: config.agents.claude.readyPattern,
      trustPattern: config.agents.claude.trustPattern,
      timeoutMs: config.agents.claude.readyTimeout * 1000,
      waitTrust: { timeoutMs: config.agents.claude.trustTimeout * 1000, onWaiting: () => {} },
    });
    assert.deepEqual([r.ready, r.trust], [false, false], 'never became ready, and the dialog is gone');
    assert.equal(runner.now() - t0, 3000 + 2000, '3s with the dialog up, then ready_timeout (2s) from the moment it went away, not the 10s trust timeout');
  });

  it('times out after trust_timeout, leaves the window open and says how to send the prompt', async () => {
    const root = scratch.sub('timeout');
    const repo = scratch.sub('timeout/app');
    const config = makeConfig(root, 'agents:\n  claude: {trust_timeout: 3}\n');
    const { ctx, runner } = makeContext(config, { respond: machine({ 'nc-1': [TRUST] }) });
    const t0 = runner.now();
    await assert.rejects(newTasks(ctx, specsFor(config, repo, ['NC-1'])), (e: Error & { hint?: string }) => {
      assert.equal(e.message, 'NC-1: agent still waits for folder trust after 3s – attach: tmux attach -t agentctl, confirm in window nc-1');
      assert.match(e.hint ?? '', /never answers that dialog/);
      assert.match(e.hint ?? '', new RegExp(`agentctl send ${path.join(config.cache, 'nc-1', 'TASK.md')}`));
      assert.match(e.hint ?? '', /raise agents\.claude\.trust_timeout/);
      return true;
    });
    assert.equal(runner.now() - t0, 3000);
    assert.equal(pastes(runner.commands).length, 0);
    assert.ok(!runner.commands.some((c) => c.includes('kill-window')));
  });

  it('--no-wait-trust (waitTrust: false) stops at the dialog without waiting', async () => {
    const root = scratch.sub('nowait');
    const repo = scratch.sub('nowait/app');
    const config = makeConfig(root);
    const { ctx, runner, out } = makeContext(config, { respond: machine({ 'nc-1': [TRUST, TRUST, IDLE] }) });
    const t0 = runner.now();
    await assert.rejects(newTasks(ctx, specsFor(config, repo, ['NC-1']), { waitTrust: false }), (e: Error) => e.message === 'NC-1: agent waits for folder trust – attach: tmux attach -t agentctl, confirm, then agentctl status');
    assert.equal(runner.now() - t0, 0);
    assert.equal(pastes(runner.commands).length, 0);
    assert.deepEqual(out.filter((l) => l.includes('confirm in window')), []);
  });

  it('Ctrl-C ends the wait, keeps the window, and prints the send command; later specs are not started', async () => {
    const root = scratch.sub('abort');
    const repo = scratch.sub('abort/app');
    const config = makeConfig(root);
    const controller = new AbortController();
    const { ctx, runner } = makeContext(config, { respond: machine({ 'nc-1': [TRUST] }, (_w, n) => n === 3 && controller.abort()) });
    const options: NewOptions = { signal: controller.signal };
    await assert.rejects(newTasks(ctx, specsFor(config, repo, ['NC-1', 'NC-2', 'NC-3']), options), (e: Error & { hint?: string }) => {
      assert.equal(e.message, 'NC-1: interrupted while waiting for the agent; window agentctl:nc-1 stays open, the prompt was not sent, not started: NC-2, NC-3');
      assert.equal(e.hint, `Once the agent shows its input, deliver the prompt with: agentctl send ${path.join(config.cache, 'nc-1', 'TASK.md')}`);
      return true;
    });
    assert.equal(pastes(runner.commands).length, 0);
    assert.ok(!runner.commands.some((c) => c.includes('kill-window')));
    assert.ok(!runner.commands.some((c) => c.includes('worktree add') && c.includes('nc-2')), 'NC-2 was not started');
  });

  it('several specs in one file: each is waited for in turn, the prompt of each goes out after its own dialog', async () => {
    const root = scratch.sub('many');
    const repo = scratch.sub('many/app');
    const config = makeConfig(root);
    const order: string[] = [];
    const respond = machine({ 'nc-1': [TRUST, TRUST, IDLE], 'nc-2': [IDLE], 'nc-3': [LOADING, TRUST, IDLE] }, (w, n) => order.push(`${w}#${n}`));
    const { ctx, runner, out } = makeContext(config, { respond });
    const results = await newTasks(ctx, specsFor(config, repo, ['NC-1', 'NC-2', 'NC-3']));
    assert.deepEqual(results.map((r) => r.task), ['NC-1', 'NC-2', 'NC-3']);
    assert.deepEqual(out.filter((l) => l.includes('confirm in window')), [
      'NC-1: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-1',
      'NC-3: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-3',
    ]);
    assert.deepEqual(order, ['nc-1#1', 'nc-1#2', 'nc-1#3', 'nc-2#1', 'nc-3#1', 'nc-3#2', 'nc-3#3']);
    assert.deepEqual(pastes(runner.commands), ['nc-1', 'nc-2', 'nc-3'].map((w) => `tmux paste-buffer -p -d -b agentctl-${w} -t =agentctl:${w}`));
    const sent = out.filter((l) => l.endsWith('prompt sent'));
    assert.deepEqual(sent, ['NC-1: prompt sent', 'NC-2: prompt sent', 'NC-3: prompt sent']);
  });

  it('a dry run mentions the wait and does not poll', async () => {
    const root = scratch.sub('dry');
    const repo = scratch.sub('dry/app');
    const config = makeConfig(root);
    const dry = makeContext(config, { dryRun: true });
    await newTasks(dry.ctx, specsFor(config, repo, ['NC-1']));
    assert.ok(dry.runner.notes.some((n) => /folder-trust dialog, keep polling \(up to 600s\)/.test(n)));
    assert.equal(dry.runner.queries.length > 0, true);
    const off = makeContext(config, { dryRun: true });
    await newTasks(off.ctx, specsFor(config, repo, ['NC-1']), { waitTrust: false });
    assert.ok(!off.runner.notes.some((n) => /folder-trust dialog/.test(n)));
  });
});

describe('trust_timeout config', () => {
  it('defaults to 600 seconds and is read per agent', () => {
    const root = scratch.sub('cfg');
    assert.equal(makeConfig(root).agents.codex.trustTimeout, 600);
    const c = makeConfig(scratch.sub('cfg2'), 'agents:\n  codex: {trust_timeout: 90}\n');
    assert.equal(c.agents.codex.trustTimeout, 90);
    assert.equal(c.agents.claude.trustTimeout, 600);
  });

  it('rejects a non-positive value', () => {
    const root = scratch.sub('cfg3');
    assert.throws(() => makeConfig(root, 'agents:\n  claude: {trust_timeout: 0}\n'), /trust_timeout must be a positive number of seconds/);
  });
});

describe('agentctl new: --no-wait-trust and Ctrl-C through the CLI', () => {
  function run(argv: string[], deps: Partial<CliDeps>, runner: RecordingRunner, config: ReturnType<typeof makeConfig>) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const full: CliDeps = {
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
      readStdin: () => '',
      stdinIsTTY: false,
      loadConfig: () => config,
      confirm: undefined,
      makeRunner: () => runner,
      readClipboard: async () => '',
      watchCommand: () => 'agentctl watch',
      ...deps,
    };
    return main(argv, full).then((code) => ({ code, stdout: stdout.join(''), stderr: stderr.join('') }));
  }

  it('without the flag it waits; with --no-wait-trust it stops at the dialog', async () => {
    const root = scratch.sub('cli');
    const repo = scratch.sub('cli/app');
    const config = makeConfig(root);
    const spec = path.join(root, 'spec.md');
    fs.writeFileSync(spec, `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nGo.\n`);

    const waiting = new RecordingRunner({ dryRun: false, respond: machine({ 'nc-1': [TRUST, IDLE] }) });
    const a = await run(['new', spec], {}, waiting, config);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /NC-1: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-1/);
    assert.equal(pastes(waiting.commands).length, 1);

    const stopping = new RecordingRunner({ dryRun: false, respond: machine({ 'nc-1': [TRUST, IDLE] }) });
    const b = await run(['new', '--no-wait-trust', spec], {}, stopping, config);
    assert.equal(b.code, 1);
    assert.match(b.stderr, /agent waits for folder trust – attach: tmux attach -t agentctl, confirm, then agentctl status/);
    assert.equal(pastes(stopping.commands).length, 0);
  });

  it('Ctrl-C (the interrupt signal) prints the send command and exits non-zero; the signal handler is released', async () => {
    const root = scratch.sub('cli2');
    const repo = scratch.sub('cli2/app');
    const config = makeConfig(root);
    const spec = path.join(root, 'spec.md');
    fs.writeFileSync(spec, `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nGo.\n`);
    const controller = new AbortController();
    let disposed = 0;
    const runner = new RecordingRunner({ dryRun: false, respond: machine({ 'nc-1': [TRUST] }, (_w, n) => n === 2 && controller.abort()) });
    const r = await run(['new', spec], { interruptSignal: () => ({ signal: controller.signal, dispose: () => void disposed++ }) }, runner, config);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: NC-1: interrupted while waiting for the agent; window agentctl:nc-1 stays open/);
    assert.match(r.stderr, new RegExp(`hint: Once the agent shows its input, deliver the prompt with: agentctl send ${path.join(config.cache, 'nc-1', 'TASK.md')}`));
    assert.equal(disposed, 1);
    assert.equal(pastes(runner.commands).length, 0);
  });
});
