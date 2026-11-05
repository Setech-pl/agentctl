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


describe('P19 FIX2: accepted starts retain their complete scope', () => {
  it('R1: a same-batch reviewer waits for its author record, then both start (934a80d control)', async () => {
    const e = environment('batch', 'sleep 0.3');
    await e.tick();
    const spec = e.spec('AUTHOR-1') + '\n' + e.spec('REVIEW-1').replace('agent: claude', 'agent: codex\nreview_of: AUTHOR-1');
    assert.ok(!(await e.call('new', { spec })).isError);
    assert.match(text(await e.call('new', { spec, confirm: true })), /^Registered:/);
    await e.tick(false);
    assert.match(text(await e.call('queue_list')), /waiting for author AUTHOR-1: setup in progress/);
    await e.memory.idle();
    assert.equal(readQueue(e.config).filter(e => e.status === 'failed').length, 0, 'the unchanged review probe expectation');
    await e.tick();
    assert.ok(readTaskRecord(e.config, 'author-1'));
    assert.ok(readTaskRecord(e.config, 'review-1'));
    assert.equal(e.tmux.windows.filter(w => w.name === 'review-1').length, 1);
    assert.deepEqual(readQueue(e.config), []);
  });

  it('R1: a reviewer registered while its author is in setup waits and validates the actual author record', async () => {
    const e = environment('later-review', 'sleep 0.3'); await e.tick();
    const author = e.spec('AUTHOR-2'); await e.call('new', { spec: author }); await e.call('new', { spec: author, confirm: true });
    await e.tick(false);
    const spec = e.spec('REVIEW-2').replace('agent: claude', 'agent: codex\nreview_of: AUTHOR-2');
    const preview = await e.call('new', { spec }); assert.ok(!preview.isError, preview.text);
    assert.match(text(await e.call('new', { spec, confirm: true })), /^Registered:/);
    await e.tick(false);
    assert.match(text(await e.call('queue_list')), /waiting for author AUTHOR-2: setup in progress/);
    await e.memory.idle();
    // A different effective author model/provider must be revalidated; admission metadata cannot bypass the rule.
    const authorFile = path.join(taskDir(e.config, 'author-2'), 'TASK.md');
    const saved = fs.readFileSync(authorFile, 'utf8'); fs.writeFileSync(authorFile, saved.replace('agent: claude', 'agent: codex'));
    await e.tick();
    assert.equal(readQueue(e.config).find(q => q.task === 'REVIEW-2')?.status, 'failed');
    assert.match(readQueue(e.config).find(q => q.task === 'REVIEW-2')?.error ?? '', /same agent and model/);
  });

  it('R1: a failed author fails its reviewer by name; both can be retried', async () => {
    const e = environment('author-failed', 'exit 3'); await e.tick();
    const spec = e.spec('AUTHOR-3') + '\n' + e.spec('REVIEW-3').replace('agent: claude', 'agent: codex\nreview_of: AUTHOR-3');
    await e.call('new', { spec }); await e.call('new', { spec, confirm: true }); await e.tick(); await e.tick();
    const reviewer = readQueue(e.config).find(q => q.task === 'REVIEW-3');
    assert.equal(reviewer?.status, 'failed'); assert.match(reviewer?.error ?? '', /author AUTHOR-3.*failed/);
    for (const repo of e.repos) fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'setup: ["true"]\n');
    await retryEntry(e.ctx, 'AUTHOR-3'); await retryEntry(e.ctx, 'REVIEW-3'); await e.tick(); await e.tick();
    assert.ok(readTaskRecord(e.config, 'review-3')); assert.deepEqual(readQueue(e.config), []);
  });

  it('R4: a mixed idempotent batch rejects the full scope and names already registered tasks', async () => {
    const e = environment('mixed', 'true'); await e.tick(); const one = e.spec('EXISTING-1');
    await e.call('new', { spec: one }); await e.call('new', { spec: one, confirm: true });
    const spec = one + '\n' + e.spec('SECOND-1');
    for (const args of [{}, { confirm: true }]) {
      const result = await e.call('new', { spec, ...args });
      assert.equal(result.isError, true, result.text); assert.match(result.text, /already.registered.*EXISTING-1/i);
    }
    assert.deepEqual(readQueue(e.config).map(q => q.task), ['EXISTING-1']);
    assert.equal(e.runner.worktrees.length, 0);
    assert.match(text(await e.call('new', { spec: one, confirm: true })), /already being started/);
  });

  it('R6: each repo and command emits SETUP and a result with its exit code and log', async () => {
    const e = environment('telemetry', 'true');
    for (const repo of e.repos) fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'setup: ["echo one", "echo two"]\n');
    await e.tick(); const spec = e.spec('STEPS-1'); await e.call('new', { spec }); await e.call('new', { spec, confirm: true }); await e.tick();
    const events = readJournal(e.config).filter(j => String(j.kind).startsWith('setup-'));
    const starts = events.filter(j => j.kind === 'setup-started'); const results = events.filter(j => String(j.kind) === 'setup-finished');
    assert.equal(starts.length, 4); assert.equal(results.length, 4);
    for (const repo of ['alpha', 'beta']) for (const command of ['echo one', 'echo two']) {
      const started = starts.find(j => j.text.includes(repo) && j.text.includes(command));
      assert.ok(started); assert.match(started.text, /log: .*setup\.log/);
      const result = results.find(j => j.text.includes(repo) && j.text.includes(command));
      assert.ok(result); assert.match(result.text, /exit 0/); assert.match(result.text, /log: .*setup\.log/);
    }
    console.log('R6', JSON.stringify(events));
  });
});

it('ACTL-0181-D M3: setup secrets stay out of progress, journal, output, queue_list and events_since', async () => {
  const sentinel = 'actl0181d-sentinel-718203';
  const command = `NPM_TOKEN='${sentinel}' sh -c 'printf "%s\\n" "$NPM_TOKEN"; sleep 1; exit 7'`;
  const e = environment('redaction', command); await e.tick();
  const spec = e.spec('SECRET-1'); await e.call('new', { spec }); await e.call('new', { spec, confirm: true });
  await e.tick(false);
  await until(() => readSetupProgress(e.config, 'SECRET-1')?.phase === 'setup', 'setup progress');
  const safe = (name: string, value: unknown) => { const text = typeof value === 'string' ? value : JSON.stringify(value); assert.ok(!text.includes(sentinel), `${name} leaked the sentinel`); assert.ok(text.includes('***'), `${name} contains a redacted label`); };
  safe('persisted progress', fs.readFileSync(setupProgressFile(e.config, 'secret-1'), 'utf8'));
  await until(() => readJournal(e.config).some(event => event.kind === 'setup-started'), 'setup journal');
  safe('persisted journal', readJournal(e.config));
  safe('queue_list', text(await e.call('queue_list')));
  safe('events_since', text(await e.call('events_since', { since: '1h', keep: true })));
  await e.memory.idle();
  safe('setup output', fs.readFileSync(path.join(taskDir(e.config, 'secret-1'), 'setup.log'), 'utf8'));
  safe('failed journal', readJournal(e.config));
  safe('failed queue and error', text(await e.call('queue_list')));
  safe('failed events_since', text(await e.call('events_since', { since: '1h', keep: true })));
  assert.equal(readQueue(e.config)[0]?.status, 'failed');
  assert.ok(e.runner.calls.filter(c => c.line.startsWith('sh ')).every(c => !c.line.includes(sentinel)), 'inline secret is never in shell argv');
});
