import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { isObject } from './util.ts';

/*
 * "Away": the phone gets notifications only while you are away from the Mac (`notify.ntfy.always: true` sends always). The state is one file
 * in AGENTCTL_HOME, so the watcher, the event hooks, the board and the MCP server all see the same answer. The desktop notifications do not depend on it.
 */

/** Who changed the state last. `auto` is `away.auto_idle`. */
export type AwayBy = 'cli' | 'board' | 'mcp' | 'auto';

export interface AwayState {
  on: boolean;
  /** ISO time of the last change. */
  since: string;
  by: AwayBy;
  /** The user turned away off by hand while the Mac was idle: `auto_idle` waits for the next activity before it may turn it on again. */
  suppressAuto?: boolean;
}

export const awayPath = (config: Pick<GlobalConfig, 'path'>): string => path.join(path.dirname(config.path), 'away.json');

const BY: readonly AwayBy[] = ['cli', 'board', 'mcp', 'auto'];

/** The state; off when nothing was ever set. */
export function readAway(config: Pick<GlobalConfig, 'path'>): AwayState {
  try {
    const d: unknown = JSON.parse(fs.readFileSync(awayPath(config), 'utf8'));
    if (isObject(d) && typeof d.on === 'boolean') {
      return {
        on: d.on,
        since: typeof d.since === 'string' ? d.since : '',
        by: BY.includes(d.by as AwayBy) ? (d.by as AwayBy) : 'cli',
        ...(d.suppressAuto === true ? { suppressAuto: true } : {}),
      };
    }
  } catch {
    // never set
  }
  return { on: false, since: '', by: 'cli' };
}

/** Turn away on or off. Returns the new state; `changed` says whether it differed from the old one. */
export async function setAway(ctx: Context, on: boolean, by: AwayBy): Promise<{ state: AwayState; changed: boolean }> {
  const was = readAway(ctx.config);
  const state: AwayState = { on, since: new Date(ctx.runner.now()).toISOString(), by };
  // A hand-made "off" while the Mac is idle must not be undone by the next tick.
  if (!on && by !== 'auto' && ctx.config.away.autoIdle !== null) state.suppressAuto = true;
  if (was.on === on && by !== 'auto') state.since = was.since || state.since;
  await ctx.runner.writeFile(awayPath(ctx.config), `${JSON.stringify(state, null, 2)}\n`);
  return { state, changed: was.on !== on };
}

/** The phone gets notifications now: a topic is set, and away is on or `notify.ntfy.always`. */
export function phoneActive(config: Pick<GlobalConfig, 'path' | 'notify'>): boolean {
  const ntfy = config.notify.ntfy;
  return Boolean(ntfy?.topic) && (ntfy?.always === true || readAway(config).on);
}

/** Seconds since the last keyboard or mouse event (macOS `HIDIdleTime`); undefined when it cannot be told. */
export async function idleSeconds(ctx: Context): Promise<number | undefined> {
  const r = await ctx.runner.exec('ioreg', ['-c', 'IOHIDSystem'], { readOnly: true });
  if (r.code !== 0) return undefined;
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) / 1e9 : undefined;
}

/**
 * `away.auto_idle`: away comes on when the Mac has been idle for the configured minutes, and goes off at the first activity afterwards.
 * Only a state that `auto_idle` set is taken back by it; what the user set by hand stays. Returns the change made, if any.
 */
export async function awayTick(ctx: Context): Promise<'on' | 'off' | undefined> {
  const minutes = ctx.config.away.autoIdle;
  if (minutes === null) return undefined;
  const idle = await idleSeconds(ctx);
  if (idle === undefined) return undefined;
  const state = readAway(ctx.config);
  const idleEnough = idle >= minutes * 60;
  if (idleEnough) {
    if (state.on || state.suppressAuto) return undefined;
    await setAway(ctx, true, 'auto');
    return 'on';
  }
  if (state.on && state.by === 'auto') {
    await setAway(ctx, false, 'auto');
    return 'off';
  }
  if (state.suppressAuto) await ctx.runner.writeFile(awayPath(ctx.config), `${JSON.stringify({ on: state.on, since: state.since, by: state.by }, null, 2)}\n`);
  return undefined;
}

export interface AwayReport {
  on: boolean;
  since: string;
  by: AwayBy;
  /** `away.auto_idle`, minutes. */
  autoIdle: number | null;
  /** `notify.ntfy.always`. */
  always: boolean;
  /** A topic is set. */
  phoneConfigured: boolean;
  /** The phone gets notifications now. */
  phoneActive: boolean;
}

export function awayReport(config: GlobalConfig): AwayReport {
  const s = readAway(config);
  const ntfy = config.notify.ntfy;
  return { on: s.on, since: s.since, by: s.by, autoIdle: config.away.autoIdle, always: ntfy?.always === true, phoneConfigured: Boolean(ntfy?.topic), phoneActive: phoneActive(config) };
}

/** Lines for `agentctl away status`. */
export function renderAway(r: AwayReport): string[] {
  const lines = [`away: ${r.on ? `ON${r.since ? ` since ${r.since}` : ''} (${r.by === 'auto' ? 'away.auto_idle' : `set by ${r.by}`})` : 'off'}`];
  lines.push(`phone: ${!r.phoneConfigured ? 'not set up (agentctl ntfy-setup)' : r.phoneActive ? `notifications are sent${r.always ? ' (notify.ntfy.always)' : ''}` : 'quiet while you are here (agentctl away on, or notify.ntfy.always: true)'}`);
  lines.push(`auto:  ${r.autoIdle === null ? 'off (away.auto_idle is not set)' : `away after ${r.autoIdle} min without keyboard or mouse`}`);
  return lines;
}
