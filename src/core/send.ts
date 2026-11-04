import fs from 'node:fs';
import type { Context } from './context.ts';
import { enqueuePrompt, drainPromptQueue, readPromptQueue } from './prompt-queue.ts';
import { readTaskRecord, renderFollowUp, taskFile } from './taskstore.ts';
import { AgentctlError, Problems } from './util.ts';

export interface SendItem {
  task: string;
  window: string;
  prompt: string;
}

/** Paste a follow-up prompt into existing windows and log it in TASK.md. */
export async function sendPrompts(ctx: Context, items: SendItem[]): Promise<{ task: string; message: string; warning?: string }[]> {
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

  const results: { task: string; message: string; warning?: string }[] = [];
  for (const item of items) {
    const record = readTaskRecord(config, item.window);
    let message = 'wklejono (prompt sent)';
    let warning: string | undefined;
    if (record && record.agent !== 'unknown' && !runner.dryRun) {
      const queued = await enqueuePrompt(ctx, item.window, item.prompt);
      await drainPromptQueue(ctx, item.window);
      const fresh = readTaskRecord(config, item.window);
      const waiting = readPromptQueue(ctx, item.window);
      const position = waiting.findIndex(p => p.id === queued.id);
      if (position >= 0 || (fresh?.deliveryId === queued.id && fresh.promptDelivery === 'pending')) {
        const n = position >= 0 ? position + 1 + (fresh?.pendingPrompt ? 1 : 0) : 1;
        message = warning = `w kolejce ${n}; watch wysyła FIFO po bezczynności lub potwierdzeniu poprzedniej wiadomości`;
      } else if (fresh?.deliveryId === queued.id && fresh.promptDelivery !== 'sent') message = warning = 'wklejono; dostarczenie niepotwierdzone – sprawdzam (watch)';
    } else {
      await tmux.submitPrompt(item.window, item.prompt);
      const file = taskFile(config, item.window);
      if (fs.existsSync(file)) await runner.appendFile(file, renderFollowUp(item.prompt, new Date(runner.now()).toISOString()));
    }
    results.push({ task: item.task, message, ...(warning ? { warning } : {}) });
    ctx.info(`${item.task}: ${message}`);
  }
  return results;
}
