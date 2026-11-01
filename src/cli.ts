import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError, Option } from 'commander';
import { closeTasks, planClose } from './core/close.ts';
import { confirmAction, readClipboard, specFromClipboard, writeClipboard } from './core/clipboard.ts';
import { runDoctor } from './core/doctor.ts';
import { renderChecks, renderStatusHints, renderStatusTable } from './render.ts';
import { adoptTask } from './core/adopt.ts';
import { attachTask, switchAttachedClient } from './core/attach.ts';
import { Alerts } from './core/alert.ts';
import { handleEvent } from './core/event-command.ts';
import { CLAUDE_KINDS, parseJson } from './core/events.ts';
import type { ClaudeKind, SelfArgv } from './core/events.ts';
import { moveTask } from './core/move.ts';
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
import type { Notifier } from './core/notify.ts';
import { ensureWatchWindow, runWatch, WATCH_WINDOW } from './core/watch.ts';
import { applyStatusLine, statusTmuxLine } from './core/statusline.ts';
import { BOARD_WINDOW, ensureWindow } from './core/windows.ts';
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
  /** Command line that starts `agentctl board` in a tmux window. */
  boardCommand?: () => string;
  /** Run the full-screen board in this terminal until the user quits. */
  runBoard?: (ctx: Context, insideTmux: boolean, self?: SelfArgv) => Promise<void>;
  /** This very agentctl as a command line (absolute node and script, config directory of this run): what the agents and notifications call back. */
  selfArgv?: () => SelfArgv;
  /** The notifier for this machine; default: terminal-notifier when installed, else osascript / notify-send. */
  makeNotifier?: (runner: Runner) => Promise<Notifier>;
  /** Command line that prints the tmux status line (`agentctl status --tmux-line`), for tmux's status-right. */
  statusLineCommand?: () => string;
  /** Build the runner: the real one, or a recording one for --dry-run. */
  makeRunner: (dryRun: boolean, emit: (line: string) => void) => Runner;
  /** `$TMUX` is set: attach switches this tmux client instead of attaching a new one. */
  insideTmux?: boolean;
  /** Pick one of several tasks on the terminal; absent when there is no terminal to ask on. */
  choose?: (targets: TaskTarget[]) => Promise<TaskTarget | undefined>;
  /** A signal that fires on Ctrl-C (or SIGTERM/SIGHUP) while a long wait runs; `dispose` restores the default Ctrl-C. Absent: no interrupt handling. */
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
    watchCommand: () => selfCommand('watch'),
    statusLineCommand: () => selfCommand('status --tmux-line'),
    boardCommand: () => selfCommand('board'),
    selfArgv,
    makeNotifier: (runner) => DesktopNotifier.detect(runner),
    runBoard: async (ctx, insideTmux, self) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentctlError('the board needs a terminal', 'Run it in a terminal, or in tmux with "agentctl board --tmux".');
      // Ink and React load only here: the other commands do not pay for them.
      const { runBoardApp } = await import('./board/app.ts');
      await runBoardApp(ctx, insideTmux, {}, self);
    },
    insideTmux: Boolean(process.env.TMUX),
    choose: process.stdin.isTTY ? chooseOnTerminal : undefined,
    makeRunner: (dryRun, emit) => (dryRun ? new RecordingRunner({ emit }) : new RealRunner()),
    interruptSignal: () => {
      const controller = new AbortController();
      const onStop = (): void => controller.abort();
      // SIGTERM and SIGHUP: tmux kills the window, or the terminal goes away; the watcher still puts the window names back.
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      for (const signal of signals) process.once(signal, onStop);
      return { signal: controller.signal, dispose: () => void signals.forEach((signal) => process.off(signal, onStop)) };
    },
  };
}

/**
 * This very agentctl as a command line for a tmux window or status bar: absolute node and script paths (the tmux server's
 * PATH may not have agentctl) and the config directory of this run.
 */
function selfCommand(args: string): string {
  const env = process.env.AGENTCTL_HOME ? `AGENTCTL_HOME=${shellQuote(process.env.AGENTCTL_HOME)} ` : '';
  const script = fs.realpathSync(process.argv[1] ?? 'bin/agentctl.ts');
  return `${env}${shellQuote(process.execPath)} --experimental-strip-types --no-warnings ${shellQuote(script)} ${args}`;
}

/**
 * This very agentctl as an argv: absolute node and script paths and the settings of this run that the callback needs (config
 * directory, tmux socket directory, PATH), set through env(1). A click on a notification runs with a bare PATH (/usr/bin:/bin),
 * where tmux, installed by Homebrew, is not found.
 */
export function selfArgv(): SelfArgv {
  const script = fs.realpathSync(process.argv[1] ?? 'bin/agentctl.ts');
  const env = (['AGENTCTL_HOME', 'TMUX_TMPDIR', 'PATH'] as const).filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  return [...(env.length > 0 ? ['/usr/bin/env', ...env] : []), process.execPath, '--experimental-strip-types', '--no-warnings', script];
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

  const contextFor = (dryRun: boolean, { migrate = true } = {}): Context => {
    const config = deps.loadConfig();
    // TASK.md and setup.log used to live in the cache folder, where agents could delete them: move them to state_dir.
    if (!dryRun && migrate) for (const message of migrateLegacyState(config)) line(message);
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
        const self = deps.selfArgv?.();
        if (self) options.self = self;
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
    .option('--tmux-line', 'one short line for the tmux status bar, like "2⚙ 1✓ 1?" (tasks per state)')
    .action(
      guarded(async (opts: { json?: boolean; clip?: boolean; tmuxLine?: boolean }) => {
        if ([opts.json, opts.clip, opts.tmuxLine].filter(Boolean).length > 1) throw new AgentctlError('--json, --clip and --tmux-line exclude each other');
        if (opts.tmuxLine) return line(await statusTmuxLine(contextFor(false, { migrate: false })));
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
    .description('Foreground loop: notifies (macOS notification / notify-send) when a task has a report ready, asks something, hit its usage limit, waits too long, needs folder trust or died.')
    .option('--tmux', `run it in window "${WATCH_WINDOW}" of the agentctl session (created if missing) instead of here; also shows the task counts in the status bar of that session`)
    .option('--no-status-line', 'with --tmux: leave the status bar of the session alone')
    .action(
      guarded(async (opts: { tmux?: boolean; statusLine?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.tmux) {
          const result = await ensureWatchWindow(ctx, deps.watchCommand(), process.cwd());
          if (result === 'exists') line(`Window ${ctx.config.session}:${WATCH_WINDOW} already exists, left alone.`);
          else line(`Started the watcher in window ${ctx.config.session}:${WATCH_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. Attach: tmux attach -t ${ctx.config.session}`);
          if (opts.statusLine !== false && ctx.config.watch.statusLine) {
            const shown = await applyStatusLine(ctx, deps.statusLineCommand?.() ?? 'agentctl status --tmux-line');
            if (shown === 'set') line(`Status bar of session ${ctx.config.session}: task counts, refreshed every 10 s (this session only; undo: tmux set-option -u -t ${ctx.config.session}: status-right).`);
            else if (typeof shown === 'object') line(`Status bar not set – ${shown.failed}`);
            else line(`Status bar left alone (${shown === 'no-session' ? 'the session is not running' : 'the command contains unbalanced parentheses'}).`);
          }
          return;
        }
        const interrupt = deps.interruptSignal?.();
        try {
          const notifier = await (deps.makeNotifier?.(ctx.runner) ?? DesktopNotifier.detect(ctx.runner));
          const self = deps.selfArgv?.();
          await runWatch(ctx, notifier, { ...(interrupt ? { signal: interrupt.signal } : {}), ...(self ? { self } : {}) });
        } finally {
          interrupt?.dispose();
        }
      }),
    );

  program
    .command('board')
    .description(`Full-screen overview of the tasks: state, progress, a live preview of the selected window, and keys to switch to it, message, interrupt, pull and close.`)
    .option('--tmux', `open it in window "${BOARD_WINDOW}" of the agentctl session (created if missing) instead of here`)
    .action(
      guarded(async (opts: { tmux?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.tmux) {
          const result = await ensureWindow(ctx, BOARD_WINDOW, deps.boardCommand?.() ?? 'agentctl board', process.cwd());
          if (result === 'exists') line(`Window ${ctx.config.session}:${BOARD_WINDOW} already exists, left alone.`);
          else line(`Started the board in window ${ctx.config.session}:${BOARD_WINDOW}${result === 'session-created' ? ' (session created)' : ''}.`);
          line(`Open it: tmux attach -t ${ctx.config.session} \\; select-window -t ${BOARD_WINDOW}   (inside tmux: tmux select-window -t ${ctx.config.session}:${BOARD_WINDOW})`);
          return;
        }
        if (!deps.runBoard) throw new AgentctlError('the board is not available here');
        await deps.runBoard(ctx, deps.insideTmux ?? false, deps.selfArgv?.());
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
    .option('--switch-client', 'for the click on a notification: select the window and switch the tmux client that is attached to the session; never attaches a terminal')
    .action(
      guarded(async (task: string | undefined, opts: { switchClient?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.switchClient) {
          if (!task) throw new AgentctlError('--switch-client needs a task ID');
          await switchAttachedClient(ctx, task);
          return;
        }
        await attachTask(ctx, task, { insideTmux: deps.insideTmux ?? false, ...(deps.choose ? { choose: deps.choose } : {}) });
      }),
    );

  program
    .command('event')
    .description('Called by the agents themselves (hooks that "new" sets up): records the event, updates the task state and notifies at once. Always exits 0.')
    .requiredOption('--task <task>', 'task ID')
    .addOption(new Option('--agent <agent>', 'the agent that reports').choices(['claude', 'codex']).makeOptionMandatory())
    .addOption(new Option('--kind <kind>', 'claude: which hook called').choices([...CLAUDE_KINDS]))
    .option('--forward <json>', 'codex: JSON list, the notify command the user had; run with the same JSON after this one')
    .argument('[payload]', 'the event as JSON (codex puts it here; claude sends it on stdin)')
    .action(async (payload: string | undefined, opts: { task: string; agent: 'claude' | 'codex'; kind?: ClaudeKind; forward?: string }) => {
      // A hook must never break the agent: whatever happens, the exit code stays 0.
      try {
        const config = deps.loadConfig();
        const ctx = new Context(deps.makeRunner(false, line), config, () => {}, deps.confirm);
        const raw = payload ?? (opts.agent === 'claude' && !deps.stdinIsTTY ? deps.readStdin() : '');
        const forward = opts.forward ? parseJson(opts.forward) : undefined;
        const notifier = await (deps.makeNotifier?.(ctx.runner) ?? DesktopNotifier.detect(ctx.runner));
        const self = deps.selfArgv?.();
        await handleEvent(ctx, new Alerts(ctx, notifier, { self }), {
          task: opts.task,
          agent: opts.agent,
          kind: opts.kind,
          payload: parseJson(raw),
          rawPayload: opts.agent === 'codex' ? raw : undefined,
          forward: Array.isArray(forward) && forward.every((x) => typeof x === 'string') ? (forward as string[]) : undefined,
        });
      } catch (e) {
        deps.stderr(`agentctl event: ${errorMessage(e)}\n`);
      }
    });

  program
    .command('move')
    .description('Hand a task that hit its usage limit to the other provider: new window <task>-2 in the same worktree, the original prompt plus a note to continue. Asks y/N.')
    .argument('<task>', 'task ID')
    .addOption(new Option('--agent <agent>', 'move to this provider (default: the other one)').choices(['claude', 'codex']))
    .option('-y, --yes', 'do not ask')
    .action(
      guarded(async (task: string, opts: { agent?: 'claude' | 'codex'; yes?: boolean }) => {
        const ctx = contextFor(false);
        const self = deps.selfArgv?.();
        const interrupt = deps.interruptSignal?.();
        try {
          await moveTask(ctx, task, { agent: opts.agent, yes: Boolean(opts.yes), self, signal: interrupt?.signal });
        } finally {
          interrupt?.dispose();
        }
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
