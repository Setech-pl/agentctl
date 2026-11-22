import { prepareRemoteTask, installRemoteHooks } from './host-task.ts';
import { remoteAttachHint } from './host-runtime.ts';
import { providerHolds, providerHoldText } from './provider-hold.ts';
import { freshTaskDiskStartHold } from './disk.ts';
import { cloneTaskNodeModules, hasNpmLockfile, nodeModulesEvent, setupNodeModules } from './node-modules-store.ts';
import { assertWorktreeVolumes, missingWorktreeVolume, WorktreeVolumeError } from './worktree-volume.ts';
import { peakHold } from './peak.ts';
import { protectReadOnly } from './read-only.ts';
import { assertCheckoutNotBorrowed, readonlyReviewEnvironment, readonlyReviewEvidence, readonlyReviewRepos } from './readonly-review.ts';
import { assertCandidateCheckout, assertReviewBase } from './review-freshness.ts';
import { attachHint } from './tmux-socket.ts';
import { writeLaunchScript } from './launch-script.ts';
import { launchEnvironment } from './safety.ts';
import { withStartLock, reserveStarts, releaseStarts } from './start-lock.ts';
import { queuePrompt, deliverPendingPrompt, DELIVERY_WARNING } from './prompt-delivery.ts';
import fs from 'node:fs';
import path from 'node:path';
import { buildAgentArgv, INSTALL_HINTS, promptWithHeader } from './agents.ts';
import type { Context } from './context.ts';
import type { Order } from './equivalents.ts';
import { touchCohort } from './cohort.ts';
import { planEventWiring } from './events.ts';
import type { SelfArgv } from './events.ts';
import { providerCommand } from './providers/registry.ts';
import { addWorktree } from './git.ts';
import { applyLinks, checkLinkTargets, planLinks } from './links.ts';
import { planBatch } from './plan.ts';
import type { PlanOptions } from './plan.ts';
import { waitForReady } from './ready.ts';
import { saveStartFailureScreen } from './start-failure.ts';
import { RC_CONFIRM, RC_FIRST_TIME } from './remote-control.ts';
import type { ResolvedSpec } from './spec.ts';
import { recordFromSpec, renderTaskMd, readTaskRecord, setHeaderField, setHeaderFields, taskDir, taskFile } from './taskstore.ts';
import { assertAgentSpawnAllowed, openAgentWindow } from './window-guard.ts';
import { AgentctlError, errorMessage } from './util.ts';
import { taskWallContext } from './wall.ts';
import { recordJournal } from './journal.ts';
import { secretRedactor } from './secret-redaction.ts';
import { writeSetupProgress } from './setup-progress.ts';
import type { SetupProgress } from './setup-progress.ts';

const guardRequest = (spec: ResolvedSpec) => ({ host: spec.host, task: spec.task, window: spec.window, report: spec.report, reportAlt: spec.reportAlt, repos: spec.repos, reviewOf: spec.reviewOf, reviewOfAll: spec.reviewOfAll, reviewMode: spec.reviewMode, autoReview: spec.autoReview });

export interface NewOptions extends PlanOptions {
  /** Wait for a human to answer the folder-trust dialog (default). `false` (--no-wait-trust): stop at the dialog. */
  waitTrust?: boolean;
  /** `--no-agent`: stop after worktree, setup and links; no TASK.md, no tmux window, no agent. */
  noAgent?: boolean;
  /** Ctrl-C: ends the wait for the agent without closing its window. */
  signal?: AbortSignal;
  /** This very agentctl as a command line (absolute node and script): the agents report their events to it. Absent: no event wiring. */
  self?: SelfArgv | undefined;
  /** Who asks for the window; `move` makes a refusal of an old review record say so. */
  origin?: 'move';
  /** A start nobody waits for (the watcher's): write the progress (`setup.json`) for status and queue_list and journal "setup started" / "setup failed". */
  trackStart?: boolean;
}

export interface NewResult {
  task: string;
  window: string;
  agentCommand: string;
  worktrees: string[];
  /** False with `--no-agent`. */
  agentStarted: boolean;
  warning?: string;
  requested: Order;
  effective: Order;
  switchedBy?: 'flag' | 'limit';
}

async function requireTool(ctx: Context, tool: string, args: string[], hint?: string): Promise<string> {
  const r = await ctx.runner.exec(tool, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${tool} not found or not working`, hint);
  return r.stdout.trim().split('\n')[0] || 'unknown';
}

const SETUP_TAIL_LINES = 15;

/**
 * Run the `setup` commands of every repository in its own worktree (the spec's `repos[].setup`, else the repository's .agentctl.yaml; the first
 * repository also takes the spec's/global `setup`), logging to `<state_dir>/<task>/setup.log`. A failure stops `new`.
 */
async function runSetup(ctx: Context, spec: ResolvedSpec, prepared: Map<string, ResolvedSpec['repos']>, track?: (step: Omit<SetupProgress, 'task' | 'startedAt' | 'stepAt'>) => Promise<void>): Promise<void> {
  const { runner, config } = ctx;
  const logFile = path.join(taskDir(config, spec.window), 'setup.log');
  const todo = [];
  for (const repo of spec.repos) {
    let commands = repo.setup ?? [];
    let cloneOnly = false;
    if (repo.nodeModules === 'clone' && spec.host && !runner.dryRun) await nodeModulesEvent(ctx, spec.task, repo, 'unsupported', 0, `SSH host ${spec.host}`);
    if (!repo.setup && (repo.nodeModules === 'clone' || spec.setupFromTask) && !spec.host && hasNpmLockfile(repo.worktree)) {
      commands = ['npm ci'];
      cloneOnly = repo.nodeModules !== 'clone';
    }
    if (commands.length) todo.push({ repo, commands, cloneOnly });
  }
  if (todo.length === 0) return;
  const redact = secretRedactor([config, spec.env, process.env, todo.map(item => item.commands)]);
  if (!runner.dryRun) await runner.writeFile(logFile, '');
  for (const [repoIndex, { repo, commands, cloneOnly }] of todo.entries()) {
    const name = path.basename(repo.path);
    for (const [i, command] of commands.entries()) {
      if (!spec.host && !runner.dryRun) assertWorktreeVolumes([repo], spec.task);
      const label = cloneOnly ? `clone node_modules from task ${spec.setupFromTask}` : redact(command);
      ctx.info(`${spec.task}: setup ${name} ${i + 1}/${commands.length}: ${label}`);
      await track?.({ phase: 'setup', repo: name, repoIndex: repoIndex + 1, repoCount: todo.length, command: label, commandIndex: i + 1, commandCount: commands.length, log: logFile });
      const setup = { repo: name, repoIndex: repoIndex + 1, repoCount: todo.length, command: label, commandIndex: i + 1, commandCount: commands.length, log: logFile };
      if (track) await recordJournal(ctx, { kind: 'setup-started', task: spec.task, ...(spec.owner ? {owner: spec.owner} : {}), setup, text: `${spec.task}: setup rozpoczęty w ${name} (repo ${repoIndex + 1}/${todo.length}, command ${i + 1}/${commands.length}): ${label}; log: ${logFile}` });
      const install = async () => {
        const r = await (spec.host ? ctx.hosts.forHost(spec.host) : runner).exec('sh', label === command ? ['-c', command] : ['-s'], { cwd: repo.worktree, ...(label === command ? {} : { input: command }), timeoutMs: ctx.config.git.timeoutS * 1000, async: true });
        if (runner.dryRun) return;
        const output = redact(`${r.stdout}${r.stderr}`);
        await runner.appendFile(logFile, `[${name}] $ ${label}\n${output}${output.endsWith('\n') || output === '' ? '' : '\n'}[exit ${r.code}]\n\n`);
        if (r.code !== 0) {
          if (track) await recordJournal(ctx, { kind: 'setup-failed', task: spec.task, ...(spec.owner ? {owner: spec.owner} : {}), setup: { ...setup, exitCode: r.code }, text: `${spec.task}: setup nie powiódł się w ${name} (exit ${r.code}): ${label}; log: ${logFile}; worktree zostaje` });
          const tail = output.trimEnd().split('\n').slice(-SETUP_TAIL_LINES).join('\n');
          throw new AgentctlError(
            `${spec.task}: setup command failed in ${name}${/ETIMEDOUT/i.test(r.stderr) ? ` after ${config.git.timeoutS}s (git.timeout_s; check disk/I/O or increase the timeout)` : ''} (exit ${r.code}): ${label}\n${tail}`,
            `Full output: ${logFile}. The worktree ${repo.worktree} was kept and no window was started; fix the cause and run "agentctl new --reuse" again.`,
          );
        }
      };
      const from = spec.setupFromTask;
      const fromTask = from && !spec.host && await cloneTaskNodeModules(ctx, spec.task, repo, command, from, prepared.get(from));
      const hit = fromTask || (!cloneOnly && (spec.host ? await install() : await setupNodeModules(ctx, spec.task, repo, command, install)));
      if (hit) {
        const source = fromTask ? `task ${from}` : 'store';
        ctx.info(`${spec.task}: ${name}: node_modules clone from ${source}`);
        await runner.appendFile(logFile, `[${name}] $ ${label}\n[node_modules clone from ${source}]\n\n`);
      } else if (cloneOnly && !runner.dryRun) {
        ctx.info(`${spec.task}: ${name}: dependency clone unavailable; no install command configured`);
        await runner.appendFile(logFile, `[${name}] ${label}\n[node_modules clone unavailable; no install command configured]\n\n`);
      }
      if (track) {
        const outcome = hit ? 'node_modules clone' : cloneOnly ? 'clone unavailable' : 'exit 0';
        await recordJournal(ctx, { kind: 'setup-finished', task: spec.task, ...(spec.owner ? {owner: spec.owner} : {}), setup: { ...setup, exitCode: 0 }, text: `${spec.task}: setup zakończony w ${name} (${outcome}): ${label}; log: ${logFile}` });
      }
    }
  }
  ctx.info(`${spec.task}: setup done (${todo.map(({ repo }) => path.basename(repo.path)).join(', ')}), output in ${logFile}`);
}

/** Start every spec: worktree, links, TASK.md, tmux window, agent, prompt. Plans and validates everything first. */
export async function newTasks(ctx: Context, requested: ResolvedSpec[], opts: NewOptions = {}): Promise<NewResult[]> {
  if (ctx.runner.dryRun || opts.noAgent) return startTasks(ctx, requested, opts);
  const admission = await withStartLock(ctx, async () => {
    const specs = await planBatch(ctx, requested, opts);
    for (const spec of specs.filter(s => !s.host)) checkLinkTargets(spec.links.filter(l => !spec.repos.some(r => l.to === r.worktree || l.to.startsWith(`${r.worktree}/`))), spec.task);
    for (const spec of specs) {const hold = providerHolds(ctx.config, ctx.runner.now())[spec.agent]; if (hold) throw new AgentctlError(`provider hold: ${providerHoldText(spec.agent, hold)}`, 'Queue the task or wait for the provider reset.');}
    for (const spec of specs) { const held = peakHold(ctx.config, spec, ctx.runner.now()); if (held) throw new AgentctlError(held, 'Add this task to the queue; it will start after peak.'); }
    for (const spec of specs) {
      if (!spec.host) assertWorktreeVolumes(spec.repos, spec.task, true);
      const held = await freshTaskDiskStartHold(ctx, spec.host, spec.repos);
      if (held?.startsWith('volume missing: ')) throw new WorktreeVolumeError(held.slice(16), spec.task, true);
      if (held) throw new AgentctlError(held, 'Free disk space before starting setup.');
    }
    return { specs, ids: opts.queueReservation ? [] : await reserveStarts(ctx, specs) };
  });
  try { return await startTasks(ctx, admission.specs, opts, true); }
  finally { await releaseStarts(ctx, admission.ids); }
}

async function startTasks(ctx: Context, requested: ResolvedSpec[], opts: NewOptions, admitted = false): Promise<NewResult[]> {
  const { runner, tmux, config } = ctx;

  // Tools needed by the orders as written; the provider may change below, so check both agents the batch could end on.
  if (!runner.dryRun && requested.some(s => !s.host)) {
    if (!opts.noAgent) await requireTool(ctx, 'tmux', ['-V'], INSTALL_HINTS.tmux);
    await requireTool(ctx, 'git', ['--version'], INSTALL_HINTS.git);
  }
  const specs = admitted ? requested : await planBatch(ctx, requested, opts);
  for (const spec of specs.filter(s => !s.host)) checkLinkTargets(spec.links.filter(l => !spec.repos.some(r => l.to === r.worktree || l.to.startsWith(`${r.worktree}/`))), spec.task);
  if (!runner.dryRun && opts.noAgent) for (const spec of specs) {
    if (!spec.host) assertWorktreeVolumes(spec.repos, spec.task, true);
    const held = await freshTaskDiskStartHold(ctx, spec.host, spec.repos);
    if (held?.startsWith('volume missing: ')) throw new WorktreeVolumeError(held.slice(16), spec.task, true);
    if (held) throw new AgentctlError(held);
  }
  const versions: Record<string, string> = {};
  if (!runner.dryRun && !opts.noAgent) {
    for (const agent of new Set(specs.filter(s => !s.host).map((s) => s.agent))) versions[agent] = await requireTool(ctx, providerCommand(config, agent), ['--version'], INSTALL_HINTS[agent]);
  }

  const results: NewResult[] = [];
  const prepared = new Map<string, ResolvedSpec['repos']>();
  let sessionUp = await tmux.hasSession();
  for (const [index, original] of specs.entries()) {
    let spec = original.host ? await prepareRemoteTask(ctx, original, opts.reuse) : original;
    if (spec.reviewMode) {
      const repos = await readonlyReviewRepos(ctx, spec);
      const evidence = readonlyReviewEvidence(ctx, spec.window);
      spec = { ...spec, repos, prompt: `Review in the author's checkout. Leave its files and Git state untouched. Write evidence under ${evidence}.\n\n${spec.prompt}` };
    } else if (!spec.host) await assertCheckoutNotBorrowed(ctx, spec.task);
    const execution = spec.host ? ctx.hosts.forHost(spec.host) : runner;
    const taskTmux = spec.host ? ctx.hosts.tmux(spec.host) : tmux;
    const hint = spec.host ? remoteAttachHint(config, spec)! : attachHint(config);
    if (spec.host) {
      if (!opts.noAgent) await execution.exec('tmux', ['-V'], { readOnly: true }).then(r => { if (r.code !== 0) throw new AgentctlError(`host ${spec.host}: tmux is unavailable`); });
      const cli = await execution.exec(providerCommand(config, spec.agent), ['--version'], { readOnly: true });
      if (!opts.noAgent && cli.code !== 0) throw new AgentctlError(`host ${spec.host}: ${spec.agent} CLI is unavailable`);
      versions[`${spec.host}:${spec.agent}`] = cli.stdout.trim().split('\n')[0] ?? 'unknown';
    }
    // The same check as in the door itself, before the first worktree or file exists.
    assertAgentSpawnAllowed(ctx, { ...guardRequest(spec), origin: opts.origin ?? (spec.autoReview ? 'start' : 'new') });
    spec = await assertReviewBase(ctx, spec);
    if (spec.reviewFreshness) ctx.info(`${spec.task}: ${spec.reviewFreshness}`);
    const taskStartedMs = runner.now();
    const primary = spec.repos[0]!.worktree;

    const startedAt = new Date(taskStartedMs).toISOString();
    const track = opts.trackStart && !runner.dryRun
      ? (step: Omit<SetupProgress, 'task' | 'startedAt' | 'stepAt'>) => writeSetupProgress(ctx, spec.window, { task: spec.task, startedAt, stepAt: new Date(runner.now()).toISOString(), ...step })
      : undefined;

    // 1. worktrees
    await track?.({ phase: 'worktree' });
    try {
      for (const repo of spec.host || spec.reviewMode ? [] : spec.repos) {
        if (!runner.dryRun) assertWorktreeVolumes([repo], spec.task);
        if (opts.reuse && fs.existsSync(repo.worktree)) ctx.info(`${spec.task}: reusing worktree ${repo.worktree}`);
        else {
          await addWorktree(runner, repo, config.git.timeoutS);
          ctx.info(`${spec.task}: worktree ${repo.worktree}`);
        }
        if (spec.mergeBaseCheck === 'candidate') await assertCandidateCheckout(ctx, spec.task, repo);
      }
      if (spec.readOnly) await protectReadOnly(ctx, spec);
      // 2. setup commands, before links because an install may wipe node_modules.
      if (!spec.reviewMode) await runSetup(ctx, spec, prepared, track);
    } catch (error) {
      const missing = error instanceof WorktreeVolumeError ? error.mount : spec.host ? undefined : missingWorktreeVolume(spec.repos);
      if (missing) throw new WorktreeVolumeError(missing, spec.task);
      throw error;
    }
    if (!spec.host && !runner.dryRun) assertWorktreeVolumes(spec.repos, spec.task);
    await track?.({ phase: 'launching' });

    // 3. symlinks (in the primary worktree)
    if (!spec.host) checkLinkTargets(spec.links, spec.task);
    const { ops, warnings } = spec.host ? { ops: [], warnings: [] } : planLinks(spec.links, primary);
    if (spec.host) for (const link of spec.links) {
      const from = path.posix.resolve(primary, link.from);
      if (!from.startsWith(`${primary}/`)) throw new AgentctlError(`${spec.task}: remote link escapes worktree: ${link.from}`);
      const exists = await execution.exec('test', ['-e', link.to], { readOnly: true });
      if (!runner.dryRun && exists.code !== 0) throw new AgentctlError(`${spec.task}: remote link target missing: ${link.to}`);
      const replaceable = await execution.exec('sh', ['-c', 'test -L "$1" || test ! -e "$1"', 'agentctl-link', from], { readOnly: true });
      if (!runner.dryRun && replaceable.code !== 0) throw new AgentctlError(`${spec.task}: remote link would overwrite an existing file/directory: ${from}`);
      await execution.mkdir(path.posix.dirname(from));
      await execution.symlink(link.to, from);
    }
    for (const w of warnings) ctx.info(`${spec.task}: warning: ${w}`);
    await applyLinks(runner, ops);
    if (!spec.host) prepared.set(spec.task, spec.repos);

    if (opts.noAgent) {
      ctx.info(`${spec.task}: --no-agent: worktree ${primary} is ready (setup and links done), no window started`);
      results.push({
        task: spec.task,
        window: spec.window,
        agentCommand: '',
        worktrees: spec.repos.map((r) => r.worktree),
        agentStarted: false,
        requested: spec.requested,
        effective: { agent: spec.agent, model: spec.model, effort: spec.effort },
      });
      continue;
    }

    // 4. TASK.md
    const record = recordFromSpec(spec, config, taskStartedMs);
    if (spec.host) {
      record.session = `agentctl-${spec.host}`;
      record.remoteReport = spec.remoteReport;
      record.remoteDir = spec.remoteDir;
    }
    // `wall:` – the open WALL messages as they are at this start (read-only data in the prompt); a WALL that cannot be read never stops a start.
    let wallContext: string | undefined;
    try { wallContext = spec.wall?.length ? taskWallContext(config, spec.task, spec.wall) : undefined; } catch (e) { ctx.info(`${spec.task}: WALL context left out: ${errorMessage(e)}`); }
    record.agentCliVersion = versions[spec.host ? `${spec.host}:${spec.agent}` : spec.agent] ?? 'unknown';
    // The cohort is made by its first task; a name that exists keeps the spelling it had.
    if (spec.cohort) record.cohort = (await touchCohort(ctx, spec.cohort)).name;
    // The reservation spans checkout/setup; its first TASK snapshot commits under the same global admission lock.
    await withStartLock(ctx, async () => {
      await runner.mkdir(taskDir(config, spec.window));
      await runner.writeFile(taskFile(config, spec.window), renderTaskMd(record, spec.prompt));
      if (spec.host) await ctx.hosts.trackHost(spec.host);
      await queuePrompt(ctx, record, promptWithHeader({ ...spec, report: spec.remoteReport ?? spec.report }, record.attemptId, wallContext), 'launching');
    });
    // The agent's own folder: only the report goes there (agentctl's state is in state_dir).
    await runner.mkdir(path.dirname(spec.report));

    // 4b. the agent reports its own events (question, end of turn, limit) to `agentctl event`
    const wiring = !spec.host && config.notify.events && opts.self ? planEventWiring({ attempt: record.attemptId, agent: spec.agent, task: spec.task, window: spec.window, config, self: opts.self, env: spec.env, worktree: primary }) : undefined;
    for (const file of wiring?.files ?? []) {
      await runner.writeFile(file.path, file.content);
      if (file.path.endsWith('.sh')) {
        const protectedFile = await runner.exec('chmod', ['0700', file.path]);
        if (protectedFile.code !== 0) throw new Error(`Cannot protect event script: ${file.path}`);
      }
    }

    let launchEnv = launchEnvironment(config, spec, spec.env);
    if (spec.reviewMode) launchEnv = await readonlyReviewEnvironment(ctx, spec, launchEnv);
    const remoteArgs = spec.host ? await installRemoteHooks(ctx, spec, record) : undefined;

    const settings = config.agents[spec.agent];
    const commandLine = await writeLaunchScript(execution, spec.remoteDir ?? taskDir(config, spec.window), buildAgentArgv({ ...spec, command: providerCommand(config, spec.agent) }, settings, remoteArgs ?? wiring?.args), launchEnv, !spec.host);
    // 5. window + agent
    const opened = await openAgentWindow(ctx, { ...guardRequest(spec), cwd: primary, env: {}, origin: opts.origin ?? (spec.autoReview ? 'start' : 'new'), sessionUp: spec.host ? await taskTmux.hasSession() : sessionUp });
    if (opened.code !== 0) throw new AgentctlError(`${spec.task}: tmux could not make the window: ${opened.stderr.trim() || `exit ${opened.code}`}`);
    if (!spec.host) sessionUp = true;

    if (spec.owner && !opts.trackStart) await recordJournal(ctx, {kind: 'task-start', task: spec.task, owner: spec.owner, text: `${spec.task}: uruchomiono (${spec.agent})`});
    if (wiring) ctx.info(`${spec.task}: ${wiring.note}`);
    const remote = spec.remoteControl === true;
    // Remote Control asks once to be switched on; like the folder trust that is a dialog for the human.
    const dialog = remote ? 'folder trust or "Enable Remote Control"' : 'folder trust';
    if (remote) ctx.info(`${spec.task}: Remote Control on: the session "${spec.task}" appears in the Claude app (Code). If a dialog comes up, ${RC_FIRST_TIME}`);
    // tmux's own ID of the window: operations keep finding it when `watch` puts a state icon in front of its name.
    const windowId = (await taskTmux.windows()).find((w) => w.plain === spec.window)?.id;
    if (windowId) await setHeaderField(runner, taskFile(config, spec.window), 'window_id', windowId);
    await execution.exec('tmux', ['set-option', '-w', '-t', windowId || tmux.target(spec.window), '@agentctl-role', spec.host ? spec.window : 'task']);
    await taskTmux.typeCommand(spec.window, commandLine);
    ctx.info(`${spec.task}: window ${config.session}:${spec.window} running ${spec.agent} (model ${spec.model}, effort ${spec.effort}) via ${commandLine}`);

    // 6. wait for the agent; never answer a trust dialog (wait for the human to do it); then paste the prompt and press Enter
    const waitTrust = opts.waitTrust !== false;
    const sendHint = `agentctl watch --tmux (original prompt with report protocol is pending in ${taskFile(config, spec.window)}; sent once after trust and ready input)`;
    const ready = await waitForReady(runner, taskTmux, spec.window, {
      pattern: settings.readyPattern,
      emptyInput: true,
      // Kimi included (P92): its box is read by its own geometry, so the paste waits for a whole composer, not for the first "│ >" row.
      structuralComposer: true,
      agent: spec.agent,
      trustPattern: remote ? `${settings.trustPattern}|${RC_CONFIRM}` : settings.trustPattern,
      ...(settings.dialogPattern ? { dialogPattern: settings.dialogPattern } : {}),
      timeoutMs: settings.readyTimeout * 1000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(waitTrust
        ? {
            waitTrust: {
              timeoutMs: settings.trustTimeout * 1000,
              onWaiting: async () => { await setHeaderField(runner, taskFile(config, spec.window), 'prompt_delivery', 'pending'); ctx.info(`${spec.task}: agent waits for ${dialog} – attach: ${hint}, confirm in window ${spec.window}`); },
            },
          }
        : {}),
    });
    const fresh = readTaskRecord(config, spec.window);
    if (fresh?.promptDelivery === 'sent') { ready.ready = true; ready.trust = false; }
    if (fresh?.promptDelivery === 'launching' && (ready.trust || ready.ready)) await setHeaderField(runner, taskFile(config, spec.window), 'prompt_delivery', 'pending');
    if (ready.aborted) {
      const notStarted = specs.slice(index + 1).map((s) => s.task);
      throw new AgentctlError(
        `${spec.task}: interrupted while waiting for the agent; window ${config.session}:${spec.window} stays open, the prompt was not sent` +
          (notStarted.length > 0 ? `, not started: ${notStarted.join(', ')}` : ''),
        `Once the agent shows its input, watch will automatically deliver the original prompt once ready: ${sendHint}`,
      );
    }
    if (ready.trust && waitTrust) {
      throw new AgentctlError(
        `${spec.task}: agent still waits for ${dialog} after ${settings.trustTimeout}s – attach: ${hint}, confirm in window ${spec.window}`,
        `agentctl never answers that dialog. The window stays open and the prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready: ${sendHint}. ` +
          `To wait longer, raise agents.${spec.agent}.trust_timeout in ${config.path}.`,
      );
    }
    if (ready.trust) {
      throw new AgentctlError(
        `${spec.task}: agent waits for ${dialog} – attach: ${hint}, confirm, then agentctl status`,
        `agentctl never answers that dialog. The prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready: ${sendHint}`,
      );
    }
    if (ready.dialog) {
      const capture = await saveStartFailureScreen(ctx, spec.window, windowId);
      const seen = capture ? ` (screen: ${capture})` : '';
      if (spec.agent === 'codex') {
        const which = ' ("Update available": choose "Skip until next version")';
        await setHeaderFields(runner, taskFile(config, spec.window), { prompt_delivery: 'needs-input', prompt_error: `${spec.agent} shows a startup dialog${which}; original prompt remains in TASK.md${seen}` });
        throw new AgentctlError(
          `${spec.task}: ${spec.agent} shows a startup dialog${which} – attach: ${hint}, answer it in window ${spec.window}`,
          `agentctl never answers that dialog. The window stays open and the prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready: ${sendHint}. ` +
            'Task windows start with the startup update check disabled (-c check_for_update_on_startup=false), so a current Codex does not show it.',
        );
      }
      // P95: Claude Code's first-run onboarding (a fresh CLAUDE_CONFIG_DIR: the claude-glm wrapper has its own) is a wait for the owner, not a failed start.
      const line = `${spec.agent} first-run onboarding – finish it once in the window, ${config.board.returnKey ?? 'Ctrl-b l'} back to board`;
      await setHeaderFields(runner, taskFile(config, spec.window), { prompt_delivery: 'needs-input', prompt_error: `${line}; trust and the prompt follow by themselves${seen}` });
      throw new AgentctlError(
        `${spec.task}: ${line} – attach: ${hint}, window ${spec.window}`,
        `agentctl never answers that dialog. The window stays open and the prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready (after the folder-trust dialog, which also waits for you): ${sendHint}.`,
      );
    }
    if (!ready.ready) {
      const capture = await saveStartFailureScreen(ctx, spec.window, windowId);
      const seen = capture ? `; last screen: ${capture}` : '';
      await setHeaderFields(runner, taskFile(config, spec.window), { prompt_delivery: 'needs-attention', prompt_error: `${spec.agent} did not become ready; original prompt remains in TASK.md${seen}` });
      throw new AgentctlError(
        `${spec.task}: ${spec.agent} did not show its input prompt within ${settings.readyTimeout}s (pattern /${settings.readyPattern}/)${seen}`,
        `The window is still open: "${hint}". Once the agent is ready, send the prompt with "agentctl send"; ` +
          `a recognized structural composer is required before any paste; if the prompt looks normal, adjust agents.${spec.agent}.ready_pattern / ready_timeout in ${config.path}.`,
      );
    }
    if (runner.dryRun) await taskTmux.submitPrompt(spec.window, promptWithHeader({ ...spec, report: spec.remoteReport ?? spec.report }, record.attemptId, wallContext));
    const delivery = runner.dryRun ? 'sent' : await deliverPendingPrompt(ctx, spec.window);
    ctx.info(`${spec.task}: ${delivery === 'sent' ? 'prompt sent' : DELIVERY_WARNING + '; watch confirms within delivery_confirm_s; do not repeat new'}`);

    const result: NewResult = {
      task: spec.task,
      window: spec.window,
      agentCommand: commandLine,
      worktrees: spec.repos.map((r) => r.worktree),
      agentStarted: true,
      ...(delivery !== 'sent' ? { warning: DELIVERY_WARNING } : {}),
      requested: spec.requested,
      effective: { agent: spec.agent, model: spec.model, effort: spec.effort },
    };
    if (spec.switchedBy) result.switchedBy = spec.switchedBy;
    results.push(result);
  }
  if (!opts.noAgent && specs.some(s => !s.host)) ctx.info(`attach with: ${attachHint(config)}`);
  return results;
}
