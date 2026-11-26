import { PROVIDER_IDS } from './providers/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import type { GlobalConfig, AgentName } from './config.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';
import { withCommandStage } from './command-stage.ts';

export interface StartReservation { owner?: string; host?: string; id: string; task: string; window: string; agent: AgentName; pid: number; at: string }
const file = (config: Pick<GlobalConfig, 'stateDir'>) => path.join(config.stateDir, 'start-reservations.json');
export function pendingStarts(config: Pick<GlobalConfig, 'stateDir'>): StartReservation[] {
  try {
    const entries = JSON.parse(fs.readFileSync(file(config), 'utf8')) as StartReservation[];
    return entries.filter(r => {
      if (!r || typeof r.id !== 'string' || (!Number.isInteger(r.pid) || r.pid <= 0) || !(PROVIDER_IDS as readonly string[]).includes(r.agent)) return false;
      try { process.kill(r.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
export async function withStartLock<T>(ctx: Context, action: () => Promise<T>, task = 'admission'): Promise<T> {
  if (ctx.runner.dryRun) return action();
  let recovered: { pid?: number; task?: string; at?: string } | undefined;
  try {
    return await withFileLock(path.join(ctx.config.stateDir, 'start.lock'), () => withCommandStage(30_000, undefined, action), 5000, false, {
      task, staleMs: ctx.config.startLockStaleS * 1000, recovered: owner => { recovered = owner; },
    });
  } finally {
    if (recovered) {
      const text = `Usunięto nieaktywną blokadę start.lock (PID ${recovered.pid || 'brak'}, zadanie ${recovered.task ?? 'nieznane'}, od ${recovered.at ?? 'nieznane'}).`;
      ctx.info(text);
      void recordJournal(ctx, { kind: 'start-lock-recovered', text }).catch(() => undefined);
    }
  }
}
/** Caller holds start.lock: this durable write reserves capacity before checkout or the first TASK.md. */
export async function reserveStarts(ctx: Context, tasks: { task: string; window: string; agent: AgentName; host?: string; owner?: string }[]): Promise<string[]> {
  if (ctx.runner.dryRun) return [];
  const reservations = tasks.map(task => ({ ...task, id: randomUUID(), pid: process.pid, at: new Date(ctx.runner.now()).toISOString() }));
  await ctx.runner.writeFile(file(ctx.config), JSON.stringify([...pendingStarts(ctx.config), ...reservations]));
  return reservations.map(r => r.id);
}
export async function releaseStarts(ctx: Context, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await withStartLock(ctx, async () => {
    await ctx.runner.writeFile(file(ctx.config), JSON.stringify(pendingStarts(ctx.config).filter(r => !ids.includes(r.id))));
  });
}
