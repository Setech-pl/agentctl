import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { DEFAULT_WINDOW_ICONS } from '../src/core/icons.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { StatusRow } from '../src/core/status.ts';
import type { TaskState } from '../src/core/state.ts';
import { applyStatusLine, statusRightFormat, tmuxLine } from '../src/core/statusline.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

const row = (state: TaskState, pulled: string | null = null): StatusRow => ({ task: 'T', state, pulled }) as StatusRow;

describe('tmuxLine', () => {
  it('counts the tasks per state: "2⚙ 1✓ 1?"', () => {
    const rows = [row('working'), row('working'), row('report-ready'), row('needs-input')];
    assert.equal(tmuxLine(rows, DEFAULT_WINDOW_ICONS), '2⚙ 1✓ 1?');
  });

  it('leaves zero counts out, and is empty when there is nothing to show', () => {
    assert.equal(tmuxLine([row('waiting')], DEFAULT_WINDOW_ICONS), '1⏸');
    assert.equal(tmuxLine([], DEFAULT_WINDOW_ICONS), '');
  });

  it('does not count reports that were pulled; orphan and dead share the ✗', () => {
    const rows = [row('report-ready', '2026-11-01T08:00:00Z'), row('report-ready'), row('orphan'), row('dead'), row('needs-trust')];
    assert.equal(tmuxLine(rows, DEFAULT_WINDOW_ICONS), '1✓ 1🔒 2✗');
  });

  it('uses the configured icons, and the default ones when window icons are off', () => {
    assert.equal(tmuxLine([row('working')], { ...DEFAULT_WINDOW_ICONS, working: '▶' }), '1▶');
    assert.equal(tmuxLine([row('working')], null), '1⚙');
  });
});

describe('statusRightFormat', () => {
  it('wraps the command in #( ) and escapes tmux format and strftime characters', () => {
    assert.equal(statusRightFormat('agentctl status --tmux-line'), '#(agentctl status --tmux-line)');
    assert.equal(statusRightFormat("AGENTCTL_HOME='/h #1/100%' agentctl status"), "#(AGENTCTL_HOME='/h ##1/100%%' agentctl status)");
  });

  it('refuses a command with unbalanced parentheses', () => {
    assert.equal(statusRightFormat("agentctl '/odd(dir' status"), undefined);
    assert.equal(statusRightFormat('a ) b ('), undefined);
    assert.equal(statusRightFormat("agentctl '/odd(dir)' status"), "#(agentctl '/odd(dir)' status)");
  });
});

describe('applyStatusLine', () => {
  it('sets status-right and status-interval for the agentctl session only', async () => {
    const config = makeConfig(scratch.sub('sl1'));
    const tmux = new FakeTmux();
    tmux.add('watch');
    const { ctx, runner } = makeContext(config, { respond: tmux.respond });
    assert.equal(await applyStatusLine(ctx, 'agentctl status --tmux-line'), 'set');
    assert.deepEqual(runner.commands.map((c) => c.replaceAll("'", '')), [
      'tmux set-option -t =agentctl: status-right #(agentctl status --tmux-line)',
      'tmux set-option -t =agentctl: status-interval 10',
    ]);
    assert.ok(!runner.commands.some((c) => /\s-g\b/.test(c)), 'never global');
  });

  it('reports a set-option that tmux refuses instead of claiming success', async () => {
    const config = makeConfig(scratch.sub('sl3'));
    const tmux = new FakeTmux();
    tmux.add('watch');
    const { ctx } = makeContext(config, { respond: (cmd, args, opts) => (args[0] === 'set-option' ? { code: 1, stderr: 'no such session: =agentctl' } : tmux.respond(cmd, args, opts)) });
    assert.deepEqual(await applyStatusLine(ctx, 'agentctl status --tmux-line'), { failed: 'tmux set-option status-right: no such session: =agentctl' });
  });

  it('does nothing without a session, and for a command that cannot go into #( )', async () => {
    const config = makeConfig(scratch.sub('sl2'));
    const { ctx, runner } = makeContext(config, { respond: new FakeTmux().respond });
    assert.equal(await applyStatusLine(ctx, 'agentctl status --tmux-line'), 'no-session');
    assert.equal(await applyStatusLine(ctx, 'agentctl (status'), 'unsupported-command');
    assert.deepEqual(runner.commands, []);
  });
});

describe('through the CLI', () => {
  function cli(config: ReturnType<typeof makeConfig>, runner: RecordingRunner, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
      confirm: undefined, readClipboard: async () => '', watchCommand: () => 'agentctl watch', statusLineCommand: () => 'agentctl status --tmux-line', makeRunner: () => runner,
    };
    return main(argv, deps).then((code) => ({ code, stdout: out.join(''), stderr: err.join('') }));
  }

  function setup(name: string, extra = '') {
    const config = makeConfig(scratch.sub(name), extra);
    const tmux = new FakeTmux();
    for (const [task, screen] of [['NC-1', '● reading\n  ⏵⏵ auto (shift+tab to cycle) · esc to interrupt\n'], ['NC-2', '● reading\n  ⏵⏵ auto (shift+tab to cycle) · esc to interrupt\n'], ['NC-3', '? Tea?\n  Enter to select · Esc to cancel\n']] as const) {
      seedTask(config, task);
      tmux.add(task.toLowerCase(), screen);
    }
    tmux.add('watch');
    return { config, tmux, runner: new RecordingRunner({ dryRun: false, respond: tmux.respond }) };
  }

  it('status --tmux-line prints exactly the line and no progress, mirror or migration noise', async () => {
    const { config, runner } = setup('cl1');
    // a task state file still in the old place: a normal command would announce the migration
    const legacy = path.join(config.cache, 'old-1');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'TASK.md'), fs.readFileSync(path.join(config.stateDir, 'nc-1', 'TASK.md'), 'utf8').replace('NC-1', 'OLD-1'));
    const r = await cli(config, runner, ['status', '--tmux-line']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^2⚙ 1\?\n$/);
    assert.ok(fs.existsSync(path.join(legacy, 'TASK.md')), 'nothing was migrated');
    assert.ok(!runner.queries.some((q) => q.startsWith('git')));
  });

  it('it excludes --json and --clip', async () => {
    const { config, runner } = setup('cl2');
    const r = await cli(config, runner, ['status', '--tmux-line', '--json']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /exclude each other/);
  });

  it('watch --tmux sets the status bar of the session; --no-status-line and status_line: false leave it', async () => {
    const on = setup('cl3');
    const r = await cli(on.config, on.runner, ['watch', '--tmux']);
    assert.equal(r.code, 0, r.stderr);
    const cmds = on.runner.commands.map((c) => c.replaceAll("'", ''));
    assert.ok(cmds.includes('tmux set-option -t =agentctl: status-right #(agentctl status --tmux-line)'), cmds.join('\n'));
    assert.ok(cmds.includes('tmux set-option -t =agentctl: status-interval 10'));
    assert.match(r.stdout, /this session only/);

    const flag = setup('cl4');
    await cli(flag.config, flag.runner, ['watch', '--tmux', '--no-status-line']);
    assert.ok(!flag.runner.commands.some((c) => c.includes('set-option')));

    const off = setup('cl5', 'watch: {status_line: false}\n');
    await cli(off.config, off.runner, ['watch', '--tmux']);
    assert.ok(!off.runner.commands.some((c) => c.includes('set-option')));
  });

  it('watch --tmux creates the session first when needed, then sets the status bar', async () => {
    const config = makeConfig(scratch.sub('cl6'));
    // FakeTmux adds the window on new-session, so the status bar is set right after
    const tmux = new FakeTmux();
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const r = await cli(config, runner, ['watch', '--tmux']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(runner.commands[0]?.startsWith('tmux new-session'));
    assert.ok(runner.commands.some((c) => c.includes('status-right')));
  });

  it('the config accepts status_line only as a boolean', () => {
    assert.throws(() => makeConfig(scratch.sub('cl7'), 'watch: {status_line: maybe}\n'), /status_line must be true or false/);
    assert.equal(makeConfig(scratch.sub('cl8')).watch.statusLine, true);
  });
});
