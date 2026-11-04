import fs from 'node:fs';
import type { Context } from './context.ts';
import { queuePrompt, deliverPendingPrompt, DELIVERY_WARNING } from './prompt-delivery.ts';
import { readTaskRecord, renderFollowUp, taskFile } from './taskstore.ts';
import { AgentctlError, Problems } from './util.ts';

export interface SendItem {
  task: string;
  window: string;
  prompt: string;
}

/** Paste a follow-up prompt into existing windows and log it in TASK.md. */
export async function sendPrompts(ctx: Context, items: SendItem[]): Promise<{ task: string; warning?: string }[]> {
  const { runner, tmux, config } = ctx;
  if (!runner.dryRun) {
    const tool = await runner.exec('tmux', ['-V'], { readOnly: true });
    if (tool.code !== 0) throw new AgentctlError('tmux not found or not working', 'Install tmux: "brew install tmux" (macOS) or "sudo apt install tmux".');
    const windows = await tmux.listWindows();
    const p = new Problems();
    for (const item of items) {
      if (!windows.includes(item.window)) {
        p.add(`${item.task}: no tmux window "${item.window}" in session "${config.session}"`);
      }
    }
    p.throwIfAny('Cannot send:', 'Start the task with "agentctl new", or list running tasks with "agentctl status".');
  }

  const results: { task: string; warning?: string }[] = [];
  for (const item of items) {
    const record = readTaskRecord(config, item.window);
    if (record && record.pendingPrompt && record.promptDelivery !== 'sent') throw new AgentctlError(`${item.task}: a prompt is already pending or awaiting confirmation`, 'Inspect the pane; do not duplicate the pending prompt.');
    let warning: string | undefined;
    if (record && record.agent !== 'unknown' && !runner.dryRun) {
      await queuePrompt(ctx, record, item.prompt);
      if (await deliverPendingPrompt(ctx, item.window) !== 'sent') warning = DELIVERY_WARNING;
    } else await tmux.submitPrompt(item.window, item.prompt);
    results.push({ task: item.task, ...(warning ? { warning } : {}) });
    const file = taskFile(config, item.window);
    if (fs.existsSync(file)) {
      await runner.appendFile(file, renderFollowUp(item.prompt, new Date(runner.now()).toISOString()));
      ctx.info(`${item.task}: ${warning ?? 'prompt sent'}, logged in ${file}`);
    } else {
      ctx.info(`${item.task}: prompt sent (no ${file}, so it was not logged)`);
    }
  }
  return results;
}
