import type { Context } from './context.ts';
import { assertReviewIsolated, findAuthorRecord, LEGACY_RECORD_HINT, LEGACY_REVIEW_HINT } from './review-gate.ts';
import type { AutoReviewSource } from './spec.ts';
import type { ExecResult } from './runner.ts';
import { AgentctlError } from './util.ts';

/*
 * The one door to an agent's tmux window. Every path that makes a window for a task (start from the queue, `new`, `resume`, `move`, `queue retry`, the
 * MCP tools over them) ends in `openAgentWindow`, so the invariant of a review - its report is not the author's, its checkout is not the author's -
 * is checked in exactly one place, before the window exists and before any report instructions reach an agent. tests/window-guard.test.ts fails
 * when another file creates a window for an agent.
 */

export interface AgentWindowRequest {
  task: string;
  window: string;
  /** The first worktree: the window's directory. */
  cwd: string;
  env: Record<string, string>;
  report: string;
  reportAlt?: string[] | undefined;
  repos: { worktree: string }[];
  reviewOf?: string | undefined;
  autoReview?: AutoReviewSource | undefined;
  /** Where the request comes from: the refusal for a record written before the own-checkout rule differs (a queue entry is removed, a record is closed). */
  origin: 'start' | 'new' | 'resume' | 'move';
  sessionUp: boolean;
  /** Optional direct process for a neutral usage probe, still through the same door. */
  command?: string;
}

/** Throws when a review would run in its author's checkout or write the author's report. A task that reviews nothing passes. */
export function assertAgentSpawnAllowed(ctx: Context, req: Omit<AgentWindowRequest, 'sessionUp' | 'cwd' | 'env' | 'window'>): void {
  const authorTask = req.autoReview?.author ?? req.reviewOf;
  if (!authorTask) return;
  const hint = req.origin === 'resume' || req.origin === 'move' ? LEGACY_RECORD_HINT : LEGACY_REVIEW_HINT;
  const author = findAuthorRecord(ctx.config, authorTask);
  if (!author) {
    if (req.autoReview) throw new AgentctlError(`${req.task}: no record of the author ${authorTask}, not even in the archive`, hint);
    return;
  }
  try { assertReviewIsolated(req, author); }
  catch (e) {
    if (req.origin === 'resume' || req.origin === 'move') throw new AgentctlError(`${req.task}: ${LEGACY_RECORD_HINT} (${e instanceof AgentctlError ? e.message.replace(/^[^:]+: /, '') : String(e)})`, hint);
    throw e;
  }
}

/** Make the window of an agent (and the session, when it is not up). The only caller of tmux new-window/new-session for a task. */
export async function openAgentWindow(ctx: Context, req: AgentWindowRequest): Promise<ExecResult> {
  assertAgentSpawnAllowed(ctx, req);
  return req.sessionUp ? ctx.tmux.newWindow(req.window, req.cwd, req.env, req.command) : ctx.tmux.newSession(req.window, req.cwd, req.env, req.command);
}
