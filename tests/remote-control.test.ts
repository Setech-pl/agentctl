import path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentCommandLine, buildAgentArgv, buildResumeArgv } from '../src/core/agents.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { newTasks } from '../src/core/new.ts';
import { RC_CONFIRM } from '../src/core/remote-control.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { parseTaskRecord, taskFile } from '../src/core/taskstore.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();
const claude = DEFAULT_AGENT_SETTINGS.claude;
const codex = DEFAULT_AGENT_SETTINGS.codex;
const IDLE = ' ▐▛███▛█   Claude Code v2.1.309\n────\n❯ Try "how does <filepath> work?"\n────\n  ⏵⏵ auto mode on';
const RC_DIALOG = ' Enable Remote Control? (y/n)\n ❯ 1. Yes, enable\n   2. Never mind';

function resolve(config: GlobalConfig, header: string, repo: string) {
  const text = `---\ntask: NC-1\n${header}repos:\n  - {path: ${repo}, worktree: ${repo}-nc-1}\n---\nDo it.\n`;
  return resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined });
}

describe('remote control: the command line of an agent', () => {
  const spec = { agent: 'claude' as const, model: 'opus', effort: 'high' as const, task: 'NC-1', remoteControl: true };

  it('--remote-control <TASK> after the flags and before the event wiring; model, effort and settings go along', () => {
    assert.deepEqual(buildAgentArgv(spec, claude, ['--settings', '/s.json']), ['claude', '--model', 'opus', '--effort', 'high', '--remote-control', 'NC-1', '--settings', '/s.json']);
    assert.equal(agentCommandLine(buildAgentArgv(spec, { ...claude, flags: ['--verbose'] })), 'claude --model opus --effort high --verbose --remote-control NC-1');
  });

  it('is off unless asked, and never in the server mode', () => {
    assert.deepEqual(buildAgentArgv({ ...spec, remoteControl: false }, claude), ['claude', '--model', 'opus', '--effort', 'high']);
    assert.deepEqual(buildAgentArgv({ agent: 'claude', model: 'opus', effort: 'high' }, claude), ['claude', '--model', 'opus', '--effort', 'high']);
    assert.notEqual(buildAgentArgv(spec, claude)[1], 'remote-control');
  });

  it('the name is the task ID, always given', () => {
    const argv = buildAgentArgv(spec, claude, ['--settings', '/s.json']);
    assert.equal(argv[argv.indexOf('--remote-control') + 1], 'NC-1', 'the optional value never takes --settings');
    assert.throws(() => buildAgentArgv({ ...spec, task: undefined }, claude), /needs the task ID/);
  });

  it('codex has no Remote Control: the flag is not added', () => {
    assert.ok(!buildAgentArgv({ ...spec, agent: 'codex', model: 'gpt-6.1-sol' }, codex).includes('--remote-control'));
  });

  it('a resumed conversation starts with the same flag, before --resume', () => {
    assert.deepEqual(buildResumeArgv(spec, claude, ['--settings', '/s.json'], 'abc-123'), ['claude', '--model', 'opus', '--effort', 'high', '--remote-control', 'NC-1', '--settings', '/s.json', '--resume', 'abc-123']);
    assert.deepEqual(buildResumeArgv({ ...spec, remoteControl: false }, claude, [], undefined).slice(-1), ['--continue']);
  });
});

describe('remote control: the spec key', () => {
  it('remote_control: true is kept, false and absent are off', () => {
    const root = scratch.sub('spec-1');
    const config = makeConfig(root);
    assert.equal(resolve(config, 'agent: claude\nremote_control: true\n', root).remoteControl, true);
    assert.equal(resolve(config, 'agent: claude\nremote_control: false\n', root).remoteControl, undefined);
    assert.equal(resolve(config, 'agent: claude\n', root).remoteControl, undefined);
  });

  it('must be a boolean, and works for Claude only (a clear message, nothing is started)', () => {
    const root = scratch.sub('spec-2');
    const config = makeConfig(root);
    assert.throws(() => resolve(config, 'agent: claude\nremote_control: "yes"\n', root), /remote_control must be true or false/);
    assert.throws(() => resolve(config, 'agent: codex\nremote_control: true\n', root), /remote_control: true works for Claude only/);
    assert.equal(resolve(config, 'agent: codex\nremote_control: false\n', root).remoteControl, undefined);
  });

  it('defaults.remote_control makes it the default of the Claude tasks only; the spec wins', () => {
    const root = scratch.sub('spec-3');
    const config = makeConfig(root, 'defaults:\n  remote_control: true\n');
    assert.equal(resolve(config, 'agent: claude\n', root).remoteControl, true);
    assert.equal(resolve(config, 'agent: codex\n', root).remoteControl, undefined, 'a default does not make a Codex task fail');
    assert.equal(resolve(config, 'agent: claude\nremote_control: false\n', root).remoteControl, undefined);
    assert.throws(() => makeConfig(scratch.sub('spec-3b'), 'defaults:\n  remote_control: maybe\n'), /defaults\.remote_control must be true or false/);
  });

  it('refuses a combination the research rules out: the flag or the server mode already in agents.claude.flags', () => {
    const root = scratch.sub('spec-4');
    for (const flag of ['--remote-control', '--rc', 'remote-control']) {
      const config = makeConfig(root, `agents:\n  claude:\n    flags: ['${flag}']\n`);
      assert.throws(() => resolve(config, 'agent: claude\nremote_control: true\n', root), /already has/, flag);
      assert.equal(resolve(config, 'agent: claude\n', root).task, 'NC-1', 'without remote_control the flags are the user\'s business');
    }
  });
});

describe('remote control: starting a task', () => {
  function world(name: string, screens: string[]) {
    const root = scratch.sub(name);
    const repo = scratch.sub(`${name}/app`);
    const config = makeConfig(root);
    let n = 0;
    const respond = (cmd: string, a: string[]) => {
      if (cmd !== 'tmux') return undefined;
      if (a[0] === 'has-session' || a[0] === 'list-windows') return { code: 1 };
      if (a[0] === 'capture-pane') return { stdout: screens[Math.min(n++, screens.length - 1)] as string };
      return undefined;
    };
    const made = makeContext(config, { respond });
    return { ...made, config, repo };
  }

  it('types claude with --remote-control <TASK> and the event hooks, tells where the session appears, and keeps it in TASK.md', async () => {
    const w = world('new-1', [IDLE]);
    const spec = resolve(w.config, 'agent: claude\nmodel: opus\nremote_control: true\n', w.repo);
    const [result] = await newTasks(w.ctx, [spec], { self: ['/usr/bin/node', '/x/agentctl.ts'] });
    assert.match(w.runner.written.get(path.join(w.config.stateDir, 'nc-1/start.sh'))!, /exec claude --model opus --effort high --remote-control NC-1 --settings /);
    const typed = w.runner.commands.find((c) => c.includes('send-keys') && c.includes('exec sh'));
    assert.ok(typed, 'the line was typed into the window');
    assert.match(w.out.join('\n'), /NC-1: Remote Control on: the session "NC-1" appears in the Claude app \(Code\)/);
    const written = w.runner.written.get(taskFile(w.config, 'nc-1')) ?? '';
    assert.match(written, /^remote_control: true$/m);
    assert.equal(parseTaskRecord(written)?.remoteControl, true);
  });

  it('a task without it starts as before and has no key in TASK.md', async () => {
    const w = world('new-2', [IDLE]);
    const spec = resolve(w.config, 'agent: claude\nmodel: opus\n', w.repo);
    const [result] = await newTasks(w.ctx, [spec], { self: ['/usr/bin/node', '/x/agentctl.ts'] });
    assert.doesNotMatch(result!.agentCommand, /remote-control/);
    const written = w.runner.written.get(taskFile(w.config, 'nc-1')) ?? '';
    assert.match(written, /^task: NC-1$/m);
    assert.doesNotMatch(written, /remote_control/);
    assert.equal(parseTaskRecord(written)?.remoteControl, undefined);
  });

  it('the "Enable Remote Control" dialog is a dialog for the human, like the folder trust: never answered, named in the message', async () => {
    const w = world('new-3', [RC_DIALOG]);
    const spec = resolve(w.config, 'agent: claude\nremote_control: true\n', w.repo);
    await assert.rejects(newTasks(w.ctx, [spec], { waitTrust: false }), (e: Error & { hint?: string }) => /waits for folder trust or "Enable Remote Control"/.test(e.message) && /never answers that dialog/.test(e.hint ?? ''));
    assert.equal(w.runner.commands.filter((c) => c.includes('paste-buffer')).length, 0, 'the prompt was not pasted');
    assert.ok(new RegExp(RC_CONFIRM, 'i').test(RC_DIALOG));
    // a task without Remote Control does not treat that text as a dialog (it would time out as before)
    const plain = world('new-4', [RC_DIALOG, IDLE]);
    const spec2 = resolve(plain.config, 'agent: claude\n', plain.repo);
    await newTasks(plain.ctx, [spec2], { waitTrust: false });
    assert.equal(plain.runner.commands.filter((c) => c.includes('paste-buffer')).length, 1);
  });
});

describe('reserved task IDs', () => {
  it('WATCH, BOARD and MANAGER are the windows of agentctl itself: a task of that name would be invisible in status', () => {
    const root = scratch.sub('reserved');
    const config = makeConfig(root);
    for (const id of ['WATCH', 'BOARD', 'MANAGER']) {
      const text = `---\ntask: ${id}\nagent: claude\nrepos:\n  - {path: ${root}, worktree: ${root}-x}\n---\nx\n`;
      assert.throws(() => resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined }), /cannot be a task ID: the window ".*" of the agentctl session is used by agentctl itself/, id);
    }
    assert.equal(resolve(config, 'agent: claude\n', root).task, 'NC-1');
  });
});
