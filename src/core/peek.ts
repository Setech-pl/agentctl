import { promptQueueView } from './prompt-queue.ts';
import { sessionQuestion } from './codex-question.ts';
import { clip, collapsedQuestion, collapsedQuestionText, extractQuestion, MAX_QUESTION } from './events.ts';
import type { Context } from './context.ts';
import { listTargets, matchTask, resolveRunningTask } from './resolve.ts';
import { readStartFailureScreen, startFailureScreenFile } from './start-failure.ts';
import { guessAgent } from './status.ts';
import { screenMetadata, contentLines } from './tmux.ts';
import { readTaskRecord } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import type { GlobalConfig } from './config.ts';
import { AgentctlError } from './util.ts';
import type { AgentName } from './config.ts';

export const PEEK_LINES = 40;
/** Extra lines captured so the footer and border lines that are filtered out do not eat into the requested count. */
const PEEK_SLACK = 40;

/**
 * The open question a peek shows. A collapsed Codex question ("? N questions · … to answer") also names its text: from the
 * pending request_user_input of the session transcript, else from the expanded view the captured scrollback still holds —
 * never by sending keys to the agent (P65-b).
 */
function peekQuestion(config: GlobalConfig, record: TaskRecord | null | undefined, screen: string): string | undefined {
  const session = record && record.agent === 'codex' ? sessionQuestion(config, record) : undefined;
  const asked = extractQuestion(screen);
  const collapsed = collapsedQuestion(screen);
  // extractQuestion says "zwinięte" only when the collapsed marker is the latest question UI; then the text comes from
  // the session log or the expanded view still in the capture.
  if (collapsed && asked && /\(zwinięte, /.test(asked)) {
    const text = session ?? collapsedQuestionText(screen);
    return clip(`Codex ma pytanie${text ? ` „${text}”` : ''} (zwinięte, ${collapsed.count}) – Enter → okno agenta, potem ${collapsed.shortcut ?? 'skrót przy „to answer” na ekranie'}`, MAX_QUESTION);
  }
  return session ?? asked;
}

export interface PeekResult {
  task: string;
  window: string;
  lines: string[];
  promptQueue?: ReturnType<typeof promptQueueView>;
  promptDelivery?: string;
  usage_hint?: string | null;
  draft_input?: string | null;
  /** The saved last screen of a start that did not reach the agent's input (P96): its file. With no window left, `lines` are that capture. */
  startFailureScreen?: string;
}

/** The last `count` lines of content of a window (screen and scrollback), without the agent's footer lines. */
export async function peekWindow(ctx: Context, window: string, count: number): Promise<string[]> {
  const screen = await ctx.tmux.capture(window, count + PEEK_SLACK);
  if (screen.code !== 0) throw new AgentctlError(`cannot read window "${window}": ${screen.stderr.trim() || `tmux exit ${screen.code}`}`);
  const record = readTaskRecord(ctx.config, window);
  const agent: AgentName = record && record.agent !== 'unknown' ? record.agent : guessAgent(screen.stdout);
  const question = peekQuestion(ctx.config, record, screen.stdout);
  return [...(question ? [question] : []), ...contentLines(screen.stdout, ctx.config.agents[agent].footerPatterns, count)];
}

/** The record says the start did not get the prompt in (failed start, or waiting for the owner at a startup dialog): its capture is worth pointing at. */
const startUnfinished = (record: TaskRecord | null | undefined): boolean => ['needs-attention', 'needs-input', 'launching'].includes(record?.promptDelivery ?? '') && !record?.deliveryStartedAt;

/** A task whose window is gone but whose failed start left a capture: peek reads that instead of failing. */
async function peekStartFailure(ctx: Context, taskArg: string, count: number): Promise<PeekResult | undefined> {
  const match = matchTask(taskArg, await listTargets(ctx));
  if (match.kind !== 'one') return undefined;
  const text = readStartFailureScreen(ctx.config, match.target.window);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return { task: match.target.task, window: match.target.window, lines: lines.slice(-count), startFailureScreen: startFailureScreenFile(ctx.config, match.target.window) };
}

/** `agentctl peek TASK [-n 40]` */
export async function peekTask(ctx: Context, taskArg: string, count: number = PEEK_LINES): Promise<PeekResult> {
  if (!Number.isInteger(count) || count < 1) throw new AgentctlError(`-n must be a positive whole number (got ${count})`);
  let target;
  try { target = await resolveRunningTask(ctx, taskArg); } catch (e) {
    const saved = await peekStartFailure(ctx, taskArg, count);
    if (saved) return saved;
    throw e;
  }
  const screen = await ctx.tmux.capture(target.window, count + PEEK_SLACK);
  if (screen.code !== 0) throw new AgentctlError(`cannot read window ${target.window}`);
  const record = readTaskRecord(ctx.config, target.window);
  const agent = record && record.agent !== 'unknown' ? record.agent : guessAgent(screen.stdout);
  const question = peekQuestion(ctx.config, record, screen.stdout);
  const failed = startUnfinished(record) && readStartFailureScreen(ctx.config, target.window) !== undefined ? startFailureScreenFile(ctx.config, target.window) : undefined;
  return { task: target.task, window: target.window, promptQueue: promptQueueView(ctx, target.window), promptDelivery: record?.promptDelivery, ...screenMetadata(screen.stdout), lines: [...(question ? [question] : []), ...contentLines(screen.stdout, ctx.config.agents[agent].footerPatterns, count)], ...(failed ? { startFailureScreen: failed } : {}) };
}
