import { recordJournal } from './journal.ts';
import type { Context } from './context.ts';
import { removeWorktrees } from './close.ts';
import { recordEvent } from './history.ts';
import { cancelFields, dropEntry, readQueue, writeCancelledRecord } from './queue.ts';
import type { QueueEntry } from './queue.ts';
import { matchTask } from './resolve.ts';
import { collectStatus } from './status.ts';
import type { StatusRow } from './status.ts';
import { listTaskRecords, readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { CancelSource, TaskRecord } from './taskstore.ts';
import { AgentctlError } from './util.ts';

/*
 * `agentctl cancel`: the work is abandoned. A task that works is interrupted, given `cancel.grace` seconds to stop, and its window is
 * closed; a task in the queue is taken out of it. Both end in state `cancelled` (not `closed`). The worktree and the branch stay unless
 * `--rm-worktree` (the worktree only; branches are never deleted). A report that was written stays and can be pulled.
 */

export interface CancelOptions {
  /** Why (free text, optional); kept in TASK.md. */
  reason?: string | undefined;
  /** `git worktree remove` (never --force) for the worktrees of a task that had one. */
  rmWorktree?: boolean | undefined;
  /** Where the request came from; kept in TASK.md. */
  source?: CancelSource | undefined;
}

export interface CancelPlanItem {
  task: string;
  /** `live`: a tmux window runs; `finished`: a state file without a window; `queued`: an entry of the queue (no state file yet, or a failed start). */
  kind: 'live' | 'finished' | 'queued';
  record?: TaskRecord;
  entry?: QueueEntry;
  /** Cancelled together with the task asked for: the other half of a `move`. */
  partnerOf?: string;
  /** Tasks of the queue (not in this plan) that wait for this one: they become blocked. */
  blocks: string[];
  /** The report file is there. */
  hasReport: boolean;
  /** Printable line for the confirmation list. */
  line: string;
}

export interface CancelPlan {
  items: CancelPlanItem[];
  /** Lines shown before the question. */
  summary: string[];
}

export interface CancelResult {
  task: string;
  kind: CancelPlanItem['kind'];
  /** Tasks of the queue that are blocked by this cancellation. */
  blocks: string[];
}

/** The other halves of a `move`: the task it was handed to, the task it continues, and so on along the chain. */
function partners(task: string, records: readonly TaskRecord[]): string[] {
  const links = records.flatMap((r) => [r.supersededBy, r.continues].filter((o): o is string => o !== undefined).map((o) => [r.task, o] as const));
  const found = new Set<string>([task]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [x, y] of links) {
      if (found.has(x) !== found.has(y)) {
        found.add(x).add(y);
        grew = true;
      }
    }
  }
  found.delete(task);
  return [...found].filter((t) => records.some((r) => r.task === t)).sort();
}

/**
 * Everything `cancel` would do, or an error saying why not. Nothing has changed when this returns or throws.
 * The task IDs may be written in any case and shortened to a unique prefix; the other half of a `move` is added to the plan.
 */
export async function planCancel(ctx: Context, inputs: string[], opts: CancelOptions = {}): Promise<CancelPlan> {
  const { config, runner, tmux } = ctx;
  if (inputs.length === 0) throw new AgentctlError('give at least one task to cancel', 'Example: agentctl cancel NC-42 --reason "wrong approach".');
  const records = listTaskRecords(config);
  const entries = readQueue(config);
  const targets = [
    ...records.map((r) => ({ task: r.task, window: r.window, alive: false })),
    ...entries.filter((e) => !records.some((r) => r.task === e.task)).map((e) => ({ task: e.task, window: e.task.toLowerCase(), alive: false })),
  ];
  const live = new Set(runner.dryRun ? [] : await tmux.listWindows());

  const chosen: { task: string; partnerOf?: string }[] = [];
  const add = (task: string, partnerOf?: string): void => {
    if (!chosen.some((c) => c.task === task)) chosen.push(partnerOf ? { task, partnerOf } : { task });
  };
  for (const input of inputs) {
    const match = matchTask(input, targets);
    if (match.kind === 'many') throw new AgentctlError(`"${input}" fits more than one task: ${match.matches.map((m) => m.task).join(', ')}`, 'Type more of the task ID.');
    if (match.kind === 'none') throw new AgentctlError(`no task "${input}"`, 'See "agentctl status" and "agentctl queue list".');
    const task = match.target.task;
    add(task);
    for (const other of partners(task, records)) add(other, task);
  }

  const selectedRecords = records.filter(r => chosen.some(c => c.task === r.task));
  const rows = new Map((await collectStatus(ctx, { progress: false, cachedOnly: true, records: { current: selectedRecords, archived: [] }, orphans: false })).map(r => [r.task, r] as const));
  const items: CancelPlanItem[] = [];
  const p = chosen.map((c) => c.task);
  for (const { task, partnerOf } of chosen) {
    const record = records.find((r) => r.task === task);
    const entry = entries.find((e) => e.task === task);
    const window = record?.window ?? task.toLowerCase();
    // A dry run asks tmux nothing: every task with a state file is taken for a running one, so the commands show.
    const alive = runner.dryRun ? record !== undefined && !entry : live.has(window);
    if (record?.cancelled && !alive) {
      if (partnerOf) continue;
      throw new AgentctlError(`${task} is already cancelled`, record.cancelReason ? `Reason given: ${record.cancelReason}` : undefined);
    }
    if (record?.closed && !alive && !entry) {
      if (partnerOf) continue;
      throw new AgentctlError(`${task} is closed: it finished, there is nothing to cancel`, 'Closed tasks stay in "agentctl status --all".');
    }
    if (entry?.status === 'starting') throw new AgentctlError(`${task} is being started right now`, 'Wait for it to finish; then it is a task with a window that cancel can stop.');
    const kind: CancelPlanItem['kind'] = alive ? 'live' : record && !entry ? 'finished' : 'queued';
    const row: StatusRow | undefined = rows.get(task);
    const hasReport = row?.report === 'yes';
    const blocks = entries.filter((e) => e.task !== task && !p.includes(e.task) && e.after.includes(task)).map((e) => e.task);
    const worktrees = (record?.repos ?? []).map((r) => r.worktree);
    const notes: string[] = [];
    if (kind === 'live') notes.push(`${row?.state ?? 'running'}: interrupt${config.cancel.grace > 0 ? `, wait ${config.cancel.grace} s` : ''}, close the window`);
    else if (kind === 'queued') notes.push(entry?.status === 'failed' ? 'in the queue (its start failed): taken out' : 'in the queue: taken out, it never starts');
    else notes.push('no window: marked cancelled');
    if (hasReport) notes.push('its report stays (agentctl pull ' + task + ')');
    if (worktrees.length > 0) notes.push(opts.rmWorktree ? 'worktree removed, branch stays' : 'worktree and branch stay');
    if (partnerOf) notes.push(`the other half of a move with ${partnerOf}`);
    items.push({
      task,
      kind,
      ...(record ? { record } : {}),
      ...(entry ? { entry } : {}),
      ...(partnerOf ? { partnerOf } : {}),
      blocks,
      hasReport,
      line: `${task}  (${notes.join('; ')})`,
    });
  }
  const blocked = [...new Set(items.flatMap((i) => i.blocks))];
  const summary = [
    `Cancel ${items.length} task${items.length === 1 ? '' : 's'}${opts.reason ? ` – ${opts.reason}` : ''}:`,
    ...items.map((i) => `  ${i.line}`),
    ...(blocked.length > 0 ? [`  ⛓ waiting for them, they become blocked: ${blocked.join(', ')} (agentctl unblock <task>, or cancel them too)`] : []),
  ];
  return { items, summary };
}

/**
 * Cancel the tasks of a plan. Live tasks are interrupted first (all of them), then everything waits `cancel.grace` seconds once, then the
 * windows are closed. A failure on one task does not stop the others; it is reported at the end.
 */
export async function cancelTasks(ctx: Context, plan: CancelPlan, opts: CancelOptions = {}): Promise<CancelResult[]> {
  const { config, runner, tmux } = ctx;
  const failures: string[] = [];
  const results: CancelResult[] = [];
  const live = plan.items.filter((i) => i.kind === 'live');

  for (const item of live) {
    const record = item.record as TaskRecord;
    const key = config.agents[record.agent === 'unknown' ? 'claude' : record.agent].interruptKey;
    await tmux.sendKey(record.window, key);
    ctx.info(`${item.task}: sent ${key} to ${config.session}:${record.window}`);
  }
  if (live.length > 0 && config.cancel.grace > 0) {
    ctx.info(`waiting ${config.cancel.grace} s for the agents to stop`);
    await runner.sleep(config.cancel.grace * 1000);
  }

  for (const item of plan.items) {
    try {
      const at = new Date(runner.now()).toISOString();
      if (item.kind === 'live') {
        const record = item.record as TaskRecord;
        await tmux.killWindow(record.window);
        ctx.info(`${item.task}: window ${config.session}:${record.window} closed`);
      }
      if (item.entry) await dropEntry(ctx, item.entry);
      if (item.record && (runner.dryRun || readTaskRecord(config, item.record.window))) {
        await setHeaderFields(runner, taskFile(config, item.record.window), cancelFields(opts, at));
      } else if (item.entry) {
        await writeCancelledRecord(ctx, item.entry, { ...opts, at });
      }
      const cancelled = readTaskRecord(config, item.record?.window ?? item.task.toLowerCase());
      if (cancelled) await recordEvent(ctx, cancelled, 'cancelled');
      await recordJournal(ctx, { kind: 'cancelled', task: item.task, text: `${item.task} anulowane${opts.reason ? ` – ${opts.reason}` : ''}`, ...(cancelled?.cohort ? { cohort: cancelled.cohort } : {}) });
      const worktree = item.record?.repos[0]?.worktree;
      ctx.out(`${item.task}: cancelled${worktree && !opts.rmWorktree ? ` (worktree ${worktree} and its branch stay)` : ''}`);
      if (opts.rmWorktree && item.record) await removeWorktrees(ctx, item.task, item.record.repos);
      for (const b of item.blocks) ctx.out(`  ⛓ ${b} is blocked: it waited for ${item.task}. agentctl unblock ${b} --drop-after ${item.task}, or agentctl cancel ${b}`);
      results.push({ task: item.task, kind: item.kind, blocks: item.blocks });
    } catch (e) {
      failures.push(`${item.task}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length > 0) {
    throw new AgentctlError(`${failures.length} of ${plan.items.length} tasks could not be cancelled completely:\n${failures.map((f) => `  - ${f}`).join('\n')}`, 'The others were cancelled. Fix the cause and run cancel again for the failed ones.');
  }
  return results;
}
