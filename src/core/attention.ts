import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import type { Notifier } from './notify.ts';
import { withFileLock } from './file-lock.ts';
import { channelMessages, messageWithBody, OWNER_IDENTITY, postMessage, setStatus } from './wall.ts';
import { recordJournal } from './journal.ts';
import { notifyPhone } from './phone-send.ts';
import { Alerts } from './alert.ts';
interface Attention { since?: number; notified?: boolean; wall?: string }
const attemptKey = (row: StatusRow) => `${row.task}:${row.attemptId ?? row.started}`;

/** Origins are in WALL itself, including requests whose old attention timer has already been removed. */
async function resolveAttention(ctx: Context, rows: StatusRow[]): Promise<void> {
  const byOrigin = new Map(rows.map(row => [`attention:${attemptKey(row)}`, row]));
  for (const message of channelMessages(ctx.config, 'agentctl')) {
    if (message.status !== 'open' || message.kind !== 'decision-request' || !message.from.startsWith('task:')
        || !message.origin?.startsWith(`attention:${message.from.slice(5)}:`)) continue;
    const row = byOrigin.get(message.origin);
    const ended = !row || row.closed || row.cancelled || row.archived || row.state === 'superseded';
    if (!ended && (row.state === 'host-unreachable' || row.tmuxLost || row.hint?.includes('State write failed:'))) continue;
    const gone = ended || row.window !== 'alive';
    if (!gone && (row.state === 'needs-trust' || row.state === 'needs-input')) {
      const previous = /: (needs-trust|needs-input) od /.exec(messageWithBody(ctx.config, message).body)?.[1];
      if (!previous || row.state === previous) continue;
    }
    await setStatus(ctx, OWNER_IDENTITY, {id: message.id, status: gone ? 'superseded' : 'answered',
      note: gone ? 'Watch: zadanie lub próba zakończona, prośba już nieaktualna.' : 'Watch: zadanie wyszło ze stanu oczekiwania na tę decyzję.'}, 'open');
  }
}

/** Durable timer and one escalation per task attempt, independent of watcher restarts and ordinary state notifications. */
export async function attentionTick(ctx: Context, rows: StatusRow[], notifier: Notifier): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = path.join(ctx.config.stateDir, 'attention.json');
  await withFileLock(`${file}.lock`, async () => {
    await resolveAttention(ctx, rows);
    let state: Record<string, Attention> = {};
    try {state = JSON.parse(fs.readFileSync(file, 'utf8'));} catch { /* first tick */ }
    const active = new Set<string>();
    for (const row of rows) {
      const key = attemptKey(row);
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
