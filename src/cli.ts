import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError, Option } from 'commander';
import { cancelTasks, planCancel } from './core/cancel.ts';
import { touchCohort } from './core/cohort.ts';
import { cohortEntries, cohortRows, findCohort, listCohorts, openCohortTasks, renderCohortList, setCohortOf, setNote, summarizeCohorts } from './core/cohort.ts';
import { closeTasks, planClose } from './core/close.ts';
import { confirmAction, readClipboard, specFromClipboard, writeClipboard } from './core/clipboard.ts';
import { runDoctor } from './core/doctor.ts';
import { renderChecks, renderStatusHints, renderStatusTable } from './render.ts';
import { adoptTask } from './core/adopt.ts';
import { attachTask, switchAttachedClient } from './core/attach.ts';
import { Alerts } from './core/alert.ts';
import { archiveClosed, parseAge } from './core/archive.ts';
import { appendStartLog, describeTerminal, loggedRun, startLogPath, waitForSize } from './core/boardstart.ts';
import { setHidden } from './core/hide.ts';
import { installClaudeCode, installDesktop, desktopConfigPath, mcpEntryFrom, pointsAtStable, stableScript, uninstallClaudeCode, uninstallDesktop } from './core/mcp-install.ts';
import { findMcpProcesses, staleProcesses, staleWarning } from './core/mcp-processes.ts';
import type { McpDeps } from './core/mcp-tools.ts';
import { applyNavigation, describeNavigation } from './core/navigation.ts';
import { handleEvent } from './core/event-command.ts';
import { CLAUDE_KINDS, parseJson } from './core/events.ts';
import type { ClaudeKind, SelfArgv } from './core/events.ts';
import { moveTask } from './core/move.ts';
import { peekTask, PEEK_LINES } from './core/peek.ts';
import { listTargets, matchTask } from './core/resolve.ts';
import type { TaskTarget } from './core/resolve.ts';
import { migrateLegacyState } from './core/taskstore.ts';
import { newTasks } from './core/new.ts';
import { commitQueueAdd, describeQueue, isPaused, moveToFront, planQueueAdd, readQueue, queueStatusLines, removeFromQueue, renderQueueList, retryEntry, setPaused, unblockEntry, waiting } from './core/queue.ts';
import { liveWindows } from './core/plan.ts';
import { collectOverlaps, renderOverlaps, touchWarnings } from './core/collisions.ts';
import type { NewOptions } from './core/new.ts';
import { pullReady, pullTask } from './core/pull.ts';
import { sendPrompts } from './core/send.ts';
import { collectStatus, reportStatus, shownRows, statusMarkdown } from './core/status.ts';
import { summarizeSpecs } from './core/summary.ts';
import { DesktopNotifier, NOTIFIER_MEMORY_MS, notifierOptionsFor } from './core/notify.ts';
import type { Notifier, NotifyResult } from './core/notify.ts';
import { ensureWatchWindow, runWatch, WATCH_WINDOW } from './core/watch.ts';
import { applyStatusLine, statusTmuxLine } from './core/statusline.ts';
import { BOARD_WINDOW, ensureWindow } from './core/windows.ts';
import { interruptTask } from './core/interrupt.ts';
import { handleTap } from './core/usage-tap.ts';
import { loadGlobalConfig } from './core/config.ts';
import { applyExamples } from './examples.ts';
import type { Effort, GlobalConfig } from './core/config.ts';
import { Context } from './core/context.ts';
import { EXAMPLE_SPEC } from './core/example.ts';
import { RealRunner, RecordingRunner } from './core/runner.ts';
import type { Runner } from './core/runner.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from './core/spec.ts';
import type { RawSpec } from './core/spec.ts';
import { AgentctlError, cohortKey, cohortNameProblem, errorMessage, formatLocalTime, resolvePath, shellQuote, windowName } from './core/util.ts';

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
  /** Serve the MCP tools on stdio until the client goes away; the default loads the SDK. */
  runMcp?: (tools: McpDeps, version: string) => Promise<void>;
  /** A board that ends sooner than this after its start (ms) is reported as a failure; default MIN_BOARD_LIFETIME_MS. */
  minBoardLifetimeMs?: number;
  /** This very agentctl as a command line (absolute node and script, config directory of this run): what the agents and notifications call back. */
  selfArgv?: () => SelfArgv;
  /** The notifier for this machine; default: terminal-notifier when installed, else osascript / notify-send. */
  makeNotifier?: (runner: Runner, config: GlobalConfig, opts?: { retryBroken?: boolean }) => Promise<Notifier>;
  /** Command line that prints the tmux status line (`agentctl status --tmux-line`), for tmux's status-right. */
  statusLineCommand?: () => string;
  /** Build the runner: the real one, or a recording one for --dry-run. */
  makeRunner: (dryRun: boolean, emit: (line: string) => void) => Runner;
  /** `$TMUX` is set: attach switches this tmux client instead of attaching a new one. */
  insideTmux?: boolean;
  /** Pick one of several tasks on the terminal; absent when there is no terminal to ask on. */
  choose?: (targets: TaskTarget[]) => Promise<TaskTarget | undefined>;
  /** Called with the finished command tree before the arguments are parsed (the help generator reads it; `npm run docs`). */
  inspect?: (program: Command) => void;
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
    makeNotifier: (runner, config, opts) => DesktopNotifier.detect(runner, undefined, notifierOptionsFor(config, opts)),
    runBoard: async (ctx, insideTmux, self) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AgentctlError('the board needs a terminal', 'Run it in a terminal, or in tmux with "agentctl board --tmux".');
      // A window made without a client attached may have no size yet: wait for it instead of drawing into nothing.
      const size = await waitForSize(process.stdout);
      if (size.waitedMs > 0) appendStartLog(startLogPath(ctx.config, 'board'), `waited ${size.waitedMs} ms for a terminal size, got ${size.columns}x${size.rows}`);
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

/** What `notify-test` tells the user about the channel that carried the notification. */
export function describeNotifyResult(result: NotifyResult | undefined, backend: string): string[] {
  if (!result) return ['Sent the test notification (this notifier does not say which channel carried it).'];
  const hours = NOTIFIER_MEMORY_MS / 3_600_000;
  if (!result.ok) {
    return [
      `No channel worked: ${result.channel} failed${result.error ? ` (${result.error})` : ''}.`,
      ...(result.fallbackFrom ? [`terminal-notifier failed first, then osascript.`] : []),
      'macOS may have notifications switched off for the app that sent it: System Settings > Notifications, and check Focus / Do Not Disturb.',
    ];
  }
  if (result.channel === 'terminal-notifier') return ['Sent through terminal-notifier: a click on the notification switches to the task window.'];
  if (result.channel === 'notify-send') return ['Sent through notify-send (no click action).'];
  const lines = ['Sent through osascript (no click action).'];
  if (result.fallbackFrom) {
    lines.push(`terminal-notifier failed: ${result.error ?? 'unknown error'}`);
    lines.push(`It is left alone for ${hours} h and notifications use osascript meanwhile; notify-test tries it again each time.`);
    lines.push('To get click-to-window: System Settings > Notifications > terminal-notifier > Allow Notifications, alert style Banners.');
    lines.push('If terminal-notifier is not on that list, set "notify: {backend: osascript}" in config.yaml and the attempts stop.');
  } else if (backend === 'osascript') lines.push('notify.backend is osascript.');
  lines.push('Did the notification appear? If not, allow notifications for "Script Editor" (osascript) in System Settings > Notifications.');
  return lines;
}

const realOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

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

  const makeNotifier = (ctx: Context, opts?: { retryBroken?: boolean }): Promise<Notifier> =>
    deps.makeNotifier?.(ctx.runner, ctx.config, opts) ?? DesktopNotifier.detect(ctx.runner, undefined, notifierOptionsFor(ctx.config, opts));

  /** A task ID from what the user typed: any task agentctl knows (a unique prefix is enough). */
  const resolveAnyTask = async (ctx: Context, input: string): Promise<string> => {
    const match = matchTask(input, await listTargets(ctx));
    if (match.kind === 'one') return match.target.task;
    throw new AgentctlError(match.kind === 'many' ? `"${input}" fits more than one task: ${match.matches.map((m) => m.task).join(', ')}` : `no task "${input}"`, 'See "agentctl status".');
  };

  /** `--cohort <name>` on new and queue: every spec of the file joins that cohort (the flag wins over `cohort:` in a spec). */
  const applyCohortFlag = (raws: RawSpec[], cohort: string | undefined): void => {
    if (cohort === undefined) return;
    const problem = cohortNameProblem(cohort);
    if (problem) throw new AgentctlError(`--cohort: ${problem}`);
    for (const raw of raws) raw.header.cohort = cohort;
  };

  /**
   * The tasks a command acts on: the ones typed, or all open tasks of `--cohort`, or (both) the typed ones, which must belong to the cohort.
   * `queued`: tasks waiting in the queue count (cancel takes them out; close has no window to close for them).
   */
  const tasksOrCohort = async (ctx: Context, typed: string[], cohort: string | undefined, queued: boolean): Promise<string[]> => {
    if (cohort === undefined) {
      if (typed.length === 0) throw new AgentctlError('give at least one task, or --cohort <name>');
      return typed;
    }
    const meta = findCohort(ctx.config, cohort);
    const open = await openCohortTasks(ctx, meta.name, { queued });
    if (typed.length === 0) {
      if (open.length === 0) throw new AgentctlError(`cohort ${meta.name} has no open tasks`, 'See "agentctl cohort show ' + meta.name + '".');
      return open;
    }
    const outside = typed.filter((t) => !open.some((o) => o.toLowerCase() === t.toLowerCase() || o.toLowerCase().startsWith(t.toLowerCase())));
    if (outside.length > 0) throw new AgentctlError(`not an open task of cohort ${meta.name}: ${outside.join(', ')}`, `Its open tasks: ${open.join(', ') || 'none'}.`);
    return typed;
  };

  /** Window "watch" exists in the agentctl session: something is there to start the queued tasks. */
  const watchRunning = async (ctx: Context): Promise<boolean> => (await ctx.tmux.hasSession()) && (await ctx.tmux.listWindows()).includes(WATCH_WINDOW);

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
    .description('Start the tasks in a spec file: worktree, setup commands, symlinks, TASK.md, tmux window, agent, prompt.')
    .argument('[file]', 'spec file, or "-" for stdin')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .option('--reuse', 'use worktrees that already exist instead of failing')
    .addOption(new Option('--agent <agent>', 'run every spec on this provider, translated through the equivalents table').choices(['claude', 'codex']))
    .option('--no-switch', 'never offer to move a task to the other provider when its limit is full')
    .option('--no-agent', 'only create the worktree, run setup and links; no TASK.md, window or agent')
    .option('--no-wait-trust', 'stop at the folder-trust dialog instead of waiting for you to confirm it (the old behaviour)')
    .option('--clip', 'read the spec from the clipboard; shows a summary and asks y/N first')
    .option('-y, --yes', 'with --clip: do not ask; also skips the question after a "touches" warning')
    .option('--cohort <name>', 'put every task of the file in this cohort (overrides "cohort:" in a spec); without it a task has a cohort only if its spec names one')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; dryRun?: boolean; reuse?: boolean; agent?: 'claude' | 'codex' | false; switch?: boolean; waitTrust?: boolean; cohort?: string }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const source = opts.clip ? 'clipboard' : (file ?? 'stdin');
        const raws = splitSpecs(await readSpecSource(file, opts.clip), source);
        applyCohortFlag(raws, opts.cohort);
        const specs = raws.map((raw) => resolveSpec(raw, { config: ctx.config }));
        if (opts.clip && !(await confirmAction(ctx, summarizeSpecs(specs), 'Start?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        // `touches`: an active task already changes files the new one says it will touch. Printed always; asked y/N with a terminal.
        if (!opts.dryRun && opts.agent !== false) {
          const warnings = await touchWarnings(ctx, specs);
          for (const w of warnings) line(`⚠ ${w}`);
          if (warnings.length > 0 && ctx.confirm && !opts.yes && !(await ctx.confirm('Start anyway? [y/N] '))) return void line('Aborted, nothing was done.');
        }
        const options: NewOptions = { reuse: Boolean(opts.reuse), noSwitch: opts.switch === false, waitTrust: opts.waitTrust !== false };
        const self = deps.selfArgv?.();
        if (self) options.self = self;
        if (opts.agent) options.agent = opts.agent;
        if (opts.agent === false) options.noAgent = true; // commander reads --no-agent as the negation of --agent
        const interrupt = opts.dryRun ? undefined : deps.interruptSignal?.();
        if (interrupt) options.signal = interrupt.signal;
        // A full provider: with a terminal, "add to the queue?" instead of an error (see "agentctl queue").
        const overflow: { queued: typeof specs } = { queued: [] };
        if (!opts.dryRun && !options.noAgent) options.overflow = overflow;
        try {
          await newTasks(ctx, specs, options);
        } finally {
          interrupt?.dispose();
        }
        if (overflow.queued.length > 0) {
          const added = await commitQueueAdd(ctx, overflow.queued.map((spec) => ({ raw: raws[spec.index - 1] as RawSpec, spec })), { ...(opts.agent ? { agent: opts.agent } : {}) });
          for (const e of added) line(`${e.task}: queued (position ${waiting(readQueue(ctx.config)).findIndex((x) => x.task === e.task) + 1}); it starts when a ${e.agent} window is free${await watchRunning(ctx) ? '' : ' – nothing starts it unless "agentctl watch" runs: agentctl watch --tmux'}`);
        }
        // The session exists now (it may have been created by this very command): mouse and the key back to the board.
        if (!opts.dryRun && !options.noAgent) for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session, true)) line(l);
      }),
    );

  const queue = program
    .command('queue')
    .description('Put the tasks of a spec file in the queue: they start by themselves (while "agentctl watch" runs) when a window of their provider is free. Shows a summary and asks y/N first.')
    .argument('[file]', 'spec file, or "-" for stdin')
    .option('--clip', 'read the spec from the clipboard')
    .addOption(new Option('--agent <agent>', 'run every spec on this provider, translated through the equivalents table (the queue never switches provider by itself)').choices(['claude', 'codex']))
    .option('-y, --yes', 'do not ask')
    .option('--cohort <name>', 'put every task of the file in this cohort (overrides "cohort:" in a spec); without it a task has a cohort only if its spec names one')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; agent?: 'claude' | 'codex'; cohort?: string }) => {
        const ctx = contextFor(false);
        const raws = splitSpecs(await readSpecSource(file, opts.clip), opts.clip ? 'clipboard' : (file ?? 'stdin'));
        applyCohortFlag(raws, opts.cohort);
        const plan = await planQueueAdd(ctx, raws, { ...(opts.agent ? { agent: opts.agent } : {}) });
        if (!(await confirmAction(ctx, plan.summary, plan.warnings.length > 0 ? 'Add to the queue anyway?' : 'Add to the queue?', Boolean(opts.yes)))) return;
        const added = await commitQueueAdd(ctx, plan.items, { ...(opts.agent ? { agent: opts.agent } : {}) });
        const entries = waiting(readQueue(ctx.config));
        for (const e of added) line(`${e.task}: queued (position ${entries.findIndex((x) => x.task === e.task) + 1} of ${entries.length})`);
        if (!(await watchRunning(ctx))) line('hint: nothing starts the queue unless "agentctl watch" runs: agentctl watch --tmux');
      }),
    );

  queue
    .command('list')
    .description('The queue: position, task, agent/model/effort, priority, start condition and how long it waits.')
    .option('--json', 'machine-readable output')
    .option('--cohort <name>', 'only the tasks of this cohort (the positions are those of the whole queue)')
    .action(
      guarded(async (opts: { json?: boolean; cohort?: string }, command: Command) => {
        const ctx = contextFor(false, { migrate: false });
        // `queue` has a --cohort of its own (for the file it adds): commander hands that one the flag, wherever it stands in the line.
        const wanted = opts.cohort ?? (command.optsWithGlobals() as { cohort?: string }).cohort;
        const cohort = wanted === undefined ? undefined : findCohort(ctx.config, wanted).name;
        const all = describeQueue(ctx.config, readQueue(ctx.config), await liveWindows(ctx), await collectStatus(ctx, { progress: false, archived: true }));
        const views = cohort === undefined ? all : all.filter((v) => v.entry.cohort !== undefined && cohortKey(v.entry.cohort) === cohortKey(cohort));
        if (opts.json) return line(JSON.stringify(views.map((v) => ({ position: v.position, task: v.entry.task, cohort: v.entry.cohort ?? null, status: v.entry.status, agent: v.entry.agent, model: v.entry.model, effort: v.entry.effort, priority: v.entry.priority, condition: v.condition.text, blocked: v.condition.kind === 'blocked', after: v.entry.after, queued: v.entry.queuedAt, error: v.entry.error ?? null })), null, 2));
        for (const l of renderQueueList(views, ctx.runner.now())) line(l);
        for (const v of views.filter((x) => x.condition.kind === 'blocked')) line(`hint: ${v.entry.task} is blocked: agentctl unblock ${v.entry.task} [--drop-after <task>], or agentctl cancel ${v.entry.task}`);
        if (isPaused(ctx.config)) line('The queue is paused: "agentctl queue resume" lets it run again.');
      }),
    );

  queue
    .command('rm')
    .description('Take a task out of the queue (a waiting or a failed one): the same as "agentctl cancel" for a queued task, without a reason. The task is then cancelled.')
    .argument('<task>', 'task ID; a unique prefix is enough')
    .action(
      guarded(async (task: string) => {
        const ctx = contextFor(false, { migrate: false });
        const entry = await removeFromQueue(ctx, task, { source: 'cli' });
        line(`${entry.task}: removed from the queue (cancelled)`);
        for (const e of readQueue(ctx.config).filter((x) => x.after.includes(entry.task))) line(`  ⛓ ${e.task} is blocked: it waited for ${entry.task}. agentctl unblock ${e.task} --drop-after ${entry.task}, or agentctl cancel ${e.task}`);
      }),
    );

  queue
    .command('up')
    .description('Move a waiting task to the front of the line (tasks with priority: high still go first).')
    .argument('<task>', 'task ID; a unique prefix is enough')
    .action(guarded(async (task: string) => line(`${(await moveToFront(contextFor(false, { migrate: false }), task)).task}: first in line`)));

  queue
    .command('retry')
    .description('Put a failed task back at the end of the line; it is tried once more (over the worktree the failed start left).')
    .argument('<task>', 'task ID; a unique prefix is enough')
    .action(guarded(async (task: string) => line(`${(await retryEntry(contextFor(false, { migrate: false }), task)).task}: back in the queue`)));

  program
    .command('unblock')
    .description('Let a blocked queued task go on: a task whose "after" names a cancelled task is blocked (⛓) and never starts. This drops the dependency (all the cancelled ones, or only --drop-after); the task is back in the queue and waits for the rest, or starts. The other way out is "agentctl cancel".')
    .argument('<task>', 'task ID; a unique prefix is enough')
    .option('--drop-after <task>', 'drop only this task from the "after" of the queued task')
    .action(
      guarded(async (task: string, opts: { dropAfter?: string }) => {
        const { entry, dropped } = await unblockEntry(contextFor(false, { migrate: false }), task, { dropAfter: opts.dropAfter });
        line(`${entry.task}: no longer waits for ${dropped.join(', ')}; back in the queue${entry.after.length > 0 ? `, still waiting for ${entry.after.join(', ')}` : ''}`);
      }),
    );

  for (const pause of [true, false]) {
    queue
      .command(pause ? 'pause' : 'resume')
      .description(pause ? 'Stop starting queued tasks (running tasks are not touched; adding and listing still work).' : 'Let the queue start tasks again.')
      .action(guarded(async () => line((await setPaused(contextFor(false, { migrate: false }), pause)) ? (pause ? 'Queue paused.' : 'Queue resumed.') : `Queue was already ${pause ? 'paused' : 'running'}.`)));
  }

  const cohort = program
    .command('cohort')
    .description('Cohorts: tasks grouped under a name you chose ("cohort: <name>" in a spec, or --cohort). A task without a name belongs to no cohort. Without a subcommand: list.');

  cohort
    .command('list', { isDefault: true })
    .description('The cohorts: how many tasks each has by state (active, queued, reports, closed, cancelled) and since when.')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (opts: { json?: boolean }) => {
        const list = await summarizeCohorts(contextFor(false, { migrate: false }));
        if (opts.json) return line(JSON.stringify(list, null, 2));
        for (const l of renderCohortList(list)) line(l);
      }),
    );

  cohort
    .command('show')
    .description('The tasks of one cohort as in "status" (closed and cancelled ones too) and its queued tasks.')
    .argument('<name>', 'cohort name; case does not matter')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (name: string, opts: { json?: boolean }) => {
        const ctx = contextFor(false);
        const meta = findCohort(ctx.config, name);
        const { rows } = await reportStatus(ctx, { archived: true });
        const mine = cohortRows(rows, meta.name);
        if (opts.json) return line(JSON.stringify({ cohort: meta.name, created: meta.created || null, note: meta.note ?? null, tasks: mine, queued: cohortEntries(readQueue(ctx.config), meta.name).map((e) => e.task) }, null, 2));
        line(`Cohort ${meta.name}${meta.created ? ` (since ${formatLocalTime(meta.created)})` : ''}${meta.note ? `: ${meta.note}` : ''}`);
        if (mine.length > 0) for (const l of renderStatusTable(mine, 60, { cohort: false })) line(l);
        const queued = await queueStatusLines(ctx, meta.name);
        for (const l of queued) line(l);
        if (mine.length === 0 && queued.length === 0) line('No tasks in it.');
      }),
    );

  cohort
    .command('add')
    .description('Put existing tasks (running, finished or queued) into a cohort; it is created if it is new. A task that was in another cohort moves.')
    .argument('<name>', 'cohort name')
    .argument('<tasks...>', 'task IDs; a unique prefix is enough')
    .action(
      guarded(async (name: string, tasks: string[]) => {
        const ctx = contextFor(false);
        const meta = await touchCohort(ctx, name);
        for (const c of await setCohortOf(ctx, tasks, meta)) line(`${c.task}: ${c.was === null ? 'joined' : cohortKey(c.was) === cohortKey(meta.name) ? 'already in' : `moved from ${c.was} to`} cohort ${meta.name}`);
      }),
    );

  cohort
    .command('remove')
    .description('Take tasks out of their cohort (they then belong to none).')
    .argument('<tasks...>', 'task IDs; a unique prefix is enough')
    .action(
      guarded(async (tasks: string[]) => {
        for (const c of await setCohortOf(contextFor(false), tasks, undefined)) line(c.was === null ? `${c.task}: was in no cohort` : `${c.task}: left cohort ${c.was}`);
      }),
    );

  cohort
    .command('note')
    .description('Write the description of a cohort (an empty text removes it).')
    .argument('<name>', 'cohort name')
    .argument('<text...>', 'the description')
    .action(
      guarded(async (name: string, text: string[]) => {
        const meta = await setNote(contextFor(false), name, text.join(' '));
        line(meta.note ? `Cohort ${meta.name}: ${meta.note}` : `Cohort ${meta.name}: note removed`);
      }),
    );

  program
    .command('overlap')
    .description('Which active tasks of one repository changed the same files (git diff of each worktree against its base, plus uncommitted files). Without a task: every pair.')
    .argument('[task]', 'only the pairs with this task; case does not matter and a unique prefix is enough')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (task: string | undefined, opts: { json?: boolean }) => {
        const ctx = contextFor(false, { migrate: false });
        const resolved = task ? (await resolveAnyTask(ctx, task)) : undefined;
        const overlaps = await collectOverlaps(ctx, resolved);
        if (opts.json) return line(JSON.stringify(overlaps, null, 2));
        for (const l of renderOverlaps(overlaps)) line(l);
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
    .option('--tmux-line', 'one short line for the tmux status bar, like "2⚙ 1✓ 1? 3⧗" (tasks per state, then the tasks in the queue)')
    .option('--all', 'also the hidden, the closed and the cancelled tasks (see "agentctl hide", "agentctl close", "agentctl cancel"), archived ones included')
    .option('--cohort <name>', 'only the tasks of this cohort (also with --json and --clip)')
    .action(
      guarded(async (opts: { json?: boolean; clip?: boolean; tmuxLine?: boolean; all?: boolean; cohort?: string }) => {
        if ([opts.json, opts.clip, opts.tmuxLine].filter(Boolean).length > 1) throw new AgentctlError('--json, --clip and --tmux-line exclude each other');
        if (opts.tmuxLine) return line(await statusTmuxLine(contextFor(false, { migrate: false })));
        const ctx = contextFor(false);
        const cohort = opts.cohort === undefined ? undefined : findCohort(ctx.config, opts.cohort).name;
        const { rows: everyRow } = await reportStatus(ctx, { archived: Boolean(opts.all) });
        const allRows = cohort === undefined ? everyRow : cohortRows(everyRow, cohort);
        const rows = shownRows(allRows, Boolean(opts.all));
        const hiddenCount = allRows.length - rows.length;
        if (opts.clip) {
          const md = statusMarkdown(rows);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the status of ${rows.length} task${rows.length === 1 ? '' : 's'} to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the table:`);
          return deps.stdout(md);
        }
        if (opts.json) return line(JSON.stringify(rows, null, 2));
        if (rows.length === 0) {
          line(hiddenCount > 0 ? `No visible tasks${cohort ? ` in cohort ${cohort}` : ''}; ${hiddenCount} hidden (see "agentctl status --all").` : cohort ? `No tasks in cohort ${cohort}.` : `No tasks yet in ${ctx.config.stateDir}. Start one with "agentctl new <spec>".`);
          for (const l of await queueStatusLines(ctx, cohort)) line(l);
          return;
        }
        for (const l of renderStatusTable(rows)) line(l);
        for (const l of renderStatusHints(rows)) line(`hint: ${l}`);
        for (const l of await queueStatusLines(ctx, cohort)) line(l);
        if (hiddenCount > 0) line(`${hiddenCount} hidden task${hiddenCount === 1 ? '' : 's'} not shown: agentctl status --all`);
      }),
    );

  program
    .command('archive')
    .description('Move the state of closed tasks (agentctl close) to the archive folder next to the state folder. Reports and worktrees are not touched.')
    .option('--older-than <age>', 'only tasks closed at least this long ago: 30m, 12h, 7d, 2w')
    .option('--dry-run', 'print the moves, do nothing')
    .action(
      guarded(async (opts: { olderThan?: string; dryRun?: boolean }) => {
        const olderThanMs = opts.olderThan === undefined ? undefined : parseAge(opts.olderThan);
        const ctx = contextFor(Boolean(opts.dryRun), { migrate: false });
        const result = await archiveClosed(ctx, { olderThanMs });
        for (const m of result.moved) line(`${m.task}: state moved to ${m.to}`);
        for (const k of result.kept) line(`${k.task}: kept (${k.reason})`);
        if (result.moved.length === 0 && result.kept.length === 0) line('No closed tasks to archive.');
      }),
    );

  for (const hide of [true, false]) {
    program
      .command(hide ? 'hide' : 'unhide')
      .description(
        hide
          ? 'Take tasks off the board and "status" (they stay in "status --all" and on the board under "a"). Does not close the task or touch its worktree.'
          : 'Show hidden tasks again on the board and in "status". A task shown on purpose is not hidden again by board.auto_hide_pulled_dead.',
      )
      .argument('<tasks...>', 'task IDs; case does not matter and a unique prefix is enough')
      .action(
        guarded(async (tasks: string[]) => {
          for (const r of await setHidden(contextFor(false, { migrate: false }), tasks, hide)) {
            if (r.unchanged) line(`${r.task}: already ${hide ? 'hidden' : 'shown'}`);
            else line(`${r.task}: ${hide ? 'hidden' : 'shown again'}${hide && r.windowAlive ? ' (its window is still running; "agentctl status --all" lists it)' : ''}`);
          }
        }),
      );
  }

  program
    .command('pull')
    .description('Copy the task report to the clipboard and print its path (without a report: last 40 lines of the window). --ready: all new reports at once.')
    .argument('[task]', 'task ID')
    .option('--ready', 'join every report in state report-ready that was not pulled yet, copy it and mark the tasks as pulled')
    .option('--all', 'with --ready: also the reports that were pulled before')
    .option('--cohort <name>', 'with --ready: only the reports of this cohort')
    .action(
      guarded(async (task: string | undefined, opts: { ready?: boolean; all?: boolean; cohort?: string }) => {
        if (opts.all && !opts.ready) throw new AgentctlError('--all only works together with --ready');
        if (opts.cohort !== undefined && !opts.ready) throw new AgentctlError('--cohort only works together with --ready');
        if (opts.ready) {
          if (task) throw new AgentctlError('--ready takes no task ID', 'Use "agentctl pull --ready" or "agentctl pull <task>".');
          const ctx = contextFor(false);
          await pullReady(ctx, { all: Boolean(opts.all), ...(opts.cohort === undefined ? {} : { cohort: findCohort(ctx.config, opts.cohort).name }) });
          return;
        }
        if (!task) throw new AgentctlError('give a task ID, or --ready', 'Example: "agentctl pull NC-42" or "agentctl pull --ready".');
        await pullTask(contextFor(false), task);
      }),
    );

  program
    .command('close')
    .description('Kill the task windows; --rm-worktree also removes their git worktrees (branches are kept). Shows the list and asks y/N first.')
    .argument('[tasks...]', 'task IDs (or --cohort)')
    .option('--cohort <name>', 'close the open tasks of this cohort (with task IDs: only those, which must belong to it)')
    .option('--rm-worktree', 'run "git worktree remove" for the task worktrees (never --force)')
    .option('-y, --yes', 'do not ask')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (typed: string[], opts: { rmWorktree?: boolean; yes?: boolean; dryRun?: boolean; cohort?: string }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const closeOpts = { rmWorktree: Boolean(opts.rmWorktree) };
        const tasks = await tasksOrCohort(ctx, typed, opts.cohort, false);
        const plan = await planClose(ctx, tasks, closeOpts);
        const summary = [`Close ${plan.length} task${plan.length === 1 ? '' : 's'}${closeOpts.rmWorktree ? ' and remove their worktrees (branches stay)' : ''}:`, ...plan.map((i) => `  ${i.line}`)];
        if (!(await confirmAction(ctx, summary, 'Go ahead?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await closeTasks(ctx, plan.map((i) => i.task), closeOpts);
      }),
    );

  program
    .command('cancel')
    .description('Abandon tasks: a task at work is interrupted, given cancel.grace seconds to stop, and its window is closed; a task in the queue is taken out of it. They become cancelled (not closed). The worktree and the branch stay unless --rm-worktree (worktree only, never the branch). Shows the list and asks y/N first.')
    .argument('[tasks...]', 'task IDs (or --cohort); a unique prefix is enough. The other half of a "move" (the old task or its successor) is cancelled with it')
    .option('--cohort <name>', 'cancel the open tasks of this cohort, the queued ones too (with task IDs: only those, which must belong to it)')
    .option('--reason <text>', 'why (optional); kept in TASK.md')
    .option('--rm-worktree', 'also run "git worktree remove" for the task worktrees (never --force; the branch stays)')
    .option('-y, --yes', 'do not ask')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (typed: string[], opts: { reason?: string; rmWorktree?: boolean; yes?: boolean; dryRun?: boolean; cohort?: string }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const cancelOpts = { reason: opts.reason, rmWorktree: Boolean(opts.rmWorktree), source: 'cli' as const };
        const plan = await planCancel(ctx, await tasksOrCohort(ctx, typed, opts.cohort, true), cancelOpts);
        if (!(await confirmAction(ctx, plan.summary, 'Cancel?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await cancelTasks(ctx, plan, cancelOpts);
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
          else line(`${result === 'restarted' ? 'Started again (its process had ended)' : 'Started'} the watcher in window ${ctx.config.session}:${WATCH_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. Attach: tmux attach -t ${ctx.config.session}. If it fails to start, the window stays with the error; ${startLogPath(ctx.config, 'watch')} has it too.`);
          for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session)) line(l);
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
          await loggedRun(startLogPath(ctx.config, 'watch'), 'watch', async () => {
            const notifier = await makeNotifier(ctx);
            const self = deps.selfArgv?.();
            await runWatch(ctx, notifier, { ...(interrupt ? { signal: interrupt.signal } : {}), ...(self ? { self } : {}) });
          }, { minLifetimeMs: 0 });
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
          else line(`${result === 'restarted' ? 'Started again (its process had ended)' : 'Started'} the board in window ${ctx.config.session}:${BOARD_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. If it fails to start, the window stays with the error; ${startLogPath(ctx.config, 'board')} has it too.`);
          for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session)) line(l);
          line(`Open it: tmux attach -t ${ctx.config.session} \\; select-window -t ${BOARD_WINDOW}   (inside tmux: tmux select-window -t ${ctx.config.session}:${BOARD_WINDOW})`);
          return;
        }
        const runBoard = deps.runBoard;
        if (!runBoard) throw new AgentctlError('the board is not available here');
        const note = await loggedRun(startLogPath(ctx.config, 'board'), 'board', () => runBoard(ctx, deps.insideTmux ?? false, deps.selfArgv?.()), { startNote: describeTerminal(process.env, process.stdout, process.stdin), ...(deps.minBoardLifetimeMs !== undefined ? { minLifetimeMs: deps.minBoardLifetimeMs } : {}) });
        // A board that ends at once without an error says so: in a window kept with remain-on-exit this is what stays on the screen.
        if (note) throw new AgentctlError(note);
      }),
    );

  program
    .command('notify-test')
    .description('Send one test notification and say which channel carried it (terminal-notifier with a click action, or the osascript fallback).')
    .action(
      guarded(async () => {
        const ctx = contextFor(false, { migrate: false });
        const notifier = await makeNotifier(ctx, { retryBroken: true });
        const result = (await notifier.notify('agentctl', 'Test powiadomienia agentctl – jeśli to widzisz, kanał działa.', { group: 'agentctl-test' })) as NotifyResult | undefined;
        for (const l of describeNotifyResult(result, ctx.config.notify.backend)) line(l);
        if (result && !result.ok) exitCode = 1;
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
        const notifier = await makeNotifier(ctx);
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
    .command('usage-tap')
    .description('Called by Claude Code as the statusLine of a task window (set up by "new"): keeps the plan limits that Claude gives only to a statusLine, remembers the session, then runs your own statusLine command with the same input and prints its output. Always exits 0.')
    .requiredOption('--task <task>', 'task ID')
    .option('--forward <command>', 'your own statusLine command: run with the same input after this one')
    .action(async (opts: { task: string; forward?: string }) => {
      // A status line must never break the agent: whatever happens, the exit code stays 0.
      try {
        const config = deps.loadConfig();
        const runner = deps.makeRunner(false, () => {});
        const raw = deps.stdinIsTTY ? '' : deps.readStdin();
        const result = await handleTap(runner, config, { task: opts.task, window: windowName(opts.task), raw, ...(opts.forward ? { forward: opts.forward } : {}) });
        if (result.output !== '') deps.stdout(result.output);
      } catch (e) {
        deps.stderr(`agentctl usage-tap: ${errorMessage(e)}\n`);
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

  const mcp = program
    .command('mcp')
    .description('Local MCP server on stdio: lets a chat (the Claude app, Claude Code, VS Code) read status, window previews and reports. "mcp install" registers it; writing is off until mcp.allow says otherwise.');

  mcp
    .command('serve', { isDefault: true })
    .description('Serve the tools on stdin/stdout (this is what the app or Claude Code starts). Nothing else is ever printed to stdout.')
    .action(
      guarded(async () => {
        // stdout belongs to the protocol: messages go to stderr, and the state is not migrated (that prints).
        const contextAt = (out: (line: string) => void): Context => new Context(deps.makeRunner(false, () => {}), deps.loadConfig(), out);
        const tools: McpDeps = {
          context: contextAt,
          notify: async (message) => {
            const ctx = contextAt(() => {});
            await (await makeNotifier(ctx)).notify('agentctl', message);
          },
          self: deps.selfArgv?.(),
          server: { version: packageVersion(), script: realOrSelf(process.argv[1] ?? 'bin/agentctl.ts'), pid: process.pid, started: new Date().toISOString() },
        };
        const run =
          deps.runMcp ??
          (async (t: McpDeps, version: string): Promise<void> => {
            const { runMcpServer } = await import('./mcp/server.ts');
            await runMcpServer(t, version);
          });
        await run(tools, packageVersion());
      }),
    );

  mcp
    .command('check')
    .description('Look for MCP server processes ("agentctl … mcp", started by the Claude app) that run older code than the stable copy: after "agentctl-update" the app keeps the old process until it is quit (⌘Q) and opened again. Prints a warning; stops nothing.')
    .action(
      guarded(async () => {
        const ctx = contextFor(false, { migrate: false });
        const stable = stableScript();
        const warning = staleWarning(staleProcesses(await findMcpProcesses(ctx.runner), stable), stable);
        line(warning ? `warning: ${warning}` : 'No MCP server process runs older code than the stable copy.');
      }),
    );

  for (const install of [true, false]) {
    mcp
      .command(install ? 'install' : 'uninstall')
      .description(
        install
          ? 'Register this agentctl as an MCP server: --desktop edits claude_desktop_config.json (diff, y/N, dated .bak copy, other servers kept), --claude-code runs "claude mcp add --scope user".'
          : 'Remove the agentctl MCP server from the Claude desktop config and/or Claude Code (without a flag: both).',
      )
      .option('--desktop', 'the Claude desktop app')
      .option('--claude-code', 'Claude Code (user scope; the VS Code extension reads the same configuration)')
      .option('--config <file>', 'with --desktop: use this file instead of ~/Library/Application Support/Claude/claude_desktop_config.json (to try it on a copy)')
      .option('--dry-run', 'show the entry, the diff and the commands; change nothing')
      .option('-y, --yes', 'do not ask')
      .action(
        guarded(async (opts: { desktop?: boolean; claudeCode?: boolean; config?: string; dryRun?: boolean; yes?: boolean }) => {
          if (install && !opts.desktop && !opts.claudeCode) throw new AgentctlError('say where: --desktop and/or --claude-code', 'Example: agentctl mcp install --desktop --dry-run');
          const ctx = contextFor(Boolean(opts.dryRun), { migrate: false });
          const yes = Boolean(opts.yes) || Boolean(opts.dryRun);
          const file = opts.config ? resolvePath(opts.config) : desktopConfigPath();
          const both = !opts.desktop && !opts.claudeCode;
          const warnings: string[] = [];
          let entry: ReturnType<typeof mcpEntryFrom> | undefined;
          if (install) {
            const self = deps.selfArgv?.();
            if (!self) throw new AgentctlError('cannot tell which agentctl this is');
            entry = mcpEntryFrom(self);
            if (!pointsAtStable(entry)) warnings.push(`this agentctl runs ${entry.args.find((a) => /\.ts$/.test(a)) ?? 'from somewhere else'}, not the stable copy ${stableScript()}; run the installed command ("agentctl mcp install …") if the registration should survive development`);
          }
          if (opts.desktop || (!install && both)) {
            const result = entry ? await installDesktop(ctx, entry, { file, yes, warnings }) : await uninstallDesktop(ctx, { file, yes });
            if (result.outcome === 'declined') return;
          }
          if (opts.claudeCode || (!install && both)) {
            try {
              if (entry) await installClaudeCode(ctx, entry, { yes, warnings });
              else await uninstallClaudeCode(ctx, { yes });
            } catch (e) {
              if (install || opts.claudeCode) throw e;
              line(`Claude Code: ${errorMessage(e)}`);
            }
          }
        }),
      );
  }

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

  applyExamples(program);
  deps.inspect?.(program);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    throw e;
  }
  return exitCode;
}
