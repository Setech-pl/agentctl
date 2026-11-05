import { provider } from './providers/registry.ts';
import { selectTranscriptSession } from './transcript.ts';
import { stableSelfArgv } from './mcp-install.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { claudePlanFile, readTaskSessions, sessionsFile } from './usage.ts';
import { agentHomes } from './usage-sources.ts';
import { windowKind } from './usage-parse.ts';
import { isObject } from './util.ts';

/*
 * Claude Code shows nothing about its plan limits except to a statusLine command: after each API response it runs that command with a JSON
 * object on stdin whose `rate_limits.five_hour` and `.seven_day` carry `used_percentage` and `resets_at` (epoch seconds) - for claude.ai
 * Pro, Max and Ultra plans only, and only after the first response of a session. The `statusLine` that `new` puts into the settings file of
 * a Claude window is `agentctl usage-tap`: it keeps those numbers, remembers the session (id and transcript path), and then runs the
 * user's own statusLine command with the same input and prints its output, so the status line the user sees does not change.
 */

export interface ClaudePlanReading {
  /** ms */
  at: number;
  windows: { minutes: number | null; usedPercent: number; resetsAt: number | null }[];
}

/** The plan windows of a statusLine input; undefined when it has none (no subscription, or before the first response). */
export function parseClaudeRateLimits(input: unknown, now: number): ClaudePlanReading | undefined {
  if (!isObject(input) || !isObject(input.rate_limits)) return undefined;
  const limits = input.rate_limits;
  const windows: ClaudePlanReading['windows'] = [];
  for (const [key, minutes] of [['five_hour', 300], ['seven_day', 10080]] as const) {
    const w = limits[key];
    if (!isObject(w) || typeof w.used_percentage !== 'number') continue;
    windows.push({ minutes, usedPercent: w.used_percentage, resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null });
  }
  return windows.length > 0 ? { at: now, windows } : undefined;
}

/** What the statusLine input says about the session. */
export function sessionOfStatusLine(input: unknown): { id: string; transcript?: string } | undefined {
  if (!isObject(input) || typeof input.session_id !== 'string' || input.session_id === '') return undefined;
  return { id: input.session_id, ...(typeof input.transcript_path === 'string' && input.transcript_path !== '' ? { transcript: input.transcript_path } : {}) };
}

/** Remember that a session belongs to the task (its events or its statusLine named it). Nothing is written when it is known already. */
export async function rememberSession(runner: Runner, config: GlobalConfig, window: string, agent: AgentName, session: { id: string; transcript?: string }, attempt?: string): Promise<void> {
  const file = sessionsFile(config, window);
  if (!fs.existsSync(path.dirname(file))) return; // an orphan window has no state folder
  await selectTranscriptSession(runner, config, window, agent, session, attempt);
  const known = readTaskSessions(config, window);
  const entries = known[agent] ??= [];
  if (provider(agent).capabilities.statusLineTap) {
    const have = entries.find((s) => s.id === session.id) as { id: string; transcript?: string } | undefined;
    if (have && (have.transcript !== undefined || session.transcript === undefined)) return;
    known[agent] = [...entries.filter((s) => s.id !== session.id), session];
  } else {
    if (entries.some((s) => s.id === session.id)) return;
    entries.push({ id: session.id });
  }
  await runner.writeFile(file, `${JSON.stringify(known, null, 2)}\n`);
}

/** Write the plan windows where `usage` reads them. Nothing is written when they are what the file has already, and fresh. */
export async function storeClaudePlan(runner: Runner, config: Pick<GlobalConfig, 'path'>, reading: ClaudePlanReading): Promise<boolean> {
  const file = claudePlanFile(config);
  try {
    const old: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(old) && typeof old.at === 'number' && reading.at - old.at < 30_000 && JSON.stringify(old.windows) === JSON.stringify(reading.windows.map((w) => ({ kind: windowKind(w.minutes), ...w })))) return false;
  } catch {
    // none yet
  }
  const windows = reading.windows.map((w) => ({ kind: windowKind(w.minutes), ...w }));
  await runner.writeFile(file, `${JSON.stringify({ v: 1, at: reading.at, windows }, null, 2)}\n`);
  return true;
}

// ---- the user's own statusLine

const settingsStatusLine = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    return isObject(data) ? data.statusLine : undefined;
  } catch {
    return undefined;
  }
};

const readIfExists = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

export interface UserStatusLine {
  /** The command the user's Claude runs as its status line; undefined when there is none. */
  command?: string;
  /** The user has a statusLine of a kind that cannot be passed on (not a `command`): the tap must stay out of the way. */
  foreign: boolean;
  padding?: number;
}

/** The statusLine Claude would use in this worktree: local settings, project settings, then the user's own (the order Claude merges them in). */
export function userStatusLine(worktree: string | undefined, claudeHome: string, read: (file: string) => string | undefined = readIfExists): UserStatusLine {
  const files = [...(worktree ? [path.join(worktree, '.claude', 'settings.local.json'), path.join(worktree, '.claude', 'settings.json')] : []), path.join(claudeHome, 'settings.json')];
  for (const file of files) {
    const sl = settingsStatusLine(read(file));
    if (sl === undefined || sl === null) continue;
    if (isObject(sl) && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim() !== '') {
      return { command: sl.command, foreign: false, ...(typeof sl.padding === 'number' ? { padding: sl.padding } : {}) };
    }
    return { foreign: true };
  }
  return { foreign: false };
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The `statusLine` entry for a task's settings file, or undefined when the tap is off or must not replace the user's own status line. */
export function buildTapStatusLine(task: string, self: string[], config: Pick<GlobalConfig, 'usage'>, worktree: string | undefined, env: Record<string, string>, attempt?: string): Record<string, unknown> | undefined {
  self = stableSelfArgv(self);
  if (!config.usage.claudeTap) return undefined;
  const user = userStatusLine(worktree, env.CLAUDE_CONFIG_DIR ?? agentHomes(config, { ...process.env, ...env }).claude);
  if (user.foreign) return undefined;
  const args = [...self, 'usage-tap', '--task', task, ...(attempt ? ['--attempt', attempt] : []), ...(user.command ? ['--forward', user.command] : [])];
  return { type: 'command', command: args.map(shellWord).join(' '), ...(user.padding !== undefined ? { padding: user.padding } : {}) };
}

export interface TapResult {
  /** What the status line shows: the output of the user's own command, or nothing. */
  output: string;
  stored: boolean;
}

/** `agentctl usage-tap`: the statusLine input arrives as `raw`. Never throws. */
export async function handleTap(runner: Runner, config: GlobalConfig, input: { task?: string | undefined; window?: string | undefined; raw: string; attempt?: string | undefined; forward?: string | undefined }): Promise<TapResult> {
  let stored = false;
  try {
    let payload: unknown;
    try {
      payload = JSON.parse(input.raw);
    } catch {
      payload = undefined;
    }
    const reading = parseClaudeRateLimits(payload, runner.now());
    if (reading) stored = await storeClaudePlan(runner, config, reading);
    const session = sessionOfStatusLine(payload);
    if (session && input.window) await rememberSession(runner, config, input.window, 'claude', session, input.attempt ?? '');
  } catch {
    // a status line must never break the agent
  }
  let output = '';
  if (input.forward) {
    const r = await runner.exec('sh', ['-c', input.forward], { input: input.raw, timeoutMs: 5000 }).catch(() => undefined);
    output = r?.stdout ?? '';
  }
  return { output, stored };
}
