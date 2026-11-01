import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError, Option } from 'commander';
import { closeTasks, planClose } from './core/close.ts';
import { confirmAction, readClipboard, specFromClipboard, writeClipboard } from './core/clipboard.ts';
import { runDoctor } from './core/doctor.ts';
import { renderChecks, renderStatusHints, renderStatusTable } from './render.ts';
import { adoptTask } from './core/adopt.ts';
import { attachTask } from './core/attach.ts';
import { peekTask, PEEK_LINES } from './core/peek.ts';
import { matchTask } from './core/resolve.ts';
import type { TaskTarget } from './core/resolve.ts';
import { migrateLegacyState } from './core/taskstore.ts';
import { newTasks } from './core/new.ts';
import type { NewOptions } from './core/new.ts';
import { pullReady, pullTask } from './core/pull.ts';
import { sendPrompts } from './core/send.ts';
import { reportStatus, statusMarkdown } from './core/status.ts';
import { summarizeSpecs } from './core/summary.ts';
import { DesktopNotifier } from './core/notify.ts';
import { ensureWatchWindow, runWatch, WATCH_WINDOW } from './core/watch.ts';
import { interruptTask } from './core/interrupt.ts';
import { loadGlobalConfig } from './core/config.ts';
import type { Effort, GlobalConfig } from './core/config.ts';
import { Context } from './core/context.ts';
import { EXAMPLE_SPEC } from './core/example.ts';
import { RealRunner, RecordingRunner } from './core/runner.ts';
import type { Runner } from './core/runner.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from './core/spec.ts';
import { AgentctlError, errorMessage, resolvePath, shellQuote } from './core/util.ts';

export interface CliDeps {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => string;
  stdinIsTTY: boolean;
  loadConfig: () => GlobalConfig;
  /** Ask a yes/no question; undefined when there is no terminal to ask on. */
  confirm: ((question: string) => Promise<boolean>) | undefined;
  /** Text on the clipboard (pbpaste, wl-paste or xclip). Always the real clipboard, also in a dry run. */
  readClipboard: () => Promise<string>;
  /** Command line that starts `agentctl watch` in a tmux window. */
  watchCommand: () => string;
  /** Build the runner: the real one, or a recording one for --dry-run. */
  makeRunner: (dryRun: boolean, emit: (line: string) => void) => Runner;
  /** `$TMUX` is set: attach switches this tmux client instead of attaching a new one. */
  insideTmux?: boolean;
  /** Pick one of several tasks on the terminal; absent when there is no terminal to ask on. */
  choose?: (targets: TaskTarget[]) => Promise<TaskTarget | undefined>;
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
    readClipboard: () => readClipboard(new RealRunner()),
    watchCommand: () => {
      const env = process.env.AGENTCTL_HOME ? `AGENTCTL_HOME=${shellQuote(process.env.AGENTCTL_HOME)} ` : '';
      const script = fs.realpathSync(process.argv[1] ?? 'bin/agentctl.ts');
      return `${env}${shellQuote(process.execPath)} --experimental-strip-types --no-warnings ${shellQuote(script)} watch`;
    },
    insideTmux: Boolean(process.env.TMUX),
    choose: process.stdin.isTTY ? chooseOnTerminal : undefined,
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

/** Numbered list; the answer is a number or a (unique) start of a task ID. */
async function chooseOnTerminal(targets: TaskTarget[]): Promise<TaskTarget | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    targets.forEach((t, i) => process.stdout.write(`  ${i + 1}) ${t.task}\n`));
    const answer = (await rl.question('Which task? number or ID: ')).trim();
    if (/^\d+$/.test(answer)) return targets[Number(answer) - 1];
    const match = matchTask(answer, targets);
    return match.kind === 'one' ? match.target : undefined;
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

  /** Spec text from the clipboard (`--clip`), a file, or stdin. */
  const readSpecSource = async (file: string | undefined, clip: boolean | undefined): Promise<string> => {
    if (!clip) return readSpecText(file);
    if (file !== undefined) throw new AgentctlError('--clip and a file argument exclude each other', 'Use one: "agentctl new --clip" or "agentctl new <file>".');
    return specFromClipboard(await deps.readClipboard());
  };

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

  const contextFor = (dryRun: boolean): Context => {
    const config = deps.loadConfig();
    // TASK.md and setup.log used to live in the cache folder, where agents could delete them: move them to state_dir.
    if (!dryRun) for (const message of migrateLegacyState(config)) line(message);
    return new Context(deps.makeRunner(dryRun, line), config, line, deps.confirm);
  };

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
    .option('--clip', 'read the spec from the clipboard; shows a summary and asks y/N first')
    .option('-y, --yes', 'with --clip: do not ask')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; dryRun?: boolean; reuse?: boolean; agent?: 'claude' | 'codex' | false; switch?: boolean; waitTrust?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const source = opts.clip ? 'clipboard' : (file ?? 'stdin');
        const specs = splitSpecs(await readSpecSource(file, opts.clip), source).map((raw) => resolveSpec(raw, { config: ctx.config }));
        if (opts.clip && !(await confirmAction(ctx, summarizeSpecs(specs), 'Start?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
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
    .option('--clip', 'read the prompt from the clipboard; shows a summary and asks y/N first')
    .option('-y, --yes', 'with --clip: do not ask')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const items = splitSpecs(await readSpecSource(file, opts.clip), opts.clip ? 'clipboard' : (file ?? 'stdin')).map(resolveSendSpec);
        const summary = items.map((i) => `${i.task}  ->  window ${ctx.config.session}:${i.window}, ${i.prompt.length} characters: ${i.prompt.split('\n')[0]!.slice(0, 80)}`);
        if (opts.clip && !(await confirmAction(ctx, summary, 'Send?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await sendPrompts(ctx, items);
      }),
    );

  program
    .command('status')
    .description('Table of tasks: window state, running time, report, last output line.')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown table to the clipboard (to paste at the start of a chat session)')
    .action(
      guarded(async (opts: { json?: boolean; clip?: boolean }) => {
        const ctx = contextFor(false);
        const { rows } = await reportStatus(ctx);
        if (opts.clip) {
          const md = statusMarkdown(rows);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the status of ${rows.length} task${rows.length === 1 ? '' : 's'} to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the table:`);
          return deps.stdout(md);
        }
        if (opts.json) return line(JSON.stringify(rows, null, 2));
        if (rows.length === 0) return line(`No tasks yet in ${ctx.config.stateDir}. Start one with "agentctl new <spec>".`);
        for (const l of renderStatusTable(rows)) line(l);
        for (const l of renderStatusHints(rows)) line(`hint: ${l}`);
      }),
    );

  program
    .command('pull')
    .description('Copy the task report to the clipboard and print its path (without a report: last 40 lines of the window). --ready: all new reports at once.')
    .argument('[task]', 'task ID')
    .option('--ready', 'join every report in state report-ready that was not pulled yet, copy it and mark the tasks as pulled')
    .option('--all', 'with --ready: also the reports that were pulled before')
    .action(
      guarded(async (task: string | undefined, opts: { ready?: boolean; all?: boolean }) => {
        if (opts.all && !opts.ready) throw new AgentctlError('--all only works together with --ready');
        if (opts.ready) {
          if (task) throw new AgentctlError('--ready takes no task ID', 'Use "agentctl pull --ready" or "agentctl pull <task>".');
          await pullReady(contextFor(false), { all: Boolean(opts.all) });
          return;
        }
        if (!task) throw new AgentctlError('give a task ID, or --ready', 'Example: "agentctl pull NC-42" or "agentctl pull --ready".');
        await pullTask(contextFor(false), task);
      }),
    );

  program
    .command('close')
    .description('Kill the task windows; --rm-worktree also removes their git worktrees (branches are kept). Shows the list and asks y/N first.')
    .argument('<tasks...>', 'task IDs')
    .option('--rm-worktree', 'run "git worktree remove" for the task worktrees (never --force)')
    .option('-y, --yes', 'do not ask')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (tasks: string[], opts: { rmWorktree?: boolean; yes?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const closeOpts = { rmWorktree: Boolean(opts.rmWorktree) };
        const plan = await planClose(ctx, tasks, closeOpts);
        const summary = [`Close ${plan.length} task${plan.length === 1 ? '' : 's'}${closeOpts.rmWorktree ? ' and remove their worktrees (branches stay)' : ''}:`, ...plan.map((i) => `  ${i.line}`)];
        if (!(await confirmAction(ctx, summary, 'Go ahead?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await closeTasks(ctx, plan.map((i) => i.task), closeOpts);
      }),
    );

  program
    .command('watch')
    .description('Foreground loop: notifies (macOS notification / notify-send) when a task has a report ready, waits too long, needs folder trust or died.')
    .option('--tmux', `run it in window "${WATCH_WINDOW}" of the agentctl session (created if missing) instead of here`)
    .action(
      guarded(async (opts: { tmux?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.tmux) {
          const result = await ensureWatchWindow(ctx, deps.watchCommand(), process.cwd());
          if (result === 'exists') line(`Window ${ctx.config.session}:${WATCH_WINDOW} already exists, left alone.`);
          else line(`Started the watcher in window ${ctx.config.session}:${WATCH_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. Attach: tmux attach -t ${ctx.config.session}`);
          return;
        }
        const interrupt = deps.interruptSignal?.();
        try {
          await runWatch(ctx, new DesktopNotifier(ctx.runner), interrupt ? { signal: interrupt.signal } : {});
        } finally {
          interrupt?.dispose();
        }
      }),
    );

  program
    .command('adopt')
    .description('Restore the state file of a task whose TASK.md is lost (the report and the window are still there). Agent, model and effort default to "unknown".')
    .argument('<task>', 'task ID')
    .requiredOption('--report <path>', 'path of the task report')
    .option('--window <name>', 'tmux window of the task (default: the lowercase task ID)')
    .option('--worktree <path>', 'worktree of the task, so "close --rm-worktree" knows it')
    .addOption(new Option('--agent <agent>', 'agent running in the window').choices(['claude', 'codex']))
    .option('--model <model>', 'model of the task')
    .addOption(new Option('--effort <effort>', 'effort of the task').choices(['low', 'medium', 'high', 'xhigh', 'max']))
    .option('--dry-run', 'print what would be written, write nothing')
    .action(
      guarded(async (task: string, opts: { report: string; window?: string; worktree?: string; agent?: 'claude' | 'codex'; model?: string; effort?: Effort; dryRun?: boolean }) => {
        await adoptTask(contextFor(Boolean(opts.dryRun)), task, opts);
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
    .command('attach')
    .description('Go to the task window: attach-session outside tmux, switch-client inside. Without a task: the only running one, or a list to choose from.')
    .argument('[task]', 'task ID; case does not matter and a unique prefix is enough')
    .action(
      guarded(async (task: string | undefined) => {
        const ctx = contextFor(false);
        await attachTask(ctx, task, { insideTmux: deps.insideTmux ?? false, ...(deps.choose ? { choose: deps.choose } : {}) });
      }),
    );

  program
    .command('peek')
    .description('Print the last lines of the task window (without the agent footer), to read along without attaching.')
    .argument('<task>', 'task ID; case does not matter and a unique prefix is enough')
    .option('-n, --lines <n>', 'number of lines', String(PEEK_LINES))
    .action(
      guarded(async (task: string, opts: { lines: string }) => {
        const count = /^\d+$/.test(opts.lines) ? Number(opts.lines) : Number.NaN;
        if (!Number.isInteger(count) || count < 1) throw new AgentctlError(`-n must be a positive whole number (got "${opts.lines}")`);
        const result = await peekTask(contextFor(false), task, count);
        for (const l of result.lines) line(l);
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
