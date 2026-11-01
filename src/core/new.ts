import fs from 'node:fs';
import path from 'node:path';
import { agentCommandLine, buildAgentArgv, INSTALL_HINTS, promptWithHeader } from './agents.ts';
import type { Context } from './context.ts';
import type { Order } from './equivalents.ts';
import { addWorktree } from './git.ts';
import { applyLinks, checkLinkTargets, planLinks } from './links.ts';
import { planBatch } from './plan.ts';
import type { PlanOptions } from './plan.ts';
import { waitForReady } from './ready.ts';
import type { ResolvedSpec } from './spec.ts';
import { recordFromSpec, renderTaskMd, setHeaderField, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError } from './util.ts';

export interface NewOptions extends PlanOptions {
  /** Wait for a human to answer the folder-trust dialog (default). `false` (--no-wait-trust): stop at the dialog. */
  waitTrust?: boolean;
  /** `--no-agent`: stop after worktree, setup and links; no TASK.md, no tmux window, no agent. */
  noAgent?: boolean;
  /** Ctrl-C: ends the wait for the agent without closing its window. */
  signal?: AbortSignal;
}

export interface NewResult {
  task: string;
  window: string;
  agentCommand: string;
  worktrees: string[];
  /** False with `--no-agent`. */
  agentStarted: boolean;
  requested: Order;
  effective: Order;
  switchedBy?: 'flag' | 'limit';
}

async function requireTool(ctx: Context, tool: string, args: string[]): Promise<void> {
  const r = await ctx.runner.exec(tool, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${tool} not found or not working`, INSTALL_HINTS[tool]);
}

const SETUP_TIMEOUT_MS = 20 * 60_000;
const SETUP_TAIL_LINES = 15;

/** Run the spec's `setup` commands in the primary worktree, logging to `<state_dir>/<task>/setup.log`. A failure stops `new`. */
async function runSetup(ctx: Context, spec: ResolvedSpec, worktree: string): Promise<void> {
  if (spec.setup.length === 0) return;
  const { runner, config } = ctx;
  const logFile = path.join(taskDir(config, spec.window), 'setup.log');
  if (!runner.dryRun) await runner.writeFile(logFile, '');
  for (const [i, command] of spec.setup.entries()) {
    ctx.info(`${spec.task}: setup ${i + 1}/${spec.setup.length}: ${command}`);
    const r = await runner.exec('sh', ['-c', command], { cwd: worktree, timeoutMs: SETUP_TIMEOUT_MS });
    if (runner.dryRun) continue;
    const output = `${r.stdout}${r.stderr}`;
    await runner.appendFile(logFile, `$ ${command}\n${output}${output.endsWith('\n') || output === '' ? '' : '\n'}[exit ${r.code}]\n\n`);
    if (r.code !== 0) {
      const tail = output.trimEnd().split('\n').slice(-SETUP_TAIL_LINES).join('\n');
      throw new AgentctlError(
        `${spec.task}: setup command failed (exit ${r.code}): ${command}\n${tail}`,
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
  for (const spec of specs) checkLinkTargets(spec.links, spec.task);
  if (!runner.dryRun && !opts.noAgent) {
    for (const agent of new Set(specs.map((s) => s.agent))) await requireTool(ctx, agent, ['--version']);
  }

  const results: NewResult[] = [];
  let sessionUp = await tmux.hasSession();
  for (const [index, spec] of specs.entries()) {
    const primary = spec.repos[0]!.worktree;

    // 1. worktrees
    for (const repo of spec.repos) {
      if (opts.reuse && fs.existsSync(repo.worktree)) ctx.info(`${spec.task}: reusing worktree ${repo.worktree}`);
      else {
        await addWorktree(runner, repo);
        ctx.info(`${spec.task}: worktree ${repo.worktree}`);
      }
    }

    // 2. setup commands (in the primary worktree; an install may wipe node_modules, so this comes before the links)
    await runSetup(ctx, spec, primary);

    // 3. symlinks (in the primary worktree)
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
    const record = recordFromSpec(spec, config, runner.now());
    await runner.mkdir(taskDir(config, spec.window));
    await runner.writeFile(taskFile(config, spec.window), renderTaskMd(record, spec.prompt));
    // The agent's own folder: only the report goes there (agentctl's state is in state_dir).
    await runner.mkdir(path.dirname(spec.report));

    // 5. window + agent
    if (sessionUp) await tmux.newWindow(spec.window, primary, spec.env);
    else {
      await tmux.newSession(spec.window, primary, spec.env);
      sessionUp = true;
    }
    const settings = config.agents[spec.agent];
    const commandLine = agentCommandLine(buildAgentArgv(spec, settings));
    // tmux's own ID of the window: operations keep finding it when `watch` puts a state icon in front of its name.
    const windowId = (await tmux.windows()).find((w) => w.plain === spec.window)?.id;
    if (windowId) await setHeaderField(runner, taskFile(config, spec.window), 'window_id', windowId);
    await tmux.typeCommand(spec.window, commandLine);
    ctx.info(`${spec.task}: window ${config.session}:${spec.window} running ${commandLine}`);

    // 6. wait for the agent; never answer a trust dialog (wait for the human to do it); then paste the prompt and press Enter
    const waitTrust = opts.waitTrust !== false;
    const sendHint = `agentctl send ${taskFile(config, spec.window)}`;
    const ready = await waitForReady(runner, tmux, spec.window, {
      pattern: settings.readyPattern,
      trustPattern: settings.trustPattern,
      timeoutMs: settings.readyTimeout * 1000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(waitTrust
        ? {
            waitTrust: {
              timeoutMs: settings.trustTimeout * 1000,
              onWaiting: () => ctx.info(`${spec.task}: agent waits for folder trust – attach: tmux attach -t ${config.session}, confirm in window ${spec.window}`),
            },
          }
        : {}),
    });
    if (ready.aborted) {
      const notStarted = specs.slice(index + 1).map((s) => s.task);
      throw new AgentctlError(
        `${spec.task}: interrupted while waiting for the agent; window ${config.session}:${spec.window} stays open, the prompt was not sent` +
          (notStarted.length > 0 ? `, not started: ${notStarted.join(', ')}` : ''),
        `Once the agent shows its input, deliver the prompt with: ${sendHint}`,
      );
    }
    if (ready.trust && waitTrust) {
      throw new AgentctlError(
        `${spec.task}: agent still waits for folder trust after ${settings.trustTimeout}s – attach: tmux attach -t ${config.session}, confirm in window ${spec.window}`,
        `agentctl never answers that dialog. The window stays open and the prompt was not sent; once the agent shows its input, deliver it with: ${sendHint}. ` +
          `To wait longer, raise agents.${spec.agent}.trust_timeout in ${config.path}.`,
      );
    }
    if (ready.trust) {
      throw new AgentctlError(
        `${spec.task}: agent waits for folder trust – attach: tmux attach -t ${config.session}, confirm, then agentctl status`,
        `agentctl never answers that dialog. The prompt was not sent; once the agent shows its input, deliver it with: ${sendHint}`,
      );
    }
    if (!ready.ready) {
      throw new AgentctlError(
        `${spec.task}: ${spec.agent} did not show its input prompt within ${settings.readyTimeout}s (pattern /${settings.readyPattern}/)`,
        `The window is still open: "tmux attach -t ${config.session}". Once the agent is ready, send the prompt with "agentctl send"; ` +
          `if the prompt looks normal, adjust agents.${spec.agent}.ready_pattern / ready_timeout in ${config.path}.`,
      );
    }
    await tmux.submitPrompt(spec.window, promptWithHeader(spec));
    ctx.info(`${spec.task}: prompt sent`);

    const result: NewResult = {
      task: spec.task,
      window: spec.window,
      agentCommand: commandLine,
      worktrees: spec.repos.map((r) => r.worktree),
      agentStarted: true,
      requested: spec.requested,
      effective: { agent: spec.agent, model: spec.model, effort: spec.effort },
    };
    if (spec.switchedBy) result.switchedBy = spec.switchedBy;
    results.push(result);
  }
  if (!opts.noAgent) ctx.info(`attach with: tmux attach -t ${config.session}`);
  return results;
}
