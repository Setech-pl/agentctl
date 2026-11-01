import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Runner } from './runner.ts';
import { AGENT_NAMES, EFFORTS } from './config.ts';
import type { AgentName, Effort, GlobalConfig, Link } from './config.ts';
import type { ResolvedRepo, ResolvedSpec } from './spec.ts';
import type { Order } from './equivalents.ts';
import { isObject } from './util.ts';

/** What agentctl remembers about a task: the YAML header of `<cache>/<task>/TASK.md`. */
export interface TaskRecord {
  task: string;
  window: string;
  session: string;
  agent: AgentName;
  model: string;
  effort: Effort;
  repos: ResolvedRepo[];
  links: Link[];
  env: Record<string, string>;
  reviewOf?: string;
  report: string;
  /** ISO timestamp of `agentctl new`. */
  started: string;
  /** The order as written in the spec; agent/model/effort above are what actually runs. */
  requested: Order;
  switchedBy?: 'flag' | 'limit';
  /** ISO timestamp of the last `pull --ready` that took the report. */
  pulled?: string;
}

export function taskDir(config: GlobalConfig, window: string): string {
  return path.join(config.cache, window);
}

export function taskFile(config: GlobalConfig, window: string): string {
  return path.join(taskDir(config, window), 'TASK.md');
}

export function recordFromSpec(spec: ResolvedSpec, config: GlobalConfig, startedMs: number): TaskRecord {
  const record: TaskRecord = {
    task: spec.task,
    window: spec.window,
    session: config.session,
    agent: spec.agent,
    model: spec.model,
    effort: spec.effort,
    repos: spec.repos,
    links: spec.links,
    env: spec.env,
    report: spec.report,
    started: new Date(startedMs).toISOString(),
    requested: spec.requested,
  };
  if (spec.switchedBy) record.switchedBy = spec.switchedBy;
  if (spec.reviewOf) record.reviewOf = spec.reviewOf;
  return record;
}

/** Render TASK.md: a YAML header (marked `agentctl: 1`) followed by the prompt. */
export function renderTaskMd(record: TaskRecord, prompt: string): string {
  const header: Record<string, unknown> = {
    agentctl: 1,
    task: record.task,
    window: record.window,
    session: record.session,
    agent: record.agent,
    model: record.model,
    effort: record.effort,
    requested: record.requested,
    repos: record.repos,
    links: record.links,
    env: record.env,
  };
  if (record.reviewOf) header.review_of = record.reviewOf;
  if (record.switchedBy) header.switched_by = record.switchedBy;
  header.report = record.report;
  header.started = record.started;
  if (record.pulled) header.pulled = record.pulled;
  return `---\n${YAML.stringify(header)}---\n\n${prompt.trim()}\n`;
}

export function renderFollowUp(prompt: string, whenIso: string): string {
  return `\n\n## Follow-up sent ${whenIso}\n\n${prompt.trim()}\n`;
}

/** Read the header of a TASK.md; undefined when missing or not written by agentctl. */
export function readTaskRecord(config: GlobalConfig, window: string): TaskRecord | undefined {
  let text: string;
  try {
    text = fs.readFileSync(taskFile(config, window), 'utf8');
  } catch {
    return undefined;
  }
  return parseTaskRecord(text);
}

export function parseTaskRecord(text: string): TaskRecord | undefined {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  let data: unknown;
  try {
    data = YAML.parse(match[1] as string);
  } catch {
    return undefined;
  }
  if (!isObject(data) || data.agentctl !== 1) return undefined;
  const { task, agent, effort } = data;
  if (typeof task !== 'string' || !(AGENT_NAMES as readonly unknown[]).includes(agent)) return undefined;
  const record: TaskRecord = {
    task,
    window: typeof data.window === 'string' ? data.window : task.toLowerCase(),
    session: typeof data.session === 'string' ? data.session : 'agentctl',
    agent: agent as AgentName,
    model: typeof data.model === 'string' ? data.model : 'default',
    effort: (EFFORTS as readonly unknown[]).includes(effort) ? (effort as Effort) : 'high',
    repos: Array.isArray(data.repos) ? (data.repos as ResolvedRepo[]) : [],
    links: Array.isArray(data.links) ? (data.links as Link[]) : [],
    env: isObject(data.env) ? (data.env as Record<string, string>) : {},
    report: typeof data.report === 'string' ? data.report : '',
    started: typeof data.started === 'string' ? data.started : '',
    requested: { agent: agent as AgentName, model: 'default', effort: 'high' },
  };
  record.requested = parseOrder(data.requested) ?? { agent: record.agent, model: record.model, effort: record.effort };
  if (data.switched_by === 'flag' || data.switched_by === 'limit') record.switchedBy = data.switched_by;
  if (typeof data.review_of === 'string') record.reviewOf = data.review_of;
  if (typeof data.pulled === 'string') record.pulled = data.pulled;
  return record;
}

function parseOrder(v: unknown): Order | undefined {
  if (!isObject(v)) return undefined;
  const { agent, model, effort } = v;
  if (!(AGENT_NAMES as readonly unknown[]).includes(agent) || typeof model !== 'string') return undefined;
  if (!(EFFORTS as readonly unknown[]).includes(effort)) return undefined;
  return { agent: agent as AgentName, model, effort: effort as Effort };
}

/** All tasks agentctl knows about (cache folders holding an agentctl-written TASK.md). */
export function listTaskRecords(config: GlobalConfig): TaskRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.cache);
  } catch {
    return [];
  }
  const records: TaskRecord[] = [];
  for (const name of entries.sort()) {
    const record = readTaskRecord(config, name);
    if (record) records.push(record);
  }
  return records;
}

/** Set one key in the YAML header of an existing TASK.md; the body (prompt, follow-ups) and the other keys stay as they are. */
export async function setHeaderField(runner: Runner, file: string, key: string, value: string): Promise<boolean> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const match = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return false;
  const doc = YAML.parseDocument(match[1] as string);
  doc.set(key, value);
  const rest = text.replace(/\r\n/g, '\n').slice(match[0].length);
  await runner.writeFile(file, `---\n${doc.toString().trimEnd()}\n---${rest}`);
  return true;
}
