import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import type { Notifier } from './notify.ts';
import { withFileLock } from './file-lock.ts';
import { postMessage } from './wall.ts';
import { recordJournal } from './journal.ts';
import { notifyPhone } from './phone-send.ts';
import { Alerts } from './alert.ts';
interface Attention { since?: number; notified?: boolean; wall?: string }
/** Durable timer and one escalation per task attempt, independent of watcher restarts and ordinary state notifications. */
export async function attentionTick(ctx: Context, rows: StatusRow[], notifier: Notifier): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = path.join(ctx.config.stateDir, 'attention.json');
  await withFileLock(`${file}.lock`, async () => {
    let state: Record<string, Attention> = {};
    try {state = JSON.parse(fs.readFileSync(file, 'utf8'));} catch { /* first tick */ }
    const active = new Set<string>();
    for (const row of rows) {
      const key = `${row.task}:${row.attemptId ?? row.started}`;
      active.add(key);
      const entry = state[key] ??= {};
      if (row.closed || row.cancelled || row.window !== 'alive' || !['needs-trust', 'needs-input'].includes(row.state)) {delete entry.since; continue;}
      entry.since ??= ctx.runner.now();
      if (entry.notified || ctx.runner.now() - entry.since < ctx.config.notify.attentionAfterMin * 60000) continue;
      const text = `${row.task}: ${row.state} od ${Math.floor((ctx.runner.now() - entry.since) / 60000)} min – wymaga decyzji właściciela. agentctl attach ${row.task}`;
      const message = await postMessage(ctx, {id: `task:${row.task}`, kind: 'task'}, {channel: 'agentctl', to: 'owner', kind: 'decision-request', subject: `${row.task}: długie oczekiwanie na odpowiedź`, body: text, origin: `attention:${key}`});
      entry.wall = message.id;
      entry.notified = true;
      // Claim before external delivery: a restart cannot spam the owner; ntfy queues network failures itself.
      await ctx.runner.writeFile(file, JSON.stringify(state));
      await new Alerts(ctx, notifier).send({task: row.task, window: row.windowName}, 'attention-timeout', text, 'watch').catch(() => undefined);
      await notifyPhone(ctx, {kind: row.state as 'needs-trust' | 'needs-input', task: row.task, cohort: row.cohort ?? undefined, text}, {forceActive: true}).catch(() => undefined);
      await recordJournal(ctx, {kind: 'needs-attention', task: row.task, text: `${text}; WALL ${message.id}`});
    }
    for (const key of Object.keys(state)) if (!active.has(key)) delete state[key];
    await ctx.runner.writeFile(file, JSON.stringify(state));
  });
}
