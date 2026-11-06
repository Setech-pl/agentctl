import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { TaskRecord } from './taskstore.ts';
import { taskDir } from './taskstore.ts';
import { readTaskSessions } from './usage.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';

/** A missing launched window is recoverable work, even after watch recreates the server/session. */
export async function tmuxLoss(ctx: Context, record: TaskRecord, alive: boolean, complete: boolean): Promise<string | undefined> {
  if (complete) return undefined;
  const file = path.join(taskDir(ctx.config, record.window), 'tmux-loss.json');
  let previous: { identity?: string; active?: boolean } | undefined;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no observation yet */ }
  const identity = `${record.attemptId ?? record.started}:${record.windowId ?? ''}`;
  // TASK.md is written only for agent launches; legacy records may predate window IDs.
  if (alive) {
    if (!ctx.runner.dryRun && previous?.active) await ctx.runner.writeFile(file, JSON.stringify({ identity, active: false }));
    return undefined;
  }
  const sessions = record.agent === 'unknown' ? [] : readTaskSessions(ctx.config, record.window)[record.agent] ?? [];
  const launched = record.agent !== 'unknown' && (record.promptDelivery !== 'launching' || !!record.windowId);
  if (!launched) return undefined;
  const recovery = sessions.length > 0
    ? `agentctl resume ${record.task}`
    : `re-queue as a new task from the old worktree ${record.repos[0]?.worktree ?? '(see TASK.md)'}; prepare a new task ID/spec pointing at it, then agentctl new --reuse`;
  const hint = `Utracono serwer/sesję tmux (tmux server/session lost); ${recovery}`;
  if (!ctx.runner.dryRun) await withFileLock(`${file}.lock`, async () => {
    let last: typeof previous;
    try { last = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first loss */ }
    if (last?.identity === identity && last.active) return;
    await ctx.runner.writeFile(file, JSON.stringify({ identity, active: true }));
    await recordJournal(ctx, { kind: 'tmux-lost', task: record.task, text: hint });
  });
  return hint;
}
