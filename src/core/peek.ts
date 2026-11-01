import type { Context } from './context.ts';
import { resolveRunningTask } from './resolve.ts';
import { guessAgent } from './status.ts';
import { contentLines } from './tmux.ts';
import { readTaskRecord } from './taskstore.ts';
import { AgentctlError } from './util.ts';
import type { AgentName } from './config.ts';

export const PEEK_LINES = 40;
/** Extra lines captured so the footer and border lines that are filtered out do not eat into the requested count. */
const PEEK_SLACK = 40;

export interface PeekResult {
  task: string;
  window: string;
  lines: string[];
}

/** The last `count` lines of content of a window (screen and scrollback), without the agent's footer lines. */
export async function peekWindow(ctx: Context, window: string, count: number): Promise<string[]> {
  const screen = await ctx.tmux.capture(window, count + PEEK_SLACK);
  if (screen.code !== 0) throw new AgentctlError(`cannot read window "${window}": ${screen.stderr.trim() || `tmux exit ${screen.code}`}`);
  const record = readTaskRecord(ctx.config, window);
  const agent: AgentName = record && record.agent !== 'unknown' ? record.agent : guessAgent(screen.stdout);
  return contentLines(screen.stdout, ctx.config.agents[agent].footerPatterns, count);
}

/** `agentctl peek TASK [-n 40]` */
export async function peekTask(ctx: Context, taskArg: string, count: number = PEEK_LINES): Promise<PeekResult> {
  if (!Number.isInteger(count) || count < 1) throw new AgentctlError(`-n must be a positive whole number (got ${count})`);
  const target = await resolveRunningTask(ctx, taskArg);
  return { task: target.task, window: target.window, lines: await peekWindow(ctx, target.window, count) };
}
