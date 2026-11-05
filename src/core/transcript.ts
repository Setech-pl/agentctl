import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { GlobalConfig, AgentName } from './config.ts';
import type { Runner } from './runner.ts';
import { withFileLock } from './file-lock.ts';
import { readTaskRecord } from './taskstore.ts';
import { sameMessage } from './paste-wrapper.ts';
import type { TaskRecord } from './taskstore.ts';
import { readTaskSessions } from './usage.ts';
import { agentHomes, claudeProjectName } from './usage-sources.ts';
import { isObject } from './util.ts';

/*
 * The session transcript of the task's own agent as a source of "this message was taken". Recorded from the real CLIs (Claude Code 2.1.311,
 * codex-cli 0.166.0, 2026-11-05; see docs/details.md):
 *  - Claude Code writes `{"type":"queue-operation","operation":"enqueue","content":"<text>"}` the moment a message is submitted while a turn runs, and
 *    later `{"type":"user","promptSource":"queued"}` when it injects it; an idle message is a `{"type":"user","promptSource":"typed"}` record at once.
 *    A collapsed paste is recorded wrapped in `<pasted_content id="…">` (paste-wrapper.ts).
 *  - Codex 0.166.0 writes the message as `response_item` (role user, `input_text`) and `event_msg` `item_completed` (item `UserMessage`) at the
 *    moment it takes it, also for a message that steers a running turn. Older versions wrote `event_msg` `user_message` (`message`).
 * Only the files of this task's own sessions are read: the id that its hook/statusLine/notify pinned to the current attempt. No cwd/mtime fallback is allowed.
 */

export interface TranscriptMessage {
  /** ms since epoch. */
  at: number;
  text: string;
  /** `queued`: Claude took it into its queue (not yet run). */
  kind: 'user' | 'queued' | 'uncertain-queue';
  /** queued injection inherits the time of its unique, unconsumed enqueue. */
  enqueuedAt?: number;
  consumed?: boolean;
  ambiguous?: boolean;
}

const TAIL_BYTES = 4 * 1024 * 1024;
/** Transcripts that were read and did not hold the message, by file, delivery and the size and time they had then. */
const unchanged = new Map<string, string>();

const fileIdentity = (s: fs.Stats) => `${s.dev}:${s.ino}:${s.birthtimeMs}`;

function readTail(file: string, expectedIdentity: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (fileIdentity(stat) !== expectedIdentity) throw new Error('the selected transcript was replaced');
    const size = stat.size, start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

const textOf = (content: unknown): string | undefined => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts = content.map(part => isObject(part) && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string' ? part.text : undefined);
  return parts.every(part => part !== undefined) ? parts.join('') : undefined;
};

const timeOf = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;

/** The messages of the human in a Claude Code transcript. */
export function claudeMessages(jsonl: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row)) continue;
    const at = timeOf(row.timestamp);
    if (row.type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string' && !Number.isNaN(at)) out.push({ at, text: row.content, kind: 'queued' });
    if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true || Number.isNaN(at) || !isObject(row.message) || row.message.role !== 'user') continue;
    const text = textOf(row.message.content);
    if (text === undefined) continue;
    if (row.promptSource !== 'queued') { out.push({ at, text, kind: 'user' }); continue; }
    const candidates = out.filter(r => r.kind === 'queued' && !r.consumed && r.at <= at && sameMessage(r.text, text, 'claude'));
    // Never guess which duplicate crossed a delivery boundary. Consume the nearest one, but mark both the enqueue and injection ambiguous.
    const nearest = candidates.at(-1);
    if (!nearest) { out.push({ at, text, kind: 'uncertain-queue' }); continue; }
    if (candidates.length !== 1) for (const candidate of candidates) candidate.ambiguous = true;
    nearest.consumed = true;
    out.push({ at, text, kind: 'user', enqueuedAt: nearest.at, ambiguous: candidates.length !== 1 || nearest.ambiguous === true });
  }
  // An unconsumed duplicate enqueue cannot identify a delivery either.
  for (const row of out.filter(r => r.kind === 'queued' && !r.consumed)) {
    if (out.some(other => other !== row && other.kind === 'queued' && !other.consumed && sameMessage(other.text, row.text, 'claude'))) row.ambiguous = true;
  }
  return out;
}

/** The messages of the human in a Codex rollout. */
export function codexMessages(jsonl: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isObject(row) || !isObject(row.payload)) continue;
    const at = timeOf(row.timestamp), payload = row.payload;
    if (Number.isNaN(at)) continue;
    let text: string | undefined;
    if (row.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') text = payload.message;
    else if (row.type === 'event_msg' && payload.type === 'item_completed' && isObject(payload.item) && payload.item.type === 'UserMessage') text = textOf(payload.item.content);
    else if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') text = textOf(payload.content);
    if (text !== undefined) out.push({ at, text, kind: 'user' });
  }
  return out;
}

interface SelectedSession { attempt: string; agent: AgentName; id: string; file?: string; identity?: string }
const selectionFile = (config: Pick<GlobalConfig, 'stateDir'>, window: string) => path.join(config.stateDir, window, 'transcript-session.json');
const identityOf = (file: string): string => fileIdentity(fs.statSync(file));
const attemptOf = (record: TaskRecord) => record.attemptId ?? record.started;

/** Locate only a named rollout. A session's path is pinned once, never rediscovered after loss or rotation. */
function namedRollout(home: string, id: string): string | undefined {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    try { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file, depth + 1);
      else if (item.isFile() && item.name.startsWith('rollout-') && item.name.endsWith(`-${id}.jsonl`)) found.push(file);
    } } catch { /* no named rollout */ }
  };
  walk(path.join(home, 'sessions'), 0);
  return found.length === 1 ? found[0] : undefined;
}

/** Called only when this task's event/statusLine names its own session. Missing files are pinned as missing, not guessed later. */
export async function selectTranscriptSession(runner: Runner, config: GlobalConfig, window: string, agent: AgentName, session: { id: string; transcript?: string }, attempt?: string): Promise<void> {
  const record = readTaskRecord(config, window);
  if (!record || (attempt !== undefined && attempt !== attemptOf(record))) return;
  const file = selectionFile(config, window), current = attemptOf(record);
  await withFileLock(`${file}.lock`, async () => {
    try { const selected = JSON.parse(fs.readFileSync(file, 'utf8')); if (selected.attempt === current) return; } catch { /* first session of the attempt */ }
    const home = agent === 'claude' ? record.env.CLAUDE_CONFIG_DIR ?? agentHomes(config).claude : record.env.CODEX_HOME ?? agentHomes(config).codex;
    const target = agent === 'claude' ? session.transcript ?? record.repos.map(r => path.join(home, 'projects', claudeProjectName(r.worktree), `${session.id}.jsonl`)).find(f => fs.existsSync(f)) : namedRollout(home, session.id);
    const selected: SelectedSession = { attempt: current, agent, id: session.id };
    if (target) { selected.file = path.resolve(target); try { selected.identity = identityOf(selected.file); } catch { /* missing stays unconfirmed */ } }
    await runner.writeFile(file, JSON.stringify(selected) + '\n');
  });
}

function selectedFile(ctx: Context, record: TaskRecord): SelectedSession | undefined {
  let selected: SelectedSession;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(selectionFile(ctx.config, record.window), 'utf8'));
    if (!isObject(value) || typeof value.attempt !== 'string' || typeof value.id !== 'string' || typeof value.file !== 'string' || typeof value.identity !== 'string') return undefined;
    selected = value as unknown as SelectedSession;
  } catch { return undefined; }
  if (selected.attempt !== attemptOf(record) || selected.agent !== record.agent || !selected.file || !selected.identity) return undefined;
  const own = readTaskSessions(ctx.config, record.window)[selected.agent] ?? [];
  if (!own.some(s => s.id === selected.id)) return undefined;
  // A session named for another task is ambiguous, including when both tasks share a worktree.
  try { for (const task of fs.readdirSync(ctx.config.stateDir)) {
    if (task !== record.window && (readTaskSessions(ctx.config, task)[selected.agent] ?? []).some(s => s.id === selected.id || ('transcript' in s && s.transcript === selected.file))) return undefined;
  } } catch { return undefined; }
  try { return identityOf(selected.file) === selected.identity ? selected : undefined; } catch { return undefined; }
}

/**
 * The first message of the human in this task's own transcript, written at or after `sinceMs`, that says exactly what was pasted; uncertain-queue when queue provenance is ambiguous; undefined when
 * there is none (or no transcript of this task can be told apart). `queued`: Claude only took it into its queue so far.
 */
export function transcriptMessage(ctx: Context, record: TaskRecord, pending: string, sinceMs: number): TranscriptMessage | undefined {
  if (record.agent === 'unknown' || !pending || Number.isNaN(sinceMs)) return undefined;
  const selected = selectedFile(ctx, record);
  const files = selected?.file ? [selected.file] : [];
  for (const file of files) {
    let text: string;
    try {
      // A transcript that was not written to since the delivery began cannot hold the message; one that did not change since the last look at it is not read again.
      const st = fs.statSync(file), key = `${file}|${record.deliveryId ?? sinceMs}|${pending}`, version = `${st.size}:${st.mtimeMs}`;
      if (st.mtimeMs < sinceMs || unchanged.get(key) === version) continue;
      text = readTail(file, selected!.identity!);
      unchanged.set(key, version);
      if (unchanged.size > 256) unchanged.delete(unchanged.keys().next().value!);
    } catch { continue; }
    const rows = record.agent === 'claude' ? claudeMessages(text) : codexMessages(text);
    const hits = rows.filter(row => row.kind !== 'uncertain-queue' && row.at >= sinceMs && !row.ambiguous && !row.consumed && (row.enqueuedAt === undefined || row.enqueuedAt >= sinceMs) && sameMessage(row.text, pending, record.agent));
    const uncertain = rows.find(row => row.at >= sinceMs && sameMessage(row.text, pending, record.agent) && (row.kind === 'uncertain-queue' || row.ambiguous || (row.enqueuedAt !== undefined && row.enqueuedAt < sinceMs)));
    const hit = hits.find(row => row.kind === 'user') ?? hits.find(row => row.kind === 'queued') ?? (uncertain ? { ...uncertain, kind: 'uncertain-queue' as const } : undefined);
    if (hit) { unchanged.delete(`${file}|${record.deliveryId ?? sinceMs}|${pending}`); return hit; }
  }
  return undefined;
}
