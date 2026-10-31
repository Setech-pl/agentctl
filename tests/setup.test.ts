import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { checkLinkTargets, planLinks } from '../src/core/links.ts';
import { newTasks } from '../src/core/new.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();
const IDLE = '❯ Try "how does <filepath> work?"\n› Ask Codex to do anything\n? for shortcuts';

type Respond = (cmd: string, args: string[], opts: ExecOptions) => Partial<ExecResult> | undefined;

/** Fresh machine: no session, no branch, the agent is ready at once; `sh` answers come from `sh`. */
const machine = (sh?: Respond): Respond => (cmd, args, opts) => {
  if (cmd === 'tmux' && (args[0] === 'has-session' || args[0] === 'list-windows')) return { code: 1 };
  if (cmd === 'git' && args.includes('--verify')) return { code: 1 };
  if (cmd === 'tmux' && args[0] === 'capture-pane') return { stdout: IDLE };
  if (cmd === 'sh') return sh?.(cmd, args, opts);
  return undefined;
};

const resolveAll = (config: ReturnType<typeof makeConfig>, text: string, loadProject: Parameters<typeof resolveSpec>[1]['loadProject'] = () => undefined): ResolvedSpec[] =>
  splitSpecs(text).map((raw) => resolveSpec(raw, { config, loadProject }));

const base = scratch.sub('setup');
const repo = scratch.sub('setup/app');
const backend = scratch.sub('setup/backend/packages');
for (const n of ['protocol', 'sim']) scratch.sub(`setup/backend/packages/${n}`);

function specText(task: string, extra: string): string {
  return `---\ntask: ${task}\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-${task.toLowerCase()}}\n${extra}---\nGo.\n`;
}

describe('new: worktree -> setup -> links -> window', () => {
  const config = makeConfig(base);

  it('runs setup in the first worktree after git worktree add and before the links', async () => {
    const text = specText('NC-1', `setup:\n  - npm ci --prefer-offline\n  - echo done\nlinks:\n  - {from: node_modules/@neon-city/protocol, to: ${backend}/protocol}\n`);
    const { ctx, runner } = makeContext(config, { respond: machine() });
    await newTasks(ctx, resolveAll(config, text));
    const wt = `${repo}-nc-1`;
    const cmds = runner.commands;
    const at = (needle: string): number => cmds.findIndex((c) => c.includes(needle));
    assert.deepEqual([at('worktree add'), at('npm ci'), at('echo done'), at('ln -sfn'), at('tmux new-session')].every((i) => i >= 0), true);
    assert.ok(at('worktree add') < at('npm ci') && at('npm ci') < at('echo done') && at('echo done') < at('ln -sfn') && at('ln -sfn') < at('tmux new-session'));
    assert.ok(cmds.includes(`(cd ${wt} && sh -c 'npm ci --prefer-offline')`), 'runs in the first worktree');
    assert.ok(cmds.some((c) => c.startsWith(`append ${path.join(config.cache, 'nc-1', 'setup.log')}`)), 'output goes to setup.log');
  });

  it('a failing setup command stops new with the output tail; worktree stays, no window', async () => {
    const text = specText('NC-2', 'setup:\n  - npm ci\n  - never-runs\n');
    const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const { ctx, runner } = makeContext(config, { respond: machine((_c, a) => (a[1] === 'npm ci' ? { code: 1, stdout: out, stderr: '\nnpm ERR! boom\n' } : undefined)) });
    await assert.rejects(newTasks(ctx, resolveAll(config, text)), (e: Error & { hint?: string }) => {
      assert.match(e.message, /^NC-2: setup command failed \(exit 1\): npm ci\n/);
      assert.match(e.message, /npm ERR! boom/);
      assert.match(e.message, /line 30/);
      assert.doesNotMatch(e.message, /line 1\n/, 'only the tail is shown');
      assert.match(e.hint ?? '', new RegExp(`${path.join(config.cache, 'nc-2', 'setup.log')}.*kept.*no window`));
      return true;
    });
    assert.ok(runner.commands.some((c) => c.includes('worktree add')));
    assert.ok(!runner.commands.some((c) => c.includes('never-runs')));
    assert.ok(!runner.commands.some((c) => c.startsWith('tmux new-')), 'no window');
    assert.ok(!runner.commands.some((c) => c.startsWith('ln ')));
  });

  it('setup: spec > project > global, and an explicit empty list switches it off', () => {
    const cfg = makeConfig(scratch.sub('setup-layers'), 'setup: [echo global]\n');
    const project = (s?: string[]) => () => ({ links: [], env: {}, defaults: {}, ...(s ? { setup: s } : {}) });
    assert.deepEqual(resolveAll(cfg, specText('NC-3', ''))[0]!.setup, ['echo global']);
    assert.deepEqual(resolveAll(cfg, specText('NC-3', ''), project(['echo project']))[0]!.setup, ['echo project']);
    assert.deepEqual(resolveAll(cfg, specText('NC-3', 'setup: [echo spec]\n'), project(['echo project']))[0]!.setup, ['echo spec']);
    assert.deepEqual(resolveAll(cfg, specText('NC-3', 'setup: []\n'), project(['echo project']))[0]!.setup, []);
    assert.deepEqual(resolveAll(cfg, specText('NC-3', 'setup: ["echo {task} in {cache}"]\n'))[0]!.setup, [`echo nc-3 in ${cfg.cache}`]);
    assert.throws(() => resolveAll(cfg, specText('NC-3', 'setup: "npm ci"\n')), /setup must be a list/);
  });

  it('--dry-run prints the setup commands and runs nothing', async () => {
    const text = specText('NC-4', 'setup:\n  - npm ci\n');
    const { ctx, runner } = makeContext(config, { dryRun: true });
    await newTasks(ctx, resolveAll(config, text));
    assert.ok(runner.commands.includes(`(cd ${repo}-nc-4 && sh -c 'npm ci')`));
    assert.ok(!runner.commands.some((c) => c.includes('setup.log')), 'no log in a dry run');
  });

  it('--no-agent stops after worktree, setup and links: no TASK.md, no tmux, no agent', async () => {
    const text = specText('NC-5', `setup: [npm ci]\nlinks:\n  - {from: node_modules/@neon-city/protocol, to: ${backend}/protocol}\n`);
    const { ctx, runner, out } = makeContext(config, { respond: machine() });
    const results = await newTasks(ctx, resolveAll(config, text), { noAgent: true });
    assert.equal(results[0]!.agentStarted, false);
    const cmds = runner.commands;
    assert.ok(cmds.some((c) => c.includes('worktree add')) && cmds.some((c) => c.includes('npm ci')) && cmds.some((c) => c.startsWith('ln -sfn')));
    assert.ok(!cmds.some((c) => c.startsWith('tmux') || c.includes('TASK.md')));
    assert.ok(out.some((l) => /--no-agent: worktree .* is ready/.test(l)));
    assert.ok(!runner.queries.some((q) => q.startsWith('claude')), 'the agent is not probed');
  });

  it('--no-agent through the CLI', async () => {
    const text = specText('NC-6', 'model: opus\nsetup: [echo ok]\n');
    const file = path.join(base, 'noagent.md');
    fs.writeFileSync(file, text);
    const runner = new RecordingRunner({ dryRun: false, respond: machine() });
    const err: string[] = [];
    const deps: CliDeps = { stdout: () => {}, stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config, confirm: undefined, makeRunner: () => runner };
    assert.equal(await main(['new', '--no-agent', file], deps), 0, err.join(''));
    assert.ok(runner.commands.some((c) => c.includes('worktree add')));
    assert.ok(!runner.commands.some((c) => c.startsWith('tmux')));
    // --agent still works next to --no-agent
    const r2 = new RecordingRunner({ dryRun: false, respond: machine((_c, _a) => undefined) });
    const code2 = await main(['new', '--agent', 'codex', file], { ...deps, makeRunner: () => r2 });
    assert.equal(code2, 0, err.join(''));
    assert.ok(r2.commands.some((c) => c.includes('codex --sandbox')), `--agent codex is not read as --no-agent: ${r2.commands.join(' | ')}`);
  });
});

describe('links: literal paths and targets', () => {
  it('a literal "from" is linked although nothing exists yet; parent directories are the runner\'s mkdir -p', () => {
    const wt = scratch.sub('setup/lit-wt');
    const { ops, warnings } = planLinks([{ from: 'node_modules/@neon-city/protocol', to: `${backend}/protocol` }], wt);
    assert.deepEqual(ops, [{ link: path.join(wt, 'node_modules/@neon-city/protocol'), target: `${backend}/protocol`, existing: 'none' }]);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(wt, 'node_modules')), false, 'planning creates nothing');
  });

  it('the real runner creates the parent directories and the symlink', async () => {
    const { RealRunner } = await import('../src/core/runner.ts');
    const wt = scratch.sub('setup/real-wt');
    await new RealRunner().symlink(`${backend}/sim`, path.join(wt, 'node_modules/@neon-city/sim'));
    assert.equal(fs.readlinkSync(path.join(wt, 'node_modules/@neon-city/sim')), `${backend}/sim`);
  });

  it('a missing "to" is an error before anything starts', async () => {
    const config = makeConfig(base);
    const text = specText('NC-7', `links:\n  - {from: node_modules/@neon-city/protocol, to: ${base}/no/such/protocol}\n`);
    const { ctx, runner } = makeContext(config, { respond: machine() });
    await assert.rejects(newTasks(ctx, resolveAll(config, text)), (e: Error & { hint?: string }) => {
      assert.match(e.message, /NC-7: link targets are missing:[\s\S]*no\/such\/protocol does not exist/);
      assert.match(e.hint ?? '', /Nothing was started/);
      return true;
    });
    assert.deepEqual(runner.commands, [], 'no worktree was created');
    assert.throws(() => checkLinkTargets([{ from: 'x/*', to: `${base}/missing-dir/*` }], 'NC-7'), /missing-dir does not exist/);
    assert.doesNotThrow(() => checkLinkTargets([{ from: 'x/*', to: `${backend}/*` }], 'NC-7'));
  });

  it('a glob without matches warns and points to literal paths', () => {
    const wt = scratch.sub('setup/glob-wt');
    const { ops, warnings } = planLinks([{ from: 'node_modules/@neon-city/*', to: `${backend}/protocol` }], wt);
    assert.equal(ops.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /no match for "node_modules\/@neon-city\/\*".*literal path.*e\.g\. from: node_modules\/@scope\/name/);
  });
});
