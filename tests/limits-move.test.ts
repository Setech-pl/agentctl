import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { applySnapshot, handleKey, initialBoardState, promptText, runBoardEffect } from '../src/core/board.ts';
import type { BoardRow, BoardState } from '../src/core/board.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { notifierProblems, runDoctor } from '../src/core/doctor.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { Context } from '../src/core/context.ts';
import { DEFAULT_WINDOW_ICONS } from '../src/core/icons.ts';
import { continuationNote, describeMove, moveTask, nextTaskId, planMove } from '../src/core/move.ts';
import { classifyScreen, inputVisible, taskState } from '../src/core/state.ts';
import { collectStatus, stateHint } from '../src/core/status.ts';
import { tmuxLine } from '../src/core/statusline.ts';
import { parseTaskRecord, readTaskPrompt, readTaskRecord, recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const CLAUDE = DEFAULT_AGENT_SETTINGS.claude;
const CODEX = DEFAULT_AGENT_SETTINGS.codex;
const IDLE = 'Welcome\n❯ Try "x"';

describe('limit patterns', () => {
  const claude = (screen: string) => classifyScreen(screen, CLAUDE);
  const codex = (screen: string) => classifyScreen(screen, CODEX);

  it('Claude Code 2.1.309 texts (from the binary): session, weekly, model and spend limits, usage limit, extra usage, 429', () => {
    for (const line of [
      "  ⎿  You've hit your session limit · resets 3pm",
      "You've hit your weekly limit · resets Mon 9am",
      "● You've hit your Opus limit · resets 11pm",
      "You've hit your monthly spend limit · your limit resets Nov 1",
      'Usage limit reached · wrapping up',
      "You're out of extra usage · add more at claude.ai/settings/usage",
      'API Error: Request rejected (429) · this may be a temporary capacity issue.',
    ]) {
      assert.equal(claude(`${IDLE}\n${line}\n`), 'limited', line);
    }
  });

  it('Codex 0.166.0 texts (from the binary; the apostrophe there is U+2019)', () => {
    for (const line of [
      '■ You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 5:30 PM.',
      "■ You've hit your usage limit for gpt-6.1-sol. Switch to another model now,",
      'Usage limit reached. You’ve reached your usage limit. Increase your limits to continue using codex.',
      "You're out of credits. Your workspace is out of credits. Add credits to continue using Codex.",
      'Your workspace is out of credits. Ask your workspace owner to refill in order to continue.',
      'You hit your spend cap set in your workspace. Increase your spend cap to continue.',
    ]) {
      assert.equal(codex(`› Ask Codex\n${line}\n`), 'limited', line);
    }
  });

  it('quoted or discussed text is not a limit: the message has to open its line', () => {
    assert.equal(claude(`${IDLE}\n+  const msg = "You've hit your session limit";\n`), 'idle', 'a diff line');
    assert.equal(claude(`${IDLE}\n  42 │ You've hit your session limit\n`), 'idle', 'a numbered source line');
    assert.equal(claude(`${IDLE}\nThe message "You've hit your session limit" is shown by the TUI.\n`), 'idle', 'prose');
    assert.equal(codex('› hi\nSee Usage limit reached in the docs? No: "Usage limit reached" is a title.\n'), 'idle');
  });

  it('a running turn is not limited (the old message may still be on screen), a dialog and the trust prompt win', () => {
    assert.equal(claude(`${IDLE}\n  ⎿  You've hit your session limit\nThinking… esc to interrupt`), 'working');
    assert.equal(claude(`Quick safety check\n  ⎿  You've hit your session limit`), 'needs-trust');
    assert.equal(claude(`Enter to select · Esc to cancel\nUsage limit reached`), 'needs-input');
  });

  it('the permission dialogs of Claude and Codex are questions for the screen reader as well', () => {
    assert.equal(claude(' Do you want to proceed?\n ❯ 1. Yes\n   4. No\n Esc to cancel · Tab to amend'), 'needs-input');
    assert.equal(codex('  Would you like to run the following command?\n› 1. Yes, proceed (y)\n  Press enter to confirm or esc to cancel'), 'needs-input');
  });

  it('taskState: limited while the agent is idle, also with the input box back; the event alone is enough', () => {
    const base = { alive: true, settings: { ...CLAUDE }, reportReady: false };
    assert.equal(taskState({ ...base, screen: `${IDLE}\n  ⎿  You've hit your session limit` }), 'limited');
    assert.equal(taskState({ ...base, screen: IDLE, event: 'limited' }), 'limited');
    assert.equal(taskState({ ...base, screen: 'Thinking… esc to interrupt', event: 'limited' }), 'working');
    assert.equal(taskState({ ...base, screen: IDLE, event: 'needs-input' }), 'waiting', 'the input box is back: the question is gone');
    assert.equal(taskState({ ...base, screen: ' ❯ 1. Yes\n 2. No', event: 'needs-input' }), 'needs-input');
    assert.equal(taskState({ ...base, screen: '', alive: false, reportReady: true, event: 'limited' }), 'report-ready');
    assert.equal(inputVisible(IDLE, CLAUDE), true);
    assert.equal(inputVisible(' ❯ 1. Yes', CLAUDE), false);
  });

  it('limit_patterns of the config replace the defaults of that agent', () => {
    const c = makeConfig(scratch.sub('lp1'), 'agents:\n  claude:\n    limit_patterns: ["^quota gone"]\n');
    assert.equal(classifyScreen(`${IDLE}\nquota gone for today`, c.agents.claude), 'limited');
    assert.equal(classifyScreen(`${IDLE}\nYou've hit your session limit`, c.agents.claude), 'idle');
  });

  it('new states: icons, hints and the tmux status line', () => {
    assert.equal(DEFAULT_WINDOW_ICONS.limited, '⛔');
    assert.equal(DEFAULT_WINDOW_ICONS.superseded, '↪');
    assert.equal(makeConfig(scratch.sub('lp2'), 'watch: {window_icons: {limited: "L", superseded: "S"}}\n').watch.windowIcons?.limited, 'L');
    assert.equal(stateHint('NC-1', 'limited', false), 'usage limit reached: agentctl move NC-1');
    assert.match(stateHint('NC-1', 'limited', true) as string, /pinned \(pin: true\)/);
    assert.match(stateHint('NC-1', 'superseded', false, 'NC-1-2') as string, /moved to NC-1-2.*agentctl close NC-1/);
    assert.equal(stateHint('NC-1', 'working', false), null);
    const rows = [{ state: 'limited', pulled: null }, { state: 'working', pulled: null }, { state: 'superseded', pulled: null }] as Parameters<typeof tmuxLine>[0];
    assert.equal(tmuxLine(rows, null), '1⚙ 1⛔');
  });
});

describe('the task record keeps pin, continues and superseded_by', () => {
  it('round trip through TASK.md; a spec with pin: true sets it, the prompt stops at the first follow-up', () => {
    const config = makeConfig(scratch.sub('rec1'));
    const spec = resolveSpec(splitSpecs('---\ntask: NC-1\nagent: claude\nmodel: opus\neffort: high\npin: true\nrepos:\n  - {path: /r, worktree: /r-wt}\n---\nDo it.\n')[0]!, { config, loadProject: () => undefined });
    const record = recordFromSpec(spec, config, Date.now());
    assert.equal(record.pin, true);
    const text = renderTaskMd({ ...record, supersededBy: 'NC-1-2', continues: 'NC-0' }, 'Do it.');
    const back = parseTaskRecord(text);
    assert.equal(back?.pin, true);
    assert.equal(back?.supersededBy, 'NC-1-2');
    assert.equal(back?.continues, 'NC-0');
    assert.equal(parseTaskRecord(renderTaskMd({ ...record, pin: undefined as never }, 'x'))?.pin, undefined);
    fs.mkdirSync(path.dirname(taskFile(config, 'nc-1')), { recursive: true });
    fs.writeFileSync(taskFile(config, 'nc-1'), `${text}\n\n## Follow-up sent 2026-11-01T10:00:00Z\n\nAlso this.\n`);
    assert.equal(readTaskPrompt(config, 'nc-1'), 'Do it.');
  });
});

describe('move', () => {
  function setup(name: string, yaml = '', extra: Parameters<typeof seedTask>[2] = {}, confirm?: (q: string) => Promise<boolean>) {
    const config = makeConfig(scratch.sub(name), yaml);
    const fake = new FakeTmux();
    fake.newWindowScreen = '› Ask Codex to do anything\n';
    const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
    const out: string[] = [];
    const ctx = new Context(runner, config, (l) => out.push(l), confirm);
    const repo = scratch.sub(`${name}/app`);
    const worktree = scratch.sub(`${name}/app-wt`);
    const record = seedTask(config, 'NC-1', {
      repos: [{ path: repo, worktree }],
      links: [{ from: 'node_modules/x', to: '/somewhere/x' }],
      env: { NEON_CITY_TASK: 'NC-1' },
      requested: { agent: 'claude', model: 'opus', effort: 'high' },
      ...extra,
    });
    fake.add('nc-1', "  ⎿  You've hit your session limit · resets 3pm\n❯ ");
    return { config, fake, runner, ctx, out, record, worktree };
  }
  const SELF = ['/opt/node/bin/node', '/opt/agentctl/bin/agentctl.ts'];

  it('the note that is appended to the prompt', () => {
    assert.equal(
      continuationNote({ agent: 'claude', model: 'opus', report: '/cache/NC-1/NC-1.md' }),
      'Poprzedni agent (claude opus) przerwał przez limit. Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. Raport zapisz do /cache/NC-1/NC-1.md.',
    );
  });

  it('the plan: the other provider through the equivalents table, a free task ID, the original prompt plus the note', async () => {
    const t = setup('mv1');
    const plan = await planMove(t.ctx, 'nc-1');
    assert.deepEqual(plan.to, { agent: 'codex', model: 'gpt-6-astra', effort: 'medium' });
    assert.equal(plan.task, 'NC-1-2');
    assert.equal(plan.window, 'nc-1-2');
    assert.equal(plan.prompt, `Do NC-1.\n\n${continuationNote(t.record)}`);
    assert.match(describeMove(plan).join('\n'), /Move NC-1 \(claude opus\/high\) -> NC-1-2 \(codex gpt-6-astra\/medium\)[\s\S]*the same one[\s\S]*superseded/);
  });

  it('--agent picks the provider; the other direction maps too; same provider is an error', async () => {
    const t = setup('mv2', '', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', requested: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
    assert.deepEqual((await planMove(t.ctx, 'NC-1')).to, { agent: 'claude', model: 'sonnet', effort: 'high' });
    await assert.rejects(planMove(t.ctx, 'NC-1', { agent: 'codex' }), /already runs on codex/);
  });

  it('refuses: pinned, already moved, unknown agent, no equivalent (fable / max), no worktree, unknown task', async () => {
    await assert.rejects(planMove(setup('mv3a', '', { pin: true }).ctx, 'NC-1'), /NC-1 is pinned \(pin: true\): it is never moved/);
    await assert.rejects(planMove(setup('mv3b', '', { supersededBy: 'NC-1-2' }).ctx, 'NC-1'), /already moved to NC-1-2/);
    await assert.rejects(planMove(setup('mv3c', '', { agent: 'unknown' }).ctx, 'NC-1'), /agent of NC-1 is unknown/);
    await assert.rejects(planMove(setup('mv3d', '', { model: 'fable', effort: 'high' }).ctx, 'NC-1'), /no equivalent in codex/);
    await assert.rejects(planMove(setup('mv3e', '', { effort: 'max' }).ctx, 'NC-1'), /fable and effort max are not mapped/);
    await assert.rejects(planMove(setup('mv3f', '', { repos: [] }).ctx, 'NC-1'), /no worktree recorded/);
    await assert.rejects(planMove(setup('mv3g').ctx, 'zz'), /no task "zz"/);
  });

  it('a user pair in equivalents is used', async () => {
    const t = setup('mv4', 'equivalents:\n  - {claude: "opus/high", codex: "gpt-6.1-sol/xhigh"}\n');
    assert.deepEqual((await planMove(t.ctx, 'NC-1')).to, { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  });

  it('the next free ID: -2, then -3 when -2 exists', async () => {
    assert.equal(nextTaskId('NC-1', (c) => c === 'NC-1-2'), 'NC-1-3');
    const t = setup('mv5');
    seedTask(t.config, 'NC-1-2');
    assert.equal((await planMove(t.ctx, 'NC-1')).task, 'NC-1-3');
  });

  it('always asks y/N: no terminal and no -y is an error, N does nothing, y starts the window', async () => {
    const quiet = setup('mv6a');
    await assert.rejects(moveTask(quiet.ctx, 'NC-1', { self: SELF }), /no terminal to ask on/);
    assert.ok(!quiet.fake.windows.some((w) => w.name === 'nc-1-2'));
    const no = setup('mv6b', '', {}, async () => false);
    assert.equal(await moveTask(no.ctx, 'NC-1', { self: SELF }), undefined);
    assert.ok(!no.fake.windows.some((w) => w.name === 'nc-1-2'));
    const asked: string[] = [];
    const yes = setup('mv6c', '', {}, async (q) => (asked.push(q), true));
    assert.ok(await moveTask(yes.ctx, 'NC-1', { self: SELF }));
    assert.deepEqual(asked, ['Move? [y/N] ']);
    assert.ok(yes.fake.windows.some((w) => w.name === 'nc-1-2'));
  });

  it('starts <task>-2 in the same worktree with the prompt, wires the events, and marks the old task superseded', async () => {
    const t = setup('mv7');
    const result = await moveTask(t.ctx, 'NC-1', { yes: true, self: SELF });
    assert.equal(result?.plan.task, 'NC-1-2');

    const typed = t.runner.commands.find((c) => c.includes(' -l -- ') && c.includes('codex')) as string;
    assert.match(typed, /codex --sandbox danger-full-access -m gpt-6-astra -c model_reasoning_effort=medium -c '\\''notify=\[/);
    assert.ok(t.runner.commands.some((c) => c.startsWith('tmux new-window') && c.includes('-n nc-1-2') && c.includes(`-c ${t.worktree}`)), 'the same worktree');
    assert.ok(!t.runner.commands.some((c) => c.includes('worktree add')), 'no new worktree');
    const pasted = t.runner.calls.find((c) => c.line.startsWith('tmux load-buffer') && c.input?.includes('Poprzedni agent'));
    assert.equal(pasted?.input, `Model: gpt-6-astra · effort medium\n\nDo NC-1.\n\n${continuationNote(t.record)}`);

    const fresh = readTaskRecord(t.config, 'nc-1-2');
    assert.equal(fresh?.agent, 'codex');
    assert.equal(fresh?.model, 'gpt-6-astra');
    assert.deepEqual(fresh?.repos, t.record.repos);
    assert.equal(fresh?.report, t.record.report);
    assert.deepEqual(fresh?.env, { NEON_CITY_TASK: 'NC-1' });
    assert.equal(fresh?.continues, 'NC-1');
    assert.equal(fresh?.switchedBy, 'limit');
    assert.deepEqual(fresh?.requested, { agent: 'claude', model: 'opus', effort: 'high' });
    assert.equal(readTaskRecord(t.config, 'nc-1')?.supersededBy, 'NC-1-2');
    assert.equal(readTaskPrompt(t.config, 'nc-1'), 'Do NC-1.', 'the old prompt is untouched');
    assert.match(t.out.join('\n'), /NC-1 -> NC-1-2: running on codex gpt-6-astra\/medium\. The old window nc-1 stays open \(superseded\)\./);
  });

  it('status and the board: the old row is superseded (no notification), the new one runs', async () => {
    const t = setup('mv8');
    await moveTask(t.ctx, 'NC-1', { yes: true, self: SELF });
    const rows = await collectStatus(t.ctx, { progress: false });
    assert.deepEqual(rows.map((r) => `${r.task}:${r.state}`), ['NC-1:superseded', 'NC-1-2:waiting']);
    assert.equal(rows[0]?.hint, 'moved to NC-1-2; close this window when you are done: agentctl close NC-1');
    assert.equal(rows[1]?.switchedBy, 'limit');
    await assert.rejects(planMove(t.ctx, 'NC-1'), /already moved to NC-1-2/);
  });

  it('a full target provider stops the move before anything starts', async () => {
    const t = setup('mv9', 'limits: {codex: 1}\n');
    seedTask(t.config, 'NC-7', { agent: 'codex', model: 'gpt-6.1-sol' });
    t.fake.add('nc-7', IDLE);
    await assert.rejects(moveTask(t.ctx, 'NC-1', { yes: true, self: SELF }), /window limit for codex reached/);
    assert.ok(!t.fake.windows.some((w) => w.name === 'nc-1-2'));
    assert.equal(readTaskRecord(t.config, 'nc-1')?.supersededBy, undefined);
  });

  it('through the CLI: -y moves, pinned fails with exit 1, no terminal without -y fails', async () => {
    const t = setup('mv10');
    const stderr: string[] = [];
    const deps: CliDeps = {
      stdout: () => {},
      stderr: (s) => stderr.push(s),
      readStdin: () => '',
      stdinIsTTY: false,
      loadConfig: () => t.config,
      confirm: undefined,
      readClipboard: async () => '',
      watchCommand: () => 'agentctl watch',
      makeRunner: () => t.runner,
      selfArgv: () => SELF,
    };
    assert.equal(await main(['move', 'NC-1'], deps), 1);
    assert.match(stderr.join(''), /no terminal to ask on/);
    assert.equal(await main(['move', 'NC-1', '-y', '--agent', 'claude'], deps), 1);
    assert.match(stderr.join(''), /already runs on claude/);
    assert.equal(await main(['move', 'NC-1', '-y'], deps), 0);
    assert.equal(readTaskRecord(t.config, 'nc-1')?.supersededBy, 'NC-1-2');
    seedTask(t.config, 'NC-9', { pin: true });
    assert.equal(await main(['move', 'NC-9', '-y'], deps), 1);
    assert.match(stderr.join(''), /NC-9 is pinned/);
  });
});

describe('board: M moves a task', () => {
  const row = (task: string, extra: Partial<BoardRow> = {}): BoardRow =>
    ({
      task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
      state: 'limited', window: 'alive', windowName: task.toLowerCase(), windowId: '@1', started: '', startedLocal: '', duration: '1m', report: 'missing',
      reportPath: '', pulled: null, lastLine: '', progress: null, hint: null, question: null, pin: false, worktrees: [], ...extra,
    }) as BoardRow;
  const boardOf = (rows: BoardRow[]): BoardState => applySnapshot(initialBoardState(100, 30), { rows, preview: null, refreshedAt: '09:00:00' });
  const press = (state: BoardState, input: string) => handleKey(state, input, {});

  it('M asks first; y starts the move, anything else cancels', () => {
    const asked = press(boardOf([row('NC-1')]), 'M');
    assert.deepEqual(asked.state.mode, { kind: 'confirm', action: 'move', task: 'NC-1' });
    assert.deepEqual(asked.effects, []);
    assert.match(promptText(asked.state) as string, /^Move NC-1 to the other provider\?.*\[y\/N\]$/);
    const yes = press(asked.state, 'y');
    assert.deepEqual(yes.effects, [{ type: 'move', task: 'NC-1' }]);
    assert.equal(yes.state.mode.kind, 'list');
    for (const key of ['n', 'x', '']) {
      const r = handleKey(asked.state, key, { escape: key === '' });
      assert.deepEqual(r.effects, []);
      assert.equal(r.state.notice?.text, 'Cancelled.');
    }
  });

  it('lower-case m is still the message key; a pinned or already moved task cannot be moved', () => {
    assert.equal(press(boardOf([row('NC-1')]), 'm').state.mode.kind, 'input');
    const pinned = press(boardOf([row('NC-1', { pin: true })]), 'M');
    assert.equal(pinned.state.mode.kind, 'list');
    assert.match(pinned.state.notice?.text as string, /pinned \(pin: true\)/);
    const done = press(boardOf([row('NC-1', { state: 'superseded' })]), 'M');
    assert.match(done.state.notice?.text as string, /already moved/);
    assert.equal(press(boardOf([]), 'M').state.notice?.level, 'error');
  });

  it('the effect moves the task with the core function and reports the new one', async () => {
    const config = makeConfig(scratch.sub('bm1'));
    const fake = new FakeTmux();
    fake.newWindowScreen = '› Ask Codex to do anything\n';
    const runner = new DiskRunner({ dryRun: false, respond: fake.respond, startTime: Date.now() });
    seedTask(config, 'NC-1', { repos: [{ path: scratch.sub('bm1/app'), worktree: scratch.sub('bm1/app-wt') }] });
    fake.add('nc-1', IDLE);
    const notice = await runBoardEffect(runner, config, { type: 'move', task: 'NC-1' }, { insideTmux: false, self: SELF_FOR_BOARD });
    assert.deepEqual(notice, { level: 'info', text: 'NC-1 -> NC-1-2 (codex); the old window stays open' });
    const failed = await runBoardEffect(runner, config, { type: 'move', task: 'NC-1' }, { insideTmux: false });
    assert.equal(failed.level, 'error');
    assert.match(failed.text, /already moved/);
  });
});

const SELF_FOR_BOARD: string[] = ['/opt/node/bin/node', '/opt/agentctl/bin/agentctl.ts'];

describe('doctor: notifications', () => {
  const run = async (platform: string, respond: (cmd: string, args: string[]) => { code?: number; stdout?: string } | undefined) => {
    const config = makeConfig(scratch.sub(`doc-${platform}-${Math.random().toString(36).slice(2, 6)}`));
    const checks = await runDoctor(new RecordingRunner({ dryRun: false, respond }), () => config, scratch.dir, '26.0.0', platform);
    return checks.find((c) => c.name === 'notifications');
  };
  const found = (diagnose: string) => (cmd: string, args: string[]) => {
    if (cmd === 'sh' && String(args[1]).includes('terminal-notifier')) return { stdout: '/opt/homebrew/bin/terminal-notifier\n' };
    if (cmd === '/opt/homebrew/bin/terminal-notifier') return { stdout: diagnose };
    return undefined;
  };

  it('terminal-notifier that works: ok', async () => {
    assert.equal((await run('darwin', found('terminal-notifier 3.1.0\n  authorization       granted\n')))?.status, 'ok');
  });

  it('terminal-notifier with problems (no permission yet, alert style None): a warning that names them, never a failure', async () => {
    const c = await run('darwin', found('terminal-notifier 3.1.0\n\nProblems found:\n  - Permission has never been requested. Send one notification and approve the prompt.\n  - Alert style is None. Set it to Banners or Alerts in System Settings > Notifications.\n'));
    assert.equal(c?.status, 'warn');
    assert.match(c?.detail as string, /will not show notifications yet: Permission has never been requested\..*Alert style is None\./);
  });

  it('without terminal-notifier: a warning with the brew command; on Linux notify-send is fine', async () => {
    const c = await run('darwin', (cmd) => (cmd === 'sh' ? { code: 1 } : undefined));
    assert.equal(c?.status, 'warn');
    assert.match(c?.detail as string, /brew install terminal-notifier/);
    assert.equal((await run('linux', () => undefined))?.status, 'ok');
    assert.deepEqual(notifierProblems('terminal-notifier 2.0.0\nUsage: ...'), []);
  });
});
