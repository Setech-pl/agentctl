import { hostAvailability } from './host-availability.ts';
import { readHostsCache } from './hosts.ts';
import { chatLoads, chatOwner, DEFAULT_OWNER, effectiveChatCeilings, parseChatQuotas, quotaBudget, quotaWarnings, renderChatLoad } from './chat-quotas.ts';
import type { ChatLoad, ChatQuotas } from './chat-quotas.ts';
import { holdUntil, providerHolds, providerHoldText, parseTimedHolds, setProviderHolds } from './provider-hold.ts';
import type { ProviderHold, TimedHolds } from './provider-hold.ts';
import { provider as adapter, activeProviders, PROVIDER_IDS } from './providers/registry.ts';
import { DEFAULT_PROVIDERS } from './providers/types.ts';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { AGENT_NAMES, loadGlobalConfig } from './config.ts';
import type { AgentName, GlobalConfig } from './config.ts';
import type { LiveWindow } from './checks.ts';
import type { Context } from './context.ts';
import { editConfigText, writeConfigText } from './config-edit.ts';
import { recordJournal, recordJournalOnce } from './journal.ts';
import { withFileLock, withStateWriteLock } from './file-lock.ts';
import { atomicWriteFile } from './atomic-file.ts';
import { readQueue, waiting, watchAlive } from './queue.ts';
import { AgentctlError, errorMessage, formatLocalTime, isObject, Problems } from './util.ts';
import { OWNER_IDENTITY, postMessage } from './wall.ts';
import { WALL_TOOL_CHANNEL } from './wall-config.ts';
import path from 'node:path';
import { openReader, readPlanStates } from './usage.ts';
import { planLine } from './usage-report.ts';
import { accountTasks, taskNames } from './task-accounting.ts';
import type { StatusRow } from './status.ts';

/*
 * The limits of simultaneous agents per provider and what uses them up: the windows of agentctl, the places the user reserved for agents
 * started by hand (`limits reserve`), and - with `limits.count_external` - claude/codex sessions found in other terminals.
 */

// ---- reservations

export interface Reservation {
  count: number;
  note?: string;
  /** ISO time of the last change. */
  at: string;
  until?: string;
}

export type Reservations = Partial<Record<AgentName, Reservation>>;

export const reservationsFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'reservations.json');

export function readReservations(config: Pick<GlobalConfig, 'path'>, now = Date.now()): Reservations {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(reservationsFile(config), 'utf8'));
    const out: Reservations = {};
    if (typeof data === 'object' && data !== null) {
      for (const agent of PROVIDER_IDS) {
        const r = (data as Record<string, unknown>)[agent] as Partial<Reservation> | undefined;
        if (r && typeof r.count === 'number' && r.count > 0 && (!r.until || Date.parse(r.until) > now)) out[agent] = { count: Math.floor(r.count), ...(typeof r.note === 'string' && r.note !== '' ? { note: r.note } : {}), at: typeof r.at === 'string' ? r.at : '', ...(r.until ? {until: r.until} : {}) };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeReservations(ctx: Context, reservations: Reservations): Promise<void> {
  await ctx.runner.writeFile(reservationsFile(ctx.config), `${JSON.stringify(reservations, null, 2)}\n`);
}

/** Parse `claude=1 codex=2` (a bare `claude` means 1 when reserving and everything when releasing). */
export function parseCounts(args: string[], bare: number | undefined, ids: readonly AgentName[] = DEFAULT_PROVIDERS): Partial<Record<AgentName, number | undefined>> {
  const out: Partial<Record<AgentName, number | undefined>> = {};
  if (args.length === 0) throw new AgentctlError('give a provider, e.g. claude=1', `The providers are ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}.`);
  for (const arg of args) {
    const m = /^([a-z]+)(?:=(\d+))?$/.exec(arg.trim());
    const agent = m?.[1] as AgentName | undefined;
    if (!m || !agent || !(ids as readonly string[]).includes(agent)) throw new AgentctlError(`"${arg}" is not ${ids.map(id => `${id}=N`).join(' or ')}`, `The providers are ${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}.`);
    const n = m[2] === undefined ? bare : Number(m[2]);
    if (n !== undefined && n < 1) throw new AgentctlError(`${arg}: the number must be 1 or more`);
    out[agent] = n;
  }
  return out;
}

export async function reservePlaces(ctx: Context, counts: Partial<Record<AgentName, number | undefined>>, note?: string, until?: string): Promise<Reservations> {
  const reservations = readReservations(ctx.config, ctx.runner.now());
  const at = new Date(ctx.runner.now()).toISOString();
  for (const agent of activeProviders(ctx.config)) {
    const n = counts[agent];
    if (n === undefined) continue;
    const have = reservations[agent];
    const expires = until ?? have?.until;
    reservations[agent] = { count: (have?.count ?? 0) + n, ...(note ? { note } : have?.note ? { note: have.note } : {}), at, ...(expires ? {until: expires} : {}) };
  }
  await writeReservations(ctx, reservations);
  await recordJournal(ctx, { kind: 'limits-changed', text: `zarezerwowano ${describeCounts(counts)}${note ? ` (${note})` : ''}` });
  return reservations;
}

/** Release places; a provider without a number is released completely. */
export async function releasePlaces(ctx: Context, counts: Partial<Record<AgentName, number | undefined>>): Promise<Reservations> {
  const reservations = readReservations(ctx.config, ctx.runner.now());
  const at = new Date(ctx.runner.now()).toISOString();
  for (const agent of activeProviders(ctx.config)) {
    if (!(agent in counts)) continue;
    const have = reservations[agent];
    if (!have) throw new AgentctlError(`nothing is reserved for ${agent}`, 'limits shows what is reserved.');
    const n = counts[agent];
    if (n === undefined || n >= have.count) delete reservations[agent];
    else reservations[agent] = { ...have, count: have.count - n, at };
  }
  await writeReservations(ctx, reservations);
  await recordJournal(ctx, { kind: 'limits-changed', text: `zwolniono ${describeCounts(counts)}` });
  return reservations;
}

const describeCounts = (counts: Partial<Record<AgentName, number | undefined>>): string =>
  AGENT_NAMES.filter((a) => a in counts).map((a) => `${a}${counts[a] === undefined ? '' : `=${counts[a]}`}`).join(' ');

// ---- agents outside agentctl

export interface ExternalAgent {
  agent: AgentName;
  pid: number;
  cwd?: string;
  command: string;
}

/** Subcommands and flags of claude/codex that are not a terminal session. */


interface Proc {
  pid: number;
  ppid: number;
  command: string;
}

export function parsePs(stdout: string): Proc[] {
  const out: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] as string });
  }
  return out;
}

/** The agent a command line starts as a terminal session; undefined for anything else (an MCP server, a headless run, agentctl itself). */
export function sessionAgent(command: string): AgentName | undefined {
  const tokens = command.split(/\s+/);
  return PROVIDER_IDS.find(id => adapter(id).isExternalSession(tokens));
}

/** Terminal sessions of claude/codex that run outside the windows of the agentctl session. Read-only: ps, tmux list-panes, lsof. */
export async function detectExternal(ctx: Context): Promise<ExternalAgent[]> {
  const { runner, config } = ctx;
  const uid = process.getuid?.();
  const ps = await runner.exec('ps', ['-ax', ...(uid === undefined ? [] : ['-U', String(uid)]), '-o', 'pid=,ppid=,command='], { readOnly: true });
  if (ps.code !== 0) return [];
  const procs = parsePs(ps.stdout);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const panes = await runner.exec('tmux', ['list-panes', '-s', '-t', `=${config.session}`, '-F', '#{pane_pid}'], { readOnly: true });
  const panePids = new Set(panes.code === 0 ? panes.stdout.split('\n').map((l) => Number(l.trim())).filter((n) => n > 0) : []);
  const candidates = procs.flatMap((p) => {
    const agent = sessionAgent(p.command);
    return agent ? [{ ...p, agent }] : [];
  });
  const candidatePids = new Set(candidates.map((c) => c.pid));
  const external = candidates.filter((c) => {
    for (let pid = c.ppid, hops = 0; pid > 1 && hops < 64; hops++) {
      if (panePids.has(pid) || candidatePids.has(pid)) return false; // inside a window of agentctl, or a child of another session
      pid = byPid.get(pid)?.ppid ?? 0;
    }
    return !panePids.has(c.pid);
  });
  if (external.length === 0) return [];
  const cwds = new Map<number, string>();
  const lsof = await runner.exec('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', external.map((e) => e.pid).join(',')], { readOnly: true });
  if (lsof.code === 0) {
    let pid = 0;
    for (const line of lsof.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0) cwds.set(pid, line.slice(1));
    }
  }
  return external.map((e) => ({ agent: e.agent, pid: e.pid, command: e.command, ...(cwds.has(e.pid) ? { cwd: cwds.get(e.pid) as string } : {}) }));
}

// ---- who holds the places

/** Places taken by something other than a window of agentctl: the reservations, and the sessions found outside (when counted). */
export async function slotHolders(ctx: Context): Promise<LiveWindow[]> {
  const out: LiveWindow[] = [];
  const reservations = readReservations(ctx.config, ctx.runner.now());
  for (const agent of activeProviders(ctx.config)) {
    const r = reservations[agent];
    for (let i = 0; r && i < r.count; i++) out.push({ window: `reserved${r.note ? ` (${r.note})` : ''}`, agent, kind: 'reserved' });
  }
  if (ctx.config.countExternal) {
    for (const e of await detectExternal(ctx)) out.push({ window: `external pid ${e.pid}${e.cwd ? ` in ${e.cwd}` : ''}`, agent: e.agent, kind: 'external', pid: e.pid, ...(e.cwd ? { cwd: e.cwd } : {}) });
  }
  return out;
}

export interface ProviderLoad {
  agent: AgentName;
  /** null: no limit; 'off': the provider is disabled. */
  limit: number | 'off' | null;
  /** Windows of agentctl. */
  windows: string[];
  starting: number;
  working: string[];
  active?: string[];
  reportReady: string[];
  reportWindows?: string[];
  slotTasks?: string[];
  queuedTasks?: string[];
  reserved: number;
  reservedNote: string | null;
  reservation?: Reservation;
  external: { pid: number; cwd: string | null }[];
  used: number;
  /** null: no limit. */
  free: number | null;
  /** Tasks waiting in the queue for this provider. */
  queued: number;
  /** `usage.queue_hold` of this provider: the plan percentage above which the queue starts none of its tasks; null: off. */
  queueHold: number | null;
  providerHold?: ProviderHold;
  chats?: ChatLoad[];
  plan?: string;
  ownerSlots?: Record<string, number>;
}

export interface LimitsReport {
  providers: ProviderLoad[];
  hosts?: { host: string; availability?: string; load?: number; memoryFreeKb?: number; total?: number; maxTotal?: number; perf?: string; providers: { agent: AgentName; limit: number | null; used: number; free: number | null; queued: number }[] }[];
  countExternal: boolean;
  config: string;
}

/** `live` is what `liveWindows` returns: windows of agentctl plus the reservations and the external sessions. */
export function collectLimits(config: GlobalConfig, live: readonly LiveWindow[], now = Date.now(), showPlans = false, rows?: StatusRow[]): LimitsReport {
  const holds = providerHolds(config, now);
  const plans = showPlans ? readPlanStates(config, openReader(config), now) : undefined;
  const healthByHost = new Map((readHostsCache()?.hosts ?? []).map(sample => [sample.name, sample]));
  const localAvailability = hostAvailability(config, 'local', healthByHost.get('local'), now);
  const queue = waiting(readQueue(config));
  const reservations = readReservations(config, now);
  return {
    countExternal: config.countExternal,
    config: config.path,
    hosts: Object.entries({ ...config.hosts, ...(config.localHost || config.placement.default === 'auto' || localAvailability ? { local: { ...config.localHost, providers: activeProviders(config) } } : {}) }).map(([host, h]) => {
      const health = healthByHost.get(host);
      const slots = live.filter(w => (w.host ?? 'local') === host && w.kind !== 'reserved');
      return { host, availability: host === 'local' ? localAvailability : hostAvailability(config, host, health, now), load: health?.load, memoryFreeKb: health?.memoryFreeKb,
        total: slots.filter(w => w.counted !== false && w.agent).length, maxTotal: h.maxTotal, perf: slots.find(w => w.perf && !w.reportReady)?.window,
        providers: h.providers.map(agent => {
      const limit = h.limits?.[agent] ?? null;
      const used = accountTasks([], slots.filter(w => w.agent === agent)).slots.length;
      return { agent, limit, used, free: holds[agent] ? 0 : limit === null ? null : Math.max(0, limit - used), queued: queue.filter(e => e.host === host && e.agent === agent).length };
    }) }; }),
    providers: activeProviders(config).map((agent): ProviderLoad => {
      const mine = live.filter((w) => w.agent === agent);
      const facts = accountTasks(rows?.filter(r => r.agent === agent && !r.hidden) ?? [], mine);
      const windows = mine.filter((w) => w.kind === undefined).map((w) => w.window);
      const working = rows ? facts.working.map(r => r.task) : mine.filter(w => w.kind === undefined && !w.reportReady).map(w => w.window);
      const reportReady = rows ? facts.reports.map(r => r.task) : mine.filter(w => w.reportReady).map(w => w.window);
      const starting = mine.filter(w => w.kind === 'starting').length;
      const reserved = mine.filter((w) => w.kind === 'reserved').length;
      const external = mine.filter((w) => w.kind === 'external').map((w) => ({ pid: w.pid ?? 0, cwd: w.cwd ?? null }));
      const limit = config.limits[agent] ?? null;
      const used = facts.slots.length;
      const chats = config.quotas?.per_host
        ? [undefined, ...Object.keys(config.hosts)].filter(host => !host || config.hosts[host]?.providers.includes(agent)).flatMap(host => chatLoads(config, agent, live, host))
        : chatLoads(config, agent, live);
      const plan = plans?.[agent];
      const ownerSlots: Record<string, number> = Object.create(null);
      for (const slot of facts.slots) if (slot.owner && (slot.kind === undefined || slot.kind === 'starting')) ownerSlots[slot.owner] = (ownerSlots[slot.owner] ?? 0) + 1;
      const queuedTasks = queue.filter(e => e.agent === agent).map(e => e.task);
      const slotTasks = facts.slots.filter(w => w.kind === undefined || w.kind === 'starting').map(w => rows?.find(r => r.windowName === w.window)?.task ?? w.window.toUpperCase());
      const reportWindows = facts.reports.filter(r => facts.slots.some(w => w.window === r.windowName && !w.kind)).map(r => r.task);
      return { agent, limit, windows, starting, working, reportReady, reserved, reservedNote: reservations[agent]?.note ?? null, ...(reservations[agent] ? {reservation: reservations[agent]} : {}), external, used, slotTasks, queuedTasks, ownerSlots,
        ...(rows ? { active: facts.active.map(r => r.task), reportWindows } : {}), ...(chats.length ? { chats } : {}), ...(plan ? {plan: planLine(plan, now)} : {}), ...(holds[agent] ? {providerHold: holds[agent]} : {}),
        free: holds[agent] || limit === 'off' ? 0 : limit === null ? null : Math.max(0, limit - used), queued: queuedTasks.length, queueHold: config.usage.queueHold[agent] ?? null };
    }),
  };
}

export function reservationText(agent: AgentName, reservation: Reservation): string {
  return `rezerwacja właściciela: ${agent} ${reservation.count}${reservation.note ? ` (${reservation.note})` : ''}${reservation.until ? ` do ${formatLocalTime(reservation.until)}` : ' do zwolnienia'}`;
}

export function reservationLines(config: GlobalConfig, now: number): string[] {
  const reservations = readReservations(config, now);
  return activeProviders(config).flatMap(agent => reservations[agent] ? [reservationText(agent, reservations[agent])] : []);
}

export function chatUsageLine(report: LimitsReport, owner: string): string {
  const usage = report.providers.map(provider => {
    const chat = provider.chats?.find(load => load.chat === owner && (!load.host || load.host === 'local'));
    const used = chat?.used ?? provider.ownerSlots?.[owner] ?? 0;
    const ceiling = provider.limit === 'off' ? 0 : chat?.share ?? '∞';
    return `${provider.agent} ${used}/${ceiling}`;
  });
  return `${owner.slice('chat:'.length)}: ${usage.join(', ')} (globalnie wolne ${report.providers.map(provider => provider.free ?? '∞').join('/')})`;
}

export function renderLimits(report: LimitsReport): string[] {
  const header = ['PROVIDER', 'LIMIT', 'USED', 'FREE', 'AGENTCTL', 'WORKING', 'REPORT-READY', 'RESERVED', 'EXTERNAL', 'QUEUED', 'HOLD'];
  const body = report.providers.map((p) => [p.agent, p.limit === null ? '-' : String(p.limit), String(p.used), p.free === null ? '-' : String(p.free), String(p.windows.length), String(p.working.length), String(p.reportReady.length), String(p.reserved), report.countExternal ? String(p.external.length) : 'off', String(p.queued), p.providerHold ? providerHoldText(p.agent, p.providerHold) : holdText(p.queueHold)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  const lines = [fmt(header), ...body.map(fmt)];
  for (const p of report.providers) {
    const parts: string[] = [];
    if (p.plan) parts.push(`plan: ${p.plan}`);
    if (p.windows.length > 0) parts.push(`agentctl${taskNames(p.windows)}`);
    if (p.working.length) parts.push(`working${taskNames(p.working)}`);
    if (p.reportReady.length) parts.push(`report-ready${taskNames(p.reportReady)}`);
    if (p.queuedTasks?.length) parts.push(`queued${taskNames(p.queuedTasks)}`);
    if (p.reserved > 0) parts.push(`reserved: ${p.reserved}${p.reservedNote ? ` (${p.reservedNote})` : ''}`);
    for (const e of p.external) parts.push(`external: pid ${e.pid}${e.cwd ? ` in ${e.cwd}` : ''}`);
    for (const chat of p.chats ?? []) lines.push(`  ${p.agent} ${renderChatLoad(chat)}`);
    if (parts.length > 0) lines.push(`  ${p.agent}: ${parts.join(' · ')}`);
  }
  for (const h of report.hosts ?? []) {
    const parts = h.providers.map(p => `${p.agent} ${p.used}/${p.limit ?? 'unbounded'}, free ${p.free ?? 'unbounded'}, queued ${p.queued}`);
    if (h.maxTotal !== undefined) parts.push(`total ${h.total ?? 0}/${h.maxTotal}`);
    if (h.availability) parts.push(h.availability);
    if (h.perf) parts.push(`perf ${h.perf}`);
    lines.push(`host ${h.host}: ${parts.join(' · ')} (account limits/holds also apply)`);
  }
  lines.push(report.countExternal ? 'External sessions are counted (limits.count_external).' : 'Sessions started by hand are not counted: "agentctl limits reserve claude=1" holds a place, or set limits.count_external: true.');
  lines.push('HOLD = usage.queue_hold: above that plan percentage (any window) the queue starts no task of the provider; off = never held.');
  lines.push('Change: agentctl limits set claude=3 codex=5 queue_hold.codex=90   (takes effect at once, also in a running watch)');
  return lines;
}

/** The provider and chat counts for concise MCP responses. */
export function compactLimits(report: LimitsReport): string {
  return report.providers.flatMap(p => [
    `${p.agent}: used=${p.used}${taskNames(p.slotTasks ?? [])} limit=${p.limit ?? 'n/d'} free=${p.free ?? 'n/d'} reserved=${p.reserved} queued=${p.queued}${taskNames(p.queuedTasks ?? [])} queue_hold=${holdText(p.queueHold)}${p.providerHold ? `; ${providerHoldText(p.agent, p.providerHold)}` : ''}`,
    ...(p.plan ? [`  ${p.agent} plan ${p.plan}`] : []),
    ...(p.working.length || p.reportReady.length ? [`  working=${p.working.length}${taskNames(p.working)} report-ready=${p.reportReady.length}${taskNames(p.reportReady)}`] : []),
    ...(p.chats ?? []).map(chat => `  ${renderChatLoad(chat)}`),
  ]).join('\n');
}

/** "90%" or "off". */
export const holdText = (hold: number | null | undefined): string => (hold === null || hold === undefined ? 'off' : `${hold}%`);

/** "queue_hold: claude off → 90%": the same words whoever changed the file (MCP, CLI, a hand edit seen by watch), so the journal says it once. */
export function holdDiffText(from: Partial<Record<AgentName, number>>, to: Partial<Record<AgentName, number>>): string | undefined {
  const parts = AGENT_NAMES.filter((a) => (from[a] ?? null) !== (to[a] ?? null)).map((a) => `${a} ${holdText(from[a])} → ${holdText(to[a])}`);
  return parts.length === 0 ? undefined : `queue_hold: ${parts.join(', ')}`;
}

/** One value of `usage.queue_hold`: a whole percentage 1–100, or off. */
export type HoldValue = number | 'off';
/** What `limits set` / MCP `set_limits` change in `usage.queue_hold`: one value for every active provider, or per provider. */
export type HoldAssignment = HoldValue | Partial<Record<AgentName, HoldValue>>;
export interface HoldChange { agent: AgentName; from: number | null; to: number | null }

function holdValue(value: unknown, where: string): HoldValue {
  if (value === 'off') return 'off';
  const n = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 100) return n;
  throw new AgentctlError(`${where}: "${String(value)}" is not a whole percentage from 1 to 100 or off`, 'Examples: queue_hold=90, queue_hold=off, queue_hold.codex=85.');
}

/** `queue_hold=90`, `queue_hold=off`, `queue_hold.codex=85`: the queue_hold words of `limits set`, and the other words left over. */
export function parseHoldArgs(args: string[], ids: readonly AgentName[] = DEFAULT_PROVIDERS): { hold?: HoldAssignment; rest: string[] } {
  const rest: string[] = [];
  let hold: HoldAssignment | undefined;
  for (const arg of args) {
    const m = /^queue_hold(?:\.([a-z]+))?=(.+)$/.exec(arg.trim());
    if (!m) { rest.push(arg); continue; }
    const value = holdValue(m[2], 'queue_hold');
    if (!m[1]) { hold = value; continue; }
    const agent = m[1] as AgentName;
    if (!ids.includes(agent)) throw new AgentctlError(`queue_hold.${m[1]}: not an active provider (${ids.join(', ')})`);
    hold = { ...(typeof hold === 'object' ? hold : {}), [agent]: value };
  }
  return { ...(hold !== undefined ? { hold } : {}), rest };
}

/** The MCP form: 90, "90", "off", or {claude: 90, codex: "off"}. */
export function parseHoldInput(input: unknown, ids: readonly AgentName[]): HoldAssignment {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const out: Partial<Record<AgentName, HoldValue>> = {};
    for (const [agent, value] of Object.entries(input as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (!(ids as readonly string[]).includes(agent)) throw new AgentctlError(`queue_hold.${agent}: not an active provider (${ids.join(', ')})`);
      out[agent as AgentName] = holdValue(value, `queue_hold.${agent}`);
    }
    if (Object.keys(out).length === 0) throw new AgentctlError('queue_hold: give at least one provider, e.g. {codex: 90}');
    return out;
  }
  return holdValue(input, 'queue_hold');
}

// ---- changing the limits

export type LimitAssignments = Partial<Record<AgentName, number | 'off' | null>>;

/** `claude=3 codex=off`: a number, `off` to disable the provider, or 0 / none to remove the limit. */
export function parseAssignments(args: string[], ids: readonly AgentName[] = DEFAULT_PROVIDERS): LimitAssignments {
  if (args.length === 0) throw new AgentctlError('give the new limits, e.g. claude=3 codex=5', 'off disables a provider; 0 or none removes a limit: codex=0.');
  const out: LimitAssignments = {};
  for (const arg of args) {
    const m = /^([a-z]+)=(\d+|off|none)$/.exec(arg.trim());
    const agent = m?.[1] as AgentName | undefined;
    if (!m || !agent || !(ids as readonly string[]).includes(agent)) throw new AgentctlError(`"${arg}" is not ${ids.map(id => `${id}=N`).join(' or ')}`, 'N is a whole number from 1, off disables the provider, 0 or none removes the limit.');
    const value = m[2] as string;
    if (value === 'off') out[agent] = 'off';
    else if (value === 'none' || Number(value) === 0) out[agent] = null;
    else out[agent] = Number(value);
  }
  return out;
}

/** "limity: claude 3 → 4, codex 5 → -": the same words whoever changed the file, so that the journal says it once. */
export function limitsDiffText(from: GlobalConfig['limits'], to: GlobalConfig['limits'], ids: readonly AgentName[] = PROVIDER_IDS.filter(id => id in from || id in to)): string | undefined {
  const parts = AGENT_NAMES.filter((a) => (from[a] ?? null) !== (to[a] ?? null)).map((a) => `${a} ${from[a] ?? '-'} → ${to[a] ?? '-'}`);
  return parts.length === 0 ? undefined : `limity: ${parts.join(', ')}; providers: ${ids.map(id => `${id}=${to[id] ?? '-'}`).join(', ')}`;
}

export interface LimitsChange {
  agent: AgentName;
  from: number | 'off' | null;
  to: number | 'off' | null;
}

export interface LimitsPlan {
  file: string;
  baseText: string;
  baseQuotaScope: string;
  changes: LimitsChange[];
  /** `usage.queue_hold` per active provider, when the plan changes it. */
  holdChanges: HoldChange[];
  timedHolds?: TimedHolds;
  /** The new text of the config file: comments and order of everything else kept. */
  text: string;
  summary: string[];
  quotaChange?: boolean;
  writesConfig: boolean;
  difference: string;
}

export interface QuotaEdit {
  quota?: unknown;
  overprovision?: unknown;
  /** Undefined for the owner; otherwise the only chat that may be edited. */
  self?: string;
}

export interface LimitEditOptions { profile?: string; until?: string }

const quotaScope = (config: GlobalConfig): string => JSON.stringify([config.limits, config.quotas, config.wall.chats]);

function editQuotas(config: GlobalConfig, edit: QuotaEdit): { chat?: string; shares?: Record<string, unknown> } {
  const p = new Problems();
  const before = config.limitSettings.baseQuotas ?? parseChatQuotas({}, p)!;
  const raw = edit.quota;
  const chat = isObject(raw) ? chatOwner(raw.chat) : undefined;
  if (raw !== undefined && !chat) throw new AgentctlError('quota must include a valid chat and at least one provider share');
  const shares = isObject(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'chat').map(([key, value]) => [key, key !== 'share' && value === null ? 'off' : value])) : undefined;
  if (shares && !Object.keys(shares).length) throw new AgentctlError('quota must include at least one provider share');
  for (const id of Object.keys(shares ?? {})) if (id !== 'share' && !(activeProviders(config) as readonly string[]).includes(id)) throw new AgentctlError(`quota.${id}: provider is not active`);
  const name = chat?.slice(5) ?? '';
  const { shareFloor, ...legacy } = before;
  const next = parseChatQuotas({
    ...legacy,
    floor: shareFloor ?? before.floor,
    ...(edit.overprovision !== undefined ? { overprovision: edit.overprovision } : {}),
    ...(shares ? chat === DEFAULT_OWNER ? { default: { ...before.default, ...shares } }
      : { chats: { ...before.chats, [name]: { ...before.chats[name], ...shares } } } : {}),
  }, p)!;
  p.throwIfAny('Invalid quota edit:');
  if (edit.self) {
    const prior = config.quotas ?? before;
    const current = chat === DEFAULT_OWNER ? next.default : next.chats[name];
    const effective = { ...prior, default: next.default, chats: { ...prior.chats, ...(chat && chat !== DEFAULT_OWNER ? { [name]: { ...prior.chats[name], ...current } } : {}) } };
    const nextConfig = { ...config, quotas: effective };
    for (const id of activeProviders(config)) {
      const budget = quotaBudget(nextConfig, id);
      if ((Object.hasOwn(shares ?? {}, id) || quotaBudget({ ...config, quotas: prior }, id).shares !== budget.shares) && budget.shares > budget.budget) {
        throw new AgentctlError(`${chat}: ${id} shares would total ${budget.shares}, above the overprovision budget ${budget.budget}`, QUOTA_DECISION_HINT);
      }
    }
  }
  return { chat, shares };
}

export const QUOTA_DECISION_HINT = 'Post a decision-request on the WALL channel agentctl for the owner.';

export function quotaDiffText(from?: ChatQuotas, to?: ChatQuotas): string | undefined {
  const differences: string[] = [];
  if (!from || !to) {
    if (from !== to) differences.push(to ? 'włączono' : 'wyłączono');
  }
  const compare = (name: string, a: unknown, b: unknown) => {
    if (a !== b) differences.push(`${name} ${a ?? '-'} → ${b ?? '-'}`);
  };
  compare('overprovision', from?.overprovision, to?.overprovision);
  compare('floor', from?.shareFloor, to?.shareFloor);
  compare('per_host', from?.per_host, to?.per_host);
  compare('self_service', from?.self_service, to?.self_service);
  const chats = [...new Set([...Object.keys(from?.chats ?? {}), ...Object.keys(to?.chats ?? {})])].sort();
  for (const name of chats) {
    if (Object.hasOwn(from?.chats ?? {}, name) !== Object.hasOwn(to?.chats ?? {}, name)) differences.push(`chat:${name} ${Object.hasOwn(to?.chats ?? {}, name) ? 'dodano' : 'usunięto'}`);
    compare(`chat:${name} share %`, from?.chats[name]?.share, to?.chats[name]?.share);
  }
  const quotaLabel = (value: unknown) => value === 0 ? '0 (blocked)' : value === 'off' ? 'off (no quota)' : value;
  for (const id of PROVIDER_IDS) {
    compare(`default ${id}`, quotaLabel(from?.default[id]), quotaLabel(to?.default[id]));
    compare(`floor ${id}`, from?.floor[id], to?.floor[id]);
    for (const name of chats) {
      compare(`chat:${name} ${id}`, quotaLabel(from?.chats[name]?.[id]), quotaLabel(to?.chats[name]?.[id]));
    }
  }
  for (const cohort of [...new Set([...Object.keys(from?.cohorts ?? {}), ...Object.keys(to?.cohorts ?? {})])].sort()) {
    compare(cohort, from?.cohorts[cohort], to?.cohorts[cohort]);
  }
  return differences.length ? `kwoty: ${differences.join(', ')}` : undefined;
}

type EffectiveLimits = Pick<GlobalConfig, 'limits' | 'quotas'> & { queueHold?: GlobalConfig['usage']['queueHold']; profile?: string; timed?: GlobalConfig['limitRuntime']['timed'] };
interface LimitNotice { changeId: string; text: string; journal?: boolean }
interface LimitNotices { observed: EffectiveLimits; pending: LimitNotice[] }
const limitNoticesPath = (file: string) => `${file}.limit-notices.json`;
export const limitEditLock = (file: string) => `${file}.limits-edit.lock`;

const limitRevision = (config: GlobalConfig): EffectiveLimits => ({ limits: config.limits, quotas: config.quotas,
  queueHold: config.usage.queueHold, profile: config.limitRuntime.profile, timed: config.limitRuntime.timed });

function revisionDiff(from: EffectiveLimits, to: EffectiveLimits): string[] {
  return [limitsDiffText(from.limits, to.limits), quotaDiffText(from.quotas, to.quotas), holdDiffText(from.queueHold ?? {}, to.queueHold ?? {}),
    from.profile !== to.profile ? `profil: ${from.profile ?? '-'} → ${to.profile ?? '-'}` : undefined,
    ...PROVIDER_IDS.flatMap(id => {
      const a = from.timed?.[id], b = to.timed?.[id];
      const print = (entry: typeof a) => entry ? `${entry.value || 'bez limitu'} do ${entry.until}` : '-';
      return JSON.stringify(a) === JSON.stringify(b) ? [] : [`limit czasowy ${id}: ${print(a)} → ${print(b)}`];
    }),
  ].filter((line): line is string => Boolean(line));
}

function ceilingLines(config: GlobalConfig): string[] {
  return Object.entries(effectiveChatCeilings(config)).map(([provider, chats]) =>
    `${provider}: ${Object.entries(chats).map(([chat, q]) => `${chat}=${q.ceiling ?? '∞'} (min. ${q.floor})`).join(', ')}`);
}

function observeLimitConfig(before: GlobalConfig, after: GlobalConfig, source: string, additional: string[] = [], now = Date.now()): LimitNotices {
  const file = limitNoticesPath(after.path);
  let notices: LimitNotices;
  let initial = false;
  try { notices = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    notices = { observed: limitRevision(before), pending: [] };
    initial = true;
  }
  const previous = notices.observed;
  // The on-disk observation from 0.26 has no queue-hold field.
  if (!previous.queueHold) previous.queueHold = before.usage.queueHold;
  const next = limitRevision(after);
  const changes = [...revisionDiff(previous, next), ...additional];
  if (changes.length) {
    const expired = Object.values(previous.timed ?? {}).some(entry => Date.parse(entry.until) <= now);
    const via = source === 'config edit' && expired ? 'wygaśnięcie limitu czasowego'
      : source === 'config edit' && previous.profile !== next.profile && after.limitSettings.schedule ? 'harmonogram' : source;
    const ceilings = ceilingLines(after);
    const text = [`Źródło: ${via}`, ...changes, ...(ceilings.length ? ['Efektywne kwoty:', ...ceilings] : [])].join('\n');
    notices.pending.push({ changeId: `limits/${randomUUID()}`, text, journal: changes.some(line => !line.startsWith('queue_hold:') && !line.startsWith('hold.')) });
  }
  if (initial || changes.length) {
    notices.observed = next;
    atomicWriteFile(file, JSON.stringify(notices));
  }
  return notices;
}

/** The shared edit lock orders observations and keeps a retry from publishing the same revision twice. */
async function publishLimitNotices(ctx: Context, notices: LimitNotices): Promise<void> {
  for (const {changeId, text, journal} of notices.pending) {
    if (journal !== false) await recordJournalOnce(ctx, {kind: 'limits-changed', text, changeId});
    await postMessage(ctx, OWNER_IDENTITY, {channel: WALL_TOOL_CHANNEL, kind: 'info', subject: 'Zmiana limitów lub kwot', body: text.slice(0, 4000), origin: changeId});
  }
  if (notices.pending.length) atomicWriteFile(limitNoticesPath(ctx.config.path), JSON.stringify({...notices, pending: []}));
}

/** Called by watch while holding the same lock that guards config edits. */
export async function announceLimitConfigChange(ctx: Context, before: GlobalConfig, after: GlobalConfig): Promise<void> {
  if (!ctx.runner.dryRun) await publishLimitNotices(ctx, observeLimitConfig(before, after, 'config edit', [], ctx.runner.now()));
}

/** The edit as text; nothing is written. */
export function planSetLimits(config: GlobalConfig, assignments: LimitAssignments, hold?: HoldAssignment, timedInput?: unknown, now = Date.now(), quotaEdit?: QuotaEdit, options: LimitEditOptions = {}): LimitsPlan {
  const timedHolds = timedInput === undefined ? undefined : parseTimedHolds(config, timedInput, now);
  const file = config.path;
  const baseText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const changes: LimitsChange[] = [];
  const holdChanges: HoldChange[] = [];
  const quota = quotaEdit ? editQuotas(config, quotaEdit) : undefined;
  const { profile, until } = options;
  if (profile !== undefined && !Object.hasOwn(config.limitSettings.profiles, profile)) throw new AgentctlError(`Unknown limits profile: ${profile}`);
  if (until && (!Object.keys(assignments).length || hold !== undefined || quotaEdit || profile !== undefined || timedHolds)) throw new AgentctlError('--until requires provider limits only');
  const deadline = until ? holdUntil(until, now) : undefined;
  const active = profile ?? config.limitRuntime.profile;
  const text = editConfigText(config, (doc) => {
    if (profile !== undefined) {
      const next = config.limitRuntime.nextSwitch;
      doc.setIn(['limits', 'active_profile'], next ? { name: profile, until: new Date(next.at).toISOString() } : profile);
    }
    if (quota && quotaEdit) {
      if (quotaEdit.overprovision !== undefined) doc.setIn(['quotas', 'overprovision'], quotaEdit.overprovision);
      if (quota.chat && quota.shares) {
        const key = quota.chat === DEFAULT_OWNER ? ['quotas', 'default'] : ['quotas', 'chats', quota.chat.slice(5)];
        for (const [agent, value] of Object.entries(quota.shares)) {
          const chat = quota.chat.slice(5);
          if (agent === 'share' && active && Object.hasOwn(config.limitSettings.profiles[active]!.shares, chat)) doc.setIn(['limits', 'profiles', active, 'shares', chat], value);
          else doc.setIn([...key, agent], value);
        }
      }
    }
    if (hold !== undefined) {
      const ids = activeProviders(config);
      const current = config.usage.queueHold;
      const next: Partial<Record<AgentName, number>> = {};
      if (typeof hold === 'number') for (const id of ids) next[id] = hold;
      else if (typeof hold === 'object') {
        for (const id of ids) if (current[id] !== undefined) next[id] = current[id];
        for (const [agent, value] of Object.entries(hold) as [AgentName, HoldValue][]) {
          if (value === 'off') delete next[agent];
          else next[agent] = value;
        }
      }
      for (const id of ids) holdChanges.push({ agent: id, from: current[id] ?? null, to: next[id] ?? null });
      // One number stays one number; a mapping names only the held providers; nothing held removes the key.
      if (Object.keys(next).length === 0) {
        if (doc.hasIn(['usage', 'queue_hold'])) doc.deleteIn(['usage', 'queue_hold']);
      }
      else doc.setIn(['usage', 'queue_hold'], typeof hold === 'number' ? hold : doc.createNode(next));
    }
    for (const agent of activeProviders(config)) {
      const to = assignments[agent];
      if (to === undefined) continue;
      const from = config.limits[agent] ?? null;
      // Omitting GLM's limit restores its built-in cap. Write an explicit zero to remove it.
      if (deadline) doc.setIn(['limits', 'timed_overrides', agent], { value: to ?? 0, until: deadline });
      else {
        if (doc.hasIn(['limits', 'timed_overrides', agent])) doc.deleteIn(['limits', 'timed_overrides', agent]);
        if (active && Object.hasOwn(config.limitSettings.profiles[active]!.providers, agent)) doc.setIn(['limits', 'profiles', active, agent], to ?? 0);
        else if (to === null && agent !== 'glm') {
          if (doc.hasIn(['limits', agent])) doc.deleteIn(['limits', agent]);
        }
        else doc.setIn(['limits', agent], to ?? 0);
      }
      changes.push({ agent, from, to });
    }
  });
  const show = (n: number | 'off' | null): string => (n === null ? 'no limit' : n === 'off' ? 'off (disabled)' : String(n));
  const writesConfig = Boolean(changes.length || holdChanges.length || quota || profile !== undefined);
  const next = writesConfig ? loadGlobalConfig(path.dirname(file), now, text) : config;
  const quotaText = quota ? quotaDiffText(config.quotas, next.quotas) : undefined;
  const difference = revisionDiff(limitRevision(config), limitRevision(next)).join('\n');
  return {
    file,
    baseText,
    baseQuotaScope: quotaScope(config),
    changes,
    holdChanges,
    writesConfig,
    difference,
    ...(quota ? {quotaChange: Boolean(quotaText)} : {}),
    ...(timedHolds ? {timedHolds} : {}),
    text,
    summary: [file, ...Object.entries(timedHolds ?? {}).map(([agent, until]) => `  hold.${agent}: ${until}`), ...changes.map((c) => `  limits.${c.agent}: ${show(c.from)} -> ${show(c.to)}${c.from === c.to ? ' (unchanged)' : ''}`), ...holdChanges.map((c) => `  usage.queue_hold.${c.agent}: ${holdText(c.from)} -> ${holdText(c.to)}${c.from === c.to ? ' (unchanged)' : ''}`),
      ...(quota ? [`  ${quotaText ?? 'quotas unchanged'}`] : []),
      ...(profile !== undefined ? [difference || `Profile: ${profile}`] : []),
      ...(deadline ? [`  Reverts at ${deadline}`] : []),
      ...quotaWarnings(next).map(warning => `  WARNING: ${warning}`),
      '  (a copy of the file is kept as config.yaml.bak; comments and the order of the keys stay)'],
  };
}

/** Write the plan: a `.bak` copy first, the new text, and a check that the result loads (else the old text comes back). */
export async function applySetLimits(ctx: Context, plan: LimitsPlan, source = 'config edit', requireDirect = false): Promise<void> {
  if (ctx.runner.dryRun) {
    if (plan.writesConfig) await writeConfigText(ctx, plan.file, plan.text);
    return;
  }
  await withStateWriteLock(limitEditLock(plan.file), async () => {
    const current = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : '';
    if (current !== plan.baseText) throw new AgentctlError('Limits config changed; preview the edit again.');
    const before = loadGlobalConfig(path.dirname(plan.file), ctx.runner.now());
    if (requireDirect && plan.writesConfig && before.limitSettings.changePolicy !== 'direct') throw new AgentctlError('Limit change policy changed; submit the request again.');
    if (plan.writesConfig && quotaScope(before) !== plan.baseQuotaScope) throw new AgentctlError('Limits or WALL identity changed; preview the edit again.');
    if (plan.writesConfig && ctx.config.limitRuntime.profile !== before.limitRuntime.profile) throw new AgentctlError('Active limits profile changed; preview the edit again.');
    await commitLimitPlan(ctx, before, plan, source);
  });
}

/** Commit a plan built against the current config under limitEditLock. */
export async function commitLimitPlan(ctx: Context, before: GlobalConfig, plan: LimitsPlan, source: string, committed?: () => void): Promise<void> {
  const { writesConfig } = plan;
  const now = ctx.runner.now();
  const previousHolds = plan.timedHolds ? providerHolds(before, now) : {};
  if (writesConfig) {
    // A manual edit may have happened since watch last saw the configuration.
    observeLimitConfig(before, before, 'config edit', [], now);
    const current = fs.existsSync(plan.file) ? fs.readFileSync(plan.file, 'utf8') : '';
    if (current !== plan.baseText) throw new AgentctlError('Limits config changed; preview the edit again.');
    await writeConfigText(ctx, plan.file, plan.text);
  }
  if (plan.timedHolds) await setProviderHolds(ctx, plan.timedHolds);
  const after = writesConfig ? loadGlobalConfig(path.dirname(plan.file), now) : before;
  if (writesConfig || plan.timedHolds) {
    const holdChanges = Object.entries(plan.timedHolds ?? {}).flatMap(([agent, until]) => {
      const previous = previousHolds[agent as AgentName]?.until ?? 'off';
      return previous === until ? [] : [`hold.${agent}: ${previous} → ${until}`];
    });
    const notices = observeLimitConfig(before, after, source, holdChanges, now);
    committed?.();
    // Retain command-line delivery for installations that run without watch.
    if (!watchAlive(ctx.config, ctx.runner.now())) await publishLimitNotices(ctx, notices);
  }
  const hold = holdDiffText(before.usage.queueHold, after.usage.queueHold);
  if (hold) await recordJournalOnce(ctx, { kind: 'limits-changed', text: hold });
}
