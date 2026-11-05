import { provider } from './providers/registry.ts';
import { stateWriteFailure } from './atomic-file.ts';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { inspectReport, reportFingerprint } from './report-state.ts';
import { PATTERN_FLAGS } from './config.ts';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { screenMetadata } from './tmux.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { errorMessage } from './util.ts';

/** Persist before waiting for trust, so a watcher can finish the same delivery after new returns. */
export async function queuePrompt(ctx: Context, record: TaskRecord, text: string, delivery: 'launching' | 'pending' = 'pending', options: { kind?: 'followup'; id?: string } = {}): Promise<void> {
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { pending_prompt: text, prompt_delivery: delivery, prompt_error: null, prompt_sent_at: null, delivery_id: options.id ?? randomUUID(), prompt_kind: options.kind ?? 'initial', delivery_was_busy: null, delivery_started_at: null, delivery_report_baseline: reportFingerprint(record.report) });
}

const outputFingerprint = (screen: string, pattern: string) => createHash('sha256').update(screen.split('\n').filter(line => new RegExp(pattern, PATTERN_FLAGS).test(line)).join('\n')).digest('hex');

export const DELIVERY_WARNING = 'dostarczenie niepotwierdzone – sprawdzam';

/** Hooks are checked first; screen evidence is adapter-specific and never an input draft. */
export function deliveryEvidence(ctx: Context, record: TaskRecord, screen: string): boolean {
  const draft = (record.agent !== 'unknown' ? provider(record.agent).screen.draft?.(screen) : undefined) ?? screenMetadata(screen).draft_input;
  if (draft) return false;
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(ctx.config.stateDir, record.window, 'delivery-evidence.json'), 'utf8'));
    if (record.deliveryId && evidence.accepted === true && evidence.deliveryId === record.deliveryId && Date.parse(evidence.at) >= Date.parse(record.deliveryStartedAt ?? '')) return true;
  } catch { /* no current hook acknowledgement */ }
  const report = inspectReport(ctx.config, record, ctx.runner.now(), false);
  if (report.ready && (!record.deliveryStartedAt || report.signature !== record.deliveryReportBaseline)) return true;
  if (record.agent === 'unknown') return false;
  const settings = ctx.config.agents[record.agent], state = classifyScreen(screen, settings);
  if ((state === 'working' || state === 'background') && !record.deliveryWasBusy) return true;
  // Only output from after this delivery started can acknowledge a fast completed turn.
  if (!record.deliveryStartedAt) return false;
  // A question or idle notification alone can belong to the previous turn.
  if (record.deliveryWasBusy && /Queued follow-up inputs|Queued messages?/i.test(screen) && record.pendingPrompt && screen.includes(record.pendingPrompt.split('\n')[0]!)) return true;
  if (!record.deliveryWasBusy && new RegExp(settings.deliveryPattern, PATTERN_FLAGS).test(screen) && outputFingerprint(screen, settings.deliveryPattern) !== record.deliveryOutputBaseline) return true;
  // A submitted user line followed by an empty composer is a transcript echo, not a draft.
  const marker = provider(record.agent).screen.echoMarker;
  const first = record.pendingPrompt?.split('\n')[0]?.trim();
  const lines = screen.split('\n').filter(line => line.trimStart().startsWith(marker));
  return Boolean(first && lines.length > 1 && lines.slice(0, -1).some(line => line.trim().slice(1).trim() === first));
}

/** Initial prompts and resume instructions are pasted once. Only Enter can be retried (twice). */
export async function deliverPendingPrompt(ctx: Context, window: string): Promise<'sent' | 'pending' | 'confirming' | 'needs-attention'> {
  if (ctx.runner.dryRun) return 'sent';
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) return 'needs-attention';
    if (record.promptDelivery === 'sent') return 'sent';
    const file = taskFile(ctx.config, window);
    if (stateWriteFailure(file)) return 'needs-attention';
    const attention = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'needs-attention', prompt_error: `Prompt delivery not confirmed: ${why}. Inspect ${record.task} with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.` });
      return 'needs-attention' as const;
    };
    const uncertain = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'confirming', prompt_error: `${DELIVERY_WARNING}: ${why}` });
      return 'confirming' as const;
    };
    const sent = async () => {
      await setHeaderFields(ctx.runner, file, { delivery_id: record.deliveryId ?? randomUUID(), prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
      return 'sent' as const;
    };
    if (['sending', 'confirming', 'needs-attention'].includes(record.promptDelivery ?? '')) {
      const screen = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
      if (deliveryEvidence(ctx, record, screen.code === 0 ? screen.stdout : '')) return sent();
      if (record.promptDelivery === 'needs-attention') return 'needs-attention';
      if (ctx.runner.now() - Date.parse(record.deliveryStartedAt ?? record.started) >= ctx.config.deliveryConfirmS * 1000) return attention('no acknowledgement before delivery_confirm_s elapsed');
      return uncertain('awaiting hook, working screen, transcript echo or canonical report');
    }
    if (!record.pendingPrompt || record.agent === 'unknown') return 'needs-attention';
    const settings = ctx.config.agents[record.agent], text = record.pendingPrompt;
    if (record.promptDelivery === 'launching') return 'pending';
    const before = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    const beforeState = classifyScreen(before.stdout, settings);
    const busyFollowup = record.promptKind === 'followup' && settings.acceptsBusyPrompt !== false && ['working', 'background'].includes(beforeState);
    if (before.code !== 0 || !inputVisible(before.stdout, settings) || (!busyFollowup && beforeState !== 'idle')) return 'pending';

    const profile = provider(record.agent).screen;
    const draftOf = (screen: string) => profile.draft ? profile.draft(screen) : screenMetadata(screen).draft_input;
    const ownsDraft = (draft: string) => (profile.stablePaste && /\[paste #\d+/.test(draft)) || text.startsWith(draft) || draft.startsWith(text.split('\n')[0]!) || /\[Pasted|pasted (?:text|content)/i.test(draft);
    record.deliveryWasBusy = busyFollowup;
    record.deliveryStartedAt = new Date(ctx.runner.now()).toISOString();
    record.deliveryOutputBaseline = outputFingerprint(before.stdout, settings.deliveryPattern);
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sending', delivery_was_busy: busyFollowup, delivery_started_at: record.deliveryStartedAt, delivery_output_baseline: record.deliveryOutputBaseline });
    if (draftOf(before.stdout)) return uncertain('the input already contains a draft; it was not overwritten');
    try {
      await ctx.tmux.pasteText(window, text);
      await ctx.runner.sleep(400);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await ctx.runner.sleep(400);
        const ready = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        const currentState = classifyScreen(ready.stdout, settings), currentDraft = draftOf(ready.stdout);
        if (deliveryEvidence(ctx, record, ready.stdout !== before.stdout ? ready.stdout : '')) return sent();
        if (currentDraft && !ownsDraft(currentDraft)) return uncertain('the input changed before Enter');
        if (ready.code !== 0 || (currentState !== 'idle' && !(busyFollowup && ['working', 'background'].includes(currentState)))) return uncertain('the agent is no longer idle before Enter');
        if (profile.stablePaste) {
          await ctx.runner.sleep(200);
          const stable = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          if (stable.code !== 0 || stable.stdout !== ready.stdout) return uncertain('Kimi screen is not stable before Enter');
        }
        const enter = profile.stablePaste
          ? await ctx.runner.exec('tmux', ['send-keys', '-t', await ctx.tmux.targetFor(window), 'C-m'])
          : await ctx.tmux.pressEnter(window);
        if (enter.code !== 0) return uncertain(`Enter failed: ${enter.stderr}`);
        let ourDraft = false;
        for (let poll = 0; poll < 8; poll++) {
          await ctx.runner.sleep(150);
          const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          if (pane.code !== 0) return uncertain('the pane cannot be read');
          const state = classifyScreen(pane.stdout, settings), draft = draftOf(pane.stdout);
          // A quick completed turn can finish between polls; require new assistant output as its acknowledgement.
          if (deliveryEvidence(ctx, record, pane.stdout !== before.stdout ? pane.stdout : '')) return sent();
          if (state !== 'idle' && !(busyFollowup && ['working', 'background'].includes(state))) return uncertain(`the agent shows ${state}; no further key was sent`);
          ourDraft = Boolean(draft && ownsDraft(draft));
          if (draft && !ourDraft) return uncertain('the input changed to another draft');
        }
        // Never send another Enter into an empty input: the first submission may already have been accepted.
        if (!ourDraft) return uncertain('no working state or completed-turn acknowledgement was observed');
      }
      return uncertain('the pasted prompt is still in the input after Enter and two retries');
    } catch (e) { return uncertain(errorMessage(e)); }
  });
}
