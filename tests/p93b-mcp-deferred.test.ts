import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { z } from 'zod';
import { composerFixture } from './composer-fixture.ts';
import { Context } from '../src/core/context.ts';
import { tryFileLock } from '../src/core/file-lock.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory, readQueue, saveEntry, setPaused } from '../src/core/queue.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { touchCohort } from '../src/core/cohort.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P93b (prod 12–13.11, load 55–70): P93 made only queue/new answer within the 8 s budget. The confirm of `unblock` (INTEGRATION-37,
 * TRAM-ROOF-1R) collected the status of every task three times (tmux captures, git for every report's commits) and ran past the budget again
 * and again; the owner ran the CLI. Every MCP write whose confirm can wait on start.lock, git, tmux or a scan of every task now records a
 * durable request and answers; the watcher checks the preview's scope again and applies it, with an event (and a notification when it fails).
 */
const scratch = useScratch();
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;
const drain = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
const IDLE = composerFixture('❯ \n');
const ALLOW = ['unblock', 'queue_up', 'queue_rm', 'queue_retry', 'close', 'cancel', 'send', 'mark', 'hide', 'unhide', 'archive', 'cohort_add', 'cohort_remove', 'cohort_note', 'cohort_archive'];

/** `hold()`: a host too loaded to run any process; every process is recorded. */
class LoadedRunner extends DiskRunner {
  readonly procs: string[][] = [];
  held = false;
  private waiters: (() => void)[] = [];
  hold(): void { this.held = true; }
  release(): void { this.held = false; for (const w of this.waiters.splice(0)) w(); }
  override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.procs.push([cmd, ...args]);
    if (this.held) await new Promise<void>(yes => this.waiters.push(yes));
    return super.exec(cmd, args, opts);
  }
}

async function environment(name: string) {
  const root = scratch.sub(name), repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, `limits: {claude: 20}\nmcp: {allow: [${ALLOW.join(', ')}]}\nwatch: {interval: 1}\ncancel: {grace: 0}\ncapacity: {snapshot: false, codex_refresh: false}\n`);
  const tmux = new FakeTmux();
  for (const task of ['CLOSE-1', 'CANCEL-1', 'SEND-1', 'HIDE-1', 'UNHIDE-1', 'MARK-1', 'COHORT-1']) { seedTask(config, task, { repos: [{ path: repo, worktree: `${repo}-${task.toLowerCase()}` }], ...(task === 'UNHIDE-1' ? { hidden: true } : {}) }); tmux.add(task.toLowerCase(), IDLE); }
  // A closed author whose report says FAIL: its dependent is blocked (unblock); an old closed task for archive.
  const author = seedTask(config, 'AUTHOR', { closed: true, closedAt: '2026-11-01T10:00:00.000Z' });
  fs.mkdirSync(path.dirname(author.report), { recursive: true });
  fs.writeFileSync(author.report, 'Werdykt: FAIL\n<!-- agentctl:report-end -->\n');
  seedTask(config, 'OLD-1', { closed: true, closedAt: '2026-10-01T10:00:00.000Z' });
  const runner = new LoadedRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === '-C') {
      const sub = args[2];
      if (sub === 'worktree' && args[3] === 'list') return { stdout: '' };
      if (sub === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${args[1]}\n` };
      if (sub === 'rev-parse') return { stdout: 'abc\n' };
      if (sub === 'status' || sub === 'diff') return { stdout: '' };
    }
    return tmux.respond(cmd, args, opts);
  } });
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const ctx = new Context(runner, config, () => {});
  const deps: McpDeps = { context: (out) => new Context(runner, config, out), notify: async (m) => void notified.push(m) };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const spec = (task: string, after = '') => splitSpecs(`---\ntask: ${task}\nagent: claude\n${after}repos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`, 'test');
  for (const [task, after] of [['DEP', 'after: AUTHOR\n'], ['UP-1', ''], ['UP-2', ''], ['RM-1', '']] as const) await commitQueueAdd(ctx, (await planQueueAdd(ctx, spec(task, after))).items);
  // A failed queue start whose spec the watcher never validated: retry gives it back to the validation.
  await commitQueueAdd(ctx, (await planQueueAdd(ctx, spec('RETRY-1'))).items);
  const retry = readQueue(config).find((e) => e.task === 'RETRY-1')!;
  await saveEntry(ctx, { ...retry, status: 'failed', failedAt: new Date().toISOString(), error: 'x', unvalidated: true });
  await touchCohort(ctx, 'batch');
  await touchCohort(ctx, 'notes');
  await setPaused(ctx, true); // the line starts nothing here: the test looks at what the requests did to it
  const memory = new QueueMemory();
  return { config, tmux, runner, ctx, call, notified, notifier, memory, tick: async () => { const began = await queueTick(ctx, memory, notifier, { rows: [] }); await memory.idle(); return began; } };
}
const token = (preview: ToolResult) => /preview_token: (\S+)/.exec(preview.text)?.[1];
const requests = (config: { path: string }) => {
  const dir = path.join(path.dirname(config.path), 'mcp-requests');
  try { return fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as { tool: string; status: string; error?: string; label: string }); } catch { return []; }
};

/** Each write as the chat calls it: the preview arguments, then the confirm (a single mark and a send have no preview). */
const WRITES: { tool: string; args: Record<string, unknown>; preview: boolean }[] = [
  { tool: 'archive', args: { older_than: '7d' }, preview: true }, // first: the closes below change the set of closed tasks it previewed
  { tool: 'unblock', args: { task: 'DEP' }, preview: true },
  { tool: 'queue_up', args: { task: 'UP-2' }, preview: true },
  { tool: 'queue_rm', args: { task: 'RM-1' }, preview: true },
  { tool: 'queue_retry', args: { task: 'RETRY-1' }, preview: true },
  { tool: 'close', args: { task: 'CLOSE-1' }, preview: true },
  { tool: 'cancel', args: { task: 'CANCEL-1', reason: 'not needed' }, preview: true },
  { tool: 'hide', args: { tasks: ['HIDE-1'] }, preview: true },
  { tool: 'unhide', args: { tasks: ['UNHIDE-1'] }, preview: true },
  { tool: 'cohort_add', args: { cohort: 'batch', tasks: ['COHORT-1'] }, preview: true },
  { tool: 'cohort_note', args: { cohort: 'notes', text: 'night batch' }, preview: true },
  { tool: 'mark', args: { task: 'MARK-1', result: 'ok' }, preview: false },
  { tool: 'send', args: { task: 'SEND-1', text: 'Continue with the tests.' }, preview: false },
];

it('P93b: every write confirm on a host that runs nothing and a held start.lock returns at once, the watcher applies it with an event', async () => {
  const e = await environment('loaded');
  await e.tick(); // the watcher's heartbeat
  const confirms: { tool: string; args: Record<string, unknown> }[] = [];
  for (const w of WRITES) {
    if (!w.preview) { confirms.push({ tool: w.tool, args: w.args }); continue; }
    const preview = await e.call(w.tool, w.args);
    assert.ok(!preview.isError, `${w.tool}: ${preview.text}`);
    confirms.push({ tool: w.tool, args: { confirm: true, preview_token: token(preview) } });
  }
  // The host runs no process any more and the watcher holds start.lock (a delivery, a start): the old confirms waited for one or both.
  e.runner.hold();
  const lock = tryFileLock(path.join(e.config.stateDir, 'start.lock'))!;
  const before = e.runner.procs.length;
  try {
    for (const c of confirms) {
      let done: ToolResult | undefined;
      const pending = e.call(c.tool, c.args).then((r) => { done = r; });
      await drain();
      assert.ok(done, `${c.tool}: the confirm answered while no process could run and start.lock was held`);
      assert.ok(!done!.isError, `${c.tool}: ${done!.text}`);
      assert.match(done!.text, new RegExp(`^Accepted: ${c.tool} `), c.tool);
      await pending;
    }
    assert.deepEqual(e.runner.procs.slice(before), [], 'no confirm ran git, tmux or anything else');
  } finally { lock(); e.runner.release(); }
  assert.deepEqual(requests(e.config).map((r) => r.status), WRITES.map(() => 'pending'), 'one durable request per confirm');
  assert.equal(readTaskRecord(e.config, 'close-1')?.closed, undefined, 'nothing was done in the confirm');
  // The watcher applies them at its next tick, outside any response budget.
  await e.tick();
  const applied = requests(e.config);
  assert.deepEqual(applied.filter((r) => r.status !== 'done').map((r) => `${r.tool}: ${r.error}`), [], 'every request was applied');
  const events = readJournal(e.config).filter((j) => j.kind === 'mcp-applied');
  for (const w of WRITES) assert.ok(events.some((j) => j.text.startsWith(`${w.tool} `)), `${w.tool}: an mcp-applied event`);
  const queue = readQueue(e.config);
  assert.deepEqual(queue.find((q) => q.task === 'DEP')?.after, [], 'unblock dropped the rejected author');
  assert.equal(queue.filter((q) => q.status === 'queued' && q.priority === 'normal').sort((a, b) => a.order - b.order)[0]?.task, 'UP-2', 'UP-2 moved to the front');
  assert.equal(queue.some((q) => q.task === 'RM-1'), false, 'RM-1 left the queue');
  assert.equal(queue.find((q) => q.task === 'RETRY-1')?.status !== 'failed', true, 'RETRY-1 is no longer failed');
  assert.equal(readTaskRecord(e.config, 'close-1')?.closed, true);
  assert.equal(readTaskRecord(e.config, 'cancel-1')?.cancelled, true);
  assert.equal(readTaskRecord(e.config, 'hide-1')?.hidden, true);
  assert.equal(readTaskRecord(e.config, 'unhide-1')?.hidden, false);
  assert.equal(readTaskRecord(e.config, 'cohort-1')?.cohort, 'batch');
  assert.equal(readTaskRecord(e.config, 'old-1'), undefined, 'OLD-1 was archived');
  assert.match(fs.readFileSync(path.join(path.dirname(e.config.path), 'history.jsonl'), 'utf8'), /"task":"MARK-1"[\s\S]*"result":"ok"/);
  assert.match(fs.readFileSync(path.join(e.config.stateDir, 'send-1', 'TASK.md'), 'utf8'), /Continue with the tests\./, 'the follow-up reached the task');
  // Nothing is applied twice.
  await e.tick();
  assert.equal(readJournal(e.config).filter((j) => j.kind === 'mcp-applied').length, events.length);
});

it('P93b: a scope that changed between the preview and the watcher is refused with an event and a notification; nothing is done', async () => {
  const e = await environment('changed');
  await e.tick();
  const preview = await e.call('close', { task: 'CLOSE-1' });
  const done = await e.call('close', { confirm: true, preview_token: token(preview) });
  assert.match(done.text, /^Accepted: close CLOSE-1/);
  e.tmux.windows = e.tmux.windows.filter((w) => w.name !== 'close-1'); // the window went away before the watcher's tick
  await e.tick();
  const [request] = requests(e.config);
  assert.equal(request?.status, 'failed');
  assert.match(request?.error ?? '', /changed preview/);
  const event = readJournal(e.config).find((j) => j.kind === 'mcp-failed');
  assert.match(event?.text ?? '', /^close CLOSE-1: nie wykonano – changed preview/);
  assert.ok(e.notified.some((m) => /close CLOSE-1: nie wykonano/.test(m)), 'the owner is notified');
  assert.equal(readTaskRecord(e.config, 'close-1')?.closed, undefined, 'the task was not closed');
});

it('P93b: the same token confirmed again records nothing twice; a permission revoked before the tick fails the request', async () => {
  const e = await environment('repeat');
  await e.tick();
  const preview = await e.call('hide', { tasks: ['HIDE-1'] });
  const first = await e.call('hide', { confirm: true, preview_token: token(preview) });
  const again = await e.call('hide', { confirm: true, preview_token: token(preview) });
  assert.match(first.text, /^Accepted: hide/);
  assert.match(again.text, /^already accepted: hide/);
  assert.equal(requests(e.config).length, 1);
  e.config.mcp.allow = ['close']; // the watcher reads the permission again when it applies the request
  await e.tick();
  assert.match(requests(e.config)[0]?.error ?? '', /"hide" is no longer in mcp\.allow/);
  assert.equal(readTaskRecord(e.config, 'hide-1')?.hidden, undefined);
});

it('P93b: the unblock preview reads only the queue and its dependencies (no capture of every window, no git)', async () => {
  const e = await environment('bounded');
  await e.tick();
  const before = e.runner.procs.length;
  const preview = await e.call('unblock', { task: 'DEP' });
  assert.ok(!preview.isError, preview.text);
  assert.match(preview.text, /"state": "blocked"/);
  const procs = e.runner.procs.slice(before);
  assert.deepEqual(procs.filter((p) => p[0] === 'git'), [], 'no git');
  assert.deepEqual(procs.filter((p) => p[0] === 'tmux' && p[1] === 'capture-pane'), [], 'no capture of the task windows');
});
