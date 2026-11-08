import { PROVIDER_IDS } from './providers/types.ts';
import type { ProviderId } from './providers/types.ts';
import fs from 'node:fs';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import { collectStatus } from './status.ts';
import { readTaskRecord } from './taskstore.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { screenMetadata } from './tmux.ts';
import type { ScreenState, TaskState } from './state.ts';

export type RecoveryPhase = 'before-paste' | 'before-enter';
/** Shared overload/limited guards are re-run immediately before paste and Enter. */
export async function recoveryGuard(ctx: Context, row: StatusRow, allowed: TaskState[], screens: ScreenState[], message: string, phase: RecoveryPhase): Promise<boolean> {
  const fresh = (await collectStatus(ctx, { progress: false })).find(t => t.task === row.task);
  const record = readTaskRecord(ctx.config, row.windowName);
  if (!fresh || fresh.finished || fresh.window !== 'alive' || fresh.windowId !== row.windowId || !allowed.includes(fresh.state) || fresh.report === 'yes' || fresh.reportCandidate || !record || record.reportCandidate || record.pulled || record.summaryDelivered || (record.report && fs.existsSync(record.report)) || record.pendingPrompt) return false;
  const captured = await ctx.tmux.capture(row.windowName, undefined, undefined, row.windowId ?? undefined);
  if (captured.code !== 0 || !(PROVIDER_IDS as readonly string[]).includes(row.agent)) return false;
  const agent = ctx.config.agents[row.agent as ProviderId];
  const draft = screenMetadata(captured.stdout).draft_input;
  return !agent.backgroundPatterns.some(p => new RegExp(p, 'im').test(captured.stdout)) && screens.includes(classifyScreen(captured.stdout, agent)) && inputVisible(captured.stdout, agent) && (!draft || (phase === 'before-enter' && draft === message));
}
