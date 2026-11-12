import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import threads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
import { it } from 'node:test';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { tryFileLock } from '../src/core/file-lock.ts';
import { shutdownMeasurements } from '../src/core/fs-measure.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { queueTick, QueueMemory, readQueue, retryEntry } from '../src/core/queue.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * P93 (prod 12.11: 10 active tasks, load 55–70, sequential `npm ci` setups): the MCP confirm of `queue` and `new` planned the specs again (tmux,
 * git rev-parse, every task record) and waited for start.lock, which the watcher holds across deliveries and starts. It ran past the 8 s response
 * budget, the budget stopped it before the entry was written, and the owner pasted `agentctl queue <spec>` in a terminal. Now the confirm records the
 * accepted spec and answers; the watcher validates it, then the worktree, the setup and the window are its work.
 */
const scratch = useScratch();
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;
const drain = async () => { for (let i = 0; i < 50; i++) await new Promise(resolve => setImmediate(resolve)); };
const NETWORK = /^(?:fetch|ls-remote|pull|remote|push)$/;

/** Every process the server or the watcher runs is recorded; `hold()` blocks all of them (a host too loaded to run any), and worktree+setup take 30 s. */
class LoadedRunner extends DiskRunner {
  readonly procs: string[][] = [];
  held = false;
  private waiters: (() => void)[] = [];
  /** `git worktree add` and the setup wait here: the 30 s of a checkout plus `npm ci` on a loaded host. */
  private gate: Promise<void> = new Promise(() => undefined);
  private open!: () => void;
  constructor(...args: ConstructorParameters<typeof DiskRunner>) {
    super(...args);
    this.gate = new Promise<void>(yes => { this.open = yes; });
  }
  hold(): void { this.held = true; }
  release(): void { this.held = false; for (const w of this.waiters.splice(0)) w(); }
  finishSlowWork(): void { this.open(); }
  override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    this.procs.push([cmd, ...args]);
    if (this.held) await new Promise<void>(yes => this.waiters.push(yes));
    if ((cmd === 'git' && args.includes('worktree') && args.includes('add')) || cmd === 'sh') {
      await this.gate;
      await this.sleep(30_000);
      if (cmd === 'git') fs.mkdirSync(args.slice(args.indexOf('add') + 1).find(a => !a.startsWith('--') && a.startsWith('/'))!, { recursive: true });
      if (cmd === 'sh') return { code: 0, stdout: '', stderr: '' };
    }
    return super.exec(cmd, args, opts);
  }
}

function environment(name: string) {
  const root = scratch.sub(name), repo = scratch.sub(`${name}/app`);
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'setup:\n  - "npm ci"\n');
  const config = makeConfig(root, 'limits: {claude: 20}\nmcp: {allow: [new, queue]}\nwatch: {interval: 1}\ncapacity: {snapshot: false, codex_refresh: false}\n');
  const tmux = new FakeTmux();
  // Ten active tasks, one with a large worktree: a walk of it would show in the spies below.
  const busy = scratch.sub(`${name}/busy-wt`);
  fs.mkdirSync(path.join(busy, 'node_modules/pkg'), { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(busy, 'node_modules/pkg', `f${i}.js`), 'x');
  for (let i = 0; i < 10; i++) { seedTask(config, `LIVE-${i}`, { repos: [{ path: repo, worktree: i ? `${busy}-${i}` : busy }] }); tmux.add(`live-${i}`, 'Working (esc to interrupt)'); }
  const runner: LoadedRunner = new LoadedRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args, opts) => {
    if (cmd === 'git' && args[0] === '-C') {
      const sub = args[2];
      if (sub === 'worktree' && args[3] === 'list') return { stdout: '' };
      if (sub === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${args[1]}\n` };
      if (sub === 'rev-parse' && args.includes('--git-path')) return { stdout: 'index.lock\n' };
      if (sub === 'rev-parse') return { stdout: 'abc\n' };
      if (sub === 'symbolic-ref') return { code: 1 };
      if (sub === 'status' || sub === 'diff') return { stdout: '' };
    }
    return tmux.respond(cmd, args, opts);
  } });
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const ctx = new Context(runner, config, () => {});
  const deps: McpDeps = { context: (out) => new Context(runner, config, out), notify: async (m) => void notified.push(m) };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const memory = new QueueMemory();
  const spec = (task: string) => `---\ntask: ${task}\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n---\nPrompt of ${task}.\n`;
  return { config, tmux, runner, ctx, call, memory, notifier, notified, spec, repo, busy, tick: () => queueTick(ctx, memory, notifier, {}) };
}
const token = (preview: ToolResult) => /preview_token: (\S+)/.exec(preview.text)![1]!;

for (const name of ['queue', 'new'] as const) it(`P93: ${name} confirm with a 30 s worktree+setup and a host that runs nothing returns before any work, the watcher validates and starts it`, async () => {
  const e = environment(`${name}-accept`);
  await e.tick(); // the watcher's heartbeat (MCP new hands starts to a live watcher)
  const preview = await e.call(name, { spec: e.spec(`${name.toUpperCase()}-1`) });
  assert.ok(!preview.isError, preview.text);
  // The host runs no process any more, and the watcher holds start.lock (a delivery, a start): the old confirm waited for both.
  e.runner.hold();
  const before = e.runner.procs.length;
  const lock = tryFileLock(path.join(e.config.stateDir, 'start.lock'))!;
  let done: ToolResult | undefined;
  const pending = e.call(name, { confirm: true, preview_token: token(preview) }).then(r => { done = r; });
  await drain();
  assert.ok(done, 'the confirm answered while no process could run and start.lock was held');
  assert.ok(!done!.isError, done!.text);
  assert.match(done!.text, name === 'new' ? /^Registered: NEW-1 \(claude \S+\) – starting\./ : /^Queued: QUEUE-1 \(accepted\)\./);
  assert.deepEqual(e.runner.procs.slice(before), [], 'the confirm ran no git, tmux or setup');
  const [entry] = readQueue(e.config);
  assert.deepEqual([entry?.task, entry?.status, Boolean(entry?.direct)], [`${name.toUpperCase()}-1`, 'accepted', name === 'new']);
  assert.ok(entry?.confirmation?.token, 'the durable entry carries the confirmation');
  await pending;
  lock(); e.runner.release();
  assert.match((await e.call('queue_list')).text, /przyjęte – watch sprawdza spec/);
  // The watcher validates the accepted spec and begins the start; the worktree and the setup take their 30 s in the background.
  assert.deepEqual(await e.tick(), [`${name.toUpperCase()}-1`]);
  assert.equal(readQueue(e.config)[0]?.status, 'starting');
  assert.match((await e.call('queue_list')).text, /starting|uruchamiane/);
  e.runner.finishSlowWork();
  await e.memory.idle();
  assert.ok(readTaskRecord(e.config, `${name}-1`), 'the task exists after the 30 s start');
  assert.ok(e.tmux.windows.some(w => w.name === `${name}-1`), 'its window is open');
  assert.deepEqual(readQueue(e.config), [], 'the entry is gone');
  assert.ok(readJournal(e.config).some(j => j.kind === 'queue-start' && j.task === `${name.toUpperCase()}-1`));
  // The same token again answers from the durable record and starts nothing twice.
  assert.match((await e.call(name, { confirm: true, preview_token: token(preview) })).text, /already executed/);
});

for (const name of ['queue', 'new'] as const) it(`P93: an accepted ${name} spec the watcher refuses fails with its reason in queue_list, an event and a notification; queue_retry validates it again`, async () => {
  const e = environment(`${name}-refused`);
  await e.tick();
  const task = `${name.toUpperCase()}-2`, wt = `${e.repo}-${task.toLowerCase()}`;
  const preview = await e.call(name, { spec: e.spec(task) });
  assert.ok(!preview.isError, preview.text);
  fs.mkdirSync(wt, { recursive: true }); // between the preview and the watcher's check, the worktree appeared
  const done = await e.call(name, { confirm: true, preview_token: token(preview) });
  assert.ok(!done.isError, done.text);
  assert.deepEqual(await e.tick(), []);
  const [entry] = readQueue(e.config);
  assert.equal(entry?.status, 'failed');
  assert.match(entry?.error ?? '', /worktree .* already exists/);
  const listed = JSON.parse((await e.call('queue_list', { format: 'json' })).text);
  assert.match(JSON.stringify(listed), /failed[\s\S]*already exists/);
  const event = readJournal(e.config).find(j => j.kind === 'queue-failed' && j.task === task);
  assert.match(event?.text ?? '', /przyjęta spec odrzucona przy sprawdzeniu w watch – .*already exists/);
  assert.ok(e.notified.some(m => m.includes(task) && /odrzucona/.test(m)), 'the owner is notified');
  assert.equal(readTaskRecord(e.config, task.toLowerCase()), undefined, 'nothing was started');
  fs.rmSync(wt, { recursive: true });
  assert.equal((await retryEntry(e.ctx, task)).status, 'accepted', 'retry goes back to validation');
  e.runner.finishSlowWork();
  assert.deepEqual(await e.tick(), [task]);
  await e.memory.idle();
  assert.ok(readTaskRecord(e.config, task.toLowerCase()));
});

it('P93: queue and new previews stay bounded: no git network, no git status, no worker measurement and no walk of a worktree', async () => {
  const e = environment('preview-spy');
  await e.tick();
  const Worker = threads.Worker, readdir = fs.readdirSync;
  let workers = 0, walks = 0;
  threads.Worker = class extends Worker { constructor(...args: ConstructorParameters<typeof Worker>) { workers++; super(...args); } } as typeof Worker;
  fs.readdirSync = ((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target).startsWith(e.busy)) walks++;
    return (readdir as Function)(target, ...args);
  }) as typeof readdir;
  syncBuiltinESMExports();
  try {
    const before = e.runner.procs.length;
    for (const name of ['queue', 'new']) {
      const preview = await e.call(name, { spec: e.spec(`SPY-${name.toUpperCase()}`) });
      assert.ok(!preview.isError, preview.text);
    }
    const git = e.runner.procs.slice(before).filter(c => c[0] === 'git').map(c => c[3] ?? c[1]!);
    assert.deepEqual(git.filter(sub => NETWORK.test(sub)), [], 'no git network call');
    assert.deepEqual(git.filter(sub => sub === 'status'), [], 'no git status walk');
    assert.deepEqual(e.runner.procs.slice(before).filter(c => c[0] === 'du' || c[0] === 'find'), [], 'no du/find');
    assert.equal(workers, 0, 'no worker measurement');
    assert.equal(walks, 0, 'no walk of a worktree');
  } finally { threads.Worker = Worker; fs.readdirSync = readdir; syncBuiltinESMExports(); await shutdownMeasurements(); }
});
