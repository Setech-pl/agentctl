import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import type { Notifier } from './notify.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { screenMetadata } from './tmux.ts';
import { recordJournal } from './journal.ts';

interface Retry { since: number; attempts: number; attention?: boolean }
/** Retry only a freshly captured idle screen, with an empty visible input. Never change provider/model. */
export async function overloadTick(ctx: Context, rows: StatusRow[], notifier: Notifier): Promise<void> {
  const file = path.join(path.dirname(ctx.config.path), 'overload-retries.json');
  let state: Record<string, Retry> = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first tick */ }
  const now = ctx.runner.now();
  const settings = ctx.config.overload;
  for (const row of rows) {
    if (row.state !== 'overloaded' || row.window !== 'alive') continue;
    const r = state[row.task] ??= { since: now, attempts: 0 };
    if (!settings.autoRetry || now - r.since < settings.retryAfter * 1000) continue;
    if (r.attempts >= settings.maxRetries) {
      if (!r.attention) {
        r.attention = true;
        const text = `${row.task}: overloaded – wymaga uwagi (${r.attempts} ponowień)`;
        await recordJournal(ctx, { kind: 'overloaded', task: row.task, text });
        await notifier.notify('agentctl', text).catch(() => undefined);
      }
      continue;
    }
    const screen = await ctx.tmux.capture(row.windowName, undefined, undefined, row.windowId ?? undefined);
    if (screen.code !== 0 || !['claude', 'codex'].includes(row.agent)) continue;
    const agent = ctx.config.agents[row.agent as 'claude' | 'codex'];
    if (agent.backgroundPatterns.some(p => new RegExp(p, 'im').test(screen.stdout))) continue;
    if (classifyScreen(screen.stdout, agent) !== 'overloaded' || !inputVisible(screen.stdout, agent) || screenMetadata(screen.stdout).draft_input) continue;
    // Persist the attempt before sending: a watcher crash must not duplicate a retry.
    r.attempts++; r.since = now;
    await ctx.runner.writeFile(file, JSON.stringify(state));
    await recordJournal(ctx, { kind: 'overload-retry', task: row.task, text: `${row.task}: overload retry ${r.attempts}/${settings.maxRetries}` });
    await ctx.tmux.submitPrompt(row.windowName, settings.message);
  }
  await ctx.runner.writeFile(file, JSON.stringify(state));
}
