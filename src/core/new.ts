import fs from 'node:fs';
import { agentCommandLine, buildAgentArgv, INSTALL_HINTS, promptWithHeader } from './agents.ts';
import type { Context } from './context.ts';
import type { Order } from './equivalents.ts';
import { addWorktree } from './git.ts';
import { applyLinks, planLinks } from './links.ts';
import { planBatch } from './plan.ts';
import type { PlanOptions } from './plan.ts';
import { waitForReady } from './ready.ts';
import type { ResolvedSpec } from './spec.ts';
import { recordFromSpec, renderTaskMd, taskDir, taskFile } from './taskstore.ts';
import { AgentctlError } from './util.ts';

export type NewOptions = PlanOptions;

export interface NewResult {
  task: string;
  window: string;
  agentCommand: string;
  worktrees: string[];
  requested: Order;
  effective: Order;
  switchedBy?: 'flag' | 'limit';
}

async function requireTool(ctx: Context, tool: string, args: string[]): Promise<void> {
  const r = await ctx.runner.exec(tool, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${tool} not found or not working`, INSTALL_HINTS[tool]);
}

/** Start every spec: worktree, links, TASK.md, tmux window, agent, prompt. Plans and validates everything first. */
export async function newTasks(ctx: Context, requested: ResolvedSpec[], opts: NewOptions = {}): Promise<NewResult[]> {
  const { runner, tmux, config } = ctx;

  // Tools needed by the orders as written; the provider may change below, so check both agents the batch could end on.
  if (!runner.dryRun) {
    await requireTool(ctx, 'tmux', ['-V']);
    await requireTool(ctx, 'git', ['--version']);
  }
  const specs = await planBatch(ctx, requested, opts);
  if (!runner.dryRun) {
    for (const agent of new Set(specs.map((s) => s.agent))) await requireTool(ctx, agent, ['--version']);
  }

  const results: NewResult[] = [];
  let sessionUp = await tmux.hasSession();
  for (const spec of specs) {
    const primary = spec.repos[0]!.worktree;

    // 1. worktrees
    for (const repo of spec.repos) {
      if (opts.reuse && fs.existsSync(repo.worktree)) ctx.info(`${spec.task}: reusing worktree ${repo.worktree}`);
      else {
        await addWorktree(runner, repo);
        ctx.info(`${spec.task}: worktree ${repo.worktree}`);
      }
    }

    // 2. symlinks (in the primary worktree)
    const { ops, warnings } = planLinks(spec.links, primary);
    for (const w of warnings) ctx.info(`${spec.task}: warning: ${w}`);
    await applyLinks(runner, ops);

    // 3. TASK.md
    const record = recordFromSpec(spec, config, runner.now());
    await runner.mkdir(taskDir(config, spec.window));
    await runner.writeFile(taskFile(config, spec.window), renderTaskMd(record, spec.prompt));

    // 4. window + agent
    if (sessionUp) await tmux.newWindow(spec.window, primary, spec.env);
    else {
      await tmux.newSession(spec.window, primary, spec.env);
      sessionUp = true;
    }
    const settings = config.agents[spec.agent];
    const commandLine = agentCommandLine(buildAgentArgv(spec, settings));
    await tmux.typeCommand(spec.window, commandLine);
    ctx.info(`${spec.task}: window ${config.session}:${spec.window} running ${commandLine}`);

    // 5. wait for the agent; never answer a trust dialog; then paste the prompt and press Enter
    const ready = await waitForReady(runner, tmux, spec.window, {
      pattern: settings.readyPattern,
      trustPattern: settings.trustPattern,
      timeoutMs: settings.readyTimeout * 1000,
    });
    if (ready.trust) {
      throw new AgentctlError(
        `${spec.task}: agent waits for folder trust – attach: tmux attach -t ${config.session}, confirm, then agentctl status`,
        `agentctl never answers that dialog. The prompt was not sent; once the agent shows its input, deliver it with: agentctl send ${taskFile(config, spec.window)}`,
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
      requested: spec.requested,
      effective: { agent: spec.agent, model: spec.model, effort: spec.effort },
    };
    if (spec.switchedBy) result.switchedBy = spec.switchedBy;
    results.push(result);
  }
  ctx.info(`attach with: tmux attach -t ${config.session}`);
  return results;
}
