import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAgentArgv, agentCommandLine, promptWithHeader } from '../src/core/agents.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { findAutoAcceptFlag } from '../src/core/safety.ts';
import { Tmux } from '../src/core/tmux.ts';

function setup(screens: string[]) {
  let i = 0;
  const runner = new RecordingRunner({
    dryRun: false,
    respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'capture-pane' ? { stdout: screens[Math.min(i++, screens.length - 1)] as string } : undefined),
  });
  return { runner, tmux: new Tmux(runner, 'agentctl'), captures: () => runner.queries.length };
}

describe('waitForReady', () => {
  it('polls successive screens until the pattern appears', async () => {
    const { runner, tmux, captures } = setup(['', 'Starting Claude Code...', 'Do you trust this folder?', 'Welcome\n> \n? for shortcuts']);
    const t0 = runner.now();
    const result = await waitForReady(runner, tmux, 'nc-1', { pattern: '\\? for shortcuts', timeoutMs: 10_000, intervalMs: 500 });
    assert.equal(result.ready, true);
    assert.match(result.screen, /for shortcuts/);
    assert.equal(captures(), 4);
    assert.equal(runner.now() - t0, 1500, 'three sleeps of 500ms between four captures');
  });

  it('times out when the pattern never shows up and returns the last screen', async () => {
    const { runner, tmux, captures } = setup(['loading', 'still loading']);
    const t0 = runner.now();
    const result = await waitForReady(runner, tmux, 'nc-1', { pattern: 'ready', timeoutMs: 2000, intervalMs: 500 });
    assert.deepEqual(result, { ready: false, trust: false, screen: 'still loading' });
    assert.equal(captures(), 5);
    assert.equal(runner.now() - t0, 2000);
  });

  it('keeps polling when capture-pane fails (window not up yet)', async () => {
    let calls = 0;
    const runner = new RecordingRunner({
      dryRun: false,
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'capture-pane' ? (calls++ < 2 ? { code: 1 } : { stdout: 'ready now' }) : undefined),
    });
    const result = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'nc-1', { pattern: 'ready', timeoutMs: 5000 });
    assert.equal(result.ready, true);
    assert.equal(calls, 3);
  });

  it('does not poll in a dry run', async () => {
    const runner = new RecordingRunner();
    const result = await waitForReady(runner, new Tmux(runner, 'agentctl'), 'nc-1', { pattern: 'x', timeoutMs: 1000 });
    assert.equal(result.ready, true);
    assert.equal(runner.queries.length, 0);
    assert.match(runner.notes[0] as string, /poll .* until \/x\/ matches/);
  });
});

describe('agent command lines', () => {
  const claude = DEFAULT_AGENT_SETTINGS.claude;
  const codex = DEFAULT_AGENT_SETTINGS.codex;

  it('claude: --model and --effort', () => {
    assert.equal(agentCommandLine(buildAgentArgv({ agent: 'claude', model: 'opus', effort: 'high' }, claude)), 'claude --model opus --effort high');
    assert.equal(agentCommandLine(buildAgentArgv({ agent: 'claude', model: 'default', effort: 'low' }, claude)), 'claude --effort low');
  });

  it('codex: danger-full-access sandbox, -m only for a non-default model, effort through -c', () => {
    assert.equal(
      agentCommandLine(buildAgentArgv({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, codex)),
      'codex --sandbox danger-full-access -m gpt-6.1-sol -c model_reasoning_effort=medium',
    );
    assert.equal(
      agentCommandLine(buildAgentArgv({ agent: 'codex', model: 'default', effort: 'high' }, codex)),
      'codex --sandbox danger-full-access -c model_reasoning_effort=high',
    );
  });

  it('effort_args can be emptied for agent versions without an effort flag', () => {
    assert.equal(agentCommandLine(buildAgentArgv({ agent: 'claude', model: 'opus', effort: 'high' }, { ...claude, effortArgs: [] })), 'claude --model opus');
  });

  it('every prompt starts with the model/effort line', () => {
    assert.equal(promptWithHeader({ model: 'opus', effort: 'high', prompt: 'Do it.' }), 'Model: opus · effort high\n\nDo it.');
  });
});

describe('auto-accept guard', () => {
  it('finds flags that would remove the human from the loop', () => {
    for (const args of [
      ['--dangerously-skip-permissions'],
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['--yolo'],
      ['--full-auto'],
      ['--permission-mode', 'bypassPermissions'],
      ['--permission-mode=acceptEdits'],
      ['-a', 'never'],
      ['--ask-for-approval=never'],
      ['-c', 'approval_policy="never"'],
    ]) {
      assert.ok(findAutoAcceptFlag(args), `should flag ${args.join(' ')}`);
    }
  });

  it('lets harmless flags through', () => {
    for (const args of [['--verbose'], ['--permission-mode', 'plan'], ['-a', 'on-request'], ['-c', 'model_reasoning_effort=high']]) {
      assert.equal(findAutoAcceptFlag(args), undefined, args.join(' '));
    }
  });
});
