import { chatQuotaWait } from './chat-quotas.ts';
import { checkHostLimit } from './host-limits.ts';
import { mapEffort } from './equivalents.ts';
import { missingBaseFailure } from './git.ts';
import { validateLaunch } from './safety.ts';
import { provider, alternatives } from './providers/registry.ts';
import { pendingStarts } from './start-lock.ts';
import { inspectReport } from './report-state.ts';
import { resolveTaskBases } from './base-ref.ts';
import fs from 'node:fs';
import { missingWorktreeVolume } from './worktree-volume.ts';
import { checkReviewer, checkWindowLimit, findAuthor } from './checks.ts';
import type { AgentModel, LiveWindow } from './checks.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { formatModelEffort, translate } from './equivalents.ts';
import type { Order } from './equivalents.ts';
import type { ResolvedSpec } from './spec.ts';
import { cancelledTasks, unmetAfter, waitingText } from './depends.ts';
import { explicitOnlyModel } from './matrix.ts';
import { slotHolders } from './limits.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { listTaskRecords, readTaskRecord } from './taskstore.ts';
import { AgentctlError, Problems } from './util.ts';

export interface PlanOptions {
  /** `--agent`: run every spec on this provider, translating through the equivalents table. */
  agent?: AgentName;
  /** `--no-switch`: never offer to move a task to the other provider when its limit is full. */
  noSwitch?: boolean;
  /** The watcher already holds this task's durable place in the admission lock. */
  queueReservation?: string;
  reuse?: boolean;
  /** Queue validation: the provider limit is not an error (the task waits for a free window), and nothing is ever switched. */
  ignoreLimits?: boolean;
  /** The queue starts a task whose `after` it has checked itself. */
  skipAfter?: boolean;
  /** Fresh rows for the dependencies of this batch, when the caller has already read them. */
  afterRows?: StatusRow[];
  /** Authors of reviewed tasks that are not started yet (waiting in the queue): task -> agent and model. */
  knownAuthors?: ReadonlyMap<string, AgentModel>;
  /**
   * `new` with a full limit: with this sink and a terminal, the question "add to the queue?" is asked and the specs the human
   * agreed to queue land here instead of being an error. Without a terminal the error names `agentctl queue`.
   */
  overflow?: { queued: ResolvedSpec[] };
  deferBases?: boolean;
  /** MCP preview: validate syntax, models and batch duplicates without runtime reads. */
  previewOnly?: boolean;
}

/** Codex reasoning efforts; `max` is Claude-only. */



const label = (o: Order): string => `${o.agent} ${formatModelEffort(o)}`;

/** Windows currently in the session, each tagged with the agent that agentctl started in it, then the places held by reservations and external sessions. */
export async function liveWindows(ctx: Context, knownRows?: StatusRow[], ignoreReservation?: string, cachedHosts = false): Promise<LiveWindow[]> {
  const names = knownRows ? [...new Set(knownRows.filter(r => r.window === 'alive').map(r => r.windowName))] : (cachedHosts ? [...await ctx.localTmux.windows(), ...await ctx.hosts.windows(true)] : await ctx.tmux.windows()).filter(w => w.exitCode === undefined).map(w => w.plain);
  if (!knownRows && ctx.hosts.hasTrackedHosts()) {
    for (const record of listTaskRecords(ctx.config)) {
      if (record.host && !record.closed && !record.cancelled && ctx.hosts.connection(record.host).unreachable && !names.includes(record.window)) names.push(record.window);
    }
  }
  const records = names.flatMap(window => { const record = readTaskRecord(ctx.config, window); return record ? [record] : []; });
  const agentByWindow = new Map(records.filter(r => r.agent !== 'unknown').map(r => [r.window, r.agent as AgentName]));
  const recordByWindow = new Map(records.map(r => [r.window, r]));
  const neverReady = (window: string): boolean => {
    const r = recordByWindow.get(window);
    return Boolean(r?.pendingPrompt && r.promptDelivery === 'needs-attention' && !r.deliveryStartedAt);
  };
  const rows = knownRows ?? (records.some(r => inspectReport(ctx.config, r, ctx.runner.now(), !r.attemptId).ready) ? await collectStatus(ctx, { progress: false, cachedOnly: true, records: { current: records, archived: [] }, orphans: false }) : []);
  const windows = names.flatMap((window): LiveWindow[] => {
    const agent = agentByWindow.get(window);
    const record = recordByWindow.get(window);
    if (record?.closed || record?.cancelled) return [];
    const reportReady = rows.some(r => r.windowName === window && r.state === 'report-ready');
    return [agent ? { window, agent, host: record?.host, perf: Boolean(record?.perf), ...(record?.owner ? {owner: record.owner} : {}), ...(neverReady(window) ? { counted: false } : reportReady ? { reportReady: true, counted: configCountsReady(ctx) } : {}) } : { window }];
  });
  // Places held by the user (`limits reserve`) and sessions outside agentctl count against the limit like its own windows.
  return [...windows, ...pendingStarts(ctx.config).filter(r => r.id !== ignoreReservation && !names.includes(r.window)).map(r => ({ window: r.window, agent: r.agent, host: r.host, perf: r.perf, ...(r.owner ? {owner: r.owner} : {}), kind: 'starting' as const })), ...(await slotHolders(ctx))];
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
  const live = ctx.runner.dryRun || opts.previewOnly ? [] : await liveWindows(ctx, undefined, opts.queueReservation, true);
  // `after` belongs to the queue: `new` starts a task now, so what it waits for must be done already.
  if (!opts.previewOnly && !opts.skipAfter && !ctx.runner.dryRun && specs.some((s) => s.after.length > 0)) {
    const rows = opts.afterRows ?? await collectStatus(ctx, { progress: false, cachedOnly: true, archived: true });
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
    if (!spec.reviewMode && spec.mergeBaseCheck !== 'candidate' && !spec.host && !spec.placement && !opts.previewOnly && !opts.deferBases) spec = await resolveTaskBases(ctx, spec);
    if (spec.review && !spec.reviewOf && !spec.host && !spec.placement && !opts.previewOnly) {
      const repos = [];
      for (const repo of spec.repos) {
        if (!repo.branch) throw new AgentctlError(`${spec.task}: review: auto requires an explicit author repos[].branch`);
        const r = await ctx.runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${repo.base ?? 'HEAD'}^{commit}`], { readOnly: true });
        if (r.code !== 0 || !/^[a-f0-9]{40}$/i.test(r.stdout.trim())) throw await missingBaseFailure(ctx.runner, repo);
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
    const mapping = mapEffort(spec);
    if (mapping.warning) {
      ctx.info(`${spec.task}: WARNING: ${mapping.warning}`);
      spec = {...spec, effort: mapping.effort, warnings: [...(spec.warnings ?? []), mapping.warning]};
    }
    if (!provider(spec.agent).effort.accepted.includes(spec.effort)) {
      p.add(`${at} ${spec.agent} has no effort "${spec.effort}" (use ${provider(spec.agent).effort.accepted.join(', ')})`);
    }

    try { validateLaunch(config, spec, spec.env); } catch (e) { p.add((e as Error).message); }

    // 2. duplicates and existing windows
    if (seen.has(spec.window)) p.add(`${at} the task appears twice in this file`);
    seen.add(spec.window);
    if (live.some((w) => w.window === spec.window)) {
      p.add(`${at} tmux window "${spec.window}" already exists in session "${config.session}" (use "agentctl send" for a follow-up, or "agentctl close ${spec.task}" first)`);
    }

    // 3. provider limit, with an offer to switch
    const occupied = (): LiveWindow[] => [...live, ...planned];
    const providerProblem = (agent: AgentName): string | undefined => checkWindowLimit(agent, config.limits[agent], occupied(), config.session) ?? chatQuotaWait(config, { ...spec, agent }, occupied());
    let limitProblem = opts.ignoreLimits || opts.previewOnly ? undefined : providerProblem(spec.agent);
    if (limitProblem) {
      const others = alternatives(config, spec.agent).filter(a => !spec.host || config.hosts[spec.host]?.providers.includes(a));
      const current: Order = { agent: spec.agent, model: spec.model, effort: spec.effort };
      let offered = false;
      if (spec.pin) {
        limitProblem += ' The task is pinned (pin: true), so it will not be moved to the other provider.';
      } else for (const other of others) {
      if (providerProblem(other)) {
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
    try { validateLaunch(config, spec, spec.env); } catch (e) { p.add((e as Error).message); }
    if (spec.switchedBy && explicitOnlyModel(spec.agent, spec.model)) {
      p.add(`${at} the switch landed on the restricted ${spec.agent} ${spec.model}: k3.1-pro* and gpt-6-astra never come from a translation; order such a model with an explicit model: in the spec, or with an explicit-only class (visual, escalate)`);
    }
    if (spec.host && !config.hosts[spec.host]?.providers.includes(spec.agent)) p.add(`${at} host ${spec.host} has no ${spec.agent} provider`);
    if (!opts.ignoreLimits && !opts.previewOnly) {
      const hostProblem = checkHostLimit(config, spec, occupied());
      if (hostProblem) p.add(`${at} ${hostProblem}`);
    }
    planned.push({ window: spec.window, agent: spec.agent, host: spec.host, owner: spec.owner, perf: Boolean(spec.perf) });

    // 4. worktrees
    for (const repo of opts.previewOnly || spec.host || spec.placement || spec.reviewMode || spec.reuseWorktree ? [] : spec.repos) {
      // A dry run may be rehearsed on a machine without the repositories, so only real runs require them.
      if (!ctx.runner.dryRun && !fs.existsSync(repo.path)) p.add(`${at} repository ${repo.path} does not exist`);
      if (!missingWorktreeVolume([repo]) && fs.existsSync(repo.worktree) && !opts.reuse) {
        p.add(`${at} worktree ${repo.worktree} already exists (pass --reuse to use it as is)`);
      }
    }
    result.push(spec);
  }

  // 5. cross-review on the effective values (after any mapping or switch)
  for (const [i, spec] of result.entries()) {
    const reviewed = spec.reviewOfAll ?? (spec.reviewOf ? [spec.reviewOf] : []);
    const warnings: string[] = [];
    for (const reviewedTask of reviewed) {
      const author = (opts.previewOnly ? result.find(s => s.task === reviewedTask) : findAuthor(reviewedTask, [...result, ...(opts.overflow?.queued ?? [])], config)) ?? opts.knownAuthors?.get(reviewedTask);
      const problem = checkReviewer({ ...spec, reviewOf: reviewedTask }, author);
      if (problem) {
        p.add(`${spec.task}: ${problem}`);
      } else if (author && author.agent === spec.agent) {
        warnings.push(`reviewer provider ${spec.agent} equals the author provider of ${reviewedTask} (author ${author.model}, reviewer ${spec.model}): a different provider reviews better`);
      }
    }
    if (warnings.length > 0) {
      for (const w of warnings) ctx.info(`${spec.task}: WARNING: ${w}`);
      result[i] = { ...spec, warnings: [...(spec.warnings ?? []), ...warnings] };
    }
  }
  p.throwIfAny('Cannot start the tasks:');
  return result;
}
