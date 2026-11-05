import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { checkRetryWorktrees } from '../src/core/git.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { collectStatus } from '../src/core/status.ts';
import { parseKimiEvent } from '../src/core/providers/kimi-events.ts';
import { provider, matchesProviderCommand } from '../src/core/providers/registry.ts';
import { taskState } from '../src/core/state.ts';
import { readStoredEvent } from '../src/core/event-command.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();

for (const command of ['kimi', '/opt/homebrew/bin/kimi', 'node /opt/lib/kimi-code/dist/main.mjs', '/opt/homebrew/bin/node /opt/lib/@moonshot-ai/kimi-code/dist/main.mjs', 'claude', '/bin/claude --continue', 'codex', 'git status']) {
  it(`F1 refuses retry before launch for live process: ${command}`, async () => {
    const root = scratch.sub(`guard-${command.replaceAll(/\W/g, '_')}`), wt = path.join(root, 'wt'); fs.mkdirSync(wt);
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args) => {
      if (cmd === 'ps') return { stdout: `123 ${command}\n` };
      if (cmd.endsWith('lsof')) return { stdout: `p123\nn${wt}\n` };
      if (args.includes('status')) return { stdout: '' };
      if (args.includes('--git-path')) return { stdout: path.join(wt, 'index.lock') };
      if (args.includes('symbolic-ref')) return { code: 1 };
      if (args.includes('--verify')) return { stdout: wt };
      return { stdout: args.includes('list') ? `worktree ${wt}\n` : wt };
    } });
    await assert.rejects(checkRetryWorktrees(runner, [{ path: root, worktree: wt }]), /unsafe start residue.*process still running/);
    assert.ok(!runner.commands.some(c => /new-window|worktree add|send-keys/.test(c)));
  });
}
it('F1/F3 keep both legacy detection patterns byte-equivalent on representative commands', () => {
  for (const command of ['claude', '/bin/claude', 'claude --print', 'node /lib/claude-code/cli.js', 'codex', '/bin/codex', 'codex app-server', 'git status', 'bash', 'xclaude', 'echo claude task', 'codex-helper']) {
    assert.equal(matchesProviderCommand(command, 'args'), /(?:^|[\s/])(?:claude|codex)(?:\s|$)/.test(command), command);
    assert.equal(matchesProviderCommand(command, 'pane'), /^(?:claude|codex)(?:\s|$)/.test(command), command);
  }
});
for (const command of ['kimi', 'kimi --continue', '/opt/homebrew/bin/kimi', 'node /opt/lib/kimi-code/dist/main.mjs', 'claude', 'codex']) {
  it(`F3 discovers unlabelled orphan: ${command}`, async () => {
    const config = makeConfig(scratch.sub(`orphan-${command.replaceAll(/\W/g, '_')}`), 'providers: [claude, codex, kimi]\n');
    const tmux = new FakeTmux(), pane = tmux.add('stray', 'Welcome to Kimi Code!\n│ > │'); pane.role = '';
    const { ctx } = makeContext(config, { respond: (cmd, args, opts) => args.includes('#{pane_current_command}') ? { stdout: command } : tmux.respond(cmd, args, opts) });
    assert.equal((await collectStatus(ctx, { progress: false }))[0]?.state, 'orphan');
  });
}
// Exact DESIGN §4 synthetic records, followed by supported nested/string forms.
for (const [error, outcome] of [
  [{ name: 'APIProviderQuotaExhaustedError' }, 'limited'],
  [{ name: 'APIProviderOverloadedError' }, 'overloaded'],
  ['APIProviderQuotaExhaustedError', 'limited'],
  ['APIProviderOverloadedError', 'overloaded'],
  ['quota exhausted', 'limited'], ['rate_limit', 'limited'], ['OVERLOADED', 'overloaded'],
  [{ message: 'APIProviderQuotaExhaustedError' }, 'limited'],
  [{ message: { name: 'APIProviderOverloadedError' } }, 'overloaded'],
  [{ error: { name: 'APIProviderQuotaExhaustedError' } }, 'limited'],
  [{ cause: { message: 'overloaded' } }, 'overloaded'],
  [{ name: 'OtherError', message: 'unknown provider failure' }, 'error'],
  ['unknown provider failure', 'error'],
  [{ unexpected: 123 }, 'ignored'], [42, 'ignored'],
] as const) it(`F2 parses synthetic failed turn ${JSON.stringify(error)}`, () => {
  for (const payload of [{ type: 'turn.ended', reason: 'failed', error }, { type: 'turn.ended', data: { reason: 'failed', error } }]) {
    assert.equal(parseKimiEvent({ payload })?.outcome, outcome);
    assert.notEqual(parseKimiEvent({ payload })?.outcome, 'turn-complete');
  }
});
it('F2 stores generic wire errors and uses attention while preserving screen precedence', () => {
  const config = makeConfig(scratch.sub('error-state')), record = seedTask(config, 'ERR', { agent: 'kimi' });
  fs.writeFileSync(path.join(config.stateDir, record.window, 'event.json'), JSON.stringify({ outcome: 'error', at: record.started, type: 'turn.ended', text: '' }));
  assert.equal(readStoredEvent(config, record)?.outcome, 'error');
  const settings = provider('kimi').defaultSettings();
  assert.equal(taskState({ alive: true, screen: '│ > │', settings, reportReady: false, event: 'error' }), 'needs-attention');
  assert.equal(taskState({ alive: true, screen: '⠸ Working…\n│ > │', settings, reportReady: false, event: 'error' }), 'working');
  assert.equal(parseKimiEvent({ payload: { type: 'turn.ended', reason: 'completed' } })?.outcome, 'turn-complete');
  assert.equal(parseKimiEvent({ payload: { type: 'turn.ended', reason: 'cancelled' } })?.outcome, 'turn-complete');
});
it('F2 passive poll persists failures, never marks them complete, and clears unknown shapes for screen fallback', async () => {
  const root = scratch.sub('poll-errors'), home = path.join(root, 'kimi'), wt = path.join(root, 'wt'); fs.mkdirSync(wt);
  const config = makeConfig(root, `providers: [claude, codex, kimi]\nusage: {kimi_dir: ${home}}\n`);
  const at = new Date().toISOString(), record = seedTask(config, 'WIRE', { agent: 'kimi', started: at, repos: [{ path: root, worktree: wt }] });
  const dir = path.join(home, 'sessions/w/session_S/agents/main'); fs.mkdirSync(dir, { recursive: true });
  const wire = path.join(dir, 'wire.jsonl'), eventFile = path.join(config.stateDir, record.window, 'event.json');
  fs.writeFileSync(wire, JSON.stringify({ type: 'metadata', protocol_version: '1.5', cwd: wt, session_id: 'S', timestamp: at }) + '\n');
  const { ctx } = makeContext(config);
  for (const [error, expected] of [[{ name: 'APIProviderQuotaExhaustedError' }, 'limited'], [{ name: 'APIProviderOverloadedError' }, 'overloaded'], [{ name: 'UnknownError' }, 'error'], [{ unknown: true }, undefined]] as const) {
    fs.appendFileSync(wire, JSON.stringify({ type: 'turn.ended', reason: 'failed', error, timestamp: at }) + '\n');
    await provider('kimi').events.poll!(ctx, record);
    assert.equal(readStoredEvent(config, record)?.outcome, expected);
    if (!expected) assert.equal(fs.existsSync(eventFile), false);
    assert.doesNotMatch(fs.readFileSync(path.join(config.stateDir, record.window, 'TASK.md'), 'utf8'), /^turn_ended_at:/m, JSON.stringify(error));
  }
});
for (const [args, found] of [['node /opt/lib/kimi-code/dist/main.mjs', true], ['node /opt/lib/server.mjs', false]] as const) it(`F3 resolves a Node pane by its own process arguments: ${args}`, async () => {
  const config = makeConfig(scratch.sub(found ? 'node-pane' : 'unrelated-node'));
  const tmux = new FakeTmux(), pane = tmux.add('stray', '│ > │'); pane.role = '';
  const { ctx } = makeContext(config, { respond: (cmd, argv, opts) => {
    if (argv.includes('#{pane_current_command}')) return { stdout: 'node' };
    if (argv.includes('#{pane_pid}')) return { stdout: '123' };
    if (cmd === 'ps') { assert.deepEqual(argv, ['-p', '123', '-o', 'args=']); return { stdout: args }; }
    return tmux.respond(cmd, argv, opts);
  } });
  assert.equal((await collectStatus(ctx, { progress: false })).some(r => r.state === 'orphan'), found);
});
