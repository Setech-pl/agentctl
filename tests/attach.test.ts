import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { ATTACH_HINT, attachTask } from '../src/core/attach.ts';
import { peekTask } from '../src/core/peek.ts';
import { listTargets, matchTask, resolveRunningTask } from '../src/core/resolve.ts';
import type { TaskTarget } from '../src/core/resolve.ts';
import { contentLines } from '../src/core/tmux.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

/** The recorded commands without the quotes the runner puts around "=session:window" targets. */
const plain = (runner: RecordingRunner): string[] => runner.commands.map((c) => c.replaceAll("'", ''));

const target = (task: string, alive = true): TaskTarget => ({ task, window: task.toLowerCase(), alive });

describe('matchTask', () => {
  const targets = [target('NC-4'), target('NC-42'), target('AGENTCTL-5'), target('AB')];

  it('ignores case and accepts the window name', () => {
    assert.deepEqual(matchTask('agentctl-5', targets), { kind: 'one', target: targets[2] });
    assert.deepEqual(matchTask('Nc-42', targets), { kind: 'one', target: targets[1] });
  });

  it('an exact ID beats a longer ID it is a prefix of', () => {
    assert.deepEqual(matchTask('nc-4', targets), { kind: 'one', target: targets[0] });
  });

  it('a unique prefix is enough, an ambiguous one lists the candidates, an unknown one matches nothing', () => {
    assert.deepEqual(matchTask('agent', targets), { kind: 'one', target: targets[2] });
    assert.deepEqual(matchTask('nc', targets), { kind: 'many', matches: [targets[0], targets[1]] });
    assert.deepEqual(matchTask('zz', targets), { kind: 'none' });
    assert.deepEqual(matchTask('  ', targets), { kind: 'none' });
  });
});

describe('resolveRunningTask and listTargets', () => {
  function setup(name: string) {
    const config = makeConfig(scratch.sub(name));
    const tmux = new FakeTmux();
    const { ctx, runner, out } = makeContext(config, { respond: tmux.respond });
    return { config, tmux, ctx, runner, out };
  }

  it('lists state files and orphan windows, never the watch and board windows', async () => {
    const { config, tmux, ctx } = setup('rt1');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2'); // no window: dead or closed
    tmux.add('nc-1');
    tmux.add('stray');
    tmux.add('watch');
    tmux.add('board');
    const targets = await listTargets(ctx);
    assert.deepEqual(targets.map((t) => `${t.task}:${t.alive}`), ['NC-1:true', 'NC-2:false', 'STRAY:true']);
  });

  it('prefers running tasks for a prefix, and says why when the only match has no window', async () => {
    const { config, tmux, ctx } = setup('rt2');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    tmux.add('nc-2');
    assert.equal((await resolveRunningTask(ctx, 'nc')).task, 'NC-2');
    await assert.rejects(resolveRunningTask(ctx, 'nc-1'), /NC-1 has no tmux window/);
  });

  it('an ambiguous prefix is an error with the list', async () => {
    const { config, tmux, ctx } = setup('rt3');
    for (const t of ['NC-1', 'NC-2', 'AB-1']) {
      seedTask(config, t);
      tmux.add(t.toLowerCase());
    }
    await assert.rejects(resolveRunningTask(ctx, 'nc'), (e: Error) => /more than one task/.test(e.message) && /- NC-1/.test(e.message) && /- NC-2/.test(e.message) && !/AB-1/.test(e.message));
    await assert.rejects(resolveRunningTask(ctx, 'zzz'), (e: Error) => /no task "zzz"/.test(e.message) && /- AB-1/.test(e.message));
  });
});

describe('attach', () => {
  function setup(name: string, tasks: string[]) {
    const config = makeConfig(scratch.sub(name));
    const tmux = new FakeTmux();
    for (const t of tasks) {
      seedTask(config, t);
      tmux.add(t.toLowerCase());
    }
    const { ctx, runner, out } = makeContext(config, { respond: tmux.respond });
    return { config, tmux, ctx, runner, out };
  }

  it('outside tmux: prints the hint, selects the window, attaches the session', async () => {
    const { ctx, runner, out } = setup('at1', ['NC-1', 'NC-2']);
    const done = await attachTask(ctx, 'nc-2', { insideTmux: false });
    assert.equal(done.task, 'NC-2');
    assert.deepEqual(out, [ATTACH_HINT]);
    assert.equal(ATTACH_HINT, 'Ctrl-b d – wyjście bez przerywania agenta; nie wciskaj Esc ani Ctrl-c');
    assert.deepEqual(plain(runner), ['tmux select-window -t =agentctl:nc-2', 'tmux attach-session -t =agentctl']);
  });

  it('inside tmux ($TMUX): switch-client instead of attach-session', async () => {
    const { ctx, runner } = setup('at2', ['NC-1']);
    await attachTask(ctx, 'NC', { insideTmux: true });
    assert.deepEqual(plain(runner), ['tmux select-window -t =agentctl:nc-1', 'tmux switch-client -t =agentctl']);
  });

  it('without a task: the only running one is used', async () => {
    const { ctx, runner } = setup('at3', ['NC-1']);
    seedTask(ctx.config, 'NC-9'); // closed
    await attachTask(ctx, undefined, { insideTmux: false });
    assert.ok(plain(runner).includes('tmux select-window -t =agentctl:nc-1'));
  });

  it('without a task and several running: the chooser decides; without a terminal it is a list and an error', async () => {
    const { ctx, runner } = setup('at4', ['NC-1', 'NC-2']);
    let offered: string[] = [];
    await attachTask(ctx, undefined, {
      insideTmux: true,
      choose: async (list) => {
        offered = list.map((t) => t.task);
        return list[1];
      },
    });
    assert.deepEqual(offered, ['NC-1', 'NC-2']);
    assert.ok(plain(runner).includes('tmux select-window -t =agentctl:nc-2'));

    const before = runner.commands.length;
    await assert.rejects(attachTask(ctx, undefined, { insideTmux: true }), (e: Error) => /more than one running task/.test(e.message) && /- NC-1/.test(e.message) && /- NC-2/.test(e.message));
    assert.equal(runner.commands.length, before, 'nothing was switched');
    await assert.rejects(attachTask(ctx, undefined, { insideTmux: true, choose: async () => undefined }), /no task chosen/);
  });

  it('no running task, and an ambiguous prefix, switch nothing', async () => {
    const empty = setup('at5', []);
    await assert.rejects(attachTask(empty.ctx, undefined, { insideTmux: false }), /no running tasks/);
    const two = setup('at6', ['NC-1', 'NC-2']);
    await assert.rejects(attachTask(two.ctx, 'nc', { insideTmux: false }), /more than one task/);
    assert.deepEqual(two.runner.commands, []);
    assert.deepEqual(two.out, [], 'no hint before the error');
  });

  it('a failing select-window is reported and attach is not tried', async () => {
    const config = makeConfig(scratch.sub('at7'));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const { ctx, runner } = makeContext(config, { respond: (cmd, args, opts) => (args[0] === 'select-window' ? { code: 1, stderr: 'boom' } : tmux.respond(cmd, args, opts)) });
    await assert.rejects(attachTask(ctx, 'nc-1', { insideTmux: false }), /cannot select window "nc-1": boom/);
    assert.ok(!runner.commands.some((c) => c.includes('attach-session')));
  });

  it('attach-session is an interactive exec: the terminal is handed over to tmux', async () => {
    const config = makeConfig(scratch.sub('at8'));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add('nc-1');
    const interactive: string[] = [];
    const { ctx } = makeContext(config, {
      respond: (cmd, args, opts) => {
        if (opts.interactive) interactive.push(args[0] as string);
        return tmux.respond(cmd, args, opts);
      },
    });
    await attachTask(ctx, 'nc-1', { insideTmux: false });
    assert.deepEqual(interactive, ['attach-session']);
  });
});

describe('peek', () => {
  const CLAUDE_SCREEN = `● Reading src/menu.ts
● Edited src/menu.ts (+12 -3)

● Done: the menu now autostarts.

──────────────────────────────────────────────
❯ 
──────────────────────────────────────────────
  ? for shortcuts                                ⚠ 1 warning
`;

  function setup(name: string, screen: string, agent: 'claude' | 'codex' = 'claude') {
    const config = makeConfig(scratch.sub(name));
    seedTask(config, 'NC-1', { agent });
    const tmux = new FakeTmux();
    tmux.add('nc-1', screen);
    return { config, ...makeContext(config, { respond: tmux.respond }) };
  }

  it('returns the content without borders, the empty input field and the footer', async () => {
    const { ctx } = setup('pk1', CLAUDE_SCREEN);
    const r = await peekTask(ctx, 'nc');
    assert.equal(r.task, 'NC-1');
    assert.deepEqual(r.lines, ['● Reading src/menu.ts', '● Edited src/menu.ts (+12 -3)', '', '● Done: the menu now autostarts.']);
  });

  it('-n keeps only the last N lines, and asks tmux for scrollback beyond the screen', async () => {
    const { ctx, runner } = setup('pk2', CLAUDE_SCREEN);
    const r = await peekTask(ctx, 'NC-1', 2);
    assert.deepEqual(r.lines, ['', '● Done: the menu now autostarts.']);
    assert.ok(runner.queries.some((q) => /capture-pane -p -t \S+ -S -42$/.test(q)), runner.queries.join('\n'));
  });

  it('uses the footer patterns of the task agent (Codex)', async () => {
    const screen = `• Report written.\n  Worked for 41s\n\n› Ask Codex to do anything\n  GPT-6.1-Sol low · ~/x · Fix\n  ? for shortcuts      ⚠ 1 warning · f2 to view\n`;
    const { ctx } = setup('pk3', screen, 'codex');
    assert.deepEqual((await peekTask(ctx, 'nc-1')).lines, ['• Report written.', '  Worked for 41s']);
  });

  it('rejects a bad -n and an unknown task', async () => {
    const { ctx } = setup('pk4', CLAUDE_SCREEN);
    await assert.rejects(peekTask(ctx, 'nc-1', 0), /-n must be a positive whole number/);
    await assert.rejects(peekTask(ctx, 'other'), /no task "other"/);
  });

  it('contentLines on its own: blank edges are trimmed, inner blank lines stay', () => {
    const lines = contentLines('\n\nfirst\n\nsecond\n\n\n', DEFAULT_AGENT_SETTINGS.claude.footerPatterns, 10);
    assert.deepEqual(lines, ['first', '', 'second']);
  });
});

describe('attach and peek through the CLI', () => {
  function cli(config: ReturnType<typeof makeConfig>, runner: RecordingRunner, argv: string[], extra: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config, confirm: undefined, readClipboard: async () => '', watchCommand: () => 'agentctl watch', makeRunner: () => runner, ...extra };
    return main(argv, deps).then((code) => ({ code, stdout: out.join(''), stderr: err.join('') }));
  }

  it('peek prints the lines; -n is validated', async () => {
    const config = makeConfig(scratch.sub('cli1'));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add('nc-1', 'one\ntwo\nthree\n❯ \n  ? for shortcuts\n');
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const ok = await cli(config, runner, ['peek', 'Nc', '-n', '2']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'two\nthree\n');
    const bad = await cli(config, runner, ['peek', 'nc-1', '-n', 'x']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /-n must be a positive whole number/);
  });

  it('attach uses insideTmux from the deps and exits 1 with a list when several run and there is no chooser', async () => {
    const config = makeConfig(scratch.sub('cli2'));
    const tmux = new FakeTmux();
    for (const t of ['NC-1', 'NC-2']) {
      seedTask(config, t);
      tmux.add(t.toLowerCase());
    }
    const runner = new RecordingRunner({ dryRun: false, respond: tmux.respond });
    const inside = await cli(config, runner, ['attach', 'nc-1'], { insideTmux: true });
    assert.equal(inside.code, 0, inside.stderr);
    assert.match(inside.stdout, /Ctrl-b d/);
    assert.ok(plain(runner).includes('tmux switch-client -t =agentctl'));
    const none = await cli(config, runner, ['attach']);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /more than one running task[\s\S]*NC-1[\s\S]*NC-2/);
  });
});
