import { queuePrompt, deliverPendingPrompt, DELIVERY_WARNING } from './prompt-delivery.ts';
import fs from 'node:fs';
import path from 'node:path';
import { agentCommandLine, buildAgentArgv, INSTALL_HINTS, promptWithHeader } from './agents.ts';
import type { Context } from './context.ts';
import type { Order } from './equivalents.ts';
import { touchCohort } from './cohort.ts';
import { planEventWiring } from './events.ts';
import type { SelfArgv } from './events.ts';
import { addWorktree } from './git.ts';
import { applyLinks, checkLinkTargets, planLinks } from './links.ts';
import { planBatch } from './plan.ts';
import type { PlanOptions } from './plan.ts';
import { waitForReady } from './ready.ts';
import { RC_CONFIRM, RC_FIRST_TIME } from './remote-control.ts';
import type { ResolvedSpec } from './spec.ts';
import { recordFromSpec, renderTaskMd, readTaskRecord, setHeaderField, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError } from './util.ts';

export interface NewOptions extends PlanOptions {
  /** Wait for a human to answer the folder-trust dialog (default). `false` (--no-wait-trust): stop at the dialog. */
  waitTrust?: boolean;
  /** `--no-agent`: stop after worktree, setup and links; no TASK.md, no tmux window, no agent. */
  noAgent?: boolean;
  /** Ctrl-C: ends the wait for the agent without closing its window. */
  signal?: AbortSignal;
  /** This very agentctl as a command line (absolute node and script): the agents report their events to it. Absent: no event wiring. */
  self?: SelfArgv | undefined;
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

async function requireTool(ctx: Context, tool: string, args: string[]): Promise<string> {
  const r = await ctx.runner.exec(tool, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${tool} not found or not working`, INSTALL_HINTS[tool]);
  return r.stdout.trim().split('\n')[0] || 'unknown';
}

const SETUP_TAIL_LINES = 15;

/** Run the spec's `setup` commands in the primary worktree, logging to `<state_dir>/<task>/setup.log`. A failure stops `new`. */
async function runSetup(ctx: Context, spec: ResolvedSpec, worktree: string): Promise<void> {
  if (spec.setup.length === 0) return;
  const { runner, config } = ctx;
  const logFile = path.join(taskDir(config, spec.window), 'setup.log');
  if (!runner.dryRun) await runner.writeFile(logFile, '');
  for (const [i, command] of spec.setup.entries()) {
    ctx.info(`${spec.task}: setup ${i + 1}/${spec.setup.length}: ${command}`);
    const r = await runner.exec('sh', ['-c', command], { cwd: worktree, timeoutMs: ctx.config.git.timeoutS * 1000, async: true });
    if (runner.dryRun) continue;
    const output = `${r.stdout}${r.stderr}`;
    await runner.appendFile(logFile, `$ ${command}\n${output}${output.endsWith('\n') || output === '' ? '' : '\n'}[exit ${r.code}]\n\n`);
    if (r.code !== 0) {
      const tail = output.trimEnd().split('\n').slice(-SETUP_TAIL_LINES).join('\n');
      throw new AgentctlError(
        `${spec.task}: setup command failed${/ETIMEDOUT/i.test(r.stderr) ? ` after ${config.git.timeoutS}s (git.timeout_s; check disk/I/O or increase the timeout)` : ''} (exit ${r.code}): ${command}\n${tail}`,
        `Full output: ${logFile}. The worktree ${worktree} was kept and no window was started; fix the cause and run "agentctl new --reuse" again.`,
      );
    }
  }
  ctx.info(`${spec.task}: setup done, output in ${logFile}`);
}

/** Start every spec: worktree, links, TASK.md, tmux window, agent, prompt. Plans and validates everything first. */
export async function newTasks(ctx: Context, requested: ResolvedSpec[], opts: NewOptions = {}): Promise<NewResult[]> {
  const { runner, tmux, config } = ctx;

  // Tools needed by the orders as written; the provider may change below, so check both agents the batch could end on.
  if (!runner.dryRun) {
    if (!opts.noAgent) await requireTool(ctx, 'tmux', ['-V']);
    await requireTool(ctx, 'git', ['--version']);
  }
  const specs = await planBatch(ctx, requested, opts);
  for (const spec of specs) checkLinkTargets(spec.links.filter(l => !spec.repos.some(r => l.to === r.worktree || l.to.startsWith(`${r.worktree}/`))), spec.task);
  const versions: Record<string, string> = {};
  if (!runner.dryRun && !opts.noAgent) {
    for (const agent of new Set(specs.map((s) => s.agent))) versions[agent] = await requireTool(ctx, agent, ['--version']);
  }

  const results: NewResult[] = [];
  let sessionUp = await tmux.hasSession();
  for (const [index, spec] of specs.entries()) {
    const taskStartedMs = runner.now();
    const primary = spec.repos[0]!.worktree;

    // 1. worktrees
    for (const repo of spec.repos) {
      if (opts.reuse && fs.existsSync(repo.worktree)) ctx.info(`${spec.task}: reusing worktree ${repo.worktree}`);
      else {
        await addWorktree(runner, repo, config.git.timeoutS);
        ctx.info(`${spec.task}: worktree ${repo.worktree}`);
      }
    }

    // 2. setup commands (in the primary worktree; an install may wipe node_modules, so this comes before the links)
    await runSetup(ctx, spec, primary);

    // 3. symlinks (in the primary worktree)
    checkLinkTargets(spec.links, spec.task);
    const { ops, warnings } = planLinks(spec.links, primary);
    for (const w of warnings) ctx.info(`${spec.task}: warning: ${w}`);
    await applyLinks(runner, ops);

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
    record.agentCliVersion = versions[spec.agent] ?? 'unknown';
    // The cohort is made by its first task; a name that exists keeps the spelling it had.
    if (spec.cohort) record.cohort = (await touchCohort(ctx, spec.cohort)).name;
    await runner.mkdir(taskDir(config, spec.window));
    await runner.writeFile(taskFile(config, spec.window), renderTaskMd(record, spec.prompt));
    await queuePrompt(ctx, record, promptWithHeader(spec, record.attemptId), 'launching');
    // The agent's own folder: only the report goes there (agentctl's state is in state_dir).
    await runner.mkdir(path.dirname(spec.report));

    // 4b. the agent reports its own events (question, end of turn, limit) to `agentctl event`
    const wiring = config.notify.events && opts.self ? planEventWiring({ agent: spec.agent, task: spec.task, window: spec.window, config, self: opts.self, env: spec.env, worktree: primary }) : undefined;
    for (const file of wiring?.files ?? []) await runner.writeFile(file.path, file.content);

    // 5. window + agent
    if (sessionUp) await tmux.newWindow(spec.window, primary, spec.env);
    else {
      await tmux.newSession(spec.window, primary, spec.env);
      sessionUp = true;
    }
    const settings = config.agents[spec.agent];
    const commandLine = agentCommandLine(buildAgentArgv(spec, settings, wiring?.args));
    if (wiring) ctx.info(`${spec.task}: ${wiring.note}`);
    const remote = spec.remoteControl === true;
    // Remote Control asks once to be switched on; like the folder trust that is a dialog for the human.
    const dialog = remote ? 'folder trust or "Enable Remote Control"' : 'folder trust';
    if (remote) ctx.info(`${spec.task}: Remote Control on: the session "${spec.task}" appears in the Claude app (Code). If a dialog comes up, ${RC_FIRST_TIME}`);
    // tmux's own ID of the window: operations keep finding it when `watch` puts a state icon in front of its name.
    const windowId = (await tmux.windows()).find((w) => w.plain === spec.window)?.id;
    if (windowId) await setHeaderField(runner, taskFile(config, spec.window), 'window_id', windowId);
    await runner.exec('tmux', ['set-option', '-w', '-t', windowId || tmux.target(spec.window), '@agentctl-role', 'task']);
    await tmux.typeCommand(spec.window, commandLine);
    ctx.info(`${spec.task}: window ${config.session}:${spec.window} running ${commandLine}`);

    // 6. wait for the agent; never answer a trust dialog (wait for the human to do it); then paste the prompt and press Enter
    const waitTrust = opts.waitTrust !== false;
    const sendHint = `agentctl watch --tmux (original prompt with report protocol is pending in ${taskFile(config, spec.window)}; sent once after trust and ready input)`;
    const ready = await waitForReady(runner, tmux, spec.window, {
      pattern: settings.readyPattern,
      emptyInput: true,
      trustPattern: remote ? `${settings.trustPattern}|${RC_CONFIRM}` : settings.trustPattern,
      timeoutMs: settings.readyTimeout * 1000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(waitTrust
        ? {
            waitTrust: {
              timeoutMs: settings.trustTimeout * 1000,
              onWaiting: async () => { await setHeaderField(runner, taskFile(config, spec.window), 'prompt_delivery', 'pending'); ctx.info(`${spec.task}: agent waits for ${dialog} – attach: tmux attach -t ${config.session}, confirm in window ${spec.window}`); },
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
        `${spec.task}: agent still waits for ${dialog} after ${settings.trustTimeout}s – attach: tmux attach -t ${config.session}, confirm in window ${spec.window}`,
        `agentctl never answers that dialog. The window stays open and the prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready: ${sendHint}. ` +
          `To wait longer, raise agents.${spec.agent}.trust_timeout in ${config.path}.`,
      );
    }
    if (ready.trust) {
      throw new AgentctlError(
        `${spec.task}: agent waits for ${dialog} – attach: tmux attach -t ${config.session}, confirm, then agentctl status`,
        `agentctl never answers that dialog. The prompt was not sent; once the agent shows its input, watch will automatically deliver it once ready: ${sendHint}`,
      );
    }
    if (!ready.ready) {
      await setHeaderField(runner, taskFile(config, spec.window), 'prompt_delivery', 'needs-attention');
      await setHeaderField(runner, taskFile(config, spec.window), 'prompt_error', `${spec.agent} did not become ready; original prompt remains in TASK.md`);
      throw new AgentctlError(
        `${spec.task}: ${spec.agent} did not show its input prompt within ${settings.readyTimeout}s (pattern /${settings.readyPattern}/)`,
        `The window is still open: "tmux attach -t ${config.session}". Once the agent is ready, send the prompt with "agentctl send"; ` +
          `if the prompt looks normal, adjust agents.${spec.agent}.ready_pattern / ready_timeout in ${config.path}.`,
      );
    }
    if (runner.dryRun) await tmux.submitPrompt(spec.window, promptWithHeader(spec, record.attemptId));
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
  if (!opts.noAgent) ctx.info(`attach with: tmux attach -t ${config.session}`);
  return results;
}
