import fs from 'node:fs';
import YAML from 'yaml';
import { AGENT_NAMES, loadGlobalConfig } from './config.ts';
import type { AgentName, GlobalConfig } from './config.ts';
import type { LiveWindow } from './checks.ts';
import type { Context } from './context.ts';
import { editConfigText, writeConfigText } from './config-edit.ts';
import { recordJournal, recordJournalOnce } from './journal.ts';
import { readQueue, waiting } from './queue.ts';
import { AgentctlError, errorMessage } from './util.ts';
import path from 'node:path';

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
}

export type Reservations = Partial<Record<AgentName, Reservation>>;

export const reservationsFile = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'reservations.json');

export function readReservations(config: Pick<GlobalConfig, 'path'>): Reservations {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(reservationsFile(config), 'utf8'));
    const out: Reservations = {};
    if (typeof data === 'object' && data !== null) {
      for (const agent of AGENT_NAMES) {
        const r = (data as Record<string, unknown>)[agent] as Partial<Reservation> | undefined;
        if (r && typeof r.count === 'number' && r.count > 0) out[agent] = { count: Math.floor(r.count), ...(typeof r.note === 'string' && r.note !== '' ? { note: r.note } : {}), at: typeof r.at === 'string' ? r.at : '' };
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
export function parseCounts(args: string[], bare: number | undefined): Partial<Record<AgentName, number | undefined>> {
  const out: Partial<Record<AgentName, number | undefined>> = {};
  if (args.length === 0) throw new AgentctlError('give a provider, e.g. claude=1', 'The providers are claude and codex.');
  for (const arg of args) {
    const m = /^([a-z]+)(?:=(\d+))?$/.exec(arg.trim());
    const agent = m?.[1] as AgentName | undefined;
    if (!m || !agent || !(AGENT_NAMES as readonly string[]).includes(agent)) throw new AgentctlError(`"${arg}" is not claude=N or codex=N`, 'The providers are claude and codex.');
    const n = m[2] === undefined ? bare : Number(m[2]);
    if (n !== undefined && n < 1) throw new AgentctlError(`${arg}: the number must be 1 or more`);
    out[agent] = n;
  }
  return out;
}

export async function reservePlaces(ctx: Context, counts: Partial<Record<AgentName, number | undefined>>, note?: string): Promise<Reservations> {
  const reservations = readReservations(ctx.config);
  const at = new Date(ctx.runner.now()).toISOString();
  for (const agent of AGENT_NAMES) {
    const n = counts[agent];
    if (n === undefined) continue;
    const have = reservations[agent];
    reservations[agent] = { count: (have?.count ?? 0) + n, ...(note ? { note } : have?.note ? { note: have.note } : {}), at };
  }
  await writeReservations(ctx, reservations);
  await recordJournal(ctx, { kind: 'limits-changed', text: `zarezerwowano ${describeCounts(counts)}${note ? ` (${note})` : ''}` });
  return reservations;
}

/** Release places; a provider without a number is released completely. */
export async function releasePlaces(ctx: Context, counts: Partial<Record<AgentName, number | undefined>>): Promise<Reservations> {
  const reservations = readReservations(ctx.config);
  const at = new Date(ctx.runner.now()).toISOString();
  for (const agent of AGENT_NAMES) {
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
const NOT_A_SESSION = new Set(['mcp', 'mcp-server', 'app-server', 'exec', 'usage-tap', 'agentctl', '--print', '-p', 'doctor', 'update', 'install', 'login', 'logout', 'proto']);

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
  const first = path.basename(tokens[0] ?? '');
  let agent: AgentName | undefined;
  if (first === 'claude' || first === 'codex') agent = first;
  else if (/^node(js)?$/.test(first) && /(claude-code|@openai\/codex)\/\S*\.js$/.test(tokens[1] ?? '')) agent = (tokens[1] ?? '').includes('claude-code') ? 'claude' : 'codex';
  if (!agent) return undefined;
  if (tokens.slice(1).some((t) => NOT_A_SESSION.has(t) || t.includes('agentctl'))) return undefined;
  return agent;
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
  const reservations = readReservations(ctx.config);
  for (const agent of AGENT_NAMES) {
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
  /** null: no limit. */
  limit: number | null;
  /** Windows of agentctl. */
  windows: string[];
  starting: number;
  working: string[];
  reportReady: string[];
  reserved: number;
  reservedNote: string | null;
  external: { pid: number; cwd: string | null }[];
  used: number;
  /** null: no limit. */
  free: number | null;
  /** Tasks waiting in the queue for this provider. */
  queued: number;
}

export interface LimitsReport {
  providers: ProviderLoad[];
  countExternal: boolean;
  config: string;
}

/** `live` is what `liveWindows` returns: windows of agentctl plus the reservations and the external sessions. */
export function collectLimits(config: GlobalConfig, live: readonly LiveWindow[]): LimitsReport {
  const queue = waiting(readQueue(config));
  const reservations = readReservations(config);
  return {
    countExternal: config.countExternal,
    config: config.path,
    providers: AGENT_NAMES.map((agent): ProviderLoad => {
      const mine = live.filter((w) => w.agent === agent);
      const windows = mine.filter((w) => w.kind === undefined).map((w) => w.window);
      const working = mine.filter(w => w.kind === undefined && !w.reportReady).map(w => w.window);
      const reportReady = mine.filter(w => w.reportReady).map(w => w.window);
      const starting = mine.filter(w => w.kind === 'starting').length;
      const reserved = mine.filter((w) => w.kind === 'reserved').length;
      const external = mine.filter((w) => w.kind === 'external').map((w) => ({ pid: w.pid ?? 0, cwd: w.cwd ?? null }));
      const limit = config.limits[agent] ?? null;
      const used = mine.filter(w => w.kind === undefined && w.counted !== false).length + starting + reserved + external.length;
      return { agent, limit, windows, starting, working, reportReady, reserved, reservedNote: reservations[agent]?.note ?? null, external, used, free: limit === null ? null : Math.max(0, limit - used), queued: queue.filter((e) => e.agent === agent).length };
    }),
  };
}

export function renderLimits(report: LimitsReport): string[] {
  const header = ['PROVIDER', 'LIMIT', 'USED', 'FREE', 'AGENTCTL', 'WORKING', 'REPORT-READY', 'RESERVED', 'EXTERNAL', 'QUEUED'];
  const body = report.providers.map((p) => [p.agent, p.limit === null ? '-' : String(p.limit), String(p.used), p.free === null ? '-' : String(p.free), String(p.windows.length), String(p.working.length), String(p.reportReady.length), String(p.reserved), report.countExternal ? String(p.external.length) : 'off', String(p.queued)]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] as string).length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ').trimEnd();
  const lines = [fmt(header), ...body.map(fmt)];
  for (const p of report.providers) {
    const parts: string[] = [];
    if (p.windows.length > 0) parts.push(`agentctl: ${p.windows.join(', ')}`);
    if (p.reserved > 0) parts.push(`reserved: ${p.reserved}${p.reservedNote ? ` (${p.reservedNote})` : ''}`);
    for (const e of p.external) parts.push(`external: pid ${e.pid}${e.cwd ? ` in ${e.cwd}` : ''}`);
    if (parts.length > 0) lines.push(`  ${p.agent}: ${parts.join(' · ')}`);
  }
  lines.push(report.countExternal ? 'External sessions are counted (limits.count_external).' : 'Sessions started by hand are not counted: "agentctl limits reserve claude=1" holds a place, or set limits.count_external: true.');
  lines.push('Change: agentctl limits set claude=3 codex=5   (takes effect at once, also in a running watch)');
  return lines;
}

// ---- changing the limits

export type LimitAssignments = Partial<Record<AgentName, number | null>>;

/** `claude=3 codex=off`: a number, or off / none to remove the limit. */
export function parseAssignments(args: string[]): LimitAssignments {
  if (args.length === 0) throw new AgentctlError('give the new limits, e.g. claude=3 codex=5', 'off removes a limit: codex=off.');
  const out: LimitAssignments = {};
  for (const arg of args) {
    const m = /^([a-z]+)=(\d+|off|none)$/.exec(arg.trim());
    const agent = m?.[1] as AgentName | undefined;
    if (!m || !agent || !(AGENT_NAMES as readonly string[]).includes(agent)) throw new AgentctlError(`"${arg}" is not claude=N or codex=N`, 'N is a whole number from 1, or off for no limit.');
    const value = m[2] as string;
    if (value === 'off' || value === 'none') out[agent] = null;
    else if (Number(value) < 1) throw new AgentctlError(`${arg}: the limit must be 1 or more (off removes it)`);
    else out[agent] = Number(value);
  }
  return out;
}

/** "limity: claude 3 → 4, codex 5 → -": the same words whoever changed the file, so that the journal says it once. */
export function limitsDiffText(from: GlobalConfig['limits'], to: GlobalConfig['limits']): string | undefined {
  const parts = AGENT_NAMES.filter((a) => (from[a] ?? null) !== (to[a] ?? null)).map((a) => `${a} ${from[a] ?? '-'} → ${to[a] ?? '-'}`);
  return parts.length === 0 ? undefined : `limity: ${parts.join(', ')}`;
}

export interface LimitsChange {
  agent: AgentName;
  from: number | null;
  to: number | null;
}

export interface LimitsPlan {
  file: string;
  changes: LimitsChange[];
  /** The new text of the config file: comments and order of everything else kept. */
  text: string;
  summary: string[];
}

/** The edit as text; nothing is written. */
export function planSetLimits(config: GlobalConfig, assignments: LimitAssignments): LimitsPlan {
  const file = config.path;
  const changes: LimitsChange[] = [];
  const text = editConfigText(config, (doc) => {
    for (const agent of AGENT_NAMES) {
      const to = assignments[agent];
      if (to === undefined) continue;
      const from = config.limits[agent] ?? null;
      if (to === null) doc.deleteIn(['limits', agent]);
      else doc.setIn(['limits', agent], to);
      changes.push({ agent, from, to });
    }
  });
  const show = (n: number | null): string => (n === null ? 'no limit' : String(n));
  return {
    file,
    changes,
    text,
    summary: [`${file}`, ...changes.map((c) => `  limits.${c.agent}: ${show(c.from)} -> ${show(c.to)}${c.from === c.to ? ' (unchanged)' : ''}`), '  (a copy of the file is kept as config.yaml.bak; comments and the order of the keys stay)'],
  };
}

/** Write the plan: a `.bak` copy first, the new text, and a check that the result loads (else the old text comes back). */
export async function applySetLimits(ctx: Context, plan: LimitsPlan): Promise<void> {
  await writeConfigText(ctx, plan.file, plan.text);
  const after: GlobalConfig['limits'] = { ...ctx.config.limits };
  for (const c of plan.changes) {
    if (c.to === null) delete after[c.agent];
    else after[c.agent] = c.to;
  }
  const text = limitsDiffText(ctx.config.limits, after);
  if (text) await recordJournalOnce(ctx, { kind: 'limits-changed', text });
}
