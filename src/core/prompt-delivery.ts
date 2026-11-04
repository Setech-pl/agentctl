import path from 'node:path';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { classifyScreen, inputVisible } from './state.ts';
import { screenMetadata } from './tmux.ts';
import { readTaskRecord, setHeaderFields, taskFile } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import { errorMessage } from './util.ts';

/** Persist before waiting for trust, so a watcher can finish the same delivery after new returns. */
export async function queuePrompt(ctx: Context, record: TaskRecord, text: string, delivery: 'launching' | 'pending' = 'pending'): Promise<void> {
  await setHeaderFields(ctx.runner, taskFile(ctx.config, record.window), { pending_prompt: text, prompt_delivery: delivery, prompt_error: null, prompt_sent_at: null });
}

/** Initial prompts and resume instructions are pasted once. Only Enter can be retried (twice). */
export async function deliverPendingPrompt(ctx: Context, window: string): Promise<'sent' | 'pending' | 'needs-attention'> {
  if (ctx.runner.dryRun) return 'sent';
  return withFileLock(path.join(ctx.config.stateDir, window, 'prompt-delivery.lock'), async () => {
    const record = readTaskRecord(ctx.config, window);
    if (!record) return 'needs-attention';
    if (record.promptDelivery === 'sent') return 'sent';
    if (record.promptDelivery === 'needs-attention' || !record.pendingPrompt || record.agent === 'unknown') return 'needs-attention';
    const file = taskFile(ctx.config, window), settings = ctx.config.agents[record.agent], text = record.pendingPrompt;
    const attention = async (why: string) => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'needs-attention', prompt_error: `Prompt delivery not confirmed: ${why}. Inspect ${record.task} with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.` });
      return 'needs-attention' as const;
    };
    if (record.promptDelivery === 'launching') return 'pending';
    if (record.promptDelivery === 'sending') return attention('a previous sender stopped before recording acknowledgement');
    const before = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
    if (before.code !== 0 || !inputVisible(before.stdout, settings) || classifyScreen(before.stdout, settings) !== 'idle') return 'pending';
    if (screenMetadata(before.stdout).draft_input) return attention('the input already contains a draft; it was not overwritten');
    const ownsDraft = (draft: string) => text.startsWith(draft) || draft.startsWith(text.split('\n')[0]!) || /\[Pasted|pasted (?:text|content)/i.test(draft);
    const sent = async () => {
      await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sent', pending_prompt: null, prompt_error: null, prompt_sent_at: new Date(ctx.runner.now()).toISOString() });
      return 'sent' as const;
    };
    await setHeaderFields(ctx.runner, file, { prompt_delivery: 'sending' });
    try {
      await ctx.tmux.pasteText(window, text);
      await ctx.runner.sleep(400);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await ctx.runner.sleep(400);
        const ready = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
        const currentState = classifyScreen(ready.stdout, settings), currentDraft = screenMetadata(ready.stdout).draft_input;
        if (ready.code === 0 && !currentDraft && (currentState === 'working' || currentState === 'background' || (currentState === 'needs-input' && ready.stdout !== before.stdout) || (ready.stdout !== before.stdout && /(?:⏺|● got:|^\s*[•■])/m.test(ready.stdout)))) return sent();
        if (currentDraft && !ownsDraft(currentDraft)) return attention('the input changed before Enter');
        if (ready.code !== 0 || currentState !== 'idle') return attention('the agent is no longer idle before Enter');
        const enter = await ctx.tmux.pressEnter(window);
        if (enter.code !== 0) return attention(`Enter failed: ${enter.stderr}`);
        let ourDraft = false;
        for (let poll = 0; poll < 8; poll++) {
          await ctx.runner.sleep(150);
          const pane = await ctx.tmux.capture(window, undefined, undefined, record.windowId, true);
          if (pane.code !== 0) return attention('the pane cannot be read');
          const state = classifyScreen(pane.stdout, settings), draft = screenMetadata(pane.stdout).draft_input;
          // A quick completed turn can finish between polls; require new assistant output as its acknowledgement.
          const completed = !draft && pane.stdout !== before.stdout && /(?:⏺|● got:|^\s*[•■])/m.test(pane.stdout);
          if ((!draft && (state === 'working' || state === 'background')) || completed || (state === 'needs-input' && !draft)) return sent();
          if (state !== 'idle') return attention(`the agent shows ${state}; no further key was sent`);
          ourDraft = Boolean(draft && ownsDraft(draft));
          if (draft && !ourDraft) return attention('the input changed to another draft');
        }
        // Never send another Enter into an empty input: the first submission may already have been accepted.
        if (!ourDraft) return attention('no working state or completed-turn acknowledgement was observed');
      }
      return attention('the pasted prompt is still in the input after Enter and two retries');
    } catch (e) { return attention(errorMessage(e)); }
  });
}
