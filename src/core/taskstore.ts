import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Runner } from './runner.ts';
import { AGENT_NAMES, EFFORTS } from './config.ts';
import type { AgentName, Effort, GlobalConfig, Link } from './config.ts';
import type { ResolvedRepo, ResolvedSpec } from './spec.ts';
import type { Order } from './equivalents.ts';
import { isObject } from './util.ts';

/** Agent, model and effort are "unknown" for a task restored with `agentctl adopt` without those flags. */
export type RecordAgent = AgentName | 'unknown';
export type RecordEffort = Effort | 'unknown';

/** What agentctl remembers about a task: the YAML header of `<state_dir>/<task>/TASK.md`. */
export interface TaskRecord {
  task: string;
  window: string;
  /**
   * tmux's own ID of the window ("@12"): stays the same when the name changes (state icons) and is used as the target
   * while it still belongs to this task's window. Absent for tasks started before it was recorded.
   */
  windowId?: string;
  session: string;
  agent: RecordAgent;
  model: string;
  effort: RecordEffort;
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
  /** ISO timestamp of `agentctl adopt`: the record was rebuilt, the original prompt is lost. */
  adopted?: string;
  /** `pin: true` in the spec: `agentctl move` never hands this task to the other provider. Absent in records from before it was kept. */
  pin?: boolean;
  /** The task that took over after `agentctl move`; this one is then `superseded`. */
  supersededBy?: string;
  /** The task this one continues (`agentctl move`). */
  continues?: string;
  /**
   * `hide` / `unhide`. true: hidden from board and status (the task itself and its worktree are untouched). false: shown on purpose,
   * so `board.auto_hide_pulled_dead` leaves it alone. Absent: the auto-hide rule decides.
   */
  hidden?: boolean;
}

/** agentctl's own state for a task. Agents get the report directory (`<cache>/<task>/`), never this one. */
export function taskDir(config: GlobalConfig, window: string): string {
  return path.join(config.stateDir, window);
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
  if (spec.pin) record.pin = true;
  return record;
}

/** Render TASK.md: a YAML header (marked `agentctl: 1`) followed by the prompt. */
export function renderTaskMd(record: TaskRecord, prompt: string): string {
  const header: Record<string, unknown> = {
    agentctl: 1,
    task: record.task,
    window: record.window,
    ...(record.windowId ? { window_id: record.windowId } : {}),
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
  if (record.adopted) header.adopted = record.adopted;
  if (record.pin) header.pin = true;
  if (record.supersededBy) header.superseded_by = record.supersededBy;
  if (record.continues) header.continues = record.continues;
  if (record.hidden !== undefined) header.hidden = record.hidden;
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

/** The prompt the task started with: the text after the header, up to the first follow-up that `send` appended. */
export function readTaskPrompt(config: GlobalConfig, window: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(taskFile(config, window), 'utf8');
  } catch {
    return undefined;
  }
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  const body = text.replace(/\r\n/g, '\n').slice(match[0].length);
  return body.split(/\n\n## Follow-up sent /)[0]?.trim();
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
  if (typeof task !== 'string' || !(agent === 'unknown' || (AGENT_NAMES as readonly unknown[]).includes(agent))) return undefined;
  const record: TaskRecord = {
    task,
    window: typeof data.window === 'string' ? data.window : task.toLowerCase(),
    session: typeof data.session === 'string' ? data.session : 'agentctl',
    agent: agent as RecordAgent,
    model: typeof data.model === 'string' ? data.model : 'default',
    effort: effort === 'unknown' || (EFFORTS as readonly unknown[]).includes(effort) ? (effort as RecordEffort) : 'high',
    repos: Array.isArray(data.repos) ? (data.repos as ResolvedRepo[]) : [],
    links: Array.isArray(data.links) ? (data.links as Link[]) : [],
    env: isObject(data.env) ? (data.env as Record<string, string>) : {},
    report: typeof data.report === 'string' ? data.report : '',
    started: typeof data.started === 'string' ? data.started : '',
    requested: { agent: 'claude', model: 'default', effort: 'high' },
  };
  record.requested = parseOrder(data.requested) ?? {
    agent: record.agent === 'unknown' ? 'claude' : record.agent,
    model: record.model,
    effort: record.effort === 'unknown' ? 'high' : record.effort,
  };
  if (typeof data.window_id === 'string' && /^@\d+$/.test(data.window_id)) record.windowId = data.window_id;
  if (data.switched_by === 'flag' || data.switched_by === 'limit') record.switchedBy = data.switched_by;
  if (typeof data.review_of === 'string') record.reviewOf = data.review_of;
  if (typeof data.pulled === 'string') record.pulled = data.pulled;
  if (typeof data.adopted === 'string') record.adopted = data.adopted;
  if (data.pin === true) record.pin = true;
  if (typeof data.superseded_by === 'string') record.supersededBy = data.superseded_by;
  if (typeof data.continues === 'string') record.continues = data.continues;
  if (typeof data.hidden === 'boolean') record.hidden = data.hidden;
  return record;
}

function parseOrder(v: unknown): Order | undefined {
  if (!isObject(v)) return undefined;
  const { agent, model, effort } = v;
  if (!(AGENT_NAMES as readonly unknown[]).includes(agent) || typeof model !== 'string') return undefined;
  if (!(EFFORTS as readonly unknown[]).includes(effort)) return undefined;
  return { agent: agent as AgentName, model, effort: effort as Effort };
}

/** All tasks agentctl knows about (state folders holding an agentctl-written TASK.md). */
export function listTaskRecords(config: GlobalConfig): TaskRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.stateDir);
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
export async function setHeaderField(runner: Runner, file: string, key: string, value: string | boolean): Promise<boolean> {
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

/** Names of the files that are agentctl state, not agent output: moved out of the cache by the migration. */
const LEGACY_STATE_FILES = ['TASK.md', 'setup.log'];

/**
 * Older versions kept TASK.md and setup.log in `<cache>/<task>/`, where an agent tidying its directory could delete them.
 * Move them to `<state_dir>/<task>/`. A folder is only touched when its TASK.md was written by agentctl.
 * Returns one message per migrated task; never overwrites existing state.
 */
export function migrateLegacyState(config: GlobalConfig): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(config.cache);
  } catch {
    return [];
  }
  const messages: string[] = [];
  for (const name of entries.sort()) {
    const legacyDir = path.join(config.cache, name);
    let text: string;
    try {
      text = fs.readFileSync(path.join(legacyDir, 'TASK.md'), 'utf8');
    } catch {
      continue;
    }
    if (!parseTaskRecord(text)) continue;
    const target = path.join(config.stateDir, name);
    if (fs.existsSync(path.join(target, 'TASK.md'))) {
      messages.push(`migration: ${name}: ${path.join(target, 'TASK.md')} already exists, left ${path.join(legacyDir, 'TASK.md')} in place (remove it by hand if it is stale)`);
      continue;
    }
    fs.mkdirSync(target, { recursive: true });
    const moved: string[] = [];
    for (const file of LEGACY_STATE_FILES) {
      const from = path.join(legacyDir, file);
      const to = path.join(target, file);
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      try {
        fs.renameSync(from, to);
      } catch {
        fs.copyFileSync(from, to);
        fs.rmSync(from);
      }
      moved.push(file);
    }
    messages.push(`migration: moved ${moved.join(' and ')} of ${name} from ${legacyDir} to ${target} (agentctl state now lives outside the agents' directories)`);
  }
  return messages;
}

export interface AdoptInput {
  task: string;
  window: string;
  report: string;
  agent?: AgentName;
  model?: string;
  effort?: Effort;
  worktree?: string;
  session: string;
}

/** Rebuild a task record from what is still known: the report path, window and optionally worktree, agent, model, effort. */
export function recordForAdopt(input: AdoptInput, nowMs: number): TaskRecord {
  const agent: RecordAgent = input.agent ?? 'unknown';
  const effort: RecordEffort = input.effort ?? 'unknown';
  const model = input.model ?? 'unknown';
  return {
    task: input.task,
    window: input.window,
    session: input.session,
    agent,
    model,
    effort,
    repos: input.worktree ? [{ path: input.worktree, worktree: input.worktree }] : [],
    links: [],
    env: {},
    report: input.report,
    // Unknown: status then counts any existing report as ready.
    started: '',
    requested: { agent: input.agent ?? 'claude', model: input.model ?? 'default', effort: input.effort ?? 'high' },
    adopted: new Date(nowMs).toISOString(),
  };
}
