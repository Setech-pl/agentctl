import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import type { Notifier } from '../src/core/notify.ts';
import { queueTick, QueueMemory, readQueue, retryEntry } from '../src/core/queue.ts';
import { RealRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { readSetupProgress, setupProgressFile } from '../src/core/setup-progress.ts';
import { readTaskRecord, taskDir } from '../src/core/taskstore.ts';
import { DiskRunner, FakeTmux, makeConfig, useScratch } from './helpers.ts';

/*
 * P19 (0.17.5): the MCP `new` of a task with setup commands must not do the setup inside the MCP server. It registers the start (an entry the
 * watcher picks up), answers at once, and the watcher runs the checkout, the setup and the window. Reads never wait for a long operation.
 */

const scratch = useScratch();
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** Real `sh` for the setup commands, a worktree directory for `git worktree add`, tmux and the rest scripted. */
class SetupRunner extends DiskRunner {
  readonly real = new RealRunner();
  readonly shells: string[] = [];
  readonly worktrees: string[] = [];
  override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
      const dir = args.slice(args.indexOf('add') + 1).find((a) => !a.startsWith('--'))!;
      fs.mkdirSync(dir, { recursive: true });
      this.worktrees.push(dir);
    }
    if (cmd === 'sh') {
      await super.exec(cmd, args, opts);
      this.shells.push(args[1] ?? '');
      return this.real.exec(cmd, args, opts);
    }
    return super.exec(cmd, args, opts);
  }
}

function environment(name: string, setupCommand: string, extraYaml = '') {
  const root = scratch.sub(name);
  const repos = ['alpha', 'beta'].map((n) => {
    const dir = scratch.sub(`${name}/${n}`);
    fs.writeFileSync(path.join(dir, '.agentctl.yaml'), `setup:\n  - ${JSON.stringify(setupCommand)}\n`);
    return dir;
  });
  const config = makeConfig(root, `limits: {claude: 4}\nmcp: {allow: [new, queue]}\nwatch: {interval: 1}\n${extraYaml}`);
  const tmux = new FakeTmux();
  const created = new Set<string>();
  const runner: SetupRunner = new SetupRunner({
    dryRun: false,
    startTime: Date.now(),
    respond: (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === '-C') {
        const sub = args[2];
        const where = args[1] as string;
        if (sub === 'worktree' && args[3] === 'list') return { stdout: runner.worktrees.map((w) => `worktree ${w}\n`).join('\n') };
        if (sub === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${where}\n` };
        if (sub === 'rev-parse' && args.includes('--git-path')) return { stdout: 'index.lock\n' };
        if (sub === 'rev-parse') return { stdout: 'abc\n' };
        if (sub === 'symbolic-ref') return { code: 1 };
        if (sub === 'status' || sub === 'diff') return { stdout: '' };
        if (sub === 'rev-list') return { stdout: '1\n' };
      }
      void created;
      return tmux.respond(cmd, args, opts);
    },
  });
  const notified: string[] = [];
  const notifier: Notifier = { clickable: false, notify: async (_t, m) => void notified.push(m) };
  const deps = (): McpDeps => ({ context: (out) => new Context(runner, loadGlobalConfig(path.dirname(config.path)), out), notify: async (m) => void notified.push(m) });
  const mcp = deps();
  const call = (n: string, args: Record<string, unknown> = {}, d: McpDeps = mcp): Promise<ToolResult> => tool(n).run(d, z.object(tool(n).input).parse(args) as never);
  const ctx = new Context(runner, config, () => {});
  const memory = new QueueMemory();
  const spec = (task: string) => `---\n${[`task: ${task}`, 'agent: claude'].join('\n')}\nrepos:\n${repos.map((r) => `  - {path: ${r}, worktree: ${r}-${task.toLowerCase()}}`).join('\n')}\n---\nPrompt of ${task}.\n`;
  /** What the watcher does at one tick (its queue part); `wait` false leaves the start running in the background. */
  const tick = async (wait = true): Promise<string[]> => {
    const began = await queueTick(ctx, memory, notifier, {});
    if (wait) await memory.idle();
    return began;
  };
  return { root, repos, config, tmux, runner, notified, call, ctx, memory, spec, tick, deps };
}
const text = (r: ToolResult): string => r.text;
const kinds = (config: ReturnType<typeof makeConfig>): string[] => readJournal(config).map((e) => e.kind);

describe('P19: MCP new with setup is handed to the watcher', () => {
  it('confirm returns at once, runs no setup in the server and registers the start; "MCP new" is in the journal before the setup ends', async () => {
    const e = environment('handover', 'sleep 3');
    await e.tick(); // the watcher is there (its tick leaves a heartbeat)
    const preview = await e.call('new', { spec: e.spec('SLOW-1') });
    assert.ok(!preview.isError, text(preview));
    assert.match(text(preview), /Start: asynchronous/);
    const t0 = Date.now();
    const done = await e.call('new', { spec: e.spec('SLOW-1'), confirm: true });
    const took = Date.now() - t0;
    assert.ok(!done.isError, text(done));
    assert.ok(took < 2000, `confirm took ${took} ms with a 2 x 3 s setup`);
    assert.match(text(done), /^Registered: SLOW-1/);
    assert.deepEqual(e.runner.shells, [], 'no setup command ran in the server');
    assert.deepEqual(e.runner.worktrees, [], 'no checkout happened in the server');
    assert.equal(readTaskRecord(e.config, 'slow-1'), undefined, 'no TASK.md yet: the watcher has not begun');
    const [entry] = readQueue(e.config);
    assert.deepEqual([entry?.task, entry?.status, entry?.direct, entry?.priority], ['SLOW-1', 'queued', true, 'high']);
    assert.ok(readJournal(e.config).some((j) => j.kind === 'mcp-write' && j.text === 'new: new SLOW-1'), 'the MCP new entry is in the journal now');
    assert.match(text(await e.call('queue_list')), /uruchamiane – czeka na najbliższy tick watch/);
  });

  it('the watcher runs the checkout, both setups and the window; status and the reads answer meanwhile and say where the setup is', async () => {
    const e = environment('watcher', 'sleep 1; echo installed');
    await e.tick();
    await e.call('new', { spec: e.spec('SLOW-2') });
    await e.call('new', { spec: e.spec('SLOW-2'), confirm: true });
    await e.tick(false);
    const seen = new Set<string>();
    const reads: number[] = [];
    while (e.memory.inflight.size > 0) {
      for (const [name, args] of [['status', {}], ['events_since', {}], ['queue_list', {}], ['version', {}], ['peek', { task: 'SLOW-2' }]] as const) {
        const t0 = Date.now();
        const r = await e.call(name, args as Record<string, unknown>);
        reads.push(Date.now() - t0);
        const m = /setup w toku \(repo (\d)\/2 (\w+)/.exec(text(r));
        if (m) seen.add(`${m[1]} ${m[2]}`);
      }
      await sleep(100);
    }
    await e.memory.idle();
    assert.ok(Math.max(...reads) < 1500, `reads took up to ${Math.max(...reads)} ms during the setup`);
    assert.ok(seen.has('1 alpha') && seen.has('2 beta'), `status showed ${[...seen].join(', ')}`);
    const record = readTaskRecord(e.config, 'slow-2');
    assert.ok(record, 'the task exists after the setup');
    assert.deepEqual(readQueue(e.config), [], 'the entry is gone');
    assert.equal(fs.existsSync(setupProgressFile(e.config, 'slow-2')), false, 'the progress file is removed');
    assert.equal(readSetupProgress(e.config, 'SLOW-2'), undefined);
    const log = fs.readFileSync(path.join(taskDir(e.config, 'slow-2'), 'setup.log'), 'utf8');
    assert.match(log, /\[alpha\] \$ sleep 1; echo installed[\s\S]*\[beta\] \$ sleep 1; echo installed/);
    assert.ok(e.tmux.windows.some((w) => w.name === 'slow-2'), 'the window exists');
    assert.deepEqual(kinds(e.config).filter((k) => k !== 'mcp-write'), ['setup-started', 'setup-finished', 'setup-started', 'setup-finished', 'queue-start']);
    assert.equal(e.runner.shells.length, 2);
  });

  it('without a watcher the confirm is refused with the reason, and nothing is created', async () => {
    const e = environment('nowatch', 'sleep 3');
    const preview = await e.call('new', { spec: e.spec('LONE-1') });
    assert.match(text(preview), /WARNING: .*watcher is not running/);
    const refused = await e.call('new', { spec: e.spec('LONE-1'), confirm: true });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /every start goes through the watcher .* it is not running[\s\S]*Nothing was started[\s\S]*agentctl watch --tmux/);
    assert.deepEqual(readQueue(e.config), []);
    assert.deepEqual(e.runner.worktrees, []);
    assert.deepEqual(kinds(e.config), []);
  });

  it('a start without setup is also handed to the watcher: Registered, then the watcher opens the window', async () => {
    const e = environment('nosetup', 'true');
    for (const r of e.repos) fs.writeFileSync(path.join(r, '.agentctl.yaml'), 'env: {X: "1"}\n');
    await e.tick(); // the watcher is there (its tick leaves a heartbeat)
    const preview = await e.call('new', { spec: e.spec('PLAIN-1') });
    assert.ok(!preview.isError, text(preview));
    assert.match(text(preview), /Start: asynchronous/);
    const done = await e.call('new', { spec: e.spec('PLAIN-1'), confirm: true });
    assert.match(text(done), /^Registered: PLAIN-1/);
    assert.equal(readTaskRecord(e.config, 'plain-1'), undefined, 'no TASK.md yet: the watcher has not begun');
    const [entry] = readQueue(e.config);
    assert.deepEqual([entry?.task, entry?.status, entry?.direct], ['PLAIN-1', 'queued', true]);
    await e.tick();
    assert.ok(readTaskRecord(e.config, 'plain-1'), 'the watcher started it');
    assert.ok(e.tmux.windows.some((w) => w.name === 'plain-1'), 'the window exists');
    assert.deepEqual(readQueue(e.config), []);
    assert.ok(kinds(e.config).includes('queue-start'));
  });

  it('a repeated new, with the token or without, while the start is in progress reports its state and starts nothing twice', async () => {
    const e = environment('twice', 'sleep 1');
    await e.tick();
    const preview = await e.call('new', { spec: e.spec('TWICE-1') });
    const token = /preview_token: (\S+)/.exec(text(preview))?.[1];
    assert.ok(token);
    const first = await e.call('new', { spec: e.spec('TWICE-1'), confirm: true, preview_token: token });
    assert.match(text(first), /^Registered/);
    for (const args of [{ confirm: true, preview_token: token }, { confirm: true }, {}]) {
      const again = await e.call('new', { spec: e.spec('TWICE-1'), ...args });
      assert.ok(!again.isError, text(again));
      if ('preview_token' in args) assert.match(text(again), /already executed: TWICE-1/);
      else {
        assert.match(text(again), /TWICE-1: already being started/);
        assert.match(text(again), /Nothing was started a second time/);
      }
    }
    assert.equal(readQueue(e.config).length, 1);
    await e.tick(false);
    await until(() => readSetupProgress(e.config, 'TWICE-1')?.phase === 'setup', 'the setup to begin');
    const during = await e.call('new', { spec: e.spec('TWICE-1'), confirm: true });
    assert.match(text(during), /already being started – setup w toku \(repo \d\/2/);
    await e.memory.idle();
    assert.equal(e.runner.shells.length, 2, 'each repository ran its setup once');
    assert.equal(e.tmux.windows.filter((w) => w.name === 'twice-1').length, 1, 'one window');
    assert.equal(kinds(e.config).filter((k) => k === 'queue-start').length, 1);
  });

  it('a failed setup: the task is failed with the reason, the event names repo, exit code and log, the worktrees stay, queue_retry starts it again', async () => {
    const e = environment('failing', 'echo boom >&2; exit 3');
    await e.tick();
    await e.call('new', { spec: e.spec('FAIL-1') });
    await e.call('new', { spec: e.spec('FAIL-1'), confirm: true });
    await e.tick();
    const [entry] = readQueue(e.config);
    assert.equal(entry?.status, 'failed');
    assert.match(entry?.error ?? '', /setup command failed in alpha \(exit 3\)/);
    const events = readJournal(e.config).filter((j) => j.kind === 'setup-failed' || j.kind === 'queue-failed');
    assert.deepEqual(events.map((j) => j.kind), ['setup-failed', 'queue-failed']);
    assert.match(events[0]!.text, /FAIL-1: setup nie powiódł się w alpha \(exit 3\): echo boom >&2; exit 3; log: .*setup\.log; worktree zostaje/);
    assert.equal(e.runner.worktrees.length >= 1 && e.runner.worktrees.every((w) => fs.existsSync(w)), true, 'the worktrees were kept');
    assert.match(text(await e.call('queue_list', { format: 'json' })), /"status": "failed"[\s\S]*queue_retry task=FAIL-1/);
    assert.equal(fs.existsSync(setupProgressFile(e.config, 'fail-1')), false, 'a failed start leaves no "setup in progress"');
    const repeated = await e.call('new', { spec: e.spec('FAIL-1') });
    assert.match(text(repeated), /FAIL-1: the start failed – .*setup command failed in alpha[\s\S]*queue_retry FAIL-1/);
    for (const r of e.repos) fs.writeFileSync(path.join(r, '.agentctl.yaml'), 'setup:\n  - "echo fixed"\n');
    await retryEntry(e.ctx, 'FAIL-1');
    await e.tick();
    assert.ok(readTaskRecord(e.config, 'fail-1'), 'started after the retry');
    assert.deepEqual(readQueue(e.config), []);
  });

  it('a paused queue still starts an explicit start, and leaves the queued tasks alone', async () => {
    const e = environment('paused', 'true');
    await e.tick();
    await e.call('queue', { spec: e.spec('LINE-1') });
    await e.call('queue', { spec: e.spec('LINE-1'), confirm: true });
    fs.mkdirSync(path.join(path.dirname(e.config.path), 'queue'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(e.config.path), 'queue', 'paused'), 'x\n');
    await e.call('new', { spec: e.spec('NOW-1') });
    await e.call('new', { spec: e.spec('NOW-1'), confirm: true });
    await e.tick();
    assert.ok(readTaskRecord(e.config, 'now-1'));
    assert.equal(readTaskRecord(e.config, 'line-1'), undefined);
    assert.deepEqual(readQueue(e.config).map((q) => [q.task, q.status]), [['LINE-1', 'queued']]);
  });

  it('an MCP server that is gone does not stop the setup: a second server sees it finish', async () => {
    const e = environment('restart', 'sleep 1');
    const first = e.deps();
    await e.tick();
    await e.call('new', { spec: e.spec('KEEP-1') }, first);
    await e.call('new', { spec: e.spec('KEEP-1'), confirm: true }, first);
    await e.tick(false);
    // the first server (the app was quit) is not used any more; a new one is asked
    await until(() => readSetupProgress(e.config, 'KEEP-1')?.phase === 'setup', 'the setup to begin');
    const second = e.deps();
    assert.match(text(await e.call('queue_list', {}, second)), /setup w toku/);
    await e.memory.idle();
    assert.ok(readTaskRecord(e.config, 'keep-1'));
    assert.match(text(await e.call('events_since', {}, second)), /START\s+KEEP-1/);
  });
});
