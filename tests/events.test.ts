import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildAgentArgv } from '../src/core/agents.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import {
  buildClaudeSettings,
  buildCodexNotify,
  claudeSettingsPath,
  clip,
  extractQuestion,
  firstLine,
  parseClaudeEvent,
  parseCodexEvent,
  parseJson,
  parseTomlNotify,
  planEventWiring,
  tomlArray,
  userCodexNotify,
} from '../src/core/events.ts';
import { newTasks } from '../src/core/new.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { FakeTmux, makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();
const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const json = (name: string): unknown => JSON.parse(fixture(name));

const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/home/me/.agentctl', '/opt/node/bin/node', '--experimental-strip-types', '--no-warnings', '/opt/agentctl/bin/agentctl.ts'];

describe('events: Claude hooks (JSON samples from Claude Code 2.1.309)', () => {
  it('a permission or question dialog is needs-input, with Claude\'s own message', () => {
    const e = parseClaudeEvent('notification', json('claude-notification-permission.json'));
    assert.deepEqual(e, { agent: 'claude', outcome: 'needs-input', type: 'notification:permission_prompt', text: 'Claude needs your permission' });
    // AskUserQuestion sends the very same type: the question itself is only on the screen
    assert.equal(parseClaudeEvent('notification', json('claude-notification-askuserquestion.json')).outcome, 'needs-input');
  });

  it('idle_prompt (a reminder after Stop) and other notification types are not questions', () => {
    assert.equal(parseClaudeEvent('notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).outcome, 'idle');
    assert.equal(parseClaudeEvent('notification', { notification_type: 'auth_success', message: 'ok' }).outcome, 'ignored');
    assert.equal(parseClaudeEvent('notification', { notification_type: 'elicitation_dialog', message: 'Pick one' }).outcome, 'needs-input');
    assert.equal(parseClaudeEvent('notification', {}).outcome, 'ignored');
  });

  it('Stop is the end of a turn, with the first line of the last message', () => {
    const e = parseClaudeEvent('stop', json('claude-stop.json'));
    assert.deepEqual(e, { agent: 'claude', outcome: 'turn-complete', type: 'stop', text: 'ok' });
    assert.equal(parseClaudeEvent('stop', { last_assistant_message: '## Done\n\n**All** tests `pass`.\nMore.' }).text, 'Done');
    assert.equal(parseClaudeEvent('stop', {}).text, '');
  });

  it('StopFailure with rate_limit or billing_error is a limit; other errors are only logged', () => {
    const limit = parseClaudeEvent('stop-failure', json('claude-stop-failure-rate-limit.synthetic.json'));
    assert.equal(limit.outcome, 'limited');
    assert.equal(limit.type, 'stop-failure:rate_limit');
    assert.match(limit.text, /session limit/);
    assert.equal(parseClaudeEvent('stop-failure', { error: 'billing_error' }).outcome, 'limited');
    assert.equal(parseClaudeEvent('stop-failure', { error: 'overloaded' }).outcome, 'ignored');
    assert.equal(parseClaudeEvent('stop-failure', { error: 'authentication_failed' }).outcome, 'ignored');
  });

  it('garbage in, "ignored" out: never throws', () => {
    assert.equal(parseClaudeEvent('stop', undefined).outcome, 'turn-complete');
    assert.equal(parseClaudeEvent('notification', 'text').outcome, 'ignored');
    assert.equal(parseJson('not json'), undefined);
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  });
});

describe('events: Codex notify (JSON samples from codex 0.166.0)', () => {
  it('agent-turn-complete is the end of a turn', () => {
    const e = parseCodexEvent(json('codex-turn-complete.json'));
    assert.equal(e.outcome, 'turn-complete');
    assert.equal(e.type, 'agent-turn-complete');
    assert.equal(e.text, 'Created approved.txt containing yes after approval.');
  });

  it('the turn that writes the session title is not an end of turn', () => {
    const e = parseCodexEvent(json('codex-title-turn.json'));
    assert.equal(e.outcome, 'ignored');
    assert.equal(e.type, 'agent-turn-complete:title');
    // recognised by its output alone as well
    assert.equal(parseCodexEvent({ type: 'agent-turn-complete', 'last-assistant-message': '{"title":"Fix the bug"}' }).outcome, 'ignored');
    assert.equal(parseCodexEvent({ type: 'agent-turn-complete', 'last-assistant-message': '{"title":"x","other":1}' }).outcome, 'turn-complete');
  });

  it('0.166.0 sends nothing else; names it may send later ask for a human, anything else is ignored', () => {
    assert.equal(parseCodexEvent({ type: 'approval-requested', message: 'Run rm -rf build?' }).outcome, 'needs-input');
    assert.equal(parseCodexEvent({ type: 'approval-requested', message: 'Run rm -rf build?' }).text, 'Run rm -rf build?');
    assert.equal(parseCodexEvent({ type: 'user-input-requested' }).outcome, 'needs-input');
    assert.equal(parseCodexEvent({ type: 'something-else' }).outcome, 'ignored');
    assert.equal(parseCodexEvent(undefined).outcome, 'ignored');
  });
});

describe('events: the question on a screen', () => {
  it('Claude permission dialog: the generic question plus what it is about', () => {
    assert.equal(extractQuestion(fixture('screen-claude-permission.txt')), 'Do you want to proceed? touch approved-by-claude.txt');
  });

  it('Claude AskUserQuestion: the question itself, not the header chip', () => {
    assert.equal(extractQuestion(fixture('screen-claude-askuserquestion.txt')), 'Which colour do you prefer, red or blue?');
  });

  it('Codex approval: the frame question plus the command, not the "?" at the end of the wrapped reason', () => {
    assert.equal(extractQuestion(fixture('screen-codex-approval.txt')), "Would you like to run the following command? $ printf 'yes' > approved-by-codex3.txt");
  });

  it('no option list, no question; a long one is cut at 120 characters', () => {
    assert.equal(extractQuestion('❯ Try "fix lint errors"\n'), undefined);
    assert.equal(extractQuestion('Is this fine?\nnot a list'), undefined);
    const long = `${'Why '.repeat(60)}?\n❯ 1. a\n  2. b`;
    const q = extractQuestion(long) as string;
    assert.ok(q.length <= 120 && q.endsWith('…'), q);
  });

  it('clip and firstLine', () => {
    assert.equal(clip('a  b\n c', 10), 'a b c');
    assert.equal(clip('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
    assert.equal(firstLine('\n\n# Title\nbody'), 'Title');
    assert.equal(firstLine('---\n***\nreal'), 'real');
  });
});

describe('events: what `new` hands to the agents', () => {
  const config = makeConfig(scratch.sub('wiring'));

  it('Claude: a settings file with the three hooks, each calling agentctl event with the task', () => {
    const settings = buildClaudeSettings('NC-1', SELF) as { hooks: Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]> };
    assert.deepEqual(Object.keys(settings.hooks), ['Notification', 'Stop', 'StopFailure']);
    for (const [name, kind] of [['Notification', 'notification'], ['Stop', 'stop'], ['StopFailure', 'stop-failure']] as const) {
      const hook = settings.hooks[name]?.[0]?.hooks[0];
      assert.equal(hook?.type, 'command');
      assert.equal(hook?.timeout, 15);
      assert.equal(
        hook?.command,
        `/usr/bin/env AGENTCTL_HOME=/home/me/.agentctl /opt/node/bin/node --experimental-strip-types --no-warnings /opt/agentctl/bin/agentctl.ts event --task NC-1 --agent claude --kind ${kind}`,
      );
    }
  });

  it('Claude: --settings <state_dir>/<window>/claude-settings.json, and it adds, not replaces: only hooks are in the file', () => {
    const w = planEventWiring({ agent: 'claude', task: 'NC-1', window: 'nc-1', config, self: SELF, env: {} });
    const file = path.join(config.stateDir, 'nc-1', 'claude-settings.json');
    assert.equal(claudeSettingsPath(config, 'nc-1'), file);
    assert.deepEqual(w.args, ['--settings', file]);
    assert.equal(w.files[0]?.path, file);
    assert.deepEqual(Object.keys(JSON.parse(w.files[0]?.content as string)), ['hooks']);
    assert.match(w.note, /Notification, Stop and StopFailure/);
  });

  it('paths with spaces or quotes survive the shell in a hook command', () => {
    const settings = buildClaudeSettings('NC-1', ['/usr/bin/node', "/my dir/it's/agentctl.ts"]) as { hooks: { Stop: { hooks: { command: string }[] }[] } };
    assert.match(settings.hooks.Stop[0]?.hooks[0]?.command as string, /^\/usr\/bin\/node '\/my dir\/it'\\''s\/agentctl.ts' event --task NC-1/);
  });

  it('Codex: -c notify=[…] as a TOML list of strings; the JSON event is appended by Codex', () => {
    const w = planEventWiring({ agent: 'codex', task: 'NC-2', window: 'nc-2', config, self: SELF, env: { CODEX_HOME: scratch.sub('wiring-empty-codex') } });
    assert.equal(w.args[0], '-c');
    assert.equal(
      w.args[1],
      'notify=["/usr/bin/env", "AGENTCTL_HOME=/home/me/.agentctl", "/opt/node/bin/node", "--experimental-strip-types", "--no-warnings", "/opt/agentctl/bin/agentctl.ts", "event", "--task", "NC-2", "--agent", "codex"]',
    );
    assert.deepEqual(w.files, []);
  });

  it('Codex: the notify command the user already has is kept (-c notify= would replace it) and runs after ours', () => {
    const home = scratch.sub('wiring-codex');
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6.1-sol"\nnotify = ["/Applications/Sky.app/client", "turn-ended"]\n\n[tui]\nx = 1\n');
    const w = planEventWiring({ agent: 'codex', task: 'NC-2', window: 'nc-2', config, self: SELF, env: { CODEX_HOME: home } });
    const value = w.args[1] as string;
    assert.ok(value.endsWith('"--forward", "[\\"/Applications/Sky.app/client\\",\\"turn-ended\\"]"]'), value);
    assert.match(w.note, /Sky\.app|\/Applications\/Sky\.app\/client/);
    const argv = buildCodexNotify('NC-2', SELF, ['/bin/sh', '-c', 'echo "hi"']);
    assert.equal(argv.at(-2), '--forward');
    assert.deepEqual(JSON.parse(argv.at(-1) as string), ['/bin/sh', '-c', 'echo "hi"']);
    assert.equal(tomlArray(['a"b', 'c\\d']), '["a\\"b", "c\\\\d"]');
  });

  it('parseTomlNotify: single and multi line lists, literal strings, comments; nothing for a notify inside a table', () => {
    assert.deepEqual(parseTomlNotify('notify = ["a", "b c"]'), ['a', 'b c']);
    assert.deepEqual(parseTomlNotify('model = "x"\nnotify=[\n  "a", # first\n  \'b\',\n]\n'), ['a', 'b']);
    assert.deepEqual(parseTomlNotify('notify = []'), []);
    assert.equal(parseTomlNotify('[tui]\nnotify = ["a"]\n'), undefined);
    assert.equal(parseTomlNotify('model = "x"\n'), undefined);
    assert.equal(parseTomlNotify('notify = [1, 2]'), undefined);
    assert.equal(parseTomlNotify('notify = ["a"'), undefined);
  });

  it('userCodexNotify reads $CODEX_HOME of the window; no file, no notify', () => {
    assert.equal(userCodexNotify({ CODEX_HOME: scratch.sub('nothing-here') }), undefined);
    assert.deepEqual(userCodexNotify({ CODEX_HOME: '/x' }, (f) => (f === '/x/config.toml' ? 'notify = ["n"]' : undefined)), ['n']);
  });

  it('the flags go last on the agent command line, after the configured ones', () => {
    const spec = { agent: 'claude', model: 'opus', effort: 'high' } as const;
    const argv = buildAgentArgv(spec, { ...config.agents.claude, flags: ['--verbose'] }, ['--settings', '/s.json']);
    assert.deepEqual(argv, ['claude', '--model', 'opus', '--effort', 'high', '--verbose', '--settings', '/s.json']);
    assert.deepEqual(buildAgentArgv({ ...spec, agent: 'codex' }, config.agents.codex, ['-c', 'notify=[]']).slice(-2), ['-c', 'notify=[]']);
  });
});

describe('new: starts the agents with the event wiring', () => {
  const specs = (config: ReturnType<typeof makeConfig>, agent: string, extraEnv = ''): ResolvedSpec[] => {
    const repo = scratch.sub(`newwire-${agent}${extraEnv ? '-env' : ''}/app`);
    const model = agent === 'claude' ? 'opus' : 'gpt-6.1-sol';
    return splitSpecs(`---\ntask: NC-1\nagent: ${agent}\nmodel: ${model}\neffort: high\n${extraEnv}repos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nGo.\n`).map((raw) =>
      resolveSpec(raw, { config, loadProject: () => undefined }),
    );
  };

  it('Claude: writes claude-settings.json before the window starts and passes --settings', async () => {
    const config = makeConfig(scratch.sub('newwire-c'));
    const fake = new FakeTmux();
    const { ctx, runner } = makeContext(config, { respond: fake.respond });
    await newTasks(ctx, specs(config, 'claude'), { self: SELF });
    const file = claudeSettingsPath(config, 'nc-1');
    assert.ok(runner.written.has(file));
    assert.ok(runner.commands.indexOf(`write ${file} (${Buffer.byteLength(runner.written.get(file) as string)} bytes)`) < runner.commands.findIndex((c) => c.startsWith('tmux new-session')));
    const typed = runner.commands.find((c) => c.includes('send-keys') && c.includes(' -l -- '));
    assert.ok(typed?.includes(`claude --model opus --effort high --settings ${file}`), String(typed));
  });

  it('Codex: -c notify=[…] on the command line, and nothing written', async () => {
    const config = makeConfig(scratch.sub('newwire-x'));
    const fake = new FakeTmux();
    fake.newWindowScreen = '› Ask Codex to do anything\n';
    const { ctx, runner } = makeContext(config, { respond: fake.respond });
    await newTasks(ctx, specs(config, 'codex', `env: {CODEX_HOME: ${scratch.sub('newwire-x-home')}}\n`), { self: SELF });
    const typed = runner.commands.find((c) => c.includes('send-keys') && c.includes(' -l -- ')) as string;
    assert.match(typed, /^tmux send-keys -t \S+ -l -- 'codex --sandbox danger-full-access -m gpt-6.1-sol -c model_reasoning_effort=high -c '\\''notify=\["\/usr\/bin\/env"/);
    assert.ok(![...runner.written.keys()].some((f) => f.endsWith('claude-settings.json')));
  });

  it('notify.events: false, or no self command: the agent starts as before', async () => {
    const off = makeConfig(scratch.sub('newwire-off'), 'notify: {events: false}\n');
    const a = makeContext(off, { respond: new FakeTmux().respond });
    await newTasks(a.ctx, specs(off, 'claude'), { self: SELF });
    assert.ok(a.runner.commands.some((c) => c.endsWith("-- 'claude --model opus --effort high'")));
    const on = makeConfig(scratch.sub('newwire-noself'));
    const b = makeContext(on, { respond: new FakeTmux().respond });
    await newTasks(b.ctx, specs(on, 'claude'));
    assert.ok(b.runner.commands.some((c) => c.endsWith("-- 'claude --model opus --effort high'")));
  });
});

describe('config: notify and limit_patterns', () => {
  it('defaults: events and turn_end on, no terminal app, no verdict pattern', () => {
    assert.deepEqual(makeConfig(scratch.sub('cfg-n1')).notify, { backend: 'auto', events: true, turnEnd: true });
  });

  it('reads terminal_app, verdict_pattern, events and turn_end; rejects what is wrong', () => {
    const c = makeConfig(scratch.sub('cfg-n2'), 'notify:\n  terminal_app: com.googlecode.iterm2\n  verdict_pattern: "^Result: (.*)"\n  events: false\n  turn_end: false\n');
    assert.deepEqual(c.notify, { backend: 'auto', events: false, turnEnd: false, terminalApp: 'com.googlecode.iterm2', verdictPattern: '^Result: (.*)' });
    assert.throws(() => makeConfig(scratch.sub('cfg-n3'), 'notify: {verdict_pattern: "("}\n'), /verdict_pattern is not a valid regular expression/);
    assert.throws(() => makeConfig(scratch.sub('cfg-n4'), 'notify: {events: yes please}\n'), /notify.events must be true or false/);
    assert.throws(() => makeConfig(scratch.sub('cfg-n5'), 'notify: {sound: x}\n'), /unknown key "sound"/);
  });

  it('limit_patterns: defaults for both agents, replaceable per agent, validated', () => {
    const c = makeConfig(scratch.sub('cfg-l1'));
    assert.ok(c.agents.claude.limitPatterns.length >= 3 && c.agents.codex.limitPatterns.length >= 3);
    const custom = makeConfig(scratch.sub('cfg-l2'), 'agents:\n  codex:\n    limit_patterns: ["quota gone"]\n');
    assert.deepEqual(custom.agents.codex.limitPatterns, ['quota gone']);
    assert.ok(custom.agents.claude.limitPatterns.length >= 3);
    assert.throws(() => makeConfig(scratch.sub('cfg-l3'), 'agents:\n  claude:\n    limit_patterns: ["["]\n'), /limit_patterns\[0\] is not a valid regular expression/);
  });

  it('loadGlobalConfig still loads without a config file', () => {
    assert.equal(loadGlobalConfig(scratch.sub('cfg-none')).notify.events, true);
  });
});
