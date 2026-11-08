import { attachHint, tmuxCommand } from './core/tmux-socket.ts';
import { collectMachine, machineLine } from './core/machine.ts';
import { exportDataset, validateDatasetOptions } from './core/dataset.ts';
import type { DatasetOptions } from './core/dataset.ts';
import { DEFAULT_PROVIDERS } from './core/providers/types.ts';
import type { AgentName } from './core/config.ts';
import { provider, PROVIDER_IDS, activeProviders } from './core/providers/registry.ts';
import { reportPathWarnings } from './core/report-path.ts';
import { planMark, markTasks } from './core/mark.ts';
import { aggregateOutputs } from './core/outputs.ts';
import { stableNodePath } from './core/mcp-install.ts';
import { packageVersion } from './core/version.ts';
import { findEntry } from './core/queue.ts';
import { collectDisk, diskLine, confirmDiskStart, refreshDiskAfterGc } from './core/disk.ts';
import { collectCapacity, capacitySnapshot, renderCapacity, snapshotLines } from './core/capacity.ts';
import { collectGuide } from './core/guide.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Argument, Command, CommanderError, Option } from 'commander';
import { cancelTasks, planCancel } from './core/cancel.ts';
import { touchCohort } from './core/cohort.ts';
import { applyCohortArchive, planCohortArchive } from './core/cohort.ts';
import { cohortEntries, cohortRows, findCohort, listCohorts, openCohortTasks, renderCohortList, setCohortOf, setNote, summarizeCohorts } from './core/cohort.ts';
import { closeTasks, planClose } from './core/close.ts';
import { confirmAction, readClipboard, specFromClipboard, writeClipboard } from './core/clipboard.ts';
import { runDoctor } from './core/doctor.ts';
import { renderChecks, renderStatusHints, renderStatusTable } from './render.ts';
import { adoptTask } from './core/adopt.ts';
import { attachTask, showWindow, switchAttachedClient } from './core/attach.ts';
import { findResumable, planResume, resumeTasks } from './core/resume.ts';
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
import { applyGc, planGc, renderGc, gcView } from './core/gc.ts';
import { collectEvents, eventsMarkdown, renderEvents } from './core/chat-events.ts';
import { planNtfySetup, renderQr, setupInstructions, subscriptionLink } from './core/ntfy-setup.ts';
import { writeConfigText } from './core/config-edit.ts';
import { sendPhoneTest } from './core/phone.ts';
import type { FetchLike } from './core/phone.ts';
import { awayReport, phoneActive, renderAway, setAway } from './core/away.ts';
import { applySetLimits, collectLimits, parseAssignments, parseCounts, planSetLimits, releasePlaces, renderLimits, reservePlaces } from './core/limits.ts';
import { collectOverlaps, renderOverlaps, touchWarnings } from './core/collisions.ts';
import type { NewOptions, NewResult } from './core/new.ts';
import { pullReady, pullTask } from './core/pull.ts';
import { reportInfo, shortPath } from './core/report-detect.ts';
import { sendPrompts, submitDrafts } from './core/send.ts';
import { resolveRunningTask } from './core/resolve.ts';
import { answerMenu } from './core/answer.ts';
import { promptQueueView, withdrawPrompt } from './core/prompt-queue.ts';
import { collectStatus, reportStatus, shownRows, statusMarkdown } from './core/status.ts';
import { summarizeSpecs } from './core/summary.ts';
import { DesktopNotifier, NOTIFIER_MEMORY_MS, notifierOptionsFor } from './core/notify.ts';
import type { Notifier, NotifyResult } from './core/notify.ts';
import { ensureWatchWindow, runWatch, WATCH_WINDOW } from './core/watch.ts';
import { applyStatusLine, statusTmuxLine } from './core/statusline.ts';
import { MANAGER_STATE_TEXT, MANAGER_WINDOW, managerAddress, managerAdvice, startManager, stopManager } from './core/manager.ts';
import { BOARD_WINDOW, ensureWindow } from './core/windows.ts';
import { interruptTask } from './core/interrupt.ts';
import { handleTap } from './core/usage-tap.ts';
import { computeStats, logMarkdown, markTask, parseResult, RESULTS, renderLog, renderStats, selectHistory, statsMarkdown } from './core/history.ts';
import type { Result } from './core/history.ts';
import { usageSummaryLines } from './core/usage-limits.ts';
import { collectUsage, renderUsage, usageMarkdown } from './core/usage-report.ts';
import { configDir, EFFORTS, loadGlobalConfig } from './core/config.ts';
import { ConfigStore, configStatePath, noteConfigState, readConfigState } from './core/config-store.ts';
import { applyExamples } from './examples.ts';
import type { Effort, GlobalConfig } from './core/config.ts';
import { Context } from './core/context.ts';
import { EXAMPLE_SPEC } from './core/example.ts';
import { RealRunner, RecordingRunner } from './core/runner.ts';
import type { Runner } from './core/runner.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from './core/spec.ts';
import type { RawSpec } from './core/spec.ts';
import { AgentctlError, cohortKey, cohortNameProblem, errorMessage, formatLocalTime, resolvePath, safeCwd, shellQuote, windowName } from './core/util.ts';

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
  /** HTTP for the phone notifications (tests give a mock). */
  fetch?: FetchLike;
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
    makeRunner: (dryRun, emit) => (dryRun ? new RecordingRunner({ emit, readRunner: new RealRunner() }) : new RealRunner()),
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
  return `${env}${shellQuote(stableNodePath(process.execPath))} ${script.endsWith('.ts') ? '--experimental-strip-types --no-warnings ' : ''}${shellQuote(script)} ${args}`;
}

/**
 * This very agentctl as an argv: absolute node and script paths and the settings of this run that the callback needs (config
 * directory, tmux socket directory, PATH), set through env(1). A click on a notification runs with a bare PATH (/usr/bin:/bin),
 * where tmux, installed by Homebrew, is not found.
 */
export function selfArgv(): SelfArgv {
  const script = fs.realpathSync(process.argv[1] ?? 'bin/agentctl.ts');
  const env = (['AGENTCTL_HOME', 'TMUX_TMPDIR', 'PATH'] as const).filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  return [...(env.length > 0 ? ['/usr/bin/env', ...env] : []), stableNodePath(process.execPath), ...(script.endsWith('.ts') ? ['--experimental-strip-types', '--no-warnings'] : []), script];
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

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[], deps: CliDeps = defaultDeps()): Promise<number> {
  const line = (text: string): void => deps.stdout(`${text}\n`);
  let exitCode = 0;
  let cliProviders: readonly import('./core/config.ts').AgentName[] = DEFAULT_PROVIDERS;
  if (!argv.includes('--version')) {
    try { cliProviders = activeProviders(deps.loadConfig()); } catch { /* the command reports invalid config when needed */ }
  }

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

  const contextFor = (dryRun: boolean, { migrate = true, silent = false } = {}): Context => {
    let config: GlobalConfig;
    try {
      config = deps.loadConfig();
    } catch (e) {
      // A running watch or MCP server keeps working with the last good settings: say so, so that the broken file is not mistaken for an outage.
      const state = readConfigState(path.join(configDir(), 'config-state.json'));
      if (e instanceof AgentctlError && state && !state.ok) throw new AgentctlError(e.message, `${e.hint ? `${e.hint} ` : ''}The ${state.by} keeps the previous settings meanwhile (since ${state.at}).`);
      throw e;
    }
    // TASK.md and setup.log used to live in the cache folder, where agents could delete them: move them to state_dir.
    const output = silent ? () => {} : line;
    if (!dryRun && migrate) for (const message of migrateLegacyState(config)) output(message);
    return new Context(deps.makeRunner(dryRun, output), config, output, deps.confirm);
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

  /** `watch --tmux`: window "watch" in the agentctl session (never a second one), the navigation key and the task counts in the status bar. */
  const startWatchWindow = async (ctx: Context, statusLine: boolean): Promise<'created' | 'exists'> => {
    const result = await ensureWatchWindow(ctx, deps.watchCommand(), safeCwd());
    if (result === 'exists') line(`Window ${ctx.config.session}:${WATCH_WINDOW} already exists, left alone.`);
    else line(`${result === 'restarted' ? 'Started again (its process had ended)' : 'Started'} the watcher in window ${ctx.config.session}:${WATCH_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. Attach: ${attachHint(ctx.config)}. If it fails to start, the window stays with the error; ${startLogPath(ctx.config, 'watch')} has it too.`);
    for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session)) line(l);
    if (statusLine && ctx.config.watch.statusLine) {
      const shown = await applyStatusLine(ctx, deps.statusLineCommand?.() ?? 'agentctl status --tmux-line');
      if (shown === 'set') line(`Status bar of session ${ctx.config.session}: task counts, refreshed every 10 s (this session only; undo: tmux set-option -u -t ${ctx.config.session}: status-right).`);
      else if (typeof shown === 'object') line(`Status bar not set – ${shown.failed}`);
      else line(`Status bar left alone (${shown === 'no-session' ? 'the session is not running' : 'the command contains unbalanced parentheses'}).`);
    }
    return result === 'exists' ? 'exists' : 'created';
  };

  /** `board --tmux`: window "board" in the agentctl session (never a second one). */
  const startBoardWindow = async (ctx: Context): Promise<'created' | 'exists'> => {
    const result = await ensureWindow(ctx, BOARD_WINDOW, deps.boardCommand?.() ?? 'agentctl board', safeCwd());
    if (result === 'exists') line(`Window ${ctx.config.session}:${BOARD_WINDOW} already exists, left alone.`);
    else line(`${result === 'restarted' ? 'Started again (its process had ended)' : 'Started'} the board in window ${ctx.config.session}:${BOARD_WINDOW}${result === 'session-created' ? ' (session created)' : ''}. If it fails to start, the window stays with the error; ${startLogPath(ctx.config, 'board')} has it too.`);
    for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session)) line(l);
    return result === 'exists' ? 'exists' : 'created';
  };

  /** `up` with manager.autostart: the window is made and the command typed; nothing is waited for, and a failure is a line, not the end of `up`. */
  const startManagerForUp = async (ctx: Context): Promise<void> => {
    try {
      const self = deps.selfArgv?.();
      if (!self) throw new AgentctlError('cannot tell how to start the agentctl MCP server for the manager');
      const result = await startManager(ctx, { self, noWait: true });
      if (result.action === 'exists') line(`Manager: already running in window ${ctx.config.session}:${MANAGER_WINDOW} (${MANAGER_STATE_TEXT[result.state]}), left alone.`);
      else line(`Manager: started in window ${ctx.config.session}:${MANAGER_WINDOW}, in ${result.project}. The first time, answer the folder trust and "Enable Remote Control" in that window; agentctl manager --url shows the address.`);
    } catch (e) {
      line(`Manager: not started - ${errorMessage(e).split('\n')[0]}`);
    }
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

  program.command('version').description('Print the installed version (alias of --version).').action(() => line(packageVersion()));

  program.command('guide').description('Read the dispatcher guide and optional project overlay.')
    .option('--project <repo>', 'repository whose .agentctl.yaml supplies guide:')
    .addOption(new Option('--lang <lang>', 'guide language (default config.guide.lang or en)').choices(['en', 'pl']))
    .option('--clip', 'copy the guide to the clipboard').option('--json', 'machine-readable guide with warnings')
    .action(guarded(async (opts: { project?: string; lang?: 'en' | 'pl'; clip?: boolean; json?: boolean }) => {
      if (opts.clip && opts.json) throw new AgentctlError('--json and --clip exclude each other');
      const ctx = contextFor(false, { migrate: false });
      const result = collectGuide(ctx.config, opts);
      if (opts.json) return line(JSON.stringify(result, null, 2));
      if (opts.clip) {
        const copy = await writeClipboard(ctx.runner, result.text);
        if (copy.ok) return line(`Copied the guide to the clipboard (${copy.tool}).`);
        line(copy.error ?? 'Clipboard unavailable');
      }
      deps.stdout(result.text);
    }));

  program.command('capacity').description('Current plan windows, pace, slots, queue, equivalents and seven-day model statistics; no provider selection.')
    .option('--json', 'machine-readable capacity; null means n/d').option('--clip', 'copy the capacity summary')
    .action(guarded(async (opts: { json?: boolean; clip?: boolean }) => {
      if (opts.clip && opts.json) throw new AgentctlError('--json and --clip exclude each other');
      const ctx = contextFor(false, { migrate: false });
      const result = await collectCapacity(ctx);
      if (opts.json) return line(JSON.stringify(result, null, 2));
      const text = renderCapacity(result).join('\n') + '\n';
      if (opts.clip) {
        const copy = await writeClipboard(ctx.runner, text);
        if (copy.ok) return line(`Copied capacity to the clipboard (${copy.tool}).`);
        line(copy.error ?? 'Clipboard unavailable');
      }
      deps.stdout(text);
    }));

  program
    .command('new')
    .description('Start the tasks in a spec file: worktree, setup commands, symlinks, TASK.md, tmux window, agent, prompt.')
    .argument('[file]', 'spec file, or "-" for stdin')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .option('--json', 'machine-readable results and capacity snapshot')
    .option('--reuse', 'use worktrees that already exist instead of failing')
    .addOption(new Option('--agent <agent>', 'run every spec on this provider, translated through the equivalents table').choices([...cliProviders]))
    .option('--no-switch', 'never offer to move a task to the other provider when its limit is full')
    .option('--no-agent', 'only create the worktree, run setup and links; no TASK.md, window or agent')
    .option('--no-wait-trust', 'stop at the folder-trust dialog instead of waiting for you to confirm it (the old behaviour)')
    .option('--clip', 'read the spec from the clipboard; shows a summary and asks y/N first')
    .option('-y, --yes', 'with --clip: do not ask; also skips the question after a "touches" warning')
    .option('--cohort <name>', 'put every task of the file in this cohort (overrides "cohort:" in a spec); without it a task has a cohort only if its spec names one')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; dryRun?: boolean; reuse?: boolean; agent?: AgentName | false; switch?: boolean; waitTrust?: boolean; cohort?: string; json?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun), { silent: Boolean(opts.json) });
        if (!opts.dryRun && !(await confirmDiskStart(ctx, Boolean(opts.yes)))) return;
        const source = opts.clip ? 'clipboard' : (file ?? 'stdin');
        const raws = splitSpecs(await readSpecSource(file, opts.clip), source);
        applyCohortFlag(raws, opts.cohort);
        const specs = raws.map((raw) => resolveSpec(raw, { config: ctx.config }));
        // The state of the plan of each provider the tasks run on, and the hint when the other one has room (it only says so: nothing is switched).
        const pathWarnings = specs.flatMap(spec => reportPathWarnings(ctx.config, spec).map(warning => `WARNING ${spec.task}: ${warning}`));
        const classWarnings = specs.flatMap(spec => (spec.warnings ?? []).map(warning => `WARNING ${spec.task}: ${warning}`));
        if (!opts.json) for (const warning of [...pathWarnings, ...classWarnings]) line(warning);
        const planLines = opts.dryRun || opts.agent === false ? [] : usageSummaryLines(ctx.config, specs.map((s) => (opts.agent && !s.pin ? { ...s, agent: opts.agent } : s)), ctx.runner.now());
        if (opts.clip && !(await confirmAction(ctx, summarizeSpecs(specs, planLines), 'Start?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        // Without the summary of --clip: only what there is to say (a plan that is n/d is not worth a line before every start).
        if (!opts.clip && !opts.json) for (const l of planLines.filter((x) => !/ n\/d/.test(x))) line(l);
        // `touches`: an active task already changes files the new one says it will touch. Printed always; asked y/N with a terminal.
        if (!opts.dryRun && opts.agent !== false) {
          const warnings = await touchWarnings(ctx, specs);
          if (!opts.json) for (const w of warnings) line(`⚠ ${w}`);
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
        let results: NewResult[] = [];
        try {
          results = await newTasks(ctx, specs, options);
        } finally {
          interrupt?.dispose();
        }
        if (overflow.queued.length > 0) {
          const added = await commitQueueAdd(ctx, overflow.queued.map((spec) => ({ raw: raws[spec.index - 1] as RawSpec, spec })), { ...(opts.agent ? { agent: opts.agent } : {}) });
          if (!opts.json) for (const e of added) line(`${e.task}: queued (position ${waiting(readQueue(ctx.config)).findIndex((x) => x.task === e.task) + 1}); it starts when a ${e.agent} window is free${await watchRunning(ctx) ? '' : ' – nothing starts it unless "agentctl watch" runs: agentctl watch --tmux'}`);
        }
        // The session exists now (it may have been created by this very command): mouse and the key back to the board.
        if (!opts.dryRun && !options.noAgent) {
          const nav = describeNavigation(await applyNavigation(ctx), ctx.config.session, true);
          if (!opts.json) for (const l of nav) line(l);
        }
        const capacity = !opts.dryRun && ctx.config.capacity.snapshot && !options.noAgent ? capacitySnapshot(await collectCapacity(ctx), [...results.map((r) => r.effective.agent), ...overflow.queued.map((s) => s.agent)]) : undefined;
        if (opts.json) line(JSON.stringify({ results, queued: overflow.queued.map((s) => s.task), ...(capacity ? { capacity } : {}) }, null, 2));
        else if (capacity) for (const l of snapshotLines(capacity)) line(l);
      }),
    );

  const queue = program
    .command('queue')
    .description('Put the tasks of a spec file in the queue: they start by themselves (while "agentctl watch" runs) when a window of their provider is free. Shows a summary and asks y/N first.')
    .argument('[file]', 'spec file, or "-" for stdin')
    .option('--clip', 'read the spec from the clipboard')
    .addOption(new Option('--agent <agent>', 'run every spec on this provider, translated through the equivalents table (the queue never switches provider by itself)').choices([...cliProviders]))
    .option('-y, --yes', 'do not ask')
    .option('--json', 'machine-readable queued entries and capacity snapshot')
    .option('--cohort <name>', 'put every task of the file in this cohort (overrides "cohort:" in a spec); without it a task has a cohort only if its spec names one')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; agent?: AgentName; cohort?: string; json?: boolean }) => {
        const ctx = contextFor(false, { silent: Boolean(opts.json) });
        const raws = splitSpecs(await readSpecSource(file, opts.clip), opts.clip ? 'clipboard' : (file ?? 'stdin'));
        applyCohortFlag(raws, opts.cohort);
        if (!(await confirmDiskStart(ctx, Boolean(opts.yes)))) return;
        const plan = await planQueueAdd(ctx, raws, { ...(opts.agent ? { agent: opts.agent } : {}) });
        if (!(await confirmAction(ctx, plan.summary, plan.warnings.length > 0 ? 'Add to the queue anyway?' : 'Add to the queue?', Boolean(opts.yes)))) return;
        const added = await commitQueueAdd(ctx, plan.items, { ...(opts.agent ? { agent: opts.agent } : {}) });
        const capacity = ctx.config.capacity.snapshot ? capacitySnapshot(await collectCapacity(ctx), added.map((e) => e.agent)) : undefined;
        if (opts.json) return line(JSON.stringify({ entries: added, ...(capacity ? { capacity } : {}) }, null, 2));
        if (capacity) for (const l of snapshotLines(capacity)) line(l);
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
        if (opts.json || (command.optsWithGlobals() as { json?: boolean }).json) return line(JSON.stringify(views.map((v) => ({ position: v.position, task: v.entry.task, cohort: v.entry.cohort ?? null, status: v.entry.status, agent: v.entry.agent, model: v.entry.model, effort: v.entry.effort, priority: v.entry.priority, condition: v.condition.text, blocked: v.condition.kind === 'blocked', after: v.entry.after, queued: v.entry.queuedAt, error: v.entry.error ?? null })), null, 2));
        for (const l of renderQueueList(views, ctx.runner.now())) line(l);
        for (const v of views.filter((x) => x.condition.kind === 'blocked')) line(`hint: ${v.entry.task} is blocked: agentctl unblock ${v.entry.task} [--drop-after <task>], or agentctl cancel ${v.entry.task}`);
        if (isPaused(ctx.config)) line('The queue is paused: "agentctl queue resume" lets it run again.');
      }),
    );

  queue.command('show').description('Full queued spec, start error and attempts.').argument('<task>', 'task ID or unique prefix').action(guarded(async (task: string) => { const entry = findEntry(contextFor(false, { migrate: false }).config, task); line(JSON.stringify(entry, null, 2)); }));

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
    .option('--all', 'include archived cohorts')
    .action(
      guarded(async (opts: { json?: boolean; all?: boolean }) => {
        const list = (await summarizeCohorts(contextFor(false, { migrate: false }))).filter((c) => opts.all || !c.archived);
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
        const outputs = aggregateOutputs(mine.filter(r => r.report === 'yes').map(r => ({ task: r.task, reviewOf: r.reviewOf, data: { outputs: r.outputs ?? null, outputs_valid: r.outputs_valid ?? false, outputs_partial: r.outputs_partial ?? false, outputs_errors: r.outputs_errors ?? [] } })));
        if (opts.json) return line(JSON.stringify({ ...outputs, cohort: meta.name, created: meta.created || null, note: meta.note ?? null, tasks: mine, queued: cohortEntries(readQueue(ctx.config), meta.name).map((e) => e.task) }, null, 2));
        line(`Cohort ${meta.name}${meta.created ? ` (since ${formatLocalTime(meta.created)})` : ''}${meta.note ? `: ${meta.note}` : ''}`);
        if (mine.length > 0) for (const l of renderStatusTable(mine, 60, { cohort: false })) line(l);
        const queued = await queueStatusLines(ctx, meta.name);
        for (const l of queued) line(l);
        if (mine.length === 0 && queued.length === 0) line('No tasks in it.');
        line(`outputs: ${JSON.stringify(outputs)}`);
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
    .command('archive')
    .description('Hide finished cohorts from the board choice and the default list; their tasks, reports and history stay. Cohorts with active or queued work are never archived. Shows the plan; --yes does it.')
    .argument('[names...]', 'cohort names; case does not matter')
    .option('--older-than <age>', 'every inactive cohort whose last activity is older, like 7d, 12h, 2w')
    .option('--yes', 'archive without asking')
    .action(
      guarded(async (names: string[], opts: { olderThan?: string; yes?: boolean }) => {
        if (names.length === 0 && !opts.olderThan) throw new AgentctlError('name the cohorts to archive, or give --older-than <age> (for example 7d)');
        const ctx = contextFor(false);
        const plan = await planCohortArchive(ctx, { ...(names.length ? { names } : {}), ...(opts.olderThan ? { olderThanMs: parseAge(opts.olderThan) } : {}) });
        for (const a of plan.archive) line(`archive ${a.name} (${a.tasks} task${a.tasks === 1 ? '' : 's'}, last activity ${a.last ? formatLocalTime(a.last) : 'n/d'})`);
        for (const s of plan.skipped) line(`skip ${s.name}: ${s.reason}`);
        if (plan.archive.length === 0) return line('Nothing to archive.');
        if (!opts.yes) return line('Not executed. Run again with --yes to archive; tasks, reports and history stay.');
        line(`Archived: ${(await applyCohortArchive(ctx, plan)).join(', ')}`);
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
    .option('--enter-only <task>', 'paste nothing: show the exact text that an earlier send left in the input field of the task ("nie dostarczono – tekst w polu wpisywania") with a token; refuses any other text')
    .option('--confirm <token>', 'with --enter-only: press Enter if the field is still exactly the text the preview showed')
    .option('--withdraw <task>', 'take back a waiting message of the task: a queued one is removed, one whose delivery already began is marked stale (the agent may already work on it)')
    .option('--entry <id>', 'with --withdraw: the id of the message (a unique prefix is enough; peek lists prompt_queue)')
    .action(
      guarded(async (file: string | undefined, opts: { clip?: boolean; yes?: boolean; dryRun?: boolean; enterOnly?: string; confirm?: string; withdraw?: string; entry?: string }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        if (opts.confirm !== undefined && opts.enterOnly === undefined) throw new AgentctlError('--confirm belongs to --enter-only');
        if (opts.entry !== undefined && opts.withdraw === undefined) throw new AgentctlError('--entry belongs to --withdraw');
        if (opts.withdraw !== undefined) {
          if (file !== undefined || opts.clip || opts.enterOnly) throw new AgentctlError('--withdraw takes a task and nothing else: no file, no --clip, no --enter-only');
          const target = await resolveRunningTask(ctx, opts.withdraw);
          let id = opts.entry;
          if (!id) {
            const waitingFor = promptQueueView(ctx, target.window);
            if (waitingFor.length === 0) throw new AgentctlError(`${target.task}: nothing waits to be withdrawn`, 'prompt_queue in peek/status lists the waiting messages.');
            if (waitingFor.length > 1) throw new AgentctlError(`${target.task}: ${waitingFor.length} messages wait`, `Choose one with --entry: ${waitingFor.map((p) => `${p.id.slice(0, 8)} (${p.state})`).join(', ')}.`);
            id = waitingFor[0]!.id;
          }
          line((await withdrawPrompt(ctx, target.window, id)).message);
          return;
        }
        if (opts.enterOnly !== undefined) {
          if (file !== undefined || opts.clip) throw new AgentctlError('--enter-only takes a task and nothing else: no file, no --clip');
          const target = await resolveRunningTask(ctx, opts.enterOnly);
          const [done] = await submitDrafts(ctx, [{ task: target.task, window: target.window }], opts.confirm ? { token: opts.confirm } : {});
          if (done?.refused || done?.outcome === 'not-delivered' || done?.outcome === 'failed') throw new AgentctlError(`${target.task}: ${done.message}${done.field ? `\nText in the field:\n${done.field.join('\n')}` : ''}`);
          if (done?.outcome === 'ready') {
            line(`Text in the field of ${target.task} (exactly):`);
            for (const text of done.field ?? []) line(`  │ ${text}`);
            line(`Screen: ${done.screenState}. Nothing was pressed. To press Enter for exactly this text: agentctl send --enter-only ${target.task} --confirm ${done.token}`);
          }
          return;
        }
        const items = splitSpecs(await readSpecSource(file, opts.clip), opts.clip ? 'clipboard' : (file ?? 'stdin')).map(resolveSendSpec);
        const summary = items.map((i) => `${i.task}  ->  window ${ctx.config.session}:${i.window}, ${i.prompt.length} characters: ${i.prompt.split('\n')[0]!.slice(0, 80)}`);
        if (opts.clip && !(await confirmAction(ctx, summary, 'Send?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await sendPrompts(ctx, items);
      }),
    );

  program
    .command('answer')
    .description('Choose a numbered option of the menu the agent shows in its window (e.g. Kimi "Run this command? 1. Approve once …"): first a preview of the options with a token, then --confirm with that token sends the digit.')
    .argument('<task>', 'task ID')
    .argument('<option>', 'number of the menu option', (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 99) throw new AgentctlError(`option must be a whole number 1-99 (got "${v}")`);
      return n;
    })
    .option('--confirm <token>', 'send the digit; the token comes from the preview (without it nothing is pressed)')
    .option('--dry-run', 'print what would happen, send nothing')
    .action(
      guarded(async (task: string, option: number, opts: { confirm?: string; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const target = await resolveRunningTask(ctx, task);
        const done = await answerMenu(ctx, target.window, option, opts.confirm ? { token: opts.confirm } : {});
        if (done.outcome === 'refused' || done.outcome === 'failed') throw new AgentctlError(`${target.task}: ${done.message}`);
        if (done.outcome === 'ready') {
          for (const l of done.message.split('\n')) line(l);
          line(`Nothing was pressed. To send ${option} for exactly this menu: agentctl answer ${target.task} ${option} --confirm ${done.token}`);
          return;
        }
        line(`${target.task}: ${done.message}`);
      }),
    );

  program
    .command('status')
    .option('--detail', 'include machine load and free memory')
    .description('Table of tasks: window state, running time, report, last output line.')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown table to the clipboard (to paste at the start of a chat session)')
    .option('--tmux-line', 'one short line for the tmux status bar, like "2⚙ 1✓ 1? 3⧗" (tasks per state, then the tasks in the queue)')
    .option('--all', 'also the hidden, the closed and the cancelled tasks (see "agentctl hide", "agentctl close", "agentctl cancel"), archived ones included')
    .option('--cohort <name>', 'only the tasks of this cohort (also with --json and --clip)')
    .action(
      guarded(async (opts: { detail?: boolean; json?: boolean; clip?: boolean; tmuxLine?: boolean; all?: boolean; cohort?: string }) => {
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
        if (opts.detail) line(machineLine(collectMachine(ctx.config)));
        line(diskLine(await collectDisk(ctx)));
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

  const limits = program
    .command('limits')
    .description('The limits of simultaneous agents per provider and what uses them up: agentctl windows, places reserved for agents you started by hand, and (limits.count_external) claude/codex sessions found in other terminals. Without a subcommand: show.');

  limits
    .command('show', { isDefault: true })
    .description('Per provider: limit, places used, free places, the windows of agentctl, the reserved and the external ones, and the tasks waiting in the queue.')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (opts: { json?: boolean }) => {
        const ctx = contextFor(false, { migrate: false });
        const report = collectLimits(ctx.config, await liveWindows(ctx));
        if (opts.json) return line(JSON.stringify(report, null, 2));
        for (const l of renderLimits(report)) line(l);
      }),
    );

  limits
    .command('set')
    .description('Change the limits in config.yaml (comments and the order of the keys stay; the old file is kept as config.yaml.bak). A running watch and the MCP server pick it up at once; waiting tasks of the queue start at the next tick.')
    .argument('<limits...>', 'claude=3 codex=5; off disables a provider (codex=off: no windows of it start), 0 or none removes a limit (codex=0)')
    .option('-y, --yes', 'do not ask')
    .option('--dry-run', 'print what would be written, change nothing')
    .action(
      guarded(async (assignments: string[], opts: { yes?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun), { migrate: false });
        const plan = planSetLimits(ctx.config, parseAssignments(assignments, activeProviders(ctx.config)));
        if (!(await confirmAction(ctx, plan.summary, 'Write it?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await applySetLimits(ctx, plan);
        if (!opts.dryRun) line('Done. The limits are in force now.');
      }),
    );

  limits
    .command('reserve')
    .description('Hold places for agents you start by hand (they count against the limit, so the queue leaves room for them). Several reservations add up; "limits release" gives them back.')
    .argument('<places...>', 'claude=1 codex=2 (a bare provider name means 1)')
    .option('--note <text>', 'what the place is for (shown by "limits")')
    .action(
      guarded(async (places: string[], opts: { note?: string }) => {
        const ctx = contextFor(false, { migrate: false });
        const reservations = await reservePlaces(ctx, parseCounts(places, 1, activeProviders(ctx.config)), opts.note);
        line(`Reserved: ${Object.entries(reservations).map(([a, r]) => `${a} ${r.count}${r.note ? ` (${r.note})` : ''}`).join(', ')}`);
      }),
    );

  limits
    .command('release')
    .description('Give reserved places back: claude=1 releases one, a bare provider name releases all of its places.')
    .argument('<places...>', 'claude=1 or claude (all of its places)')
    .action(
      guarded(async (places: string[]) => {
        const ctx = contextFor(false, { migrate: false });
        const reservations = await releasePlaces(ctx, parseCounts(places, undefined, activeProviders(ctx.config)));
        const left = Object.entries(reservations).map(([a, r]) => `${a} ${r.count}`).join(', ');
        line(left === '' ? 'Nothing is reserved now.' : `Still reserved: ${left}`);
      }),
    );

  program
    .command('events')
    .description('What changed since the last time: reports that became ready (with the verdict), starts from the queue, questions, folder trust, blocked, cancelled and limited tasks, finished cohorts, plan thresholds, changed limits - then a line with the state now. Needs "agentctl watch" for what it sees (the journal is written by watch and by the commands). Each client (cli, mcp) has its own "last" marker.')
    .option('--since <time>', 'last (default: since this client looked), an age (30m, 2h, 1d), HH:MM (the latest past occurrence; still ahead today means yesterday) or an ISO time')
    .option('--cohort <name>', 'only the events and tasks of this cohort')
    .option('--keep', 'do not move the "last" marker of the cli client')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown text to the clipboard (to paste at the start of a chat)')
    .action(
      guarded(async (opts: { since?: string; cohort?: string; keep?: boolean; json?: boolean; clip?: boolean }) => {
        if (opts.json && opts.clip) throw new AgentctlError('--json and --clip exclude each other');
        const ctx = contextFor(false, { migrate: false });
        const report = await collectEvents(ctx, { client: 'cli', since: opts.since, cohort: opts.cohort, keep: Boolean(opts.keep) || Boolean(opts.clip) });
        if (opts.json) return line(JSON.stringify(report, null, 2));
        if (opts.clip) {
          const md = eventsMarkdown(report);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the events to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the text:`);
          return deps.stdout(md);
        }
        for (const l of renderEvents(report)) line(l);
      }),
    );

  program
    .command('usage')
    .description('Token usage of the tasks and the state of the plans: per provider the limit used (5 h and weekly window, with the reset) and the tokens today and in the period, the active tasks with their tokens, the cohorts. What a provider does not tell is n/d.')
    .option('--cohort <name>', 'only the tasks of this cohort')
    .option('--since <age>', 'period of the token columns, whole days back: 12h, 7d, 2w (default 7d)')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown table to the clipboard (to paste at the start of a chat session)')
    .action(
      guarded(async (opts: { cohort?: string; since?: string; json?: boolean; clip?: boolean }) => {
        if (opts.json && opts.clip) throw new AgentctlError('--json and --clip exclude each other');
        const ctx = contextFor(false, { migrate: false });
        const cohort = opts.cohort === undefined ? undefined : findCohort(ctx.config, opts.cohort).name;
        const report = await collectUsage(ctx, { cohort, since: opts.since });
        if (opts.json) return line(JSON.stringify(report, null, 2));
        if (opts.clip) {
          const md = usageMarkdown(report);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the usage to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the table:`);
          return deps.stdout(md);
        }
        for (const l of renderUsage(report)) line(l);
      }),
    );

  program
    .command('resume')
    .description('After a restart (the Mac, the tmux server): make the window again for active tasks that have a worktree and no window, and start the agent in resume mode - Claude with --resume <session> or --continue, Codex with "resume <session>" or "resume --last" - with the same model, effort, flags, event hooks and usage tap, without pasting the prompt again. Tasks whose report is ready are left alone unless --all. Shows the list and asks y/N first.')
    .argument('[tasks...]', 'task IDs; a unique prefix is enough. Default: every task that can be resumed')
    .option('--all', 'also tasks that already have a report')
    .option('-y, --yes', 'do not ask')
    .option('--dry-run', 'print the commands that would run, execute nothing')
    .action(
      guarded(async (typed: string[], opts: { all?: boolean; yes?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun));
        const plan = await planResume(ctx, typed, { all: Boolean(opts.all) });
        if (plan.items.length === 0) {
          for (const l of plan.summary) line(l);
          return;
        }
        if (!(await confirmAction(ctx, plan.summary, 'Resume?', Boolean(opts.yes) || Boolean(opts.dryRun)))) return;
        await resumeTasks(ctx, plan, { self: deps.selfArgv?.() });
        line(`attach with: ${attachHint(ctx.config)}`);
      }),
    );

  program
    .command('up')
    .description('Start of the day: make sure the watcher and the board run in the agentctl session (never a second copy; with manager.autostart the manager too), say which tasks can be resumed, and go to the board (attach, or switch inside tmux). Without a terminal it only prints the command to attach.')
    .option('--no-attach', 'do not go to the board; print the command')
    .action(
      guarded(async (opts: { attach?: boolean }) => {
        const ctx = contextFor(false);
        await startWatchWindow(ctx, true);
        await startBoardWindow(ctx);
        if (ctx.config.manager.autostart) await startManagerForUp(ctx);
        const resumable = await findResumable(ctx);
        if (resumable.length > 0) line(`${resumable.length} task${resumable.length === 1 ? '' : 's'} to resume (${resumable.map((r) => r.task).join(', ')}): agentctl resume`);
        const command = `${attachHint(ctx.config)} \\; select-window -t ${BOARD_WINDOW}`;
        if (opts.attach === false || !deps.stdinIsTTY) return line(`Open the board: ${command}`);
        await showWindow(ctx, BOARD_WINDOW, deps.insideTmux ?? false);
      }),
    );

  program
    .command('mark')
    .description('Record the result the user judged. Multiple tasks require a preview and confirmation.')
    .argument('<taskOrResult>', 'task ID, or result when --cohort is used')
    .argument('[result]', 'ok, partial or fail')
    .option('--cohort <name>', 'mark every task in this cohort')
    .option('--note <text>', 'why (optional)')
    .option('-y, --yes', 'confirm the displayed batch')
    .action(guarded(async (taskOrResult: string, value: string | undefined, opts: { cohort?: string; note?: string; yes?: boolean }) => {
      const ctx = contextFor(false, { migrate: false });
      const result = parseResult(opts.cohort ? taskOrResult : value ?? '');
      if (opts.cohort && value) throw new AgentctlError('with --cohort give only the result');
      const tasks = planMark(ctx, opts.cohort ? { cohort: opts.cohort } : { task: taskOrResult });
      if (tasks.length > 1) {
        line(`Would mark ${tasks.join(', ')}: ${result}${opts.note ? ` – ${opts.note}` : ''}`);
        if (!opts.yes && (!ctx.confirm || !await ctx.confirm('Apply these marks? [y/N] '))) { line('Not executed. Re-run with --yes to confirm this batch.'); return; }
      }
      for (const r of await markTasks(ctx, tasks, result, opts.note)) line(`${r.task}: ${r.result}${r.previous && r.previous !== r.result ? ` (was ${r.previous})` : ''}`);
    }));

  program.command('dataset').description('Read-only benchmark datasets').command('export')
    .description('Export one record per known task attempt; no content by default')
    .option('--since <time>', 'inclusive attempt start: ISO time or age (7d)')
    .option('--until <time>', 'inclusive attempt start: ISO time or age')
    .option('--cohort <name>', 'cohort filter')
    .option('--agent <provider>', 'resolved provider filter')
    .option('--out <file>', 'create a new export file (never overwrite existing files)')
    .option('--format <format>', 'jsonl or csv', 'jsonl')
    .option('--include-prompts', 'include redacted prompt text (JSONL only)')
    .option('--include-reports', 'include redacted report text (JSONL only)')
    .action(guarded(async (opts: DatasetOptions) => {
      const ctx = contextFor(false, { migrate: false, silent: true });
      validateDatasetOptions(opts, ctx.runner.now());
      // Exclusive creation protects state/history/report files, including symlink aliases.
      const fd = opts.out ? fs.openSync(opts.out, 'wx', 0o600) : undefined;
      try { await exportDataset(ctx, opts, chunk => { if (fd !== undefined) fs.writeSync(fd, chunk); else deps.stdout(chunk); }); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }));

  program
    .command('log')
    .description('The history of the tasks: when, agent/model/effort, how long, tokens, progress, the result you marked and the verdict of the report. One line per task, newest first.')
    .option('--since <age>', 'only tasks with something new within this age: 12h, 7d, 2w')
    .option('--cohort <name>', 'only the tasks of this cohort')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown table to the clipboard')
    .action(
      guarded(async (opts: { since?: string; cohort?: string; json?: boolean; clip?: boolean }) => {
        if (opts.json && opts.clip) throw new AgentctlError('--json and --clip exclude each other');
        const ctx = contextFor(false, { migrate: false });
        const cohort = opts.cohort === undefined ? undefined : findCohort(ctx.config, opts.cohort).name;
        const rows = selectHistory(ctx, { since: opts.since, cohort });
        if (opts.json) return line(JSON.stringify(rows, null, 2));
        line(diskLine(await collectDisk(ctx)));
        if (opts.clip) {
          const md = logMarkdown(rows);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the log of ${rows.length} task${rows.length === 1 ? '' : 's'} to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the table:`);
          return deps.stdout(md);
        }
        for (const l of renderLog(rows)) line(l);
      }),
    );

  program
    .command('stats')
    .description('Which model and effort work: the tasks of the history grouped by agent/model/effort - how many, median time and tokens, the share of ok, partial and fail (agentctl mark), cancelled ones and tasks moved to the other provider after a limit.')
    .option('--since <age>', 'only tasks with something new within this age: 30d, 2w (default: all)')
    .option('--cohort <name>', 'only the tasks of this cohort')
    .option('--json', 'machine-readable output')
    .option('--clip', 'copy a compact Markdown table to the clipboard')
    .action(
      guarded(async (opts: { since?: string; cohort?: string; json?: boolean; clip?: boolean }) => {
        if (opts.json && opts.clip) throw new AgentctlError('--json and --clip exclude each other');
        const ctx = contextFor(false, { migrate: false });
        const cohort = opts.cohort === undefined ? undefined : findCohort(ctx.config, opts.cohort).name;
        const groups = computeStats(selectHistory(ctx, { since: opts.since, cohort }));
        if (opts.json) return line(JSON.stringify(groups, null, 2));
        if (opts.clip) {
          const md = statsMarkdown(groups);
          const copy = await writeClipboard(ctx.runner, md);
          if (copy.ok) return line(`Copied the stats to the clipboard (${copy.tool}), ${md.length} characters.`);
          line(`${copy.error}; here is the table:`);
          return deps.stdout(md);
        }
        for (const l of renderStats(groups)) line(l);
      }),
    );

  program
    .command('gc')
    .description('Bez flag = podgląd, --apply wykonuje. Take back disk space from finished tasks: the git worktrees of closed, cancelled and archived tasks without uncommitted changes, the files next to their reports that are older than --older-than (the *.md reports stay), their state folders (moved to the archive), and with --branches their branches merged into the base (git branch -d, never -D, never main/master or the current branch). A dry run with sizes unless --apply. History and reports stay; uncommitted work, foreign worktrees and unmerged branches are only listed as skipped.')
    .option('--preview', 'alias of the default preview; changes nothing')
    .option('--dry-run', 'alias of the default preview; changes nothing')
    .option('--verbose', 'full details, paginated with --offset/--limit')
    .option('--offset <n>', 'page offset', '0')
    .option('--limit <n>', 'page size (1–100)', '10')
    .option('--force-links', 'CLI only: allow removing a worktree referenced by links (other protections stay)')
    .option('--apply', 'do it (after showing the list and asking y/N); without it nothing is changed')
    .option('--older-than <age>', 'age of the files next to the reports before they go: 12h, 7d, 2w (default 7d)')
    .option('--branches', 'also delete the branches of finished tasks that are merged into the base (git branch -d)')
    .option('--cohort <name>', 'only the tasks of this cohort')
    .option('-y, --yes', 'with --apply: do not ask')
    .option('--json', 'machine-readable output (the plan, or the result with --apply)')
    .action(
      guarded(async (opts: { preview?: boolean; dryRun?: boolean; verbose?: boolean; offset: string; limit: string; forceLinks?: boolean; apply?: boolean; olderThan?: string; branches?: boolean; cohort?: string; yes?: boolean; json?: boolean }) => {
        const ctx = contextFor(false, { migrate: false });
        if (opts.apply && (opts.preview || opts.dryRun)) throw new AgentctlError("--apply cannot be combined with --preview or --dry-run");
        const view = { detail: Boolean(opts.verbose), offset: Number(opts.offset), limit: Number(opts.limit) };
        if (!Number.isInteger(view.offset) || view.offset < 0 || !Number.isInteger(view.limit) || view.limit < 1 || view.limit > 100) throw new AgentctlError("offset must be >=0 and limit must be 1–100");
        const plan = await planGc(ctx, { olderThan: opts.olderThan, branches: opts.branches, cohort: opts.cohort, forceLinks: opts.forceLinks });
        if (!opts.apply) {
          if (opts.json) return line(JSON.stringify(gcView(plan, view), null, 2));
          for (const l of renderGc(plan, view)) line(l);
          return;
        }
        if (plan.items.length === 0) return opts.json ? line(JSON.stringify({ plan, done: [], failed: [], freedBytes: 0 }, null, 2)) : void renderGc(plan).forEach(line);
        if (!(await confirmAction(ctx, renderGc(plan), 'Clean up?', Boolean(opts.yes)))) return;
        const result = await applyGc(ctx, plan);
        const freed = await refreshDiskAfterGc(ctx, result.freedBytes);
        if (opts.json) return line(JSON.stringify({ plan, ...result }, null, 2));
        for (const l of renderGc(plan, { ...view, applied: result })) line(l);
        if (freed) line(freed);
        if (result.failed.length > 0) exitCode = 1;
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
    .option('--restart', 'with --tmux: restart the window identified by its stable role')
    .option('--no-status-line', 'with --tmux: leave the status bar of the session alone')
    .action(
      guarded(async (opts: { tmux?: boolean; statusLine?: boolean; restart?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.tmux) {
          if (opts.restart) await ctx.tmux.killRole('watch');
          await startWatchWindow(ctx, opts.statusLine !== false);
          return;
        }
        const interrupt = deps.interruptSignal?.();
        try {
          const note = await loggedRun(startLogPath(ctx.config, 'watch'), 'watch', async () => {
            const notifier = await makeNotifier(ctx);
            const self = deps.selfArgv?.();
            await runWatch(ctx, notifier, { insideTmux: deps.insideTmux, ...(interrupt ? { signal: interrupt.signal } : {}), ...(self ? { self } : {}), configStore: new ConfigStore(deps.loadConfig, ctx.config), remakeNotifier: () => makeNotifier(ctx) });
          });
          if (note && !interrupt?.signal.aborted) throw new AgentctlError(note);
        } catch (e) {
          await (await makeNotifier(ctx)).notify('agentctl', `watch failed: ${errorMessage(e).split('\n')[0]}; restart: agentctl watch --tmux --restart`).catch(() => undefined);
          throw e;
        } finally {
          interrupt?.dispose();
        }
      }),
    );

  program
    .command('board')
    .description(`Full-screen overview of the tasks: state, progress, a live preview of the selected window, and keys to switch to it, message, interrupt, pull and close.`)
    .option('--restart', 'with --tmux: restart the window identified by its stable role')
    .option('--tmux', `open it in window "${BOARD_WINDOW}" of the agentctl session (created if missing) instead of here`)
    .action(
      guarded(async (opts: { tmux?: boolean; restart?: boolean }) => {
        const ctx = contextFor(false);
        if (opts.tmux) {
          if (opts.restart) await ctx.tmux.killRole('board');
          await startBoardWindow(ctx);
          line(`Open it: ${attachHint(ctx.config)} \\; select-window -t ${BOARD_WINDOW}   (inside tmux: ${tmuxCommand(ctx.config, ['select-window', '-t', `=${ctx.config.session}:${BOARD_WINDOW}`])})`);
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
    .command('report')
    .description('Where the report of a task is: the canonical path (the first "report:" entry) and, when the agent wrote it elsewhere, the source it was copied from. Without --from it also shows what the search finds now (the last lines of the window, the "report:" list); with --from <path> that file becomes the source and is copied to the canonical path (not over a report the agent wrote, unless --force).')
    .argument('<task>', 'task ID')
    .option('--from <path>', 'use this file as the report (absolute, ~/ or relative to the worktree)')
    .option('--force', 'with --from: replace a canonical report that the agent wrote')
    .option('--json', 'print JSON')
    .option('--dry-run', 'with --from: copy nothing')
    .action(
      guarded(async (task: string, opts: { from?: string; force?: boolean; json?: boolean; dryRun?: boolean }) => {
        if (opts.force && !opts.from) throw new AgentctlError('--force only works together with --from');
        const info = await reportInfo(contextFor(Boolean(opts.dryRun)), task, { from: opts.from, force: opts.force });
        if (opts.json) return line(JSON.stringify(info, null, 2));
        line(`${info.task}: report ${info.canonical} (${info.canonicalExists ? 'exists' : 'missing'})`);
        if (info.source) line(`  copied from ${info.source}`);
        if (info.result) {
          const r = info.result;
          line(r.action === 'none' || r.action === 'kept' ? `  nothing copied${r.note ? `: ${r.note}` : ''}` : `  ${r.action}${opts.dryRun ? ' (dry run)' : ''} from ${r.source}`);
        } else if (info.candidates.length === 0) line('  the search finds no other report (a .md file named in the last lines of the window or in the "report:" list, written after the task started)');
        else {
          for (const c of info.candidates) line(`  found: ${shortPath(c.file)} (${c.why})`);
          line(`  agentctl report ${info.task} --from ${shortPath(info.candidates[0]?.file ?? '')}   # use the first`);
        }
      }),
    );

  const away = program
    .command('away')
    .description('Away mode: the phone (ntfy) gets the notifications only while away is on; the notifications on the Mac do not depend on it. notify.ntfy.always: true sends always, away.auto_idle turns it on by itself when the Mac is idle. Without a subcommand: status.');

  away
    .command('status', { isDefault: true })
    .description('Is away on, who set it, and does the phone get notifications now.')
    .option('--json', 'machine-readable output')
    .action(
      guarded(async (opts: { json?: boolean }) => {
        const ctx = contextFor(false, { migrate: false });
        const report = awayReport(ctx.config);
        if (opts.json) return line(JSON.stringify(report, null, 2));
        for (const l of renderAway(report)) line(l);
      }),
    );

  for (const on of [true, false]) {
    away
      .command(on ? 'on' : 'off')
      .description(on ? 'Away: the notifications go to the phone as well. Takes effect at once, also in a running watch.' : 'Back at the Mac: the phone is quiet again (unless notify.ntfy.always is true).')
      .action(
        guarded(async () => {
          const ctx = contextFor(false, { migrate: false });
          const { state, changed } = await setAway(ctx, on, 'cli');
          line(changed ? `away ${state.on ? 'on' : 'off'}` : `away was already ${state.on ? 'on' : 'off'}`);
          if (on && !ctx.config.notify.ntfy?.topic) line('Note: no phone is set up yet - run "agentctl ntfy-setup".');
        }),
      );
  }

  const manager = program
    .command('manager')
    .description('The manager: a Claude Code session in window "manager" of the agentctl session, started with Remote Control, so you can talk to it from the Claude app on your phone. It has the agentctl MCP tools (status, reports; it starts more work only after your yes) and a role file generated in <config dir>/manager/ - the project it runs in is not changed. Never a second copy. The first time, Claude Code asks in that window for the folder trust and "Enable Remote Control": answer there.')
    .option('--name <name>', 'the name of the session in the Claude app (default: manager.name, "agentctl manager")')
    .option('--project <dir>', 'the directory the session runs in (default: manager.project, else the current directory)')
    .option('--model <model>', 'model of the session (default: manager.model, sonnet)')
    .addOption(new Option('--effort <level>', 'effort of the session (default: manager.effort, medium)').choices([...EFFORTS]))
    .option('--url', 'only print the address of the session and the QR code, if the window shows them')
    .option('--dry-run', 'print the commands that would run, change nothing')
    .action(
      guarded(async (opts: { name?: string; project?: string; model?: string; effort?: Effort; url?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun), { migrate: false });
        if (opts.url) {
          const address = await managerAddress(ctx);
          if (address.view.state === 'missing') throw new AgentctlError('the manager is not running', 'Start it: agentctl manager');
          if (address.url) line(address.url);
          for (const l of address.qr) line(l);
          if (!address.url && address.qr.length === 0) {
            line(`The address is not on the screen of window ${ctx.config.session}:${MANAGER_WINDOW}. In that window type /remote-control: it shows the address and a QR code. Or open the Claude app on the phone, tap Code, and pick the session "${address.view.name}" (a computer icon, a green dot).`);
          }
          return;
        }
        const self = deps.selfArgv?.();
        if (!self) throw new AgentctlError('cannot tell how to start the agentctl MCP server for the manager', 'Run agentctl from its installed command.');
        const interrupt = opts.dryRun ? undefined : deps.interruptSignal?.();
        let result;
        try {
          result = await startManager(ctx, { project: opts.project, name: opts.name, model: opts.model, effort: opts.effort, self, ...(interrupt ? { signal: interrupt.signal } : {}) });
        } finally {
          interrupt?.dispose();
        }
        if (result.action === 'exists') {
          line(`The manager is already running in window ${ctx.config.session}:${MANAGER_WINDOW}, left alone: ${MANAGER_STATE_TEXT[result.state]}. (agentctl manager stop closes it.)`);
          if (result.state !== 'connected') for (const l of managerAdvice(ctx, result)) line(l);
          return;
        }
        if (opts.dryRun) return;
        line(`The manager "${result.name}" runs in window ${ctx.config.session}:${MANAGER_WINDOW}, in ${result.project}.`);
        for (const l of managerAdvice(ctx, result)) line(l);
        for (const l of describeNavigation(await applyNavigation(ctx), ctx.config.session, true)) line(l);
      }),
    );

  manager
    .command('stop')
    .description('Close the window "manager": the session goes offline in the app (its conversation stays in the history of Claude Code). Nothing else is touched.')
    .action(
      guarded(async () => {
        const ctx = contextFor(false, { migrate: false });
        line((await stopManager(ctx)) === 'stopped' ? `The manager is stopped (window ${ctx.config.session}:${MANAGER_WINDOW} closed).` : 'The manager is not running.');
      }),
    );

  program
    .command('ntfy-setup')
    .description('Set up notifications to a phone through ntfy: makes a random topic (agentctl-<24 hex digits>), writes it to config.yaml (comments and the order of the keys stay; the old file is kept as config.yaml.bak) and prints what to do on the phone. A topic that is already set is kept.')
    .option('--server <url>', 'a ntfy server of your own (default https://ntfy.sh)')
    .option('--regenerate', 'make a new topic although one is set (the phone subscribes again)')
    .option('--show-qr', 'print the subscription link as a QR code (needs the qrencode tool: brew install qrencode)')
    .option('--dry-run', 'print what would be written, change nothing')
    .action(
      guarded(async (opts: { server?: string; regenerate?: boolean; showQr?: boolean; dryRun?: boolean }) => {
        const ctx = contextFor(Boolean(opts.dryRun), { migrate: false });
        const plan = planNtfySetup(ctx.config, { server: opts.server, regenerate: opts.regenerate });
        if (plan.text !== undefined) {
          await writeConfigText(ctx, plan.file, plan.text);
          line(opts.dryRun ? `Would write notify.ntfy.topic to ${plan.file}` : `Topic written to ${plan.file} (notify.ntfy.topic; a copy of the old file: config.yaml.bak)`);
        } else line(`The topic is already set in ${plan.file}; kept (--regenerate makes a new one).`);
        line(`Topic:  ${plan.topic}`);
        line(`Server: ${plan.server}`);
        line('');
        for (const l of setupInstructions(plan.server, plan.topic)) line(l);
        if (opts.showQr) {
          const qr = await renderQr(ctx.runner, subscriptionLink(plan.server, plan.topic));
          line('');
          if (qr) for (const l of qr) line(l);
          else line('No QR code: it needs the qrencode tool (brew install qrencode). Type the topic in the app instead.');
        }
      }),
    );

  program
    .command('notify-test')
    .description('Send one test notification and say which channels carried it, with the result and the time of each: the Mac (terminal-notifier with a click action, or the osascript fallback) and the phone (ntfy, whatever away says). Default: --local.')
    .option('--local', 'the notification on the Mac (the default)')
    .option('--phone', 'the phone through ntfy')
    .option('--all', 'both')
    .action(
      guarded(async (opts: { local?: boolean; phone?: boolean; all?: boolean }) => {
        const ctx = contextFor(false, { migrate: false });
        if (deps.fetch) ctx.fetch = deps.fetch;
        const phone = Boolean(opts.phone || opts.all);
        const local = Boolean(opts.local || opts.all || !phone);
        if (local) {
          const notifier = await makeNotifier(ctx, { retryBroken: true });
          const started = ctx.runner.now();
          const result = (await notifier.notify('agentctl', 'Test powiadomienia agentctl – jeśli to widzisz, kanał działa.', { group: 'agentctl-test' })) as NotifyResult | undefined;
          const ms = ctx.runner.now() - started;
          if (phone) line(`Mac:    ${result ? `${result.channel}  ${result.ok ? 'ok' : 'FAILED'}` : 'sent'}  ${ms} ms`);
          for (const l of describeNotifyResult(result, ctx.config.notify.backend)) line(l);
          if (result && !result.ok) exitCode = 1;
        }
        if (phone) {
          const r = await sendPhoneTest(ctx);
          if (!r.configured) line(`Phone:  not set up - ${r.error}`);
          else line(`Phone:  ntfy  ${r.ok ? `ok  HTTP ${r.status}` : `FAILED  ${r.status > 0 ? `HTTP ${r.status}` : 'no answer'}${r.error && r.status === 0 ? ` (${r.error})` : ''}`}  ${r.ms} ms  (${r.target})`);
          if (!r.ok) exitCode = 1;
          else if (!phoneActive(ctx.config)) line('Note: away is off, so real notifications stay on the Mac (agentctl away on, or notify.ntfy.always: true).');
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
    .addOption(new Option('--agent <agent>', 'agent running in the window').choices([...cliProviders]))
    .option('--model <model>', 'model of the task')
    .addOption(new Option('--effort <effort>', 'effort of the task').choices(['low', 'medium', 'high', 'xhigh', 'max']))
    .option('--dry-run', 'print what would be written, write nothing')
    .action(
      guarded(async (task: string, opts: { report: string; window?: string; worktree?: string; agent?: AgentName; model?: string; effort?: Effort; dryRun?: boolean }) => {
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
    .option('--attempt <id>', 'attempt that owns this hook/session')
    .addOption(new Option('--agent <agent>', 'the agent that reports').choices([...cliProviders]).makeOptionMandatory())
    .addOption(new Option('--kind <kind>', 'claude: which hook called').choices(PROVIDER_IDS.flatMap(id => [...provider(id).events.kinds])))
    .option('--forward-file <path>', 'codex: private JSON file containing the original notify command')
    .option('--forward <json>', 'codex: JSON list, the notify command the user had; run with the same JSON after this one')
    .argument('[payload]', 'the event as JSON (codex puts it here; claude sends it on stdin)')
    .action(async (payload: string | undefined, opts: { task: string; attempt?: string; agent: AgentName; kind?: ClaudeKind; forward?: string; forwardFile?: string }) => {
      // A hook must never break the agent: whatever happens, the exit code stays 0.
      try {
        const config = deps.loadConfig();
        const ctx = new Context(deps.makeRunner(false, line), config, () => {}, deps.confirm);
        const raw = payload ?? (provider(opts.agent).events.payloadFrom === 'stdin' && !deps.stdinIsTTY ? deps.readStdin() : '');
        const forward = opts.forwardFile ? parseJson(fs.readFileSync(opts.forwardFile, 'utf8')) : opts.forward ? parseJson(opts.forward) : undefined;
        const notifier = await makeNotifier(ctx);
        const self = deps.selfArgv?.();
        await handleEvent(ctx, new Alerts(ctx, notifier, { self }), {
          task: opts.task,
          attempt: opts.attempt,
          agent: opts.agent,
          kind: opts.kind,
          payload: parseJson(raw),
          rawPayload: provider(opts.agent).events.payloadFrom === 'argv' ? raw : undefined,
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
    .option('--attempt <id>', 'attempt that owns this statusLine session')
    .option('--forward <command>', 'your own statusLine command: run with the same input after this one')
    .action(async (opts: { task: string; attempt?: string; forward?: string }) => {
      // A status line must never break the agent: whatever happens, the exit code stays 0.
      try {
        const config = deps.loadConfig();
        const runner = deps.makeRunner(false, () => {});
        const raw = deps.stdinIsTTY ? '' : deps.readStdin();
        const result = await handleTap(runner, config, { task: opts.task, attempt: opts.attempt, window: windowName(opts.task), raw, ...(opts.forward ? { forward: opts.forward } : {}) });
        if (result.output !== '') deps.stdout(result.output);
      } catch (e) {
        deps.stderr(`agentctl usage-tap: ${errorMessage(e)}\n`);
      }
    });

  program
    .command('move')
    .description('Hand a task that hit its usage limit to the other provider: new window <task>-2 in the same worktree, the original prompt plus a note to continue. Asks y/N.')
    .argument('<task>', 'task ID')
    .addOption(new Option('--agent <agent>', 'move to this provider (default: the other one)').choices([...cliProviders]))
    .option('-y, --yes', 'do not ask')
    .action(
      guarded(async (task: string, opts: { agent?: AgentName; yes?: boolean }) => {
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
        // The file is read again when its text changes; one that does not load leaves the previous settings in force (and `status` says so).
        const store = new ConfigStore(deps.loadConfig);
        const contextAt = (out: (line: string) => void): Context => {
          const r = store.refresh();
          const config = r.config;
          noteConfigState(configStatePath(config), 'mcp', Date.now(), r.error ?? (config.reloadWarning ? config.reloadWarning : undefined));
          return new Context(deps.makeRunner(false, () => {}), config, out);
        };
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
