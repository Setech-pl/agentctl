import { checkHostLimit } from './host-limits.ts';
import { collectStatus } from './status.ts';
import { inspectField } from './input-field.ts';
import { classifyScreen, inputVisible, startupDialogShown } from './state.ts';
import type { TaskState } from './state.ts';
import { stateWriteFailure } from './atomic-file.ts';
import { withStartLock } from './start-lock.ts';
import { liveWindows } from './plan.ts';
import { checkWindowLimit } from './checks.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { taskLock, withFileLock } from './file-lock.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import { codexBackgroundComposer, queuePrompt, deliverPendingPrompt } from './prompt-delivery.ts';
import { recordJournal } from './journal.ts';
import { AgentctlError } from './util.ts';

export interface QueuedPrompt { id: string; text: string; queuedAt: string; waitForTurnEnd?: boolean; idleTicks?: number }
export const queueFile = (ctx: Context, window: string) => path.join(ctx.config.stateDir, window, 'prompt-queue.json');
export function readPromptQueue(ctx: Context, window: string): QueuedPrompt[] {
  try { const data: unknown = JSON.parse(fs.readFileSync(queueFile(ctx, window), 'utf8')); return Array.isArray(data) ? data.filter((p): p is QueuedPrompt => p && typeof p.id === 'string' && typeof p.text === 'string' && typeof p.queuedAt === 'string') : []; } catch { return []; }
}
export async function enqueuePrompt(ctx: Context, window: string, text: string, options: { waitForTurnEnd?: boolean } = {}): Promise<QueuedPrompt> {
  return withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    const item = { id: randomUUID(), text, queuedAt: new Date(ctx.runner.now()).toISOString(), ...(options.waitForTurnEnd ? { waitForTurnEnd: true } : {}) };
    await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify([...readPromptQueue(ctx, window), item]));
    await ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up queued ${item.queuedAt} (${item.id})\n\n${text.trim()}\n`);
    await recordJournal(ctx, { kind: 'delivery-queued', task: readTaskRecord(ctx.config, window)?.task ?? window, text: `message ${item.id} queued since ${item.queuedAt}; waiting for idle/turn end` });
    return item;
  });
}

/** An explicit follow-up may take over from a stalled Kimi start once its pane can accept input. */
async function replaceStalledKimiStart(ctx: Context, window: string, next: QueuedPrompt): Promise<boolean> {
  const file = taskFile(ctx.config, window);
  return withFileLock(taskLock(file), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record || record.closed || record.cancelled || record.agent !== 'kimi' || record.promptKind === 'followup'
      || record.promptDelivery !== 'needs-attention' || !record.pendingPrompt || !record.deliveryStartedAt
      || record.deliveryResult === 'queued-in-agent' || record.deliveryResult === 'queued-in-agent-confirmed' || stateWriteFailure(file)) return false;
    const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    const settings = ctx.config.agents.kimi, field = inspectField(pane.stdout, 'kimi');
    if (pane.code !== 0 || classifyScreen(pane.stdout, settings) !== 'idle' || startupDialogShown(pane.stdout, settings)
      || !inputVisible(pane.stdout, settings) || !field.readable || field.area.length !== 0) return false;
    // Reuse the queued ID. If interrupted before dequeue, the ordinary FIFO transfer recognizes the same active delivery.
    await queuePrompt(ctx, record, next.text, 'pending', { kind: 'followup', id: next.id });
    await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: follow-up ${next.id} replaced the unconfirmed start ${record.deliveryId ?? 'legacy'}; original instructions remain in TASK.md` });
    return true;
  });
}

/** Durable FIFO. Only a stalled Kimi start can yield to a follow-up in a verified empty pane. */
export async function drainPromptQueue(ctx: Context, window: string, turnState?: TaskState): Promise<void> {
  if (ctx.runner.dryRun) return;
  await withStartLock(ctx, () => withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    let record = readTaskRecord(ctx.config, window);
    if (!record || record.closed || record.cancelled || stateWriteFailure(taskFile(ctx.config, window))) return;
    let queue = readPromptQueue(ctx, window);
    let stalledStart = false;
    if (record.pendingPrompt && record.promptDelivery !== 'sent') {
      if (record.promptDelivery === 'launching') return;
      const outcome = await deliverPendingPrompt(ctx, window);
      stalledStart = outcome === 'needs-attention' && record.agent === 'kimi' && record.promptKind !== 'followup';
      if (outcome !== 'sent' && !stalledStart) return;
    }
    while (queue.length) {
      record = readTaskRecord(ctx.config, window)!;
      if (record.agent !== 'unknown') {
        const live = await liveWindows(ctx);
        if (live.some(w => w.window === window && w.counted === false) && (checkWindowLimit(record.agent, ctx.config.limits[record.agent], live, ctx.config.session) || checkHostLimit(ctx.config, { ...record, agent: record.agent }, live))) return;
      }
      // Codex redraws its composer mid-turn. Keep the FIFO intact until watch observes idle.
      if (record.agent === 'codex') {
        const item = queue[0]!;
        const resetIdle = async () => {
          if (!item.idleTicks) return;
          queue[0] = { ...item, idleTicks: 0 };
          await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue));
        };
        const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        if (screen.code !== 0) { await resetIdle(); return; }
        const settings = ctx.config.agents.codex;
        const screenState = classifyScreen(screen.stdout, settings);
        const background = screenState === 'background' && codexBackgroundComposer(screen.stdout, settings)?.area.length === 0;
        if (screenState !== 'idle' && !background) { await resetIdle(); return; }
        if (item.waitForTurnEnd || background) {
          const state = background ? 'background' : turnState ?? (await collectStatus(ctx, { progress: false, cachedOnly: true, records: { current: [record], archived: [] }, orphans: false }))[0]?.state;
          if (state !== 'waiting' && state !== 'report-ready' && !background) { await resetIdle(); return; }
          // Report-ready and the background badge bypass status's idle counter. Confirm their empty idle frames here.
          const ended = Date.parse(record.turnEndedAt ?? '') > Date.parse(item.queuedAt);
          if (background || (state === 'report-ready' && !ended)) {
            const idleTicks = (Number.isSafeInteger(item.idleTicks) ? Math.max(0, item.idleTicks!) : 0) + 1;
            if (idleTicks < ctx.config.watch.idleConfirmTicks) {
              queue[0] = { ...item, idleTicks };
              await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue));
              return;
            }
          }
        }
      }
      const item = queue[0]!;
      if (stalledStart && !await replaceStalledKimiStart(ctx, window, item)) return;
      if (!stalledStart && record.deliveryId !== item.id) await queuePrompt(ctx, record, item.text, 'pending', { kind: 'followup', id: item.id });
      // Transfer persisted before the item leaves the FIFO. Recovery sees the same delivery ID.
      queue = queue.slice(1);
      await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue));
      const result = await deliverPendingPrompt(ctx, window);
      const fresh = readTaskRecord(ctx.config, window)!;
      if (fresh.deliveryStartedAt) await ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up ${result === 'sent' ? 'sent' : 'pasted, unconfirmed'} ${fresh.deliveryStartedAt} (${item.id})\n`);
      if (result !== 'sent') return;
      if (record.agent === 'codex') return; // One queued turn per idle observation.
      stalledStart = false;
    }
  }));
}

export function promptQueueView(ctx: Context, window: string, record?: ReturnType<typeof readTaskRecord>) {
  const known = record ?? readTaskRecord(ctx.config, window);
  const active = known?.pendingPrompt && known.promptDelivery !== 'sent' ? [{ id: known.deliveryId ?? 'legacy', text: known.pendingPrompt, state: known.deliveryResult === 'stale' ? 'stale' : (known.promptDelivery ?? 'pending') }] : [];
  return [...active, ...readPromptQueue(ctx, window).filter(p => p.id !== known?.deliveryId).map(({ idleTicks: _idleTicks, ...p }) => ({ ...p, state: 'queued' }))];
}

/** Reading a report never acknowledges a message or releases a dependent task. */
export function reportMessageWarning(ctx: Context, window: string, record = readTaskRecord(ctx.config, window)): string | undefined {
  const queued = readPromptQueue(ctx, window)[0];
  if (queued) return `message ${queued.id} pending since ${queued.queuedAt} – report may predate it`;
  if (record?.pendingPrompt && record.promptDelivery !== 'sent') return `message ${record.deliveryId ?? 'legacy'} ${record.deliveryResult === 'stale' ? 'withdrawn (stale)' : 'pending'} since ${record.deliveryStartedAt ?? record.started} – report may predate it`;
  return record?.reportMessageWarning;
}

export interface WithdrawResult {
  /** withdrawn: the message left the queue before its delivery began; stale: the delivery already began, the agent may already work on it. */
  outcome: 'withdrawn' | 'stale';
  id: string;
  message: string;
}

/**
 * `agentctl send --withdraw` / MCP `send` with `withdraw`: take a waiting message back, by id or a unique prefix of it
 * (peek/status list them in prompt_queue). A FIFO entry simply leaves the queue. The active pending prompt leaves only before
 * its delivery began; once agentctl started delivering it, the agent may already work on it, so the message is marked stale
 * instead: the delivery machinery finishes its confirmation, and status, peek and the journal say the user withdrew it.
 */
export async function withdrawPrompt(ctx: Context, window: string, idPrefix: string): Promise<WithdrawResult> {
  return withStartLock(ctx, () => withFileLock(`${queueFile(ctx, window)}.lock`, async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) throw new AgentctlError(`no task state for window ${window}`);
    const now = new Date(ctx.runner.now()).toISOString();
    const note = (text: string) => ctx.runner.appendFile(taskFile(ctx.config, window), `\n\n## Follow-up withdrawn ${now} (${text})\n`);
    // Match the prefix against the active delivery and the FIFO together, before anything changes: a prefix that names both
    // is ambiguous across the two, not "the active one wins".
    const queue = readPromptQueue(ctx, window);
    const matches = queue.filter((p) => p.id === idPrefix || p.id.startsWith(idPrefix));
    const activeId = record.pendingPrompt && record.promptDelivery !== 'sent' ? record.deliveryId : undefined;
    const activeMatch = activeId !== undefined && (activeId === idPrefix || activeId.startsWith(idPrefix));
    // An interrupted durable transfer leaves the same id in the FIFO and the active delivery: it is one message
    // (prompt_queue shows it once), so matching copies of the active id reconcile instead of reading as ambiguous.
    const duplicates = activeId === undefined ? [] : queue.filter((p) => p.id === activeId);
    const others = matches.filter((p) => p.id !== activeId);
    if (activeMatch && others.length > 0) throw new AgentctlError(
      `${record.task}: ${idPrefix} matches the message being delivered and ${others.length} queued message${others.length === 1 ? '' : 's'}`,
      `Choose a longer prefix: ${activeId.slice(0, 8)} (being delivered), ${others.map((p) => `${p.id.slice(0, 8)} (queued)`).join(', ')}.`,
    );
    // The active pending prompt first.
    if (activeMatch) {
      const id = activeId;
      const dropDuplicates = async () => { if (duplicates.length > 0) await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue.filter((p) => p.id !== id))); };
      // The FIFO copy goes first, the active identity only after it: an interruption between the two writes leaves the
      // message as the active delivery, never as an eligible queued duplicate (recovery would deliver it again).
      if (record.deliveryStartedAt) {
        await dropDuplicates();
        await setHeaderFields(ctx.runner, taskFile(ctx.config, window), { delivery_report_baseline: null, report_message_warning: `message ${id} withdrawn (stale) since ${now} – report may predate it`, delivery_result: 'stale', prompt_error: `wiadomość wycofana (${now}) po rozpoczęciu dostarczania – agent może już nad nią pracować` });
        await note(`${id}, stale`);
        await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano wiadomość po rozpoczęciu dostarczania (stale); agent może już nad nią pracować [dostawa ${id.slice(0, 8)}]` });
        return { outcome: 'stale', id, message: `${record.task}: dostarczanie już się zaczęło – wiadomość oznaczona jako wycofana (stale), agent może już nad nią pracować; nic nie jest wycofywane z okna` };
      }
      await dropDuplicates();
      await setHeaderFields(ctx.runner, taskFile(ctx.config, window), { delivery_report_baseline: null, report_message_warning: `message ${id} withdrawn since ${now} – report may predate it`, pending_prompt: null, prompt_delivery: null, prompt_error: null, delivery_id: null, delivery_result: null });
      await note(id);
      await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano oczekującą wiadomość przed rozpoczęciem dostarczania [dostawa ${id.slice(0, 8)}]` });
      return { outcome: 'withdrawn', id, message: `${record.task}: wycofano oczekującą wiadomość (${id.slice(0, 8)}) – nie zostanie wysłana` };
    }
    if (record.deliveryId === idPrefix && record.promptDelivery === 'sent') throw new AgentctlError(`${record.task}: the message ${idPrefix} is already delivered`, 'Only a waiting message can be withdrawn; prompt_queue in peek/status lists them.');
    // A FIFO entry.
    if (matches.length > 1) throw new AgentctlError(`${record.task}: ${idPrefix} matches ${matches.length} queued messages`, `Choose one: ${matches.map((p) => p.id.slice(0, 8)).join(', ')}.`);
    const entry = matches[0];
    if (!entry) throw new AgentctlError(`${record.task}: no waiting message ${idPrefix}`, 'prompt_queue in peek/status lists the waiting messages with their ids.');
    await ctx.runner.writeFile(queueFile(ctx, window), JSON.stringify(queue.filter((p) => p !== entry)));
    await setHeaderFields(ctx.runner, taskFile(ctx.config, window), { delivery_report_baseline: null, report_message_warning: `message ${entry.id} withdrawn since ${entry.queuedAt} – report may predate it` });
    await note(entry.id);
    await recordJournal(ctx, { kind: 'delivery', task: record.task, text: `${record.task}: wycofano wiadomość z kolejki (${entry.id.slice(0, 8)})` });
    return { outcome: 'withdrawn', id: entry.id, message: `${record.task}: wycofano wiadomość z kolejki (${entry.id.slice(0, 8)}) – nie zostanie wysłana` };
  }));
}
