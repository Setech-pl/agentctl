import fs from 'node:fs';
import { checkReviewer, checkWindowLimit, findAuthor } from './checks.ts';
import type { LiveWindow } from './checks.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { formatModelEffort, translate } from './equivalents.ts';
import type { Order } from './equivalents.ts';
import type { ResolvedSpec } from './spec.ts';
import { listTaskRecords } from './taskstore.ts';
import { Problems } from './util.ts';

export interface PlanOptions {
  /** `--agent`: run every spec on this provider, translating through the equivalents table. */
  agent?: AgentName;
  /** `--no-switch`: never offer to move a task to the other provider when its limit is full. */
  noSwitch?: boolean;
  reuse?: boolean;
}

/** Codex reasoning efforts; `max` is Claude-only. */
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const otherAgent = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');
const label = (o: Order): string => `${o.agent} ${formatModelEffort(o)}`;

/** Windows currently in the session, each tagged with the agent that agentctl started in it. */
export async function liveWindows(ctx: Context): Promise<LiveWindow[]> {
  const names = await ctx.tmux.listWindows();
  const agentByWindow = new Map<string, AgentName>();
  for (const record of listTaskRecords(ctx.config)) if (record.agent !== 'unknown') agentByWindow.set(record.window, record.agent);
  return names.map((window) => {
    const agent = agentByWindow.get(window);
    return agent ? { window, agent } : { window };
  });
}

function switchTo(spec: ResolvedSpec, to: Order, by: 'flag' | 'limit'): ResolvedSpec {
  return { ...spec, agent: to.agent, model: to.model, effort: to.effort, switchedBy: by };
}

/**
 * Validate a batch and settle the effective order of every spec. Nothing is switched silently:
 * `--agent` is an explicit order, a limit-driven switch needs a "y" from a human, and `pin: true` forbids it.
 * Every problem is collected and reported together; nothing has run when this throws.
 */
export async function planBatch(ctx: Context, specs: ResolvedSpec[], opts: PlanOptions = {}): Promise<ResolvedSpec[]> {
  const { config } = ctx;
  const p = new Problems();
  const live = ctx.runner.dryRun ? [] : await liveWindows(ctx);
  const planned: LiveWindow[] = [];
  const seen = new Set<string>();
  const result: ResolvedSpec[] = [];

  for (let spec of specs) {
    const at = `${spec.task}:`;

    // 1. --agent: explicit, so no question asked.
    if (opts.agent && spec.agent !== opts.agent) {
      if (spec.pin) {
        p.add(`${at} is pinned to ${spec.agent} (pin: true) but --agent ${opts.agent} was given. Drop one of them.`);
      } else {
        const t = translate({ agent: spec.agent, model: spec.model, effort: spec.effort }, opts.agent, config.equivalents);
        if (t.ok) spec = switchTo(spec, t.order, 'flag');
        else p.add(`${at} ${t.message}. ${t.hint}`);
      }
    }
    if (spec.agent === 'codex' && !CODEX_EFFORTS.includes(spec.effort)) {
      p.add(`${at} codex has no effort "${spec.effort}" (use ${CODEX_EFFORTS.join(', ')})`);
    }

    // 2. duplicates and existing windows
    if (seen.has(spec.window)) p.add(`${at} the task appears twice in this file`);
    seen.add(spec.window);
    if (live.some((w) => w.window === spec.window)) {
      p.add(`${at} tmux window "${spec.window}" already exists in session "${config.session}" (use "agentctl send" for a follow-up, or "agentctl close ${spec.task}" first)`);
    }

    // 3. provider limit, with an offer to switch
    const occupied = (): LiveWindow[] => [...live, ...planned];
    let limitProblem = checkWindowLimit(spec.agent, config.limits[spec.agent], occupied(), config.session);
    if (limitProblem) {
      const other = otherAgent(spec.agent);
      const current: Order = { agent: spec.agent, model: spec.model, effort: spec.effort };
      let offered = false;
      if (spec.pin) {
        limitProblem += ' The task is pinned (pin: true), so it will not be moved to the other provider.';
      } else if (checkWindowLimit(other, config.limits[other], occupied(), config.session)) {
        limitProblem += ` ${other} is full too.`;
      } else {
        const t = translate(current, other, config.equivalents);
        if (!t.ok) limitProblem += ` ${other} has room, but ${t.message}. ${t.hint}`;
        else if (opts.noSwitch) limitProblem += ` ${other} has room; switching was disabled with --no-switch.`;
        else if (!ctx.confirm) limitProblem += ` ${other} has room; switching needs a terminal to ask you (re-run in one, or use --agent ${other}).`;
        else {
          offered = true;
          const yes = await ctx.confirm(
            `${spec.task}: ${limitProblem}\n  ${other} has room. Switch to ${label(t.order)} (equivalent of ${label(current)})? [y/N] `,
          );
          if (yes) {
            spec = switchTo(spec, t.order, 'limit');
            ctx.info(`${spec.task}: switched ${label(current)} -> ${label(t.order)} (limit)`);
            limitProblem = undefined;
          }
        }
      }
      if (limitProblem) p.add(`${at} ${limitProblem}${offered ? ' (switch declined)' : ''} Close one with "agentctl close <task>" or raise limits.${spec.agent} in ${config.path}.`);
    }
    planned.push({ window: spec.window, agent: spec.agent });

    // 4. worktrees
    for (const repo of spec.repos) {
      // A dry run may be rehearsed on a machine without the repositories, so only real runs require them.
      if (!ctx.runner.dryRun && !fs.existsSync(repo.path)) p.add(`${at} repository ${repo.path} does not exist`);
      if (fs.existsSync(repo.worktree) && !opts.reuse) {
        p.add(`${at} worktree ${repo.worktree} already exists (pass --reuse to use it as is)`);
      }
    }
    result.push(spec);
  }

  // 5. cross-review on the effective values (after any mapping or switch)
  for (const spec of result) {
    const problem = checkReviewer(spec, spec.reviewOf ? findAuthor(spec.reviewOf, result, config) : undefined);
    if (problem) p.add(`${spec.task}: ${problem}`);
  }
  p.throwIfAny('Cannot start the tasks:');
  return result;
}
