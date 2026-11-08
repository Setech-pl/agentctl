import { get as providerValue } from './providers/registry.ts';
import type { ProviderValues } from './providers/registry.ts';
import { activeProviders, PROVIDER_IDS } from './providers/registry.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { AgentName } from './config.ts';
import type { StatusRow } from './status.ts';
import type { Notifier } from './notify.ts';
import { formatReset, openReader, readPlans } from './usage.ts';
import type { PlanState } from './usage.ts';
import { recordJournal } from './journal.ts';
import { withFileLock } from './file-lock.ts';
import { recoveryGuard } from './recovery.ts';
import { errorMessage } from './util.ts';

interface Retry { firstAt: number; since: number; attempts: number; attention?: boolean; workingSince?: number }
interface Episode { since: number; reset: number | null; notified: boolean; tasks: Record<string, Retry> }
const readState = (file: string): Partial<Record<AgentName, Episode>> => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
const plansNow = (ctx: Context) => { const reader = openReader(ctx.config); const plans = readPlans(ctx.config, reader, ctx.runner.now()); reader.save(); return plans; };
export function limitedRecovered(ctx: Context, plan: PlanState, episode: Pick<Episode, 'since' | 'reset'>): boolean {
  return (episode.reset !== null && ctx.runner.now() >= episode.reset) || (plan.available && !plan.stale && plan.readAt !== null && plan.readAt >= episode.since && plan.maxPercent !== null && 100 - plan.maxPercent > ctx.config.limited.resumeAbovePercent);
}
/** Once per provider episode, with durable per-task retry counts. Never changes the model/provider. */
export async function limitedTick(ctx: Context, rows: StatusRow[], notifier: Notifier, supplied?: ProviderValues<PlanState>): Promise<void> {
  if (ctx.runner.dryRun) return;
  const file = path.join(path.dirname(ctx.config.path), 'limited-retries.json');
  await withFileLock(`${file}.lock`, async () => {
    const state = readState(file), now = ctx.runner.now(), settings = ctx.config.limited;
    const plans = supplied ?? plansNow(ctx);
    const persist = () => ctx.runner.writeFile(file, JSON.stringify(state));
    for (const provider of activeProviders(ctx.config)) {
      const mine = rows.filter(r => r.agent === provider && !r.closed && !r.cancelled && r.window === 'alive' && r.report !== 'yes' && !r.finished);
      const limited = mine.filter(r => r.state === 'limited');
      const exhausted = providerValue(plans, provider).windows.filter(w => w.usedPercent >= 100);
      if (!state[provider] && !limited.length) continue;
      const reset = exhausted.length && exhausted.every(w => w.resetsAt !== null) ? Math.max(...exhausted.map(w => w.resetsAt!)) : null;
      const episode = state[provider] ??= { since: now, reset, notified: false, tasks: {} };
      if (episode.reset === null && reset !== null) episode.reset = reset;
      if (!episode.notified) {
        const text = `${provider}: limit wyczerpany – zresetuj lub poczekaj do ${episode.reset === null ? 'n/d' : formatReset(episode.reset, now)}`;
        episode.notified = true; await persist();
        await recordJournal(ctx, { kind: 'limited', ...(limited[0] ? { task: limited[0].task } : {}), text });
        await notifier.notify('agentctl', text).catch(() => undefined);
      }
      for (const task of Object.keys(episode.tasks)) {
        const row = mine.find(r => r.task === task), retry = episode.tasks[task]!;
        if (!row) { delete episode.tasks[task]; continue; }
        if (row.state === 'working' || row.state === 'background') {
          retry.workingSince ??= now;
          if (now - retry.workingSince >= ctx.config.overload.resetAfterS * 1000) delete episode.tasks[task];
        } else delete retry.workingSince;
      }
      for (const row of limited) {
        const retry = episode.tasks[row.task] ??= { firstAt: 0, since: 0, attempts: 0 };
        if (!settings.autoResume || !limitedRecovered(ctx, providerValue(plans, provider), episode)) continue;
        if (retry.attempts >= ctx.config.overload.maxRetries || (retry.firstAt > 0 && now - retry.firstAt >= ctx.config.overload.giveUpAfter * 1000)) {
          if (!retry.attention) {
            retry.attention = true; await persist();
            const text = `${row.task}: limited resume wymaga uwagi (${retry.attempts} prób; max_retries/give_up_after)`;
            await recordJournal(ctx, { kind: 'needs-attention', task: row.task, text });
            await notifier.notify('agentctl', text).catch(() => undefined);
          }
          continue;
        }
        if (retry.attempts && now - retry.since < ctx.config.overload.retryAfter * 1000) continue;
        const guard = async (phase: 'before-paste' | 'before-enter') => limitedRecovered(ctx, providerValue(supplied ?? plansNow(ctx), provider), episode) && await recoveryGuard(ctx, row, ['limited', 'waiting'], ['limited', 'idle'], settings.message, phase);
        try {
          if (!await guard('before-paste')) continue;
          retry.firstAt ||= now; retry.attempts++; retry.since = now; await persist();
          await recordJournal(ctx, { kind: 'limited-resume', task: row.task, text: `${row.task}: limited resume ${retry.attempts}/${ctx.config.overload.maxRetries}` });
          if (!await ctx.tmux.submitPrompt(row.windowName, settings.message, guard)) throw new Error('screen/report changed before submit; inspect pasted input');
        } catch (e) { await recordJournal(ctx, { kind: 'limited-resume', task: row.task, text: `${row.task}: resume failed: ${errorMessage(e)}` }); }
      }
      if (!limited.length && !Object.keys(episode.tasks).length && !exhausted.length) delete state[provider];
    }
    await persist();
  });
}
