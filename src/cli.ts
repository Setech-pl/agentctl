import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError, Option } from 'commander';
import { closeTask } from './core/close.ts';
import { runDoctor } from './core/doctor.ts';
import { renderChecks, renderStatusTable } from './render.ts';
import { newTasks } from './core/new.ts';
import type { NewOptions } from './core/new.ts';
import { pullTask } from './core/pull.ts';
import { sendPrompts } from './core/send.ts';
import { reportStatus } from './core/status.ts';
import { interruptTask } from './core/interrupt.ts';
import { loadGlobalConfig } from './core/config.ts';
import type { GlobalConfig } from './core/config.ts';
import { Context } from './core/context.ts';
import { EXAMPLE_SPEC } from './core/example.ts';
import { RealRunner, RecordingRunner } from './core/runner.ts';
import type { Runner } from './core/runner.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from './core/spec.ts';
import { AgentctlError, errorMessage, resolvePath } from './core/util.ts';

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  stdinIsTTY: boolean;
  loadConfig: () => GlobalConfig;
  /** Ask a yes/no question; undefined when there is no terminal to ask on. */
  confirm: ((question: string) => Promise<boolean>) | undefined;
  /** Build the runner: the real one, or a recording one for --dry-run. */
  makeRunner: (dryRun: boolean, emit: (line: string) => void) => Runner;
  /** A signal that fires on Ctrl-C while a long wait runs; `dispose` restores the default Ctrl-C. Absent: no interrupt handling. */
  interruptSignal?: () => { signal: AbortSignal; dispose: () => void };
}

export function defaultDeps(): CliDeps {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: () => fs.readFileSync(0, 'utf8'),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    loadConfig: () => loadGlobalConfig(),
    confirm: process.stdin.isTTY ? askOnTerminal : undefined,
    makeRunner: (dryRun, emit) => (dryRun ? new RecordingRunner({ emit }) : new RealRunner()),
    interruptSignal: () => {
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);
      return { signal: controller.signal, dispose: () => void process.off('SIGINT', onSigint) };
    },
  };
}

async function askOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const line = (text: string): void => deps.stdout(`${text}\n`);
  let exitCode = 0;

  const readSpecText = (file: string | undefined): string => {
    if (file === undefined || file === '-') {
      if (file === undefined && deps.stdinIsTTY) {
        throw new AgentctlError('no spec given', 'Pass a spec file, or "-" to read it from stdin. See "agentctl spec example".');
      }
      return deps.readStdin();
    }
    const resolved = resolvePath(file);
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new AgentctlError(`cannot read spec ${resolved}: ${errorMessage(e)}`, 'Check the path.');
    }
  };

  const contextFor = (dryRun: boolean): Context => new Context(deps.makeRunner(dryRun, line), deps.loadConfig(), line, deps.confirm);

  const program = new Command();
  program
    .name('agentctl')
    .description('Dispatch tasks to CLI coding agents (Claude Code, Codex) in tmux windows and git worktrees.')
    .version(packageVersion())
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr });

  const guarded = (fn: (...args: any[]) => Promise<void>) => async (...args: any[]): Promise<void> => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof CommanderError) throw e;
      if (e instanceof AgentctlError) {
        deps.stderr(`error: ${e.message}\n`);
        if (e.hint) deps.stderr(`hint: ${e.hint}\n`);
      } else {
        deps.stderr(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      }
      exitCode = 1;
    }
  };

  program
    .command('new')
    .description('Start the tasks in a spec file: worktree, symlinks, TASK.md, tmux window, agent, prompt.')
    .argument('[file]', 'spec file, or "-" for stdin')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .option('--reuse', 'use worktrees that already exist instead of failing')
    .addOption(new Option('--agent <agent>', 'run every spec on this provider, translated through the equivalents table').choices(['claude', 'codex']))
    .option('--no-switch', 'never offer to move a task to the other provider when its limit is full')
    .option('--no-agent', 'only create the worktree, run setup and links; no TASK.md, window or agent')
    .option('--no-wait-trust', 'stop at the folder-trust dialog instead of waiting for you to confirm it (the old behaviour)')
    .action(
      guarded(async (file: string | undefined, opts: { dryRun?: boolean; reuse?: boolean; agent?: 'claude' | 'codex' | false; switch?: boolean; waitTrust?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const specs = splitSpecs(readSpecText(file), file ?? 'stdin').map((raw) => resolveSpec(raw, { config: ctx.config }));
        const options: NewOptions = { reuse: Boolean(opts.reuse), noSwitch: opts.switch === false, waitTrust: opts.waitTrust !== false };
        if (opts.agent) options.agent = opts.agent;
        if (opts.agent === false) options.noAgent = true; // commander reads --no-agent as the negation of --agent
        const interrupt = opts.dryRun ? undefined : deps.interruptSignal?.();
        if (interrupt) options.signal = interrupt.signal;
        try {
          await newTasks(ctx, specs, options);
        } finally {
          interrupt?.dispose();
        }
      }),
    );

  program
    .command('send')
    .description('Paste a follow-up prompt into the existing window of each task in the file.')
    .argument('[file]', 'spec file (only "task" and the prompt are used), or "-" for stdin')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (file: string | undefined, opts: { dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const items = splitSpecs(readSpecText(file), file ?? 'stdin').map(resolveSendSpec);
        await sendPrompts(ctx, items);
      }),
    );

  program
    .command('status')
    .description('Table of tasks: window state, running time, report, last output line.')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (opts: { json?: boolean }) => {
        const ctx = contextFor(false);
        const { rows } = await reportStatus(ctx);
        if (opts.json) return line(JSON.stringify(rows, null, 2));
        if (rows.length === 0) return line(`No tasks yet in ${ctx.config.cache}. Start one with "agentctl new <spec>".`);
        for (const l of renderStatusTable(rows)) line(l);
      }),
    );

  program
    .command('pull')
    .description('Copy the task report to the clipboard and print its path (without a report: last 40 lines of the window).')
    .argument('<task>', 'task ID')
    .action(guarded(async (task: string) => pullTask(contextFor(false), task)));

  program
    .command('close')
    .description('Kill the task window; --rm-worktree also removes its git worktree (branches are kept).')
    .argument('<task>', 'task ID')
    .option('--rm-worktree', 'run "git worktree remove" for the task worktrees (never --force)')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (task: string, opts: { rmWorktree?: boolean; dryRun?: boolean }) => {
        await closeTask(contextFor(Boolean(opts.dryRun)), task, { rmWorktree: Boolean(opts.rmWorktree) });
      }),
    );

  program
    .command('interrupt')
    .description("Interrupt the task's current turn (sends the agent's interrupt key, default Escape); the window stays open.")
    .argument('<task>', 'task ID')
    .option('--dry-run', 'print the command that would run, execute nothing')
    .action(
      guarded(async (task: string, opts: { dryRun?: boolean }) => {
        await interruptTask(contextFor(Boolean(opts.dryRun)), task);
      }),
    );

  program
    .command('doctor')
    .description('Check tmux, node, claude, codex, gh, the cache directory and the configs.')
    .action(
      guarded(async () => {
        const runner = deps.makeRunner(false, line);
        const checks = await runDoctor(runner, deps.loadConfig);
        for (const l of renderChecks(checks)) line(l);
        if (checks.some((c) => c.status === 'fail')) {
          line('\nSome required checks failed.');
          exitCode = 1;
        }
      }),
    );

  program
    .command('spec')
    .description('Spec helpers.')
    .command('example')
    .description('Print an example spec (the Neon City example from the README).')
    .action(guarded(async () => deps.stdout(EXAMPLE_SPEC)));

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
  return exitCode;
}
