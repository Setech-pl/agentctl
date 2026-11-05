import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
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
 * Only the files of this task's own sessions are read: the ids that its hooks recorded, else the single transcript of its worktree that is newer than the delivery.
 */

export interface TranscriptMessage {
  /** ms since epoch. */
  at: number;
  text: string;
  /** `queued`: Claude took it into its queue (not yet run). */
  kind: 'user' | 'queued';
}

const TAIL_BYTES = 4 * 1024 * 1024;

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), buffer = Buffer.alloc(size - start);
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
    if (text !== undefined) out.push({ at, text, kind: 'user' });
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

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function claudeFiles(ctx: Context, record: TaskRecord, sinceMs: number): string[] {
  const home = record.env.CLAUDE_CONFIG_DIR ? path.resolve(record.env.CLAUDE_CONFIG_DIR) : agentHomes(ctx.config).claude;
  const known = readTaskSessions(ctx.config, record.window).claude;
  const files = known.map(s => s.transcript ?? record.repos.map(r => path.join(home, 'projects', claudeProjectName(r.worktree), `${s.id}.jsonl`)).find(f => fs.existsSync(f)) ?? '').filter(f => f !== '' && fs.existsSync(f));
  if (files.length) return files;
  // No session recorded yet: the one transcript of the worktree that was written since the delivery began; two of them are not told apart.
  const fresh: string[] = [];
  for (const repo of record.repos) {
    const dir = path.join(home, 'projects', claudeProjectName(repo.worktree));
    try { for (const name of fs.readdirSync(dir)) if (name.endsWith('.jsonl') && fs.statSync(path.join(dir, name)).mtimeMs >= sinceMs) fresh.push(path.join(dir, name)); } catch { /* no folder */ }
  }
  return fresh.length === 1 ? fresh : [];
}

function codexFiles(ctx: Context, record: TaskRecord, sinceMs: number): string[] {
  const home = record.env.CODEX_HOME ? path.resolve(record.env.CODEX_HOME) : agentHomes(ctx.config).codex;
  const ids = readTaskSessions(ctx.config, record.window).codex.map(s => s.id);
  const named: string[] = [], fresh: string[] = [];
  for (let back = 0; back < 3; back++) {
    const day = new Date(sinceMs - back * 86_400_000), dir = path.join(home, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      if (ids.some(id => name.endsWith(`-${id}.jsonl`))) { named.push(file); continue; }
      try {
        if (fs.statSync(file).mtimeMs < sinceMs) continue;
        const head = fs.readFileSync(file, 'utf8').slice(0, 64 * 1024).split('\n')[0] ?? '';
        const meta: unknown = JSON.parse(head);
        const cwd = isObject(meta) && isObject(meta.payload) && typeof meta.payload.cwd === 'string' ? meta.payload.cwd : '';
        if (cwd && record.repos.some(r => within(cwd, r.worktree))) fresh.push(file);
      } catch { /* not a rollout we can read */ }
    }
  }
  if (named.length) return named;
  return fresh.length === 1 ? fresh : [];
}

/**
 * The first message of the human in this task's own transcript, written at or after `sinceMs`, that says exactly what was pasted; undefined when
 * there is none (or no transcript of this task can be told apart). `queued`: Claude only took it into its queue so far.
 */
export function transcriptMessage(ctx: Context, record: TaskRecord, pending: string, sinceMs: number): TranscriptMessage | undefined {
  if (record.agent === 'unknown' || !pending || Number.isNaN(sinceMs)) return undefined;
  const files = record.agent === 'claude' ? claudeFiles(ctx, record, sinceMs) : codexFiles(ctx, record, sinceMs);
  for (const file of files) {
    let text: string;
    try { text = readTail(file); } catch { continue; }
    const rows = record.agent === 'claude' ? claudeMessages(text) : codexMessages(text);
    const hit = rows.filter(row => row.at >= sinceMs && sameMessage(row.text, pending, record.agent)).sort((a, b) => a.at - b.at)[0];
    if (hit) return hit;
  }
  return undefined;
}
