import { readTaskRecord } from '../src/core/taskstore.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { buildResumeArgv } from '../src/core/agents.ts';
import { handleKey, initialBoardState, listItems, loadBoard, ProgressCache, runBoardEffect } from '../src/core/board.ts';
import type { BoardRow, BoardState } from '../src/core/board.ts';
import { DEFAULT_AGENT_SETTINGS, loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { findResumable, planResume, resumeTasks, resumeText } from '../src/core/resume.ts';
import { sessionsFile } from '../src/core/usage.ts';
import { announceResumable } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const SELF = ['/usr/bin/env', '/opt/node/bin/node', '--experimental-strip-types', '--no-warnings', '/opt/agentctl/bin/agentctl.ts'];

function world(name: string, extra = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, extra);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const ctx = new Context(runner, config, () => {});
  /** A task with a worktree on disk. */
  const task = (id: string, extra2: Parameters<typeof seedTask>[2] = {}, session?: { agent: 'claude' | 'codex'; id: string }) => {
    const wt = path.join(root, 'wt', id.toLowerCase());
    fs.mkdirSync(wt, { recursive: true });
    const record = seedTask(config, id, { repos: [{ path: path.join(root, 'app'), worktree: wt }], ...extra2 });
    if (session) fs.writeFileSync(sessionsFile(config, record.window), JSON.stringify({ [session.agent]: [{ id: session.id }] }));
    return record;
  };
  return { root, config, tmux, runner, ctx, task };
}

describe('resume: argv per agent', () => {
  const claude = DEFAULT_AGENT_SETTINGS.claude;
  const codex = DEFAULT_AGENT_SETTINGS.codex;
  it('claude: --resume <session> when known, else --continue; model, effort and the event wiring as at the start', () => {
    assert.deepEqual(buildResumeArgv({ agent: 'claude', model: 'opus', effort: 'high' }, claude, ['--settings', '/s.json'], 'abc-123'), ['claude', '--model', 'opus', '--effort', 'high', '--settings', '/s.json', '--resume', 'abc-123']);
    assert.deepEqual(buildResumeArgv({ agent: 'claude', model: 'default', effort: 'low' }, claude), ['claude', '--effort', 'low', '--continue']);
  });
  it('codex: resume <session> or resume --last, then the same flags; the sandbox stays', () => {
    assert.deepEqual(buildResumeArgv({ agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium' }, codex, ['-c', 'notify=["x"]'], 'sess-9'), ['codex', 'resume', 'sess-9', '--sandbox', 'danger-full-access', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', '-c', 'notify=["x"]']);
    assert.deepEqual(buildResumeArgv({ agent: 'codex', model: 'default', effort: 'high' }, codex).slice(0, 3), ['codex', 'resume', '--last']);
  });
});

describe('resume: which tasks', () => {
  it('active tasks with a worktree and no window; a report, a window, closed, cancelled, hidden or no worktree keep a task out', async () => {
    const w = world('which');
    w.task('NC-1');
    const withReport = w.task('NC-2');
    fs.mkdirSync(path.dirname(withReport.report), { recursive: true });
    fs.writeFileSync(withReport.report, '# NC-2\n');
    w.task('NC-3');
    w.tmux.add('nc-3', '❯ ');
    w.task('NC-4', { closed: true });
    w.task('NC-5', { cancelled: true });
    w.task('NC-6', { hidden: true });
    seedTask(w.config, 'NC-7', { repos: [{ path: '/x', worktree: path.join(w.root, 'wt', 'gone') }] });
    assert.deepEqual((await findResumable(w.ctx)).map((c) => c.task), ['NC-1']);
    assert.deepEqual((await findResumable(w.ctx, { all: true })).map((c) => c.task), ['NC-1', 'NC-2']);
  });

  it('typed tasks must be resumable (a prefix is enough); the limit of a provider is respected', async () => {
    const w = world('typed', 'limits:\n  claude: 2\n');
    w.task('NC-1');
    w.task('NC-2');
    w.task('NC-3');
    w.tmux.add('nc-9', '❯ ');
    seedTask(w.config, 'NC-9');
    const plan = await planResume(w.ctx, []);
    assert.deepEqual(plan.items.map((i) => i.task), ['NC-1'], 'one window is taken, the limit is 2');
    assert.match(plan.skipped.map((s) => `${s.task}: ${s.reason}`).join('\n'), /NC-2: window limit for claude reached/);
    assert.deepEqual((await planResume(w.ctx, ['nc-3'])).items.map((i) => i.task), ['NC-3']);
    await assert.rejects(planResume(w.ctx, ['NC-4']), /NC-4 cannot be resumed/);
    await assert.rejects(planResume(w.ctx, ['NC-']), /fits more than one task/);
  });
});

describe('resume: starting the agents', () => {
  it('after the tmux server is gone: a session and windows come back, the agent starts in resume mode, the prompt is not pasted', async () => {
    const w = world('start');
    w.task('NC-1', {}, { agent: 'claude', id: 'aaaa-bbbb' });
    w.task('NC-2', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    assert.equal(w.tmux.windows.length, 0);
    const plan = await planResume(w.ctx, []);
    const results = await resumeTasks(w.ctx, plan, { self: SELF as never });
    assert.deepEqual(results.map((r) => r.task), ['NC-1', 'NC-2']);
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['nc-1', 'nc-2']);
    assert.match(results[0]?.command ?? '', /^claude --model opus --effort high --settings \S+claude-settings\.json --resume aaaa-bbbb$/);
    assert.match(results[1]?.command ?? '', /^codex resume --last --sandbox danger-full-access -m gpt-6\.1-sol -c model_reasoning_effort=high -c 'notify=/);
    const cmds = w.runner.commands.join('\n');
    assert.ok(w.runner.calls.filter(c => c.line.includes('load-buffer')).every(c => c.input?.startsWith('Report protocol:')), 'only new attempt instructions, not the original task prompt');
    assert.ok(readTaskRecord(w.config, 'nc-1')!.attemptId);
    assert.ok(fs.existsSync(path.join(w.config.stateDir, 'nc-1', 'claude-settings.json')), 'the hooks and the usage tap are wired again');
    assert.match(fs.readFileSync(path.join(w.config.stateDir, 'nc-1', 'claude-settings.json'), 'utf8'), /usage-tap/);
    assert.match(fs.readFileSync(path.join(w.config.stateDir, 'nc-1', 'TASK.md'), 'utf8'), /window_id: ['"]?@/);
    assert.deepEqual((await findResumable(w.ctx)).map((c) => c.task), [], 'nothing left to resume: the windows are there');
  });

  it('notify.events: false starts the agent without hooks', async () => {
    const w = world('start-noevents', 'notify:\n  events: false\n');
    w.task('NC-1');
    const results = await resumeTasks(w.ctx, await planResume(w.ctx, []), { self: SELF as never });
    assert.equal(results[0]?.command, 'claude --model opus --effort high --continue');
  });
});

describe('resume: CLI, watch, up', () => {
  it('agentctl resume: list and y/N (no terminal: needs -y), --dry-run, nothing to do', async () => {
    const w = world('cli');
    assert.match((await runCli(w.config, w.runner, ['resume'])).stdout, /Nothing to resume/);
    w.task('NC-1');
    const noTty = await runCli(w.config, w.runner, ['resume']);
    assert.equal(noTty.code, 1);
    assert.match(noTty.stderr, /no terminal to ask on/);
    const no = await runCli(w.config, w.runner, ['resume'], { confirm: async () => false });
    assert.match(no.stdout, /Aborted/);
    assert.equal(w.tmux.windows.length, 0);
    const yes = await runCli(w.config, w.runner, ['resume', '-y'], { selfArgv: () => SELF as never });
    assert.equal(yes.code, 0, yes.stderr);
    assert.match(yes.stdout, /Resume 1 task:/);
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['nc-1']);
  });

  it('the watcher says once, at its start, how many tasks can be resumed', async () => {
    const w = world('watch');
    const sent: string[] = [];
    const notifier: Notifier = { clickable: false, notify: async (_t, m) => void sent.push(m) };
    assert.equal(await announceResumable(w.ctx, notifier), 0);
    w.task('NC-1');
    w.task('NC-2');
    assert.equal(await announceResumable(w.ctx, notifier), 2);
    assert.deepEqual(sent, ['2 zadania do wznowienia (agentctl resume)']);
    assert.deepEqual([1, 2, 5, 12, 22].map(resumeText), ['1 zadanie do wznowienia (agentctl resume)', '2 zadania do wznowienia (agentctl resume)', '5 zadań do wznowienia (agentctl resume)', '12 zadań do wznowienia (agentctl resume)', '22 zadania do wznowienia (agentctl resume)']);
  });

  it('agentctl up: watcher and board windows (never a second copy), the resume hint, the command to open the board without a terminal', async () => {
    const w = world('up');
    w.task('NC-1');
    const first = await runCli(w.config, w.runner, ['up']);
    assert.equal(first.code, 0, first.stderr);
    const names = w.tmux.windows.map((x) => x.name).sort();
    assert.deepEqual(names, ['board', 'watch']);
    assert.match(first.stdout, /1 task to resume \(NC-1\): agentctl resume/);
    assert.match(first.stdout, /Open the board: tmux attach -t agentctl \\; select-window -t board/);
    const second = await runCli(w.config, w.runner, ['up']);
    assert.match(second.stdout, /Window agentctl:watch already exists, left alone/);
    assert.match(second.stdout, /Window agentctl:board already exists, left alone/);
    assert.deepEqual(w.tmux.windows.map((x) => x.name).sort(), ['board', 'watch']);
  });

  it('agentctl up in a terminal goes to the board (switch inside tmux, attach outside)', async () => {
    const w = world('up-tty');
    await runCli(w.config, w.runner, ['up']);
    const inside = await runCli(w.config, w.runner, ['up'], { stdinIsTTY: true, insideTmux: true });
    assert.equal(inside.code, 0, inside.stderr);
    assert.ok(w.tmux.seen.some((s) => s.startsWith('select-window')), w.tmux.seen.join());
    assert.ok(w.runner.commands.some((c) => c.includes('switch-client')), w.runner.commands.join('\n'));
  });
});

describe('resume: the board and the chat', () => {
  const row = (task: string): BoardRow => ({
    task, agent: 'claude', model: 'opus', effort: 'high', requested: 'claude opus/high', effective: 'claude opus/high', switchedBy: null,
    state: 'dead', window: 'gone', windowName: task.toLowerCase(), windowId: null, started: '', startedLocal: '', duration: '1m', report: 'missing', reportPath: '', pulled: null,
    lastLine: '', progress: null, hint: null, question: null, pin: false, finished: true, hidden: false, hiddenBy: null, closed: false, closedAt: null, archived: false,
    cancelled: false, cancelledAt: null, cancelReason: null, cohort: null, supersededBy: null, continues: null, worktrees: [], collide: [],
  });

  it('R asks first, y resumes, Esc and n do not; with nothing to resume it says so; the section lists the tasks', () => {
    const empty = handleKey(initialBoardState(100, 30), 'R', {});
    assert.deepEqual(empty.effects, []);
    assert.match(empty.state.notice?.text ?? '', /Nothing to resume/);
    const state: BoardState = { ...initialBoardState(100, 30), rows: [row('A-1'), row('A-2')], resumable: ['A-1', 'A-2'], showFinished: true };
    const asked = handleKey(state, 'R', {});
    assert.deepEqual(asked.state.mode, { kind: 'confirm', action: 'resume', task: 'A-1, A-2' });
    assert.deepEqual(handleKey(asked.state, 'y', {}).effects, [{ type: 'resume' }]);
    assert.deepEqual(handleKey(asked.state, 'n', {}).effects, []);
    assert.deepEqual(handleKey(asked.state, '', { escape: true }).effects, []);
    const items = listItems(state);
    assert.deepEqual(items.filter((i) => i.kind === 'resume-title' || i.kind === 'resume').map((i) => (i.kind === 'resume' ? i.task : i.kind)), ['resume-title', 'A-1', 'A-2']);
  });

  it('loadBoard carries the resumable tasks and the effect resumes them', async () => {
    const w = world('board');
    w.task('NC-1');
    const snap = await loadBoard(w.ctx, null, new ProgressCache());
    assert.deepEqual(snap.resumable, ['NC-1']);
    const notice = await runBoardEffect(w.runner, w.config, { type: 'resume' }, { insideTmux: false });
    assert.deepEqual(notice, { level: 'info', text: 'Resumed: NC-1' });
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['nc-1']);
    assert.deepEqual((await runBoardEffect(w.runner, w.config, { type: 'resume' }, { insideTmux: false })).text, 'Nothing to resume.');
  });

  it('MCP resume: off by default, a summary first, confirm: true resumes', async () => {
    const w = world('mcp', 'mcp:\n  allow: [mark]\n');
    w.task('NC-1');
    const deps: McpDeps = { context: (out) => new Context(w.runner, loadGlobalConfig(path.dirname(w.config.path)), out), notify: async () => undefined, self: SELF as never };
    const tool = MCP_TOOLS.find((t) => t.name === 'resume')!;
    const call = (args: Record<string, unknown> = {}) => tool.run(deps, z.object(tool.input).parse(args) as never);
    assert.equal((await call()).isError, true);
    fs.appendFileSync(w.config.path, 'mcp:\n  allow: [resume]\n'.replace('mcp:', 'x_mcp:'));
    fs.writeFileSync(w.config.path, fs.readFileSync(w.config.path, 'utf8').replace(/mcp:\n {2}allow: \[mark\]\n/, 'mcp:\n  allow: [resume]\n').replace(/x_mcp:\n {2}allow: \[resume\]\n/, ''));
    const preview = await call();
    assert.match(preview.text, /Resume 1 task:/);
    assert.match(preview.text, /confirm: true/);
    assert.equal(w.tmux.windows.length, 0);
    const done = await call({ confirm: true });
    assert.match(done.text, /Resumed: NC-1/);
    assert.deepEqual(w.tmux.windows.map((x) => x.name), ['nc-1']);
    assert.match((await call({ tasks: ['NC-1'] })).text, /cannot be resumed/);
  });
});
