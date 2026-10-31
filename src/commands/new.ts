import fs from 'node:fs';
import { agentCommandLine, buildAgentArgv, INSTALL_HINTS, promptWithHeader } from '../agents.ts';
import { checkReviewer, checkWindowLimit, findAuthor } from '../checks.ts';
import type { LiveWindow } from '../checks.ts';
import type { AgentName } from '../config.ts';
import type { Context } from '../context.ts';
import { addWorktree } from '../git.ts';
import { applyLinks, planLinks } from '../links.ts';
import { waitForReady } from '../ready.ts';
import type { ResolvedSpec } from '../spec.ts';
import { listTaskRecords, recordFromSpec, renderTaskMd, taskDir, taskFile } from '../taskstore.ts';
import { AgentctlError, Problems } from '../util.ts';

export interface NewOptions {
  reuse?: boolean;
}

async function requireTool(ctx: Context, tool: string, args: string[]): Promise<void> {
  const r = await ctx.runner.exec(tool, args, { readOnly: true });
  if (r.code !== 0) throw new AgentctlError(`${tool} not found or not working`, INSTALL_HINTS[tool]);
}

/** Windows currently in the session, each tagged with the agent that agentctl started in it. */
async function liveWindows(ctx: Context): Promise<LiveWindow[]> {
  const names = await ctx.tmux.listWindows();
  const agentByWindow = new Map<string, AgentName>();
  for (const record of listTaskRecords(ctx.config)) agentByWindow.set(record.window, record.agent);
  return names.map((window) => {
    const agent = agentByWindow.get(window);
    return agent ? { window, agent } : { window };
  });
}

/** Everything that can be checked before touching anything. All problems are reported together. */
export async function validateBatch(ctx: Context, specs: ResolvedSpec[], opts: NewOptions): Promise<void> {
  const { config } = ctx;
  const p = new Problems();
  const live = ctx.runner.dryRun ? [] : await liveWindows(ctx);
  const planned: LiveWindow[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    const at = `${spec.task}:`;
    if (seen.has(spec.window)) p.add(`${at} the task appears twice in this file`);
    seen.add(spec.window);

    const reviewProblem = checkReviewer(spec, spec.reviewOf ? findAuthor(spec.reviewOf, specs, config) : undefined);
    if (reviewProblem) p.add(`${at} ${reviewProblem}`);

    if (live.some((w) => w.window === spec.window)) {
      p.add(`${at} tmux window "${spec.window}" already exists in session "${config.session}" (use "agentctl send" for a follow-up, or "agentctl close ${spec.task}" first)`);
    }

    const limitProblem = checkWindowLimit(spec.agent, config.limits[spec.agent], [...live, ...planned], config.session);
    if (limitProblem) p.add(`${at} ${limitProblem} Close one with "agentctl close <task>" or raise limits.${spec.agent} in ${config.path}.`);
    planned.push({ window: spec.window, agent: spec.agent });

    for (const repo of spec.repos) {
      // A dry run may be rehearsed on a machine without the repositories, so only real runs require them.
      if (!ctx.runner.dryRun && !fs.existsSync(repo.path)) p.add(`${at} repository ${repo.path} does not exist`);
      if (fs.existsSync(repo.worktree) && !opts.reuse) {
        p.add(`${at} worktree ${repo.worktree} already exists (pass --reuse to use it as is)`);
      }
    }
  }
  p.throwIfAny('Cannot start the tasks:');
}

/** Start every spec: worktree, links, TASK.md, tmux window, agent, prompt. Validates everything first. */
export async function newTasks(ctx: Context, specs: ResolvedSpec[], opts: NewOptions = {}): Promise<void> {
  const { runner, tmux, config } = ctx;

  if (!runner.dryRun) {
    await requireTool(ctx, 'tmux', ['-V']);
    await requireTool(ctx, 'git', ['--version']);
    for (const agent of new Set(specs.map((s) => s.agent))) await requireTool(ctx, agent, ['--version']);
  }
  await validateBatch(ctx, specs, opts);

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
    const argv = buildAgentArgv(spec, settings);
    await tmux.typeCommand(spec.window, agentCommandLine(argv));
    ctx.info(`${spec.task}: window ${config.session}:${spec.window} running ${agentCommandLine(argv)}`);

    // 5. wait for the agent, then paste the prompt and press Enter
    const ready = await waitForReady(runner, tmux, spec.window, {
      pattern: settings.readyPattern,
      timeoutMs: settings.readyTimeout * 1000,
    });
    if (!ready.ready) {
      throw new AgentctlError(
        `${spec.task}: ${spec.agent} did not show its input prompt within ${settings.readyTimeout}s (pattern /${settings.readyPattern}/)`,
        `The window is still open: "tmux attach -t ${config.session}". Once the agent is ready, send the prompt with "agentctl send"; ` +
          `if the prompt looks normal, adjust agents.${spec.agent}.ready_pattern / ready_timeout in ${config.path}.`,
      );
    }
    await tmux.submitPrompt(spec.window, promptWithHeader(spec));
    ctx.info(`${spec.task}: prompt sent`);
  }
  ctx.info(`attach with: tmux attach -t ${config.session}`);
}
