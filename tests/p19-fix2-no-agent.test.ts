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



describe('P19 FIX2: preparing an admitted author/reviewer batch without agents', () => {
  it('R1: no_agent prepares both worktrees without requiring a TASK.md that no_agent never writes', async () => {
    const e = environment('prepared', 'sleep 0.1'); await e.tick();
    const spec = e.spec('PREP-A') + '\n' + e.spec('PREP-R').replace('agent: claude', 'agent: codex\nreview_of: PREP-A');
    assert.ok(!(await e.call('new', { spec, no_agent: true })).isError);
    assert.match(text(await e.call('new', { spec, no_agent: true, confirm: true })), /^Registered:/);
    await e.tick(); await e.tick();
    assert.deepEqual(readQueue(e.config), []);
    assert.equal(e.runner.shells.length, 4);
    assert.ok(e.runner.worktrees.every(p => fs.existsSync(p)));
    assert.equal(readTaskRecord(e.config, 'prep-a'), undefined);
    assert.equal(readTaskRecord(e.config, 'prep-r'), undefined);
    assert.equal(e.tmux.windows.length, 0);
  });
  it('R1: a failed no_agent author still fails its reviewer and both remain retryable', async () => {
    const e = environment('prepared-fail', 'exit 3'); await e.tick();
    const spec = e.spec('PREP-FAIL-A') + '\n' + e.spec('PREP-FAIL-R').replace('agent: claude', 'agent: codex\nreview_of: PREP-FAIL-A');
    await e.call('new', { spec, no_agent: true }); await e.call('new', { spec, no_agent: true, confirm: true }); await e.tick(); await e.tick();
    assert.match(readQueue(e.config).find(q => q.task === 'PREP-FAIL-R')?.error ?? '', /author PREP-FAIL-A.*failed/);
    for (const repo of e.repos) fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'setup: ["true"]\n');
    await retryEntry(e.ctx, 'PREP-FAIL-A'); await retryEntry(e.ctx, 'PREP-FAIL-R'); await e.tick(); await e.tick();
    assert.deepEqual(readQueue(e.config), []); assert.equal(e.tmux.windows.length, 0);
  });
});
