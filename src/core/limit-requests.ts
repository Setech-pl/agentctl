import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.ts';
import { loadGlobalConfig } from './config.ts';
import type { GlobalConfig } from './config.ts';
import { Context } from './context.ts';
import { withStateWriteLock } from './file-lock.ts';
import { commitLimitPlan, limitEditLock, planSetLimits } from './limits.ts';
import type { HoldAssignment, LimitAssignments, QuotaEdit } from './limits.ts';
import { AgentctlError } from './util.ts';
import { LIMIT_REQUEST_ORIGIN, OWNER_IDENTITY, planPost, postMessage, setStatus } from './wall.ts';
import type { PostInput } from './wall.ts';
import { WALL_TOOL_CHANNEL } from './wall-config.ts';

export interface RequestedLimits {
  assignments: LimitAssignments;
  hold?: HoldAssignment;
  quota?: QuotaEdit;
  profile?: string;
}

type Decision = 'approved' | 'rejected' | 'expired' | 'superseded';
export interface LimitRequest {
  id: string;
  wallId?: string;
  by: string;
  reason: string;
  difference: string;
  at: number;
  expires: number;
  change: RequestedLimits;
  status: 'pending' | Decision;
  intent?: { before: string; after: string };
  synced?: boolean;
}

const requestsFile = (file: string) => path.join(path.dirname(file), 'limit-requests.json');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const configText = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const approvalWindow = 2 * 3_600_000;

function readRequests(file: string): LimitRequest[] {
  try { return JSON.parse(fs.readFileSync(requestsFile(file), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function pendingLimitRequests(config: GlobalConfig, now: number): LimitRequest[] {
  return readRequests(config.path).filter(request => request.status === 'pending' && request.expires > now);
}

const planned = (config: GlobalConfig, change: RequestedLimits, now: number) =>
  planSetLimits(config, change.assignments, change.hold, undefined, now, change.quota, { profile: change.profile });

function wallPost(request: LimitRequest): PostInput {
  return { channel: WALL_TOOL_CHANNEL, to: 'owner', kind: 'decision-request', origin: LIMIT_REQUEST_ORIGIN + request.id,
    subject: `Zmiana limitów (${request.id})`,
    body: `Wnioskuje: ${request.by}\nPowód: ${request.reason}\n${request.difference}\nWygasa: ${new Date(request.expires).toISOString()}\nDecyzja: L na tablicy albo agentctl limits approve|reject ${request.id}` };
}

function saveRequests(ctx: Context, requests: LimitRequest[]): void {
  const keepAfter = ctx.runner.now() - 7 * 86_400_000;
  atomicWriteFile(requestsFile(ctx.config.path), JSON.stringify(requests.filter(request => !request.synced || request.expires > keepAfter)));
}

async function syncRequest(ctx: Context, requests: LimitRequest[], request: LimitRequest): Promise<void> {
  if (!request.wallId) {
    request.wallId = (await postMessage(ctx, OWNER_IDENTITY, wallPost(request))).id;
    saveRequests(ctx, requests);
  }
  if (request.status === 'pending' || request.synced) return;
  const status = { approved: 'accepted', rejected: 'rejected', expired: 'stale', superseded: 'superseded' } as const;
  const note = { approved: 'Właściciel zatwierdził zmianę limitów.', rejected: 'Właściciel odrzucił zmianę limitów.', expired: 'Wniosek wygasł po 2 godzinach.', superseded: 'Konfiguracja zmieniła się po przerwaniu zatwierdzania. Sprawdź stan limitów.' };
  await setStatus(ctx, OWNER_IDENTITY, { id: request.wallId, status: status[request.status], note: note[request.status] }, 'open', true);
  request.synced = true;
  saveRequests(ctx, requests);
}

function recoverDecision(ctx: Context, requests: LimitRequest[], request: LimitRequest): void {
  if (request.status !== 'pending') return;
  if (request.intent) {
    const current = hash(configText(ctx.config.path));
    if (current === request.intent.after) request.status = 'approved';
    else if (current !== request.intent.before) request.status = 'superseded';
    delete request.intent;
    saveRequests(ctx, requests);
  }
  if (request.status === 'pending' && request.expires <= ctx.runner.now()) {
    request.status = 'expired';
    saveRequests(ctx, requests);
  }
}

export async function requestLimitChange(ctx: Context, change: RequestedLimits, by: string, reason: string | undefined, notify: (text: string) => Promise<void>): Promise<LimitRequest | undefined> {
  if (ctx.runner.dryRun) throw new AgentctlError('Limit requests require a writable instance.');
  const { request, created } = await withStateWriteLock(limitEditLock(ctx.config.path), async () => {
    const now = ctx.runner.now();
    const config = loadGlobalConfig(path.dirname(ctx.config.path), now);
    const fresh = new Context(ctx.runner, config, ctx.out);
    const plan = planned(config, change, now);
    const difference = plan.difference || (change.profile ? `Aktywny profil: ${config.limitRuntime.profile ?? '-'} → ${change.profile}` : '');
    if (!difference) return { request: undefined, created: false };
    const requests = readRequests(config.path);
    const explanation = reason?.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || 'Prośba o zmianę ustawień instancji.';
    const existing = requests.find(entry => entry.status === 'pending' && entry.expires > now && entry.by === by && entry.reason === explanation && entry.difference === difference && JSON.stringify(entry.change) === JSON.stringify(change));
    const request: LimitRequest = existing ?? { id: `limit-${randomUUID().slice(0, 12)}`, at: now, expires: now + approvalWindow,
      by, reason: explanation, difference, change, status: 'pending' };
    if (!existing) {
      planPost(config, OWNER_IDENTITY, wallPost(request));
      requests.push(request);
      saveRequests(fresh, requests);
    }
    const created = !request.wallId;
    await syncRequest(fresh, requests, request);
    return { request, created };
  });
  if (created && request) {
    const change = request.difference.replaceAll('\n', ' · ');
    void notify(`Zmiana limitów (${request.id}) · ${request.by}\n${change}\nPowód: ${request.reason}\nDecyzja: L na tablicy.`).catch(() => undefined);
  }
  return request;
}

export async function decideLimitRequest(ctx: Context, id: string, decision: 'approved' | 'rejected', source: string): Promise<LimitRequest> {
  return withStateWriteLock(limitEditLock(ctx.config.path), async () => {
    const now = ctx.runner.now();
    const config = loadGlobalConfig(path.dirname(ctx.config.path), now);
    const fresh = new Context(ctx.runner, config, ctx.out);
    const requests = readRequests(config.path);
    const request = requests.find(entry => entry.id === id || entry.wallId === id);
    if (!request) throw new AgentctlError(`Unknown limit request: ${id}`);
    recoverDecision(fresh, requests, request);
    if (request.status === 'pending' && decision === 'approved') {
      const plan = planned(config, request.change, now);
      const difference = plan.difference || (request.change.profile ? `Aktywny profil: ${config.limitRuntime.profile ?? '-'} → ${request.change.profile}` : '');
      if (difference !== request.difference) throw new AgentctlError('The proposed change differs from the original request. Reject it and ask for a new request.');
      if (plan.baseText !== plan.text) {
        request.intent = { before: hash(plan.baseText), after: hash(plan.text) };
        saveRequests(fresh, requests);
      }
      await commitLimitPlan(fresh, config, plan, `${source} (${request.by}, ${request.id})`, () => {
        request.status = 'approved';
        delete request.intent;
        saveRequests(fresh, requests);
      });
    } else if (request.status === 'pending') {
      request.status = 'rejected';
      saveRequests(fresh, requests);
    }
    await syncRequest(fresh, requests, request);
    return request;
  });
}

/** Resolve deadlines and finish WALL writes after an interruption or watch restart. */
export async function maintainLimitRequests(ctx: Context): Promise<void> {
  if (ctx.runner.dryRun || !fs.existsSync(requestsFile(ctx.config.path))) return;
  await withStateWriteLock(limitEditLock(ctx.config.path), async () => {
    const requests = readRequests(ctx.config.path);
    for (const request of requests) {
      recoverDecision(ctx, requests, request);
      await syncRequest(ctx, requests, request);
    }
  });
}
