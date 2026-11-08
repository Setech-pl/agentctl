import { promptQueueView } from './prompt-queue.ts';
import { sessionQuestion } from './codex-question.ts';
import { extractQuestion } from './events.ts';
import type { Context } from './context.ts';
import { resolveRunningTask } from './resolve.ts';
import { guessAgent } from './status.ts';
import { screenMetadata, contentLines } from './tmux.ts';
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
  promptQueue?: ReturnType<typeof promptQueueView>;
  promptDelivery?: string;
  usage_hint?: string | null;
  draft_input?: string | null;
}

/** The last `count` lines of content of a window (screen and scrollback), without the agent's footer lines. */
export async function peekWindow(ctx: Context, window: string, count: number): Promise<string[]> {
  const screen = await ctx.tmux.capture(window, count + PEEK_SLACK);
  if (screen.code !== 0) throw new AgentctlError(`cannot read window "${window}": ${screen.stderr.trim() || `tmux exit ${screen.code}`}`);
  const record = readTaskRecord(ctx.config, window);
  const agent: AgentName = record && record.agent !== 'unknown' ? record.agent : guessAgent(screen.stdout);
  const question = (record && record.agent === 'codex' ? sessionQuestion(ctx.config, record) : undefined) ?? extractQuestion(screen.stdout);
  return [...(question ? [question] : []), ...contentLines(screen.stdout, ctx.config.agents[agent].footerPatterns, count)];
}

/** `agentctl peek TASK [-n 40]` */
export async function peekTask(ctx: Context, taskArg: string, count: number = PEEK_LINES): Promise<PeekResult> {
  if (!Number.isInteger(count) || count < 1) throw new AgentctlError(`-n must be a positive whole number (got ${count})`);
  const target = await resolveRunningTask(ctx, taskArg);
  const screen = await ctx.tmux.capture(target.window, count + PEEK_SLACK);
  if (screen.code !== 0) throw new AgentctlError(`cannot read window ${target.window}`);
  const record = readTaskRecord(ctx.config, target.window);
  const agent = record && record.agent !== 'unknown' ? record.agent : guessAgent(screen.stdout);
  const question = (record && record.agent === 'codex' ? sessionQuestion(ctx.config, record) : undefined) ?? extractQuestion(screen.stdout);
  return { task: target.task, window: target.window, promptQueue: promptQueueView(ctx, target.window), promptDelivery: record?.promptDelivery, ...screenMetadata(screen.stdout), lines: [...(question ? [question] : []), ...contentLines(screen.stdout, ctx.config.agents[agent].footerPatterns, count)] };
}
