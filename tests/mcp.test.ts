import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { auditPath, MAX_PEEK_LINES, MAX_SEND_CHARS, MAX_TEXT_BYTES, MCP_TOOL_NAMES, MCP_TOOLS, readReportFile, statusLine } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import { readTaskPrompt, readTaskRecord, taskFile } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const SELF = ['/usr/bin/env', 'AGENTCTL_HOME=/h', '/opt/node/bin/node', '--experimental-strip-types', '--no-warnings', '/opt/agentctl/bin/agentctl.ts'];
const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';
const IDLE = 'Welcome\n❯ \n  ⏵⏵ auto mode on';

const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;
const schemaOf = (name: string) => z.object(tool(name).input);

/** The config file as the user would edit it; the server reads it again on every call. */
function writeConfig(config: GlobalConfig, extra = ''): void {
  fs.writeFileSync(config.path, `cache: ${config.cache}\nstate_dir: ${config.stateDir}\n${extra}`);
}

function setup(name: string, extraYaml = '') {
  const config = makeConfig(scratch.sub(name), extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() });
  const notified: string[] = [];
  const outLines: string[] = [];
  let notifyFails = false;
  const deps: McpDeps = {
    context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), (l) => (out(l), outLines.push(l))),
    notify: async (m) => {
      if (notifyFails) throw new Error('no notifier');
      notified.push(m);
    },
    self: SELF as never,
  };
  const call = (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(name).run(deps, schemaOf(name).parse(args) as never);
  const audit = (): { tool: string; task?: string; outcome: string; detail?: string }[] =>
    fs.existsSync(auditPath(config)) ? fs.readFileSync(auditPath(config), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
  return { config, tmux, runner, deps, notified, outLines, call, audit, failNotify: () => void (notifyFails = true) };
}

function withReport(config: GlobalConfig, task: string, text = `# ${task}\nWerdykt: PASS\n`, extra: Parameters<typeof seedTask>[2] = {}) {
  const record = seedTask(config, task, extra);
  fs.mkdirSync(path.dirname(record.report), { recursive: true });
  fs.writeFileSync(record.report, text);
  return record;
}

describe('mcp: the registry', () => {
  it('has the six read tools and the five write tools, with unique short names', () => {
    assert.deepEqual(MCP_TOOLS.filter((t) => t.kind === 'read').map((t) => t.name), ['status', 'peek', 'list_reports', 'get_report', 'pull_ready', 'task_spec']);
    assert.deepEqual(MCP_TOOLS.filter((t) => t.kind === 'write').map((t) => t.name), ['send', 'new', 'interrupt', 'close', 'move']);
    assert.equal(new Set(MCP_TOOL_NAMES).size, MCP_TOOL_NAMES.length);
    for (const t of MCP_TOOLS) assert.ok(t.name.length <= 64 && /^[a-z_]+$/.test(t.name), t.name);
  });

  it('the descriptions tell the chat when to use each tool, and mark the write tools', () => {
    assert.match(tool('status').description, /FIRST/);
    assert.match(tool('pull_ready').description, /START of discussing/);
    assert.match(tool('peek').description, /what a task is doing right now/);
    assert.match(tool('get_report').description, /never another path/);
    for (const t of MCP_TOOLS.filter((x) => x.kind === 'write')) assert.match(t.description, /^WRITE, off unless the user put "\w+" in mcp\.allow/, t.name);
    assert.match(tool('new').description, /confirm: true/);
    assert.match(tool('move').description, /confirm: true/);
    for (const t of MCP_TOOLS) assert.ok(t.description.length > 80, t.name);
  });

  it('the annotations are honest: reads are read-only, pull_ready and the writes are not, close is destructive', () => {
    for (const t of MCP_TOOLS.filter((x) => x.kind === 'read' && x.name !== 'pull_ready')) assert.equal(t.annotations.readOnlyHint, true, t.name);
    for (const t of MCP_TOOLS.filter((x) => x.kind === 'write' || x.name === 'pull_ready')) assert.equal(t.annotations.readOnlyHint, false, t.name);
    assert.equal(tool('close').annotations.destructiveHint, true);
    assert.ok(MCP_TOOLS.every((t) => t.annotations.openWorldHint === false && t.annotations.title === t.title));
  });

  it('the schemas take what they should and refuse the rest', () => {
    assert.ok(schemaOf('peek').safeParse({ task: 'NC-1', lines: MAX_PEEK_LINES }).success);
    assert.ok(!schemaOf('peek').safeParse({ task: 'NC-1', lines: MAX_PEEK_LINES + 1 }).success);
    assert.ok(!schemaOf('peek').safeParse({ task: 'NC-1', lines: 0 }).success);
    assert.ok(!schemaOf('peek').safeParse({ task: '' }).success);
    assert.ok(!schemaOf('get_report').safeParse({}).success);
    assert.ok(!schemaOf('send').safeParse({ task: 'NC-1', text: 'x'.repeat(MAX_SEND_CHARS + 1) }).success);
    assert.ok(schemaOf('new').safeParse({ spec: '---\ntask: A\n---\nx', confirm: true }).success);
    assert.ok(!schemaOf('move').safeParse({ task: 'NC-1', agent: 'gemini' }).success);
    assert.ok(schemaOf('status').safeParse({}).success && schemaOf('pull_ready').safeParse({}).success);
    assert.ok(!('path' in tool('get_report').input) && !('file' in tool('get_report').input), 'no tool takes a path');
    for (const t of MCP_TOOLS) assert.ok(!Object.keys(t.input).some((k) => /path|file|command|shell|branch/i.test(k)), t.name);
  });
});

describe('mcp: reading', () => {
  it('status: counts and rows; hidden and closed tasks only with all', async () => {
    const t = setup('r1');
    seedTask(t.config, 'NC-1');
    seedTask(t.config, 'NC-2', { hidden: true });
    seedTask(t.config, 'NC-3', { closed: true });
    t.tmux.add('nc-1', WORKING);
    const plain = await t.call('status');
    assert.match(plain.text, /^1 task: 1 working \(2 hidden or closed not shown; all: true lists them\)/);
    const rows = JSON.parse(plain.text.slice(plain.text.indexOf('['))) as { task: string; state: string }[];
    assert.deepEqual(rows.map((r) => [r.task, r.state]), [['NC-1', 'working']]);
    const all = await t.call('status', { all: true });
    assert.match(all.text, /^3 tasks: 1 working, 1 waiting, 1 closed|^3 tasks: .*closed/);
    assert.deepEqual((JSON.parse(all.text.slice(all.text.indexOf('['))) as { task: string }[]).map((r) => r.task), ['NC-1', 'NC-2', 'NC-3']);
    assert.equal(statusLine([], 0), 'No tasks');
  });

  it('peek: the last lines of a running window without the footer; a task without a window is an error with a hint', async () => {
    const t = setup('r2');
    seedTask(t.config, 'NC-1');
    seedTask(t.config, 'NC-2');
    t.tmux.add('nc-1', `line one\nline two\nline three\n  ⏵⏵ auto mode on (shift+tab to cycle)\n❯ `);
    const r = await t.call('peek', { task: 'nc-1', lines: 2 });
    assert.match(r.text, /^NC-1: last 2 lines of its window \(agent footer removed\)\n\nline two\nline three$/);
    const gone = await t.call('peek', { task: 'NC-2' });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /NC-2 has no tmux window/);
  });

  it('get_report: the report file of the task, found by a unique prefix, also for a closed task; it does not mark it pulled', async () => {
    const t = setup('r3');
    withReport(t.config, 'NC-42', '# NC-42\nWerdykt: PASS\n');
    withReport(t.config, 'OLD-7', '# old\n', { closed: true });
    assert.equal((await t.call('get_report', { task: 'nc-4' })).text, '=== NC-42 (claude opus/high) ===\n# NC-42\nWerdykt: PASS');
    assert.match((await t.call('get_report', { task: 'OLD-7' })).text, /# old/);
    assert.equal(readTaskRecord(t.config, 'nc-42')?.pulled, undefined);
  });

  it('get_report never takes a path: whatever is given must name a task', async () => {
    const t = setup('r4');
    withReport(t.config, 'NC-1');
    for (const arg of ['/etc/passwd', '../../../etc/passwd', '~/.ssh/id_rsa', 'nc-1/NC-1.md', 'NC-1/../NC-1', './NC-1']) {
      const r = await t.call('get_report', { task: arg });
      assert.equal(r.isError, true, arg);
      assert.match(r.text, /^no task /, arg);
    }
    // A long absolute path, such as the report's own, does not even pass the schema.
    assert.ok(!schemaOf('get_report').safeParse({ task: `${t.config.cache}/nc-1/NC-1.md` }).success);
  });

  it('get_report refuses a report that an agent replaced with a symbolic link, and a directory', async () => {
    const t = setup('r5');
    const secret = path.join(scratch.sub('r5-secret'), 'secret.txt');
    fs.writeFileSync(secret, 'TOP SECRET');
    const record = withReport(t.config, 'NC-1');
    fs.rmSync(record.report);
    fs.symlinkSync(secret, record.report);
    const r = await t.call('get_report', { task: 'NC-1' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not a regular file; refusing/);
    assert.ok(!r.text.includes('TOP SECRET'));
    fs.rmSync(record.report);
    fs.mkdirSync(record.report);
    assert.match((await t.call('get_report', { task: 'NC-1' })).text, /not a regular file/);
  });

  it('get_report cuts a report at 200 KB and says so; a missing report is an error with a hint', async () => {
    const t = setup('r6');
    const big = 'x'.repeat(MAX_TEXT_BYTES + 5000);
    withReport(t.config, 'NC-1', big);
    const r = await t.call('get_report', { task: 'NC-1' });
    assert.ok(Buffer.byteLength(r.text) < MAX_TEXT_BYTES + 400);
    assert.ok(r.text.endsWith(`[cut: the first 200 KB of ${big.length} bytes]`));
    seedTask(t.config, 'NC-2');
    const none = await t.call('get_report', { task: 'NC-2' });
    assert.deepEqual([none.isError, /has no report yet/.test(none.text)], [true, true]);
    assert.throws(() => readReportFile({ task: 'X', report: '' }), /no report path/);
  });

  it('list_reports: size, time and whether pulled', async () => {
    const t = setup('r7');
    withReport(t.config, 'NC-1', 'abc');
    seedTask(t.config, 'NC-2');
    const r = await t.call('list_reports');
    const list = JSON.parse(r.text.slice(r.text.indexOf('['))) as { task: string; bytes: number; pulled: boolean }[];
    assert.deepEqual(list.map((x) => [x.task, x.bytes, x.pulled]), [['NC-1', 3, false]]);
    assert.equal((await setup('r7b').call('list_reports')).text, 'No reports.');
  });

  it('pull_ready: all new reports under headers, marked as pulled; the second call has nothing', async () => {
    const t = setup('r8');
    withReport(t.config, 'NC-1', '# one\n');
    withReport(t.config, 'NC-2', '# two\n', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    seedTask(t.config, 'NC-3');
    await t.runner.sleep(1000);
    const first = await t.call('pull_ready');
    assert.match(first.text, /^2 new reports, now marked as pulled: NC-1, NC-2\n\n=== NC-1 \(claude opus\/high\) ===\n# one\n\n=== NC-2 \(codex gpt-6\.1-sol\/low\) ===\n# two/);
    assert.ok(readTaskRecord(t.config, 'nc-1')?.pulled && readTaskRecord(t.config, 'nc-2')?.pulled);
    assert.equal(readTaskRecord(t.config, 'nc-3')?.pulled, undefined);
    assert.equal((await t.call('pull_ready')).text, 'No new reports (2 already pulled; --all takes them again).');
    assert.equal((await setup('r8b').call('pull_ready')).text, 'No reports ready.');
  });

  it('pull_ready takes as many reports as fit under 200 KB and leaves the rest new', async () => {
    const t = setup('r9');
    withReport(t.config, 'NC-1', 'a'.repeat(150 * 1024));
    withReport(t.config, 'NC-2', 'b'.repeat(150 * 1024));
    await t.runner.sleep(1000);
    const first = await t.call('pull_ready');
    assert.match(first.text, /^1 new report, now marked as pulled: NC-1\n1 more did not fit under 200 KB and stay new: NC-2\. Call pull_ready again\./);
    assert.equal(readTaskRecord(t.config, 'nc-2')?.pulled, undefined);
    assert.match((await t.call('pull_ready')).text, /^1 new report, now marked as pulled: NC-2/);
  });

  it('task_spec: header and prompt; env values are not shown and follow-ups are not part of the prompt', async () => {
    const t = setup('r10');
    seedTask(t.config, 'NC-1', { env: { TOKEN: 'hunter2' }, repos: [{ path: '/r/app', worktree: '/r/app-wt', branch: 'nc-1' }] });
    fs.appendFileSync(taskFile(t.config, 'nc-1'), '\n\n## Follow-up sent 2026-11-01\n\nsecond prompt\n');
    const r = await t.call('task_spec', { task: 'NC-1' });
    assert.ok(!r.text.includes('hunter2'));
    assert.match(r.text, /"env_names": \[\s+"TOKEN"\s+\]/);
    assert.match(r.text, /"worktree": "\/r\/app-wt"/);
    assert.ok(r.text.endsWith('--- prompt ---\nDo NC-1.'), r.text.slice(-60));
    assert.equal(readTaskPrompt(t.config, 'nc-1'), 'Do NC-1.');
  });
});

describe('mcp: writing is off by default', () => {
  const calls: [string, Record<string, unknown>][] = [
    ['send', { task: 'NC-1', text: 'hello' }],
    ['new', { spec: '---\ntask: NC-9\nagent: claude\nrepos:\n  - path: /r\n---\nx\n', confirm: true }],
    ['interrupt', { task: 'NC-1' }],
    ['close', { task: 'NC-1' }],
    ['move', { task: 'NC-1', confirm: true }],
  ];

  it('every write tool is refused without mcp.allow: nothing runs, the refusal is audited, nobody is notified', async () => {
    const t = setup('w1');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', IDLE);
    for (const [name, args] of calls) {
      const r = await t.call(name, args);
      assert.equal(r.isError, true, name);
      assert.match(r.text, new RegExp(`Writing is off for "${name}": it is not in mcp\\.allow\\. Nothing was done\\.`), name);
      assert.match(r.text, /mcp: \{allow: \[/);
    }
    assert.deepEqual(t.runner.commands.filter((c) => !c.startsWith('write ') && !c.startsWith('append ')), [], 'no tmux, no git');
    assert.deepEqual(t.audit().map((a) => [a.tool, a.outcome]), calls.map(([n]) => [n, 'denied']));
    assert.deepEqual(t.notified, []);
    assert.equal(readTaskRecord(t.config, 'nc-1')?.closed, undefined);
  });

  it('only the listed tools work; the list is read again on every call, so a change needs no restart', async () => {
    const t = setup('w2');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', IDLE);
    writeConfig(t.config, 'mcp: {allow: [interrupt]}\n');
    assert.equal((await t.call('send', { task: 'NC-1', text: 'hi' })).isError, true);
    assert.equal((await t.call('interrupt', { task: 'NC-1' })).isError, undefined);
    writeConfig(t.config, 'mcp: {allow: [send]}\n');
    assert.equal((await t.call('interrupt', { task: 'NC-1' })).isError, true, 'revoked at once');
    assert.equal((await t.call('send', { task: 'NC-1', text: 'hi' })).isError, undefined);
    writeConfig(t.config);
    assert.equal((await t.call('send', { task: 'NC-1', text: 'hi' })).isError, true);
  });

  it('the config rejects a name that is not a write tool, and shell or merge are not among them', () => {
    assert.throws(() => makeConfig(scratch.sub('w3'), 'mcp: {allow: [merge]}\n'), /"merge" is not a write tool \(allowed: send, new, interrupt, close, move\)/);
    assert.throws(() => makeConfig(scratch.sub('w3b'), 'mcp: {allow: [shell]}\n'), /not a write tool/);
    assert.deepEqual(makeConfig(scratch.sub('w3c')).mcp, { allow: [], allowRmWorktree: false });
    assert.deepEqual(makeConfig(scratch.sub('w3d'), 'mcp: {allow: [send, send, close], allow_rm_worktree: true}\n').mcp, { allow: ['send', 'close'], allowRmWorktree: true });
  });

  it('a write that cannot be audited is not done', async () => {
    const t = setup('w4', 'mcp: {allow: [send]}\n');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', IDLE);
    fs.mkdirSync(auditPath(t.config)); // the log is a directory: it cannot be appended to
    const r = await t.call('send', { task: 'NC-1', text: 'hi' });
    assert.equal(r.isError, true);
    assert.match(r.text, /cannot write the audit log/);
    assert.ok(!t.runner.commands.some((c) => c.includes('paste-buffer')));
  });
});

describe('mcp: the write tools', () => {
  it('send: pastes the text into the window, logs it in TASK.md, audits it and notifies', async () => {
    const t = setup('s1', 'mcp: {allow: [send]}\n');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', IDLE);
    const r = await t.call('send', { task: 'nc-1', text: 'dopisz test' });
    assert.match(r.text, /^NC-1: prompt sent \(11 characters\)/);
    assert.ok(t.runner.commands.some((c) => c.startsWith('tmux paste-buffer')));
    assert.ok(t.runner.commands.some((c) => c.includes('send-keys') && c.includes('Enter')));
    assert.match(fs.readFileSync(taskFile(t.config, 'nc-1'), 'utf8'), /## Follow-up sent .*\n\ndopisz test/);
    assert.deepEqual(t.audit().map((a) => [a.tool, a.task, a.outcome]), [['send', 'nc-1', 'requested'], ['send', 'nc-1', 'done']]);
    assert.equal(t.audit()[0]?.detail, 'dopisz test');
    assert.deepEqual(t.notified, ['czat zlecił: send NC-1']);
  });

  it('send: a task without a window, an empty text and a failing notifier', async () => {
    const t = setup('s2', 'mcp: {allow: [send]}\n');
    seedTask(t.config, 'NC-1');
    seedTask(t.config, 'NC-2');
    t.tmux.add('nc-1', IDLE);
    const gone = await t.call('send', { task: 'NC-2', text: 'hi' });
    assert.deepEqual([gone.isError, /no tmux window/.test(gone.text)], [true, true]);
    assert.match((await t.call('send', { task: 'NC-1', text: '   ' })).text, /the text is empty/);
    assert.deepEqual(t.notified, []);
    assert.deepEqual(t.audit().filter((a) => a.outcome === 'error').length, 2);
    t.failNotify();
    assert.equal((await t.call('send', { task: 'NC-1', text: 'hi' })).isError, undefined, 'a notifier that fails does not fail the tool');
  });

  it('interrupt: sends the agent key once and the window stays', async () => {
    const t = setup('i1', 'mcp: {allow: [interrupt]}\n');
    seedTask(t.config, 'NC-1');
    t.tmux.add('nc-1', WORKING);
    const r = await t.call('interrupt', { task: 'NC-1' });
    assert.match(r.text, /NC-1: interrupted \(Escape sent\); the window stays open/);
    assert.equal(t.runner.commands.filter((c) => c.includes('send-keys')).length, 1);
    assert.deepEqual(t.notified, ['czat zlecił: interrupt NC-1']);
  });

  it('close: kills the window and marks the task closed; the worktree stays', async () => {
    const t = setup('c1', 'mcp: {allow: [close]}\n');
    seedTask(t.config, 'NC-1', { repos: [{ path: '/r/app', worktree: '/r/app-wt' }] });
    t.tmux.add('nc-1', IDLE);
    const r = await t.call('close', { task: 'NC-1' });
    assert.match(r.text, /^NC-1: closed; the worktree and the report stay/);
    assert.equal(readTaskRecord(t.config, 'nc-1')?.closed, true);
    assert.ok(!t.runner.commands.some((c) => c.includes('worktree')));
    assert.deepEqual(t.notified, ['czat zlecił: close NC-1']);
  });

  it('close: removing the worktree needs mcp.allow_rm_worktree as well, and is never forced', async () => {
    const t = setup('c2', 'mcp: {allow: [close]}\n');
    const wt = scratch.sub('c2/app-wt');
    seedTask(t.config, 'NC-1', { repos: [{ path: scratch.sub('c2/app'), worktree: wt }] });
    t.tmux.add('nc-1', IDLE);
    const refused = await t.call('close', { task: 'NC-1', remove_worktree: true });
    assert.deepEqual([refused.isError, /not allowed for the chat/.test(refused.text)], [true, true]);
    assert.equal(t.tmux.windows.length, 1, 'the window is still there: nothing was done');
    assert.equal(readTaskRecord(t.config, 'nc-1')?.closed, undefined);
    writeConfig(t.config, 'mcp: {allow: [close], allow_rm_worktree: true}\n');
    const done = await t.call('close', { task: 'NC-1', remove_worktree: true });
    assert.match(done.text, /worktree removed \(the branch stays\)/);
    const git = t.runner.commands.filter((c) => c.startsWith('git'));
    assert.ok(git.some((c) => /worktree remove/.test(c)));
    assert.ok(!git.some((c) => /--force|\bpush\b|\bmerge\b|\brebase\b|branch -[dD]/.test(c)));
  });

  it('new: the first call only summarizes, the second with confirm: true starts the task', async () => {
    const t = setup('n1', 'mcp: {allow: [new]}\n');
    const repo = scratch.sub('n1/app');
    const spec = `---\ntask: NC-9\nagent: claude\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n---\nZrób NC-9.\n`;
    const preview = await t.call('new', { spec });
    assert.match(preview.text, /^NC-9 {2}claude\/default\/high\n {2}worktree: .*app-wt[\s\S]*Not started yet\. Show this to the user and ask; if they agree, call new again with the same spec and confirm: true\.$/);
    assert.deepEqual(t.runner.commands.filter((c) => !c.startsWith('write ') && !c.startsWith('append ')), [], 'nothing ran');
    assert.deepEqual(t.notified, []);
    assert.deepEqual(t.audit().map((a) => a.outcome), ['requested', 'preview']);
    const done = await t.call('new', { spec, confirm: true });
    assert.match(done.text, /^Started: NC-9 \(window nc-9, claude default\/high\)/);
    assert.ok(t.runner.commands.some((c) => c.startsWith('git') && c.includes('worktree add')));
    assert.ok(t.runner.commands.some((c) => c.includes('new-window') || c.includes('new-session')));
    assert.ok(readTaskRecord(t.config, 'nc-9'));
    assert.deepEqual(t.notified, ['czat zlecił: new NC-9']);
  });

  it('new: validation like the CLI (a bad spec is an error, nothing is started) and no shell commands from the chat', async () => {
    const t = setup('n2', 'mcp: {allow: [new]}\n');
    const repo = scratch.sub('n2/app');
    const bad = await t.call('new', { spec: 'task: NC-9\n', confirm: true });
    assert.deepEqual([bad.isError, /must start with a YAML header/.test(bad.text)], [true, true]);
    const noAgent = await t.call('new', { spec: `---\ntask: nc-9\nrepos:\n  - path: ${repo}\n---\nx\n`, confirm: true });
    assert.equal(noAgent.isError, true);
    const withSetup = await t.call('new', { spec: `---\ntask: NC-9\nagent: claude\nsetup: ["touch /tmp/x"]\nrepos:\n  - path: ${repo}\n---\nx\n`, confirm: true });
    assert.match(withSetup.text, /NC-9: "setup" runs shell commands and is not accepted from the chat/);
    assert.ok(!t.runner.commands.some((c) => c.startsWith('sh ') || c.includes('touch')), 'no shell ran');
    assert.ok(!t.runner.commands.some((c) => c.startsWith('git')));
    assert.deepEqual(t.notified, []);
  });

  it('move: the first call describes it, confirm: true hands the task over', async () => {
    const t = setup('m1', 'mcp: {allow: [move]}\n');
    t.tmux.newWindowScreen = '› Ask Codex to do anything\n';
    seedTask(t.config, 'NC-1', { repos: [{ path: scratch.sub('m1/app'), worktree: scratch.sub('m1/app-wt') }], requested: { agent: 'claude', model: 'opus', effort: 'high' } });
    t.tmux.add('nc-1', "  ⎿  You've hit your session limit · resets 3pm\n❯ ");
    const preview = await t.call('move', { task: 'NC-1' });
    assert.match(preview.text, /^Move NC-1 \(claude opus\/high\) -> NC-1-2 \(codex .*\)[\s\S]*Not moved yet\. Ask the user, then call move again with confirm: true\.$/);
    assert.ok(!t.tmux.windows.some((w) => w.name === 'nc-1-2'));
    assert.deepEqual(t.notified, []);
    const done = await t.call('move', { task: 'NC-1', confirm: true });
    assert.match(done.text, /NC-1 -> NC-1-2: running on codex/);
    assert.ok(t.tmux.windows.some((w) => w.name === 'nc-1-2'));
    assert.equal(readTaskRecord(t.config, 'nc-1')?.supersededBy, 'NC-1-2');
    assert.deepEqual(t.notified, ['czat zlecił: move NC-1 -> NC-1-2']);
  });

  it('no tool can merge, push, rebase, delete a branch or run a command: no tool call produces such a git or shell command', async () => {
    const t = setup('x1', 'mcp: {allow: [send, new, interrupt, close, move], allow_rm_worktree: true}\n');
    const repo = scratch.sub('x1/app');
    seedTask(t.config, 'NC-1', { repos: [{ path: repo, worktree: `${repo}-wt` }] });
    t.tmux.add('nc-1', IDLE);
    await t.call('send', { task: 'NC-1', text: 'git push --force origin main; rm -rf /' });
    await t.call('interrupt', { task: 'NC-1' });
    await t.call('new', { spec: `---\ntask: NC-2\nagent: claude\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt2\n---\ngit merge main\n`, confirm: true });
    await t.call('close', { task: 'NC-1', remove_worktree: true });
    const cmds = t.runner.commands.filter((c) => /^(git|sh)\b/.test(c));
    assert.ok(cmds.length > 0);
    assert.ok(!cmds.some((c) => /\b(push|merge|rebase|reset|checkout|commit)\b|branch -[dD]|--force|-rf/.test(c)), cmds.join('\n'));
  });
});
