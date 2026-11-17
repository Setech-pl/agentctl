import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import { pulledOpen } from './pulled.ts';
import { closeTask } from './close.ts';
import { recordJournal } from './journal.ts';

/** Owner opt-in only, measured from acknowledgement of the current report. No worktree removal. */
export async function autoClosePulled(ctx: Context, rows: StatusRow[]): Promise<boolean> {
  const hours = ctx.config.board.pulledAutoCloseAfter;
  if (hours == null) return false;
  let changed = false;
  for (const row of rows) {
    if (!pulledOpen(row) || ctx.runner.now() - Date.parse(row.pulled!) < hours * 3_600_000) continue;
    await closeTask(ctx, row.task);
    await recordJournal(ctx, { kind: 'pulled-auto-close', task: row.task, text: `${row.task}: automatycznie zamknięte po odebraniu raportu (board.pulled_auto_close_after=${hours}h); worktree pozostaje` });
    changed = true;
  }
  return changed;
}
