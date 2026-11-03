import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { StatusRow } from './status.ts';
import { collectStatus } from './status.ts';
import type { Notifier } from './notify.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { screenMetadata } from './tmux.ts';
import { recordJournal } from './journal.ts';
import { readTaskRecord } from './taskstore.ts';
import { errorMessage } from './util.ts';

interface Retry { since: number; firstAt: number; attempts: number; attention?: boolean; workingSince?: number }
/** An episode survives brief work and watcher restarts; only sustained recovery or completion ends it. */
export async function overloadTick(ctx: Context, rows: StatusRow[], notifier: Notifier): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = path.join(path.dirname(ctx.config.path), 'overload-retries.json');
  let state: Record<string, Retry> = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first tick */ }
  const now = ctx.runner.now(), settings = ctx.config.overload;
  const persist = () => ctx.runner.writeFile(file, JSON.stringify(state));
  for (const task of Object.keys(state)) {
    const row = rows.find(r => r.task === task);
    const episode = state[task]!;
    if (!row || row.finished || row.closed || row.cancelled || row.report === 'yes' || row.state === 'report-ready') { delete state[task]; continue; }
    if (row.state === 'working') {
      episode.workingSince ??= now;
      if (now - episode.workingSince >= settings.resetAfterS * 1000) delete state[task];
    } else delete episode.workingSince;
  }
  for (const row of rows) {
    if (row.state !== 'overloaded' || row.window !== 'alive' || row.finished || row.report === 'yes' || row.reportCandidate) continue;
    const r = state[row.task] ??= { since: now, firstAt: now, attempts: 0 };
    r.firstAt ??= r.since;
    if (!settings.autoRetry) continue;
    if (r.attempts >= settings.maxRetries || now - r.firstAt >= settings.giveUpAfter * 1000) {
      if (!r.attention) {
        r.attention = true; await persist();
        const text = `${row.task}: overloaded – wymaga uwagi (${r.attempts} ponowień; max_retries/give_up_after)`;
        await recordJournal(ctx, { kind: 'overloaded', task: row.task, text });
        await notifier.notify('agentctl', text).catch(() => undefined);
      }
      continue;
    }
    if (now - r.since < settings.retryAfter * 1000) continue;
    const guard = async (phase: 'before-paste' | 'before-enter'): Promise<boolean> => {
      const fresh = (await collectStatus(ctx, { progress: false })).find(t => t.task === row.task);
      const record = readTaskRecord(ctx.config, row.windowName);
      if (!fresh || fresh.finished || fresh.window !== 'alive' || fresh.windowId !== row.windowId || fresh.state !== 'overloaded' || fresh.report === 'yes' || fresh.reportCandidate || !record || record.reportCandidate || record.pulled || record.summaryDelivered || (record.report && fs.existsSync(record.report))) return false;
      const captured = await ctx.tmux.capture(row.windowName, undefined, undefined, row.windowId ?? undefined);
      if (captured.code !== 0 || !['claude', 'codex'].includes(row.agent)) return false;
      const agent = ctx.config.agents[row.agent as 'claude' | 'codex'];
      const draft = screenMetadata(captured.stdout).draft_input;
      return !agent.backgroundPatterns.some(p => new RegExp(p, 'im').test(captured.stdout)) && classifyScreen(captured.stdout, agent) === 'overloaded' && inputVisible(captured.stdout, agent) && (!draft || (phase === 'before-enter' && draft === settings.message));
    };
    try {
      if (!await guard('before-paste')) continue;
      r.attempts++; r.since = now; await persist();
      await recordJournal(ctx, { kind: 'overload-retry', task: row.task, text: `${row.task}: overload retry ${r.attempts}/${settings.maxRetries}` });
      const sent = await ctx.tmux.submitPrompt(row.windowName, settings.message, guard);
      if (!sent) throw new Error('screen/report changed before submit; Enter was not sent, inspect pasted input');
    } catch (e) {
      await recordJournal(ctx, { kind: 'overload-retry', task: row.task, text: `${row.task}: retry failed: ${errorMessage(e)}` });
      await notifier.notify('agentctl', `${row.task}: overload retry wymaga uwagi`).catch(() => undefined);
    }
  }
  await persist();
}
