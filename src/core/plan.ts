import { provider, alternatives } from './providers/registry.ts';
import { pendingStarts } from './start-lock.ts';
import { inspectReport } from './report-state.ts';
import { resolveTaskBases } from './base-ref.ts';
import fs from 'node:fs';
import { checkReviewer, checkWindowLimit, findAuthor } from './checks.ts';
import type { AgentModel, LiveWindow } from './checks.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { formatModelEffort, translate } from './equivalents.ts';
import type { Order } from './equivalents.ts';
import type { ResolvedSpec } from './spec.ts';
import { cancelledTasks, unmetAfter, waitingText } from './depends.ts';
import { slotHolders } from './limits.ts';
import { collectStatus } from './status.ts';
import { listTaskRecords } from './taskstore.ts';
import { AgentctlError, Problems } from './util.ts';

export interface PlanOptions {
  /** `--agent`: run every spec on this provider, translating through the equivalents table. */
  agent?: AgentName;
  /** `--no-switch`: never offer to move a task to the other provider when its limit is full. */
  noSwitch?: boolean;
  reuse?: boolean;
  /** Queue validation: the provider limit is not an error (the task waits for a free window), and nothing is ever switched. */
  ignoreLimits?: boolean;
  /** The queue starts a task whose `after` it has checked itself. */
  skipAfter?: boolean;
  /** Authors of reviewed tasks that are not started yet (waiting in the queue): task -> agent and model. */
  knownAuthors?: ReadonlyMap<string, AgentModel>;
  /**
   * `new` with a full limit: with this sink and a terminal, the question "add to the queue?" is asked and the specs the human
   * agreed to queue land here instead of being an error. Without a terminal the error names `agentctl queue`.
   */
  overflow?: { queued: ResolvedSpec[] };
  deferBases?: boolean;
}

/** Codex reasoning efforts; `max` is Claude-only. */



const label = (o: Order): string => `${o.agent} ${formatModelEffort(o)}`;

/** Windows currently in the session, each tagged with the agent that agentctl started in it, then the places held by reservations and external sessions. */
export async function liveWindows(ctx: Context): Promise<LiveWindow[]> {
  const names = await ctx.tmux.listWindows();
  const agentByWindow = new Map<string, AgentName>();
  for (const record of listTaskRecords(ctx.config)) if (record.agent !== 'unknown') agentByWindow.set(record.window, record.agent);
  const records = listTaskRecords(ctx.config);
  const candidates = records.some(r => inspectReport(ctx.config, r, ctx.runner.now(), !r.attemptId).ready);
  const rows = candidates ? await collectStatus(ctx, { progress: false }) : [];
  const windows = names.map((window): LiveWindow => {
    const agent = agentByWindow.get(window);
    const reportReady = rows.some(r => r.windowName === window && r.state === 'report-ready');
    return agent ? { window, agent, ...(reportReady ? { reportReady: true, counted: configCountsReady(ctx) } : {}) } : { window };
  });
  // Places held by the user (`limits reserve`) and sessions outside agentctl count against the limit like its own windows.
  return [...windows, ...pendingStarts(ctx.config).filter(r => !names.includes(r.window)).map(r => ({ window: r.window, agent: r.agent, kind: 'starting' as const })), ...(await slotHolders(ctx))];
}

function configCountsReady(ctx: Context): boolean { return ctx.config.countReportReady; }

function switchTo(spec: ResolvedSpec, to: Order, by: 'flag' | 'limit'): ResolvedSpec {
  // Remote Control is Claude only: a task that goes to Codex loses it (a switch always changes the provider).
  const { remoteControl: _remote, ...rest } = spec;
  return { ...rest, agent: to.agent, model: to.model, effort: to.effort, switchedBy: by };
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
  // `after` belongs to the queue: `new` starts a task now, so what it waits for must be done already.
  if (!opts.skipAfter && !ctx.runner.dryRun && specs.some((s) => s.after.length > 0)) {
    const rows = await collectStatus(ctx, { progress: false, archived: true });
    for (const spec of specs) {
      const unmet = unmetAfter(spec.after, rows, spec.afterVerdicts);
      const gone = cancelledTasks(rows);
      if (unmet.some((t) => gone.has(t))) p.add(`${spec.task}: after ${spec.after.join(', ')}: ${unmet.filter((t) => gone.has(t)).join(', ')} was cancelled, so it never gets a report. Remove it from "after".`);
      else if (unmet.length > 0) p.add(`${spec.task}: after ${spec.after.join(', ')}: ${waitingText(unmet)} (no report yet). "agentctl queue" starts the task by itself once they have one.`);
    }
  }
  const planned: LiveWindow[] = [];
  const seen = new Set<string>();
  const result: ResolvedSpec[] = [];

  for (let spec of specs) {
    if (!opts.deferBases) spec = await resolveTaskBases(ctx, spec);
    if (spec.review) {
      const repos = [];
      for (const repo of spec.repos) {
        if (!repo.branch) throw new AgentctlError(`${spec.task}: review: auto requires an explicit author repos[].branch`);
        const r = await ctx.runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${repo.base ?? 'HEAD'}^{commit}`], { readOnly: true });
        if (r.code !== 0 || !/^[a-f0-9]{40}$/i.test(r.stdout.trim())) throw new AgentctlError(`${spec.task}: cannot freeze author base for auto review in ${repo.path}`);
        repos.push({ ...repo, base: r.stdout.trim() });
      }
      spec = { ...spec, repos };
    }
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
    if (!provider(spec.agent).effort.accepted.includes(spec.effort)) {
      p.add(`${at} ${spec.agent} has no effort "${spec.effort}" (use ${provider(spec.agent).effort.accepted.join(', ')})`);
    }

    // 2. duplicates and existing windows
    if (seen.has(spec.window)) p.add(`${at} the task appears twice in this file`);
    seen.add(spec.window);
    if (live.some((w) => w.window === spec.window)) {
      p.add(`${at} tmux window "${spec.window}" already exists in session "${config.session}" (use "agentctl send" for a follow-up, or "agentctl close ${spec.task}" first)`);
    }

    // 3. provider limit, with an offer to switch
    const occupied = (): LiveWindow[] => [...live, ...planned];
    let limitProblem = opts.ignoreLimits ? undefined : checkWindowLimit(spec.agent, config.limits[spec.agent], occupied(), config.session);
    if (limitProblem) {
      const others = alternatives(config, spec.agent);
      const current: Order = { agent: spec.agent, model: spec.model, effort: spec.effort };
      let offered = false;
      if (spec.pin) {
        limitProblem += ' The task is pinned (pin: true), so it will not be moved to the other provider.';
      } else for (const other of others) {
      if (checkWindowLimit(other, config.limits[other], occupied(), config.session)) {
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
            break;
          }
        }
      }
      }
      if (limitProblem && opts.overflow && ctx.confirm) {
        const yes = await ctx.confirm(`${spec.task}: ${limitProblem}${offered ? ' (switch declined)' : ''}\n  Add it to the queue (it starts by itself when a ${spec.agent} window is free)? [y/N] `);
        if (yes) {
          opts.overflow.queued.push(spec);
          limitProblem = undefined;
          continue;
        }
      }
      if (limitProblem) {
        p.add(
          `${at} ${limitProblem}${offered ? ' (switch declined)' : ''} Close one with "agentctl close <task>", raise limits.${spec.agent} in ${config.path}, ` +
            `or queue the task: "agentctl queue <file>" starts it when a window is free.`,
        );
      }
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
    const problem = checkReviewer(spec, spec.reviewOf ? (findAuthor(spec.reviewOf, [...result, ...(opts.overflow?.queued ?? [])], config) ?? opts.knownAuthors?.get(spec.reviewOf)) : undefined);
    if (problem) p.add(`${spec.task}: ${problem}`);
  }
  p.throwIfAny('Cannot start the tasks:');
  return result;
}
