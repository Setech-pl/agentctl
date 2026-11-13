import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomic-file.ts';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { withFileLock } from './file-lock.ts';
import { recordJournal } from './journal.ts';
import type { Notifier } from './notify.ts';
import { watchAlive } from './queue.ts';
import { errorMessage } from './util.ts';

/*
 * P93b: the confirm of an MCP write that can wait on start.lock, git, tmux or a scan of every task (unblock, queue_up, queue_rm, queue_retry,
 * close, cancel, send, mark, hide/unhide, archive, cohort_*) answers within the 8 s response budget on a loaded host. It records the request
 * here, one file per request under a short lock (never start.lock), and returns. The watcher applies the pending requests at its next tick,
 * outside any response budget: it computes the scope of the preview again (a changed scope is refused, as the synchronous confirm refused it),
 * runs the operation and records an `mcp-applied` event, or an `mcp-failed` event and a notification.
 */

export type McpRequestStatus = 'pending' | 'applying' | 'done' | 'failed';

export interface McpRequest {
  id: string;
  /** The order of the confirms: the watcher applies the requests in it (two confirms of one millisecond included). */
  seq: number;
  tool: string;
  /** The arguments the preview validated, without confirm and preview_token. */
  args: Record<string, unknown>;
  /** The scope identity of the preview; the watcher computes the scope again and refuses a changed one. null: the tool has no preview scope. */
  scope: string | null;
  /** The preview's argument key (audit) and its token: a repeated confirm of one token records one request. */
  key: string;
  token?: string;
  /** What the events name: the task(s), the cohort or the operation. */
  label: string;
  /** The one task the request is about, when there is one (events_since filters by task and cohort). */
  task?: string;
  requestedAt: string;
  status: McpRequestStatus;
  appliedAt?: string;
  /** done: the first lines of what the operation answered; failed: why nothing (or not everything) was done. */
  result?: string;
  error?: string;
}

/** `<config dir>/mcp-requests/<id>.json`. */
export const mcpRequestDir = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'mcp-requests');
const requestFile = (config: Pick<GlobalConfig, 'path'>, id: string): string => path.join(mcpRequestDir(config), `${id}.json`);

/** How long applied and failed requests stay readable (queue of events_since covers the rest). */
const KEEP_MS = 7 * 24 * 3600_000;

export function readMcpRequests(config: Pick<GlobalConfig, 'path'>): McpRequest[] {
  let names: string[];
  try { names = fs.readdirSync(mcpRequestDir(config)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: McpRequest[] = [];
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(mcpRequestDir(config), name), 'utf8')) as McpRequest;
      if (typeof data.id === 'string' && typeof data.tool === 'string' && typeof data.requestedAt === 'string' && data.args && typeof data.args === 'object') out.push(data);
    } catch { /* removed or half written: the writer is atomic, so a later read sees it */ }
  }
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
}

/** The short lock of the request directory: held for one read and one file write, never across git, tmux or a start. */
function withRequestLock<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  return withFileLock(path.join(ctx.config.stateDir, 'mcp-requests.lock'), action);
}

function writeRequest(config: Pick<GlobalConfig, 'path'>, request: McpRequest): void {
  fs.mkdirSync(mcpRequestDir(config), { recursive: true });
  atomicWriteFile(requestFile(config, request.id), `${JSON.stringify(request, null, 2)}\n`);
}

/** A confirm hands its write to the watcher only when one runs (else nothing would apply it) and the run is real. */
export function deferMcpWrites(ctx: Context): boolean {
  return !ctx.runner.dryRun && watchAlive(ctx.config, ctx.runner.now());
}

/** Record a confirmed write for the watcher. A token that was recorded already returns that request (`existing`), nothing is added. */
export async function recordMcpRequest(ctx: Context, input: Omit<McpRequest, 'id' | 'seq' | 'requestedAt' | 'status'>): Promise<{ request: McpRequest; existing: boolean }> {
  return withRequestLock(ctx, async () => {
    const all = readMcpRequests(ctx.config);
    const known = input.token ? all.find((r) => r.token === input.token) : undefined;
    if (known) return { request: known, existing: true };
    const seq = all.reduce((n, r) => Math.max(n, r.seq ?? 0), 0) + 1;
    const request: McpRequest = { ...input, id: randomUUID(), seq, requestedAt: new Date(ctx.runner.now()).toISOString(), status: 'pending' };
    writeRequest(ctx.config, request);
    return { request, existing: false };
  });
}

/** "close NC-1: przyjęte – watch wykona przy najbliższym ticku": what the confirm answers. */
export function acceptedText(config: Pick<GlobalConfig, 'watch'>, request: McpRequest, existing: boolean): string {
  return `${existing ? 'already accepted' : 'Accepted'}: ${request.tool} ${request.label} (request ${request.id.slice(0, 8)}). The watcher applies it at its next tick (about ${config.watch.interval} s), not this call: ` +
    'it checks the scope of the preview again, then does it. Follow it with events_since: "MCP WYKONANE" when it is done, "MCP BŁĄD" with the reason (and a notification) when it was refused or failed; then preview again. Calling confirm again with the same preview_token records nothing twice.';
}

const firstLines = (text: string, n = 6): string => text.split('\n').filter((l) => l.trim() !== '').slice(0, n).join('\n').slice(0, 2000);

export interface ApplyOptions {
  log?: ((line: string) => Promise<void> | void) | undefined;
}

/**
 * The watcher's half: apply every pending request, oldest first. A request is marked `applying` before it runs, so a watcher that dies
 * in the middle never runs it a second time (it becomes failed, "interrupted", and the chat previews again). Done and failed requests
 * are kept for a week.
 */
export async function applyMcpRequests(ctx: Context, notifier: Notifier, apply: (request: McpRequest) => Promise<{ text: string; announce?: string }>, opts: ApplyOptions = {}): Promise<McpRequest[]> {
  if (ctx.runner.dryRun) return [];
  const now = () => new Date(ctx.runner.now()).toISOString();
  const finished: McpRequest[] = [];
  for (const stale of readMcpRequests(ctx.config).filter((r) => r.status === 'applying')) {
    finished.push(await finish(ctx, notifier, { ...stale, status: 'failed', appliedAt: now(), error: 'interrupted: the watcher stopped while applying it; check status and preview again' }, opts));
  }
  for (const pending of readMcpRequests(ctx.config).filter((r) => r.status === 'pending')) {
    const claimed = await withRequestLock(ctx, async () => {
      const fresh = readMcpRequests(ctx.config).find((r) => r.id === pending.id);
      if (fresh?.status !== 'pending') return undefined;
      const applying: McpRequest = { ...fresh, status: 'applying' };
      writeRequest(ctx.config, applying);
      return applying;
    });
    if (!claimed) continue;
    let next: McpRequest;
    try {
      const done = await apply(claimed);
      next = { ...claimed, status: 'done', appliedAt: now(), result: firstLines(done.announce ?? done.text) };
    } catch (e) {
      next = { ...claimed, status: 'failed', appliedAt: now(), error: errorMessage(e) };
    }
    finished.push(await finish(ctx, notifier, next, opts));
  }
  for (const old of readMcpRequests(ctx.config)) {
    if ((old.status === 'done' || old.status === 'failed') && ctx.runner.now() - Date.parse(old.appliedAt ?? old.requestedAt) > KEEP_MS) fs.rmSync(requestFile(ctx.config, old.id), { force: true });
  }
  return finished;
}

async function finish(ctx: Context, notifier: Notifier, request: McpRequest, opts: ApplyOptions): Promise<McpRequest> {
  writeRequest(ctx.config, request);
  const failed = request.status === 'failed';
  const reason = (request.error ?? '').split('\n').map((l) => l.trim().replace(/^- /, '')).filter(Boolean).slice(0, 2).join(' ');
  const text = failed
    ? `${request.tool} ${request.label}: nie wykonano – ${reason || 'n/d'} (request ${request.id.slice(0, 8)})`
    : `${request.tool} ${request.label}: wykonane przez watch – ${(request.result ?? '').split('\n')[0] ?? ''} (request ${request.id.slice(0, 8)})`;
  await opts.log?.(`mcp: ${text}`);
  await recordJournal(ctx, { kind: failed ? 'mcp-failed' : 'mcp-applied', ...(request.task ? { task: request.task } : {}), text });
  if (failed) await notifier.notify('agentctl', text).catch(() => undefined);
  return request;
}
