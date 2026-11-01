import type { AgentName, GlobalConfig } from './config.ts';
import type { ResolvedSpec } from './spec.ts';
import { readTaskRecord } from './taskstore.ts';

export interface AgentModel {
  agent: AgentName;
  model: string;
}

/**
 * Cross-review rule: a reviewer must differ from the author in agent or in model.
 * Returns a problem description, or undefined when the pairing is fine.
 */
export function checkReviewer(spec: Pick<ResolvedSpec, 'task' | 'agent' | 'model' | 'reviewOf'>, author: AgentModel | undefined): string | undefined {
  if (!spec.reviewOf) return undefined;
  if (!author) {
    return `review_of ${spec.reviewOf}: no record of that task (no ${spec.reviewOf.toLowerCase()}/TASK.md in the cache and not in this file), so the author's agent and model are unknown. Start the author's task with agentctl first.`;
  }
  if (author.agent === spec.agent && author.model === spec.model) {
    return `${spec.task} reviews ${spec.reviewOf} but uses the same agent and model (${spec.agent}, ${spec.model}). Pick a different agent or a different model for the reviewer.`;
  }
  return undefined;
}

/** Look up the author of a reviewed task: first among specs started together, then in the cache. */
export function findAuthor(task: string, batch: ResolvedSpec[], config: GlobalConfig): AgentModel | undefined {
  const inBatch = batch.find((s) => s.task === task);
  if (inBatch) return { agent: inBatch.agent, model: inBatch.model };
  const record = readTaskRecord(config, task.toLowerCase());
  return record && record.agent !== 'unknown' ? { agent: record.agent, model: record.model } : undefined;
}

export interface LiveWindow {
  window: string;
  /** Unknown when the window was not created through agentctl. */
  agent?: AgentName;
}

/** Provider limit: counts windows already running for the agent and refuses one more past the limit. */
export function checkWindowLimit(agent: AgentName, limit: number | undefined, live: LiveWindow[], session: string): string | undefined {
  if (limit === undefined) return undefined;
  const running = live.filter((w) => w.agent === agent);
  if (running.length < limit) return undefined;
  const list = running.map((w) => w.window).join(', ');
  return `window limit for ${agent} reached: ${running.length} of ${limit} in session "${session}" (${list}).`;
}
