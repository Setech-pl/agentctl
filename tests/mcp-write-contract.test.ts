import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { z } from 'zod';
import { touchCohort } from '../src/core/cohort.ts';
import { areaKey, inspectField } from '../src/core/input-field.ts';
import { enqueuePrompt } from '../src/core/prompt-queue.ts';
import { saveEntry } from '../src/core/queue.ts';
import { OWNER_IDENTITY, postMessage } from '../src/core/wall.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, applyMcpRequest, auditPath } from '../src/core/mcp-tools.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { directLimitPolicy, DiskRunner, FakeTmux, fakeWatcher, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

it('WALL-23: a working Claude send previews before registering a watcher request', async () => {
  const config = makeConfig(scratch.sub('busy'), 'mcp: {allow: [send]}\n');
  const task = seedTask(config, 'VS65-3', { started: new Date().toISOString() });
  const tmux = new FakeTmux();
  tmux.add(task.window, 'Working (esc to interrupt)\n');
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: tmux.respond });
  const deps = { context: () => new Context(runner, config, () => {}), notify: async () => {} };
  fakeWatcher(config);
  const tool = MCP_TOOLS.find(t => t.name === 'send')!;
  const text = '  First line.\nSecond line.  ';
  const before = fs.readFileSync(path.join(config.stateDir, task.window, 'TASK.md'), 'utf8');
  const preview = await tool.run(deps, z.object(tool.input).parse({ task: task.task, text }));
  assert.deepEqual(readMcpRequests(config), [], preview.text);
  assert.doesNotMatch(tmux.seen.join('\n'), /send-keys|paste-buffer|load-buffer/);
  assert.equal(fs.readFileSync(path.join(config.stateDir, task.window, 'TASK.md'), 'utf8'), before);
  assert.ifError(preview.isError);
  assert.ok(preview.text.includes(text), preview.text);
  assert.match(preview.text, /working/i);
  assert.match(preview.text, /queued until the turn ends/i);
  const token = /preview_token: (\S+)/.exec(preview.text)?.[1];
  assert.ok(token, preview.text);
  assert.equal((await tool.run(deps, { task: task.task, text: 'Changed', confirm: true, preview_token: token })).isError, true);
  assert.equal((await tool.run(deps, { task: task.task, text: 'Unpreviewed', confirm: true })).isError, true);
  assert.deepEqual(readMcpRequests(config), []);
  const done = await tool.run(deps, { confirm: true, preview_token: token });
  assert.match(done.text, /^Accepted: send/);
  assert.equal(readMcpRequests(config)[0]?.args.text, text);
});

/** Audit records are part of the preview; compare the rest of the fixture by content. */
function snapshot(root: string, audit: string): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => file !== audit)
    .map(file => [path.relative(root, file), fs.readFileSync(file, 'utf8')]));
}

it('MCP-WRITE-PREVIEW: previews only record a plan request for watched GC and never send keys', async () => {
  const writes = MCP_TOOLS.filter(t => t.kind === 'write');
  const root = scratch.sub('registry');
  const repo = scratch.sub('registry/repo');
  const config = makeConfig(root, `providers: [claude, codex, kimi]
limits: {${directLimitPolicy}}
mcp: {allow: [${writes.map(t => t.name).join(', ')}, send_enter], max_response_kb: 256}
capacity: {snapshot: false, codex_refresh: false}
`);
  const tmux = new FakeTmux();
  const mutatingCommands: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    if (!opts?.readOnly) mutatingCommands.push([cmd, ...args].join(' '));
    if (cmd === 'git' && args.includes('--show-toplevel')) return { stdout: repo + '\n' };
    if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'a'.repeat(40) + '\n' };
    return tmux.respond(cmd, args, opts);
  } });
  const ctx = new Context(runner, config, () => {});
  const notices: string[] = [];
  const deps = {
    context: () => ctx, notify: async (notice: string) => { notices.push(notice); },
    budgetClock: { now: () => runner.now(), schedule: () => () => {} },
  };
  const draft = fs.readFileSync(new URL('./fixtures/screen-claude-draft.txt', import.meta.url), 'utf8');
  const menu = fs.readFileSync(new URL('./fixtures/screen-kimi-04-zgoda.txt', import.meta.url), 'utf8');
  const limited = "  ⎿  You've hit your session limit · resets 3pm\n❯ ";
  const active = seedTask(config, 'ACTIVE', { repos: [{ path: repo, worktree: repo }] });
  for (const [task, screen] of [['ACTIVE', 'Working (esc to interrupt)'], ['DRAFT', draft], ['MENU', menu], ['LIMITED', limited]]) tmux.add(task!.toLowerCase(), screen);
  seedTask(config, 'DRAFT', { deliveryId: 'fixture-draft', deliveryField: areaKey(inspectField(draft, 'claude').area), promptDelivery: 'needs-attention' });
  seedTask(config, 'MENU', { agent: 'kimi', model: 'k3' });
  seedTask(config, 'LIMITED', { repos: active.repos, model: 'claude-opus-5-5' });
  seedTask(config, 'CLOSED', { closed: true, closedAt: '2026-01-01T00:00:00.000Z' });
  const queuedMessage = await enqueuePrompt(ctx, 'active', 'A waiting message');
  const spec = (task: string) => `---\ntask: ${task}\nagent: claude\nmodel: opus\nrepos: [{path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}]\n---\nTest task.\n`;
  for (const [i, task] of ['WAITING', 'FAILED'].entries()) {
    await saveEntry(ctx, { seq: i + 1, order: i + 1, task, status: task === 'FAILED' ? 'failed' : 'queued', priority: 'normal', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: task === 'WAITING' ? ['CLOSED'] : [], spec: spec(task) });
  }
  await touchCohort(ctx, 'batch');
  const parent = await postMessage(ctx, OWNER_IDENTITY, { channel: 'nc', kind: 'question', subject: 'Question', body: 'A question for the fixture.' });
  const source = path.join(repo, 'REPORT.md');
  fs.writeFileSync(source, 'Verdict: PASS\n<!-- agentctl:report-end -->\n');
  const panel = [{ agent: 'claude', model: 'opus', effort: 'high' }, { agent: 'codex', model: 'gpt-5.4', effort: 'high' }];
  const task = { task: 'ACTIVE' }, tasks = { tasks: ['ACTIVE'] };
  const samples: Record<string, Record<string, unknown>> = {
    adopt: { task: 'ADOPT', report: path.join(config.cache, 'ADOPT.md'), worktree: repo },
    answer: { task: 'MENU', option: 1 },
    archive: {},
    away: { on: true },
    cancel: task,
    close: task,
    cohort_add: { ...tasks, cohort: 'batch' },
    cohort_archive: { cohorts: ['batch'] },
    cohort_note: { cohort: 'batch', text: 'Reviewed' },
    cohort_remove: tasks,
    consult: { spec: JSON.stringify({ consult: 'CHOICE', question: 'Which contract?', repos: [{ path: repo }], panel, synthesis: panel[0] }) },
    gc: {},
    hide: tasks,
    interrupt: task,
    limits_release: { claude: 1 },
    manager_start: {},
    manager_stop: {},
    mark: { ...task, result: 'ok' },
    move: { task: 'LIMITED', agent: 'codex' },
    new: { spec: spec('NEW') },
    notify_test: {},
    pin: tasks,
    queue: { spec: spec('NEW-QUEUED') },
    queue_pause: {},
    queue_resume: {},
    queue_retry: { task: 'FAILED' },
    queue_rm: { task: 'WAITING' },
    queue_up: { task: 'WAITING' },
    report_from: { ...task, from: source },
    reserve: { claude: 1 },
    resume: {},
    send: { ...task, text: 'Another follow-up' },
    set_limits: { claude: 2 },
    unblock: { task: 'WAITING', drop_after: 'CLOSED' },
    unhide: tasks,
    unpin: tasks,
    wall_post: { as: 'chat:nc', channel: 'nc', kind: 'info', subject: 'Update', body: 'An update for the fixture.' },
    wall_reply: { as: 'chat:nc', reply_to: parent.id, body: 'An answer for the fixture.' },
    wall_set_status: { as: 'chat:nc', id: parent.id, status: 'answered' },
  };
  assert.deepEqual(Object.keys(samples).sort(), writes.map(t => t.name).sort());
  const send = writes.find(t => t.name === 'send')!;
  const cases = [
    ...writes.map(tool => ({ tool, args: samples[tool.name]!, label: tool.name })),
    { tool: send, args: { task: 'DRAFT', enter_only: true }, label: 'send_enter' },
    { tool: send, args: { ...task, withdraw: queuedMessage.id.slice(0, 8) }, label: 'send withdraw' },
  ];
  let gcRequest: string | undefined;
  for (const watching of [true, false]) {
    if (watching) fakeWatcher(config);
    else fs.unlinkSync(path.join(config.stateDir, 'queue-worker.json'));
    const before = snapshot(root, auditPath(config));
    const errors: string[] = [];
    for (const { tool, args, label } of cases) {
      const beforeCase = snapshot(root, auditPath(config));
      const commandCount = mutatingCommands.length;
      const preview = await tool.run(deps, z.object(tool.input).parse(args));
      if (mutatingCommands.length !== commandCount) errors.push(`${label}: ran ${mutatingCommands.slice(commandCount).join(', ')}`);
      const afterCase = snapshot(root, auditPath(config));
      const changed = [...new Set([...Object.keys(beforeCase), ...Object.keys(afterCase)])].filter(file => beforeCase[file] !== afterCase[file]);
      if (watching && tool.name === 'gc') {
        assert.ifError(preview.isError);
        gcRequest = /^request_id: ([a-f0-9-]+)$/m.exec(preview.text)?.[1];
        assert.ok(gcRequest, preview.text);
        assert.doesNotMatch(preview.text, /^preview_token:/m);
        const requestFile = path.join('home', 'mcp-requests', `${gcRequest}.json`);
        assert.deepEqual(changed, [requestFile]);
        before[requestFile] = afterCase[requestFile]!;
        continue;
      }
      if (preview.isError || !/^preview_token: [a-f0-9-]+$/m.test(preview.text)) errors.push(`${label}: ${preview.text}`);
      if (changed.length) errors.push(`${label}: changed persisted state (${changed.join(', ')})`);
    }
    assert.deepEqual(errors, [], watching ? 'watcher running' : 'inline mode');
    assert.deepEqual(snapshot(root, auditPath(config)), before);
    assert.deepEqual(readMcpRequests(config).map(({id, tool, status, scope}) => ({id, tool, status, scope})),
      [{id: gcRequest, tool: 'gc_preview', status: 'pending', scope: null}]);
    assert.deepEqual(notices, []);
  }
});

it('WALL-23: legacy unconfirmed send requests are refused by the watcher', async () => {
  const root = scratch.sub('legacy-request');
  const config = makeConfig(root, 'mcp: {allow: [send]}');
  const tmux = new FakeTmux();
  const task = seedTask(config, 'TARGET');
  tmux.add(task.window, 'Working (esc to interrupt)');
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const deps = { context: () => new Context(runner, config, () => {}), notify: async () => {} };
  const legacy = {
    tool: 'send', task: task.task, args: { task: task.task, text: 'Unconfirmed' }, scope: null,
    key: 'legacy-send', id: 'legacy-id', seq: 1, status: 'pending', requestedAt: task.started, label: task.task,
  } as const;
  await assert.rejects(() => applyMcpRequest(deps, legacy), /no confirmed preview/);
  assert.deepEqual(tmux.seen, []);
});
