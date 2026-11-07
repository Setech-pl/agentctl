import { PROVIDER_IDS } from './providers/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import type { GlobalConfig, AgentName } from './config.ts';
import { withFileLock } from './file-lock.ts';

export interface StartReservation { id: string; task: string; window: string; agent: AgentName; pid: number; at: string }
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
export function withStartLock<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  return ctx.runner.dryRun ? action() : withFileLock(path.join(ctx.config.stateDir, 'start.lock'), action);
}
/** Caller holds start.lock: this durable write reserves capacity before checkout or the first TASK.md. */
export async function reserveStarts(ctx: Context, tasks: { task: string; window: string; agent: AgentName }[]): Promise<string[]> {
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
