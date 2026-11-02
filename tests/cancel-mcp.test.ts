import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { auditPath, MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import { readQueue } from '../src/core/queue.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;
const WORKING = '● Working\n  esc to interrupt\n';

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 3_600_000, respond: tmux.respond });
  const notified: string[] = [];
  const deps: McpDeps = {
    context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), out),
    notify: async (m) => void notified.push(m),
  };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const audit = (): { tool: string; task?: string; outcome: string; detail?: string }[] =>
    fs.existsSync(auditPath(config)) ? fs.readFileSync(auditPath(config), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
  const spec = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const running = (id: string, cohort?: string): string => {
    const worktree = path.join(root, `wt-${id.toLowerCase()}`);
    fs.mkdirSync(worktree, { recursive: true });
    tmux.add(id.toLowerCase(), WORKING);
    seedTask(config, id, { repos: [{ path: repo, worktree }], ...(cohort ? { cohort } : {}) });
    return worktree;
  };
  const ready = (id: string, cohort?: string): void => {
    const r = seedTask(config, id, cohort ? { cohort } : {});
    fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, `# report of ${id}\n`);
  };
  return { config, tmux, runner, notified, call, audit, spec, running, ready };
}

const json = <T>(r: ToolResult): T => JSON.parse(r.text.slice(r.text.indexOf('\n\n') + 2)) as T;

describe('mcp: cancel', () => {
  it('is a write tool that is off unless mcp.allow lists it; the refusal is audited and nothing is done', () => {
    assert.equal(tool('cancel').kind, 'write');
    assert.match(tool('cancel').description, /^WRITE, off unless the user put "cancel" in mcp\.allow/);
    assert.match(tool('cancel').description, /confirm: true/);
    assert.equal(tool('cancel').annotations.destructiveHint, true);
    const t = setup('off');
    t.running('NC-1');
    return t.call('cancel', { task: 'NC-1', confirm: true }).then((r) => {
      assert.equal(r.isError, true);
      assert.match(r.text, /Writing is off for "cancel"/);
      assert.equal(readTaskRecord(t.config, 'nc-1')?.cancelled, undefined);
      assert.deepEqual(t.audit().map((a) => [a.tool, a.outcome]), [['cancel', 'denied']]);
      assert.deepEqual(t.notified, []);
    });
  });

  it('the first call only describes; confirm: true cancels, records the reason and the source mcp, audits and notifies', async () => {
    const t = setup('do', 'mcp: {allow: [cancel]}\n');
    const worktree = t.running('NC-1');
    const preview = await t.call('cancel', { task: 'nc-1', reason: 'wrong approach' });
    assert.match(preview.text, /Cancel 1 task – wrong approach:\n {2}NC-1 /);
    assert.match(preview.text, /Not cancelled yet\. Show this to the user and ask/);
    assert.equal(readTaskRecord(t.config, 'nc-1')?.cancelled, undefined);
    assert.equal(t.tmux.windows.length, 1);
    assert.deepEqual(t.notified, [], 'a preview notifies nobody');
    const done = await t.call('cancel', { task: 'nc-1', reason: 'wrong approach', confirm: true });
    assert.equal(done.isError, undefined, done.text);
    assert.match(done.text, /^Cancelled: NC-1/);
    const record = readTaskRecord(t.config, 'nc-1');
    assert.deepEqual([record?.cancelled, record?.cancelReason, record?.cancelSource], [true, 'wrong approach', 'mcp']);
    assert.equal(t.tmux.windows.length, 0);
    assert.ok(fs.existsSync(worktree), 'the worktree stays');
    assert.deepEqual(t.notified, ['czat zlecił: cancel NC-1 (wrong approach)']);
    assert.deepEqual(t.audit().map((a) => [a.tool, a.outcome]), [['cancel', 'requested'], ['cancel', 'preview'], ['cancel', 'requested'], ['cancel', 'done']]);
    assert.match(t.audit()[2]?.detail ?? '', /reason=wrong approach confirm=true/);
  });

  it('a queued task is cancelled the same way; the tasks that wait for it become blocked', async () => {
    const t = setup('queued', 'mcp: {allow: [queue, cancel]}\n');
    await t.call('queue', { spec: t.spec('Q-1') + t.spec('Q-2', 'after: Q-1\n'), confirm: true });
    const r = await t.call('cancel', { task: 'Q-1', confirm: true });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /⛓ Q-2 is blocked: it waited for Q-1/);
    assert.deepEqual(readQueue(t.config).map((e) => e.task), ['Q-2']);
    assert.equal(readTaskRecord(t.config, 'q-1')?.cancelSource, 'mcp');
    const list = json<{ task: string; blocked: boolean; startCondition: string }[]>(await t.call('queue_list'));
    assert.deepEqual(list.map((l) => [l.task, l.blocked, l.startCondition]), [['Q-2', true, '⛓ zablokowane – Q-1 anulowane']]);
  });

  it('cohort cancels every open task of a cohort, the queued ones too; task and cohort together, or neither, is an error', async () => {
    const t = setup('cohort', 'mcp: {allow: [queue, cancel]}\n');
    t.running('A-1', 'Sprint-1');
    t.running('B-1', 'Other');
    await t.call('queue', { spec: t.spec('Q-1', 'cohort: sprint-1\n'), confirm: true });
    const preview = await t.call('cancel', { cohort: 'SPRINT-1' });
    assert.match(preview.text, /Cancel 2 tasks:\n {2}A-1 .*\n {2}Q-1 /);
    await t.call('cancel', { cohort: 'sprint-1', confirm: true, reason: 'scrapped' });
    assert.deepEqual(['a-1', 'q-1', 'b-1'].map((x) => readTaskRecord(t.config, x)?.cancelled), [true, true, undefined]);
    assert.deepEqual(t.tmux.windows.map((w) => w.name), ['b-1']);
    assert.deepEqual(t.notified.slice(1), ['czat zlecił: cancel A-1, Q-1 (scrapped)']);
    for (const args of [{}, { task: 'B-1', cohort: 'Other' }]) {
      const bad = await t.call('cancel', args);
      assert.equal(bad.isError, true);
      assert.match(bad.text, /give either task or cohort/);
    }
    assert.match((await t.call('cancel', { cohort: 'nope' })).text, /no cohort "nope"/);
    assert.match((await t.call('cancel', { cohort: 'sprint-1' })).text, /cohort sprint-1 has no open tasks/);
  });

  it('remove_worktree needs mcp.allow_rm_worktree, like close', async () => {
    const t = setup('rmwt', 'mcp: {allow: [cancel]}\n');
    t.running('NC-1');
    const denied = await t.call('cancel', { task: 'NC-1', remove_worktree: true, confirm: true });
    assert.equal(denied.isError, true);
    assert.match(denied.text, /removing the worktree is not allowed for the chat/);
    assert.equal(readTaskRecord(t.config, 'nc-1')?.cancelled, undefined);
    const ok = setup('rmwt2', 'mcp: {allow: [cancel], allow_rm_worktree: true}\n');
    const worktree = ok.running('NC-1');
    const r = await ok.call('cancel', { task: 'NC-1', remove_worktree: true, confirm: true });
    assert.equal(r.isError, undefined, r.text);
    assert.ok(ok.runner.commands.some((c) => c.includes(`worktree remove ${worktree}`) && !c.includes('--force')));
  });
});

describe('mcp: cohorts', () => {
  it('cohort_list and cohort_show are read tools, always there', () => {
    for (const name of ['cohort_list', 'cohort_show']) {
      assert.equal(tool(name).kind, 'read');
      assert.equal(tool(name).annotations.readOnlyHint, true);
      assert.ok(tool(name).description.length > 80);
    }
    assert.ok('cohort' in tool('status').input && 'cohort' in tool('pull_ready').input);
  });

  it('status takes a cohort and every row says its cohort; cancelled tasks only with all', async () => {
    const t = setup('status');
    t.running('A-1', 'Sprint-1');
    t.running('B-1', 'Other');
    t.running('C-1');
    seedTask(t.config, 'A-2', { cohort: 'Sprint-1', cancelled: true, cancelledAt: '2026-11-02T08:00:00.000Z', cancelReason: 'x' });
    const all = json<{ task: string; cohort: string | null }[]>(await t.call('status'));
    assert.deepEqual(all.map((r) => [r.task, r.cohort]), [['A-1', 'Sprint-1'], ['B-1', 'Other'], ['C-1', null]]);
    const one = await t.call('status', { cohort: 'sprint-1' });
    assert.match(one.text, /^1 task: 1 working \(1 hidden or closed not shown; all: true lists them\)\nCohort Sprint-1: only its tasks are listed\./);
    assert.deepEqual(json<{ task: string }[]>(one).map((r) => r.task), ['A-1']);
    const withAll = json<{ task: string; cancelled: boolean; cancelReason: string | null }[]>(await t.call('status', { cohort: 'sprint-1', all: true }));
    assert.deepEqual(withAll.map((r) => [r.task, r.cancelled, r.cancelReason]), [['A-1', false, null], ['A-2', true, 'x']]);
    const unknown = await t.call('status', { cohort: 'nope' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /no cohort "nope"/);
  });

  it('cohort_list counts by state; cohort_show lists the tasks and the queued ones', async () => {
    const t = setup('list', 'mcp: {allow: [queue]}\n');
    t.running('A-1', 'Sprint-1');
    t.ready('A-2', 'Sprint-1');
    t.running('C-1');
    await t.call('queue', { spec: t.spec('Q-1', 'cohort: Sprint-1\n'), confirm: true });
    await t.call('queue', { spec: t.spec('Q-2'), confirm: true });
    const list = json<{ name: string; active: number; queued: number; reports: number; total: number }[]>(await t.call('cohort_list'));
    assert.deepEqual(list.map((c) => [c.name, c.active, c.queued, c.reports, c.total]), [['Sprint-1', 1, 1, 1, 3]]);
    const show = await t.call('cohort_show', { cohort: 'SPRINT-1' });
    assert.match(show.text, /^\{"cohort":"Sprint-1",.*"tasks":2,"queued":1\}/);
    const body = json<{ tasks: { task: string; state: string }[]; queued: { task: string }[] }>(show);
    assert.deepEqual(body.tasks.map((x) => [x.task, x.state]), [['A-1', 'working'], ['A-2', 'report-ready']]);
    assert.deepEqual(body.queued.map((x) => x.task), ['Q-1']);
    assert.equal((await t.call('cohort_show', { cohort: 'nope' })).isError, true);
    assert.match((await setup('none').call('cohort_list')).text, /No cohorts\./);
  });

  it('pull_ready with a cohort takes only that cohort and marks only its reports as pulled', async () => {
    const t = setup('pull');
    t.ready('A-1', 'Sprint-1');
    t.ready('B-1', 'Other');
    const r = await t.call('pull_ready', { cohort: 'sprint-1' });
    assert.match(r.text, /^1 new report, now marked as pulled: A-1/);
    assert.doesNotMatch(r.text, /report of B-1/);
    assert.equal(readTaskRecord(t.config, 'b-1')?.pulled, undefined);
    assert.match((await t.call('pull_ready', { cohort: 'sprint-1' })).text, /No new reports \(1 already pulled/);
    assert.match((await t.call('pull_ready')).text, /^1 new report, now marked as pulled: B-1/);
  });

  it('task_spec carries the cohort and the cancellation; a cancelled task keeps its report readable', async () => {
    const t = setup('spec');
    const r = seedTask(t.config, 'A-1', { cohort: 'Sprint-1', cancelled: true, cancelledAt: '2026-11-02T08:00:00.000Z', cancelReason: 'x' });
    fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, '# partial\n');
    const spec = await t.call('task_spec', { task: 'A-1' });
    assert.match(spec.text, /"cohort": "Sprint-1"/);
    assert.match(spec.text, /"cancelled": true/);
    assert.match(spec.text, /"cancel_reason": "x"/);
    assert.match((await t.call('get_report', { task: 'A-1' })).text, /# partial/);
    assert.match((await t.call('pull_ready')).text, /^No reports ready\./, 'a cancelled task is not handed over');
  });
});
