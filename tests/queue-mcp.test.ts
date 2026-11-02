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

function setup(name: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, `limits: {claude: 1}\n${extraYaml}`);
  const tmux = new FakeTmux();
  const git = new Map<string, string[]>();
  const runner = new DiskRunner({
    dryRun: false,
    startTime: Date.now(),
    respond: (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === '-C') {
        const wt = args[1] as string;
        const sub = args[2];
        if (sub === 'status') return { stdout: '' };
        if (sub === 'rev-parse') return { stdout: 'abc' };
        if (sub === 'rev-list') return { stdout: '1\n' };
        if (sub === 'diff') return { stdout: (git.get(wt) ?? []).join('\n') };
      }
      return tmux.respond(cmd, args, opts);
    },
  });
  const notified: string[] = [];
  const deps: McpDeps = {
    context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), out),
    notify: async (m) => void notified.push(m),
  };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const audit = (): { tool: string; task?: string; outcome: string }[] =>
    fs.existsSync(auditPath(config)) ? fs.readFileSync(auditPath(config), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
  const spec = (task: string, extra = ''): string => `---\ntask: ${task}\nagent: claude\n${extra}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  const running = (id: string, files: string[]): void => {
    tmux.add(id.toLowerCase(), '● Working\n  esc to interrupt\n');
    seedTask(config, id, { repos: [{ path: repo, worktree: `${repo}-${id.toLowerCase()}` }] });
    git.set(`${repo}-${id.toLowerCase()}`, files);
  };
  return { config, tmux, runner, notified, call, audit, spec, running };
}

describe('mcp: queue read tools', () => {
  it('queue_list and overlap are read tools, always there, with read-only annotations', () => {
    for (const name of ['queue_list', 'overlap']) {
      assert.equal(tool(name).kind, 'read');
      assert.equal(tool(name).annotations.readOnlyHint, true);
    }
    assert.equal(tool('queue').kind, 'write');
    assert.equal(tool('queue_rm').kind, 'write');
  });

  it('queue_list says the queue is empty, then lists position, condition, after and the error', async () => {
    const t = setup('ql', 'mcp: {allow: [queue]}\n');
    assert.equal((await t.call('queue_list')).text, 'The queue is empty.');
    t.running('NC-9', []);
    assert.equal((await t.call('queue', { spec: t.spec('Q-1') + t.spec('Q-2', 'after: Q-1\n'), confirm: true })).isError, undefined);
    const r = await t.call('queue_list');
    assert.match(r.text, /^2 waiting in the queue; 0 starting or failed\./);
    const list = JSON.parse(r.text.slice(r.text.indexOf('['))) as { task: string; position: number; startCondition: string; after: string[] }[];
    assert.deepEqual(list.map((x) => [x.task, x.position, x.startCondition, x.after]), [['Q-1', 1, 'czeka na miejsce: claude 1/1', []], ['Q-2', 2, 'czeka na Q-1', ['Q-1']]]);
  });

  it('overlap lists the pairs and the files; with a task only its pairs; an unknown task is an error', async () => {
    const t = setup('ov');
    t.running('A-1', ['x.ts', 'y.ts']);
    t.running('A-2', ['y.ts']);
    t.running('A-3', ['z.ts']);
    const r = await t.call('overlap');
    assert.match(r.text, /^1 colliding pair;/);
    assert.deepEqual((JSON.parse(r.text.slice(r.text.indexOf('['))) as { a: string; b: string; files: string[] }[]).map((o) => [o.a, o.b, o.files]), [['A-1', 'A-2', ['y.ts']]]);
    assert.match((await t.call('overlap', { task: 'a-3' })).text, /^No two active tasks/);
    assert.equal((await t.call('overlap', { task: 'zzz' })).isError, true);
  });

  it('status carries the queue and the collisions as short lines before the rows, and collidesWith per task', async () => {
    const t = setup('st', 'mcp: {allow: [queue]}\n');
    t.running('A-1', ['y.ts']);
    t.running('A-2', ['y.ts']);
    await t.call('queue', { spec: t.spec('Q-1'), confirm: true });
    const r = await t.call('status');
    const lines = r.text.split('\n');
    assert.match(lines[0]!, /^2 tasks:/);
    assert.match(lines[1]!, /^Queue \(1\): Q-1 – czeka na miejsce: claude 2\/1\. queue_list has the detail\.$/);
    assert.match(lines[2]!, /^Collisions: A-1 ⚠ A-2: 1; A-2 ⚠ A-1: 1\. overlap lists the files\.$/);
    const rows = JSON.parse(r.text.slice(r.text.indexOf('['))) as { task: string; collidesWith: unknown }[];
    assert.deepEqual(rows.find((x) => x.task === 'A-1')!.collidesWith, [{ task: 'A-2', files: 1 }]);
  });
});

describe('mcp: queue write tools', () => {
  it('queue is refused unless mcp.allow lists it; the refusal is audited', async () => {
    const t = setup('qd', 'mcp: {allow: [new]}\n');
    const r = await t.call('queue', { spec: t.spec('Q-1'), confirm: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /Writing is off for "queue"/);
    assert.deepEqual(readQueue(t.config), []);
    assert.deepEqual(t.audit().map((a) => [a.tool, a.outcome]), [['queue', 'denied']]);
    assert.equal((await t.call('queue_rm', { task: 'Q-1' })).isError, true);
  });

  it('the first call returns the summary and writes nothing; confirm: true queues, audits and notifies', async () => {
    const t = setup('qc', 'mcp: {allow: [queue]}\n');
    t.running('NC-9', []);
    const first = await t.call('queue', { spec: t.spec('Q-1') });
    assert.match(first.text, /Q-1 {2}claude\/default\/high {2}priority normal/);
    assert.match(first.text, /waits for a free claude window/);
    assert.match(first.text, /Not queued yet\. Show this to the user and ask; .*confirm: true\.$/);
    assert.deepEqual(readQueue(t.config), []);
    assert.deepEqual(t.audit().map((a) => [a.tool, a.task, a.outcome]), [['queue', 'Q-1', 'requested'], ['queue', 'Q-1', 'preview']]);
    assert.deepEqual(t.notified, []);
    const done = await t.call('queue', { spec: t.spec('Q-1'), confirm: true });
    assert.match(done.text, /^Queued: Q-1\./);
    assert.deepEqual(readQueue(t.config).map((e) => e.task), ['Q-1']);
    assert.deepEqual(t.notified, ['czat zlecił: queue Q-1']);
    assert.equal(t.audit().at(-1)!.outcome, 'done');
  });

  it('validates like the CLI (unknown after, a circle), refuses setup, and shows touches warnings and the review hint in the summary', async () => {
    const t = setup('qv', 'mcp: {allow: [queue]}\n');
    t.running('A-1', ['src/menu/a.ts']);
    const bad = await t.call('queue', { spec: t.spec('Q-1', 'after: NOPE-1\n') });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /after NOPE-1: there is no such task/);
    const setupSpec = t.spec('Q-2').replace('repos:', 'setup: [rm -rf /]\nrepos:');
    const refused = await t.call('queue', { spec: setupSpec, confirm: true });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /"setup" runs shell commands and is not accepted from the chat/);
    const warn = await t.call('queue', { spec: t.spec('Q-3', 'touches: src/menu/**\n') });
    assert.match(warn.text, /⚠ Q-3 touches src\/menu\/\*\*, and A-1 already changes 1 matching file/);
    const hint = await t.call('queue', { spec: t.spec('Q-4', 'review_of: A-1\nmodel: sonnet\n') });
    assert.match(hint.text, /hint: .*add "after: A-1"/);
    assert.deepEqual(readQueue(t.config), []);
  });

  it('queue_rm takes a task out; an unknown one is an error; both are audited', async () => {
    const t = setup('qr', 'mcp: {allow: [queue, queue_rm]}\n');
    await t.call('queue', { spec: t.spec('Q-1') + t.spec('Q-2'), confirm: true });
    const r = await t.call('queue_rm', { task: 'q-1' });
    assert.equal(r.text, 'Q-1: removed from the queue (cancelled)');
    assert.equal(readTaskRecord(t.config, 'q-1')?.cancelSource, 'mcp');
    assert.deepEqual(readQueue(t.config).map((e) => e.task), ['Q-2']);
    assert.equal((await t.call('queue_rm', { task: 'Q-1' })).isError, true);
    assert.deepEqual(t.audit().filter((a) => a.tool === 'queue_rm').map((a) => a.outcome), ['requested', 'done', 'requested', 'error']);
    assert.ok(t.notified.includes('czat zlecił: queue_rm Q-1'));
  });
});
