import { confirmAction } from './clipboard.ts';
import type { AgentName } from './config.ts';
import type { Context } from './context.ts';
import { formatModelEffort, translate } from './equivalents.ts';
import type { Order } from './equivalents.ts';
import type { SelfArgv } from './events.ts';
import { newTasks } from './new.ts';
import type { NewResult } from './new.ts';
import { listTargets, matchTask, describeTargets } from './resolve.ts';
import type { ResolvedSpec } from './spec.ts';
import { readTaskPrompt, readTaskRecord, setHeaderField, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, windowName } from './util.ts';

export interface MoveOptions {
  /** The provider to move to; default: the other one. */
  agent?: AgentName | undefined;
  /** `-y`: do not ask. */
  yes?: boolean;
  self?: SelfArgv | undefined;
  signal?: AbortSignal | undefined;
}

export interface MovePlan {
  from: TaskRecord;
  /** The order on the other provider, translated through the equivalents table. */
  to: Order;
  task: string;
  window: string;
  prompt: string;
}

const otherAgent = (a: AgentName): AgentName => (a === 'claude' ? 'codex' : 'claude');
const label = (o: Order): string => `${o.agent} ${formatModelEffort(o)}`;

/** The text added to the original prompt for the agent that takes over. */
export function continuationNote(from: Pick<TaskRecord, 'agent' | 'model' | 'report'>): string {
  return (
    `Poprzedni agent (${from.agent} ${from.model}) przerwał przez limit. ` +
    'Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. ' +
    `Raport zapisz do ${from.report}.`
  );
}

/** `<task>-2`, or the first free `-N` after it: not a task, a window or a state folder that exists. */
export function nextTaskId(task: string, taken: (task: string) => boolean): string {
  for (let n = 2; ; n++) {
    const candidate = `${task}-${n}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Everything `move` would do, or an error saying why not. Nothing has changed when this returns or throws. */
export async function planMove(ctx: Context, taskArg: string, opts: MoveOptions = {}): Promise<MovePlan> {
  const { config } = ctx;
  const targets = await listTargets(ctx);
  const match = matchTask(taskArg, targets);
  if (match.kind === 'many') throw new AgentctlError(`"${taskArg}" fits more than one task:\n${describeTargets(match.matches).join('\n')}`, 'Type more of the task ID.');
  if (match.kind === 'none') throw new AgentctlError(`no task "${taskArg}"`, 'See "agentctl status".');
  const from = readTaskRecord(config, match.target.window);
  if (!from) throw new AgentctlError(`${match.target.task} has no state file, so its prompt and worktree are unknown`, 'Orphans cannot be moved; see "agentctl adopt".');

  if (from.supersededBy) throw new AgentctlError(`${from.task} was already moved to ${from.supersededBy}`, `Close the old window when you are done: agentctl close ${from.task}`);
  if (from.pin) throw new AgentctlError(`${from.task} is pinned (pin: true): it is never moved to the other provider`, 'Wait for the limit to reset, or remove the pin from the spec and start the task again.');
  if (from.agent === 'unknown') throw new AgentctlError(`the agent of ${from.task} is unknown (adopted without --agent), so its model cannot be translated`, 'Start the task again on the provider you want, with "agentctl new --agent <agent>".');
  const target = opts.agent ?? otherAgent(from.agent);
  if (target === from.agent) throw new AgentctlError(`${from.task} already runs on ${from.agent}`, `Pick the other provider: agentctl move ${from.task} --agent ${otherAgent(from.agent)}`);

  const t = translate({ agent: from.agent, model: from.model, effort: from.effort === 'unknown' ? 'high' : from.effort }, target, config.equivalents);
  if (!t.ok) throw new AgentctlError(`${from.task}: ${t.message}`, t.hint);
  if (from.repos.length === 0) throw new AgentctlError(`${from.task} has no worktree recorded, so there is nothing for the new agent to continue from`, 'Start a new task by hand.');

  const original = readTaskPrompt(config, from.window);
  if (!original) throw new AgentctlError(`cannot read the prompt of ${from.task} from ${taskFile(config, from.window)}`);

  const used = new Set([...targets.map((x) => x.window), ...targets.map((x) => x.task.toLowerCase())]);
  const task = nextTaskId(from.task, (candidate) => used.has(windowName(candidate)) || used.has(candidate.toLowerCase()));
  return { from, to: t.order, task, window: windowName(task), prompt: `${original}\n\n${continuationNote(from)}` };
}

/** Summary lines shown before the question. */
export function describeMove(plan: MovePlan): string[] {
  const { from } = plan;
  return [
    `Move ${from.task} (${from.agent} ${from.model}/${from.effort}) -> ${plan.task} (${label(plan.to)})`,
    ...from.repos.map((r) => `  worktree: ${r.worktree} (the same one)`),
    `  report:   ${from.report}`,
    `  prompt:   the original from TASK.md + a note that ${from.agent} stopped at its usage limit`,
    `  ${from.task} keeps its window (state superseded); you close it with "agentctl close ${from.task}".`,
  ];
}

/**
 * `agentctl move`: the task goes on at the other provider. A new window `<task>-N` starts in the same worktree with the
 * original prompt and a note to continue from the state of the worktree; the old window stays, marked `superseded`.
 * Always asks y/N (`yes` skips); without a terminal and without `yes` it is an error.
 */
export async function moveTask(ctx: Context, taskArg: string, opts: MoveOptions = {}): Promise<{ plan: MovePlan; result: NewResult } | undefined> {
  const plan = await planMove(ctx, taskArg, opts);
  if (!(await confirmAction(ctx, describeMove(plan), 'Move?', Boolean(opts.yes)))) return undefined;
  const { from } = plan;
  const spec: ResolvedSpec = {
    index: 1,
    task: plan.task,
    window: plan.window,
    agent: plan.to.agent,
    model: plan.to.model,
    effort: plan.to.effort,
    repos: from.repos,
    // The symlinks are in the worktree already (and their targets may be gone by now): nothing is linked again.
    links: [],
    setup: [],
    env: from.env,
    ...(from.reviewOf ? { reviewOf: from.reviewOf } : {}),
    report: from.report,
    prompt: plan.prompt,
    pin: false,
    requested: from.requested,
    switchedBy: 'limit',
  };
  const [result] = await newTasks(ctx, [spec], { reuse: true, noSwitch: true, ...(opts.self ? { self: opts.self } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  await setHeaderField(ctx.runner, taskFile(ctx.config, plan.window), 'continues', from.task);
  await setHeaderField(ctx.runner, taskFile(ctx.config, from.window), 'superseded_by', plan.task);
  ctx.out(`${from.task} -> ${plan.task}: running on ${label(plan.to)}. The old window ${from.window} stays open (superseded).`);
  return { plan, result: result as NewResult };
}
