import { recordJournal } from './journal.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import type { HostHealth } from './hosts.ts';
import { withFileLock } from './file-lock.ts';
import { AgentctlError, isObject } from './util.ts';
import type { Problems } from './util.ts';

export interface Availability {
  windows?: { day: number; start: number; end: number }[];
  processes: string[];
  gpuBusyPct?: number;
  yield: 'stop-new' | 'pause-all';
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function parseAvailability(raw: unknown, where: string, p: Problems): Availability | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) { p.add(`${where} must be a mapping`); return undefined; }
  for (const key of Object.keys(raw)) if (!['windows', 'processes', 'gpu_busy_pct', 'yield'].includes(key)) p.add(`${where}.${key}: unknown key`);
  let windows: Availability['windows'];
  if (raw.windows !== undefined) {
    windows = [];
    if (!Array.isArray(raw.windows)) p.add(`${where}.windows must list "mon 09:00-17:00" windows`);
    else for (const window of raw.windows) {
      const match = typeof window === 'string' && /^(sun|mon|tue|wed|thu|fri|sat) (\d\d:\d\d)-(\d\d:\d\d)$/.exec(window);
      if (!match || !CLOCK_TIME.test(match[2]!) || !CLOCK_TIME.test(match[3]!) || match[2] === match[3]) p.add(`${where}.windows: invalid window ${JSON.stringify(window)}`);
      else windows.push({ day: DAYS.indexOf(match[1]!), start: minutes(match[2]!), end: minutes(match[3]!) });
    }
  }
  const processes = raw.processes;
  if (processes !== undefined && (!Array.isArray(processes) || !processes.every(v => typeof v === 'string' && /^[\w.-]+$/.test(v)))) p.add(`${where}.processes must list process names`);
  const gpu = raw.gpu_busy_pct;
  if (gpu !== undefined && (typeof gpu !== 'number' || !Number.isFinite(gpu) || gpu < 0 || gpu > 100)) p.add(`${where}.gpu_busy_pct must be from 0 to 100`);
  if (raw.yield !== undefined && raw.yield !== 'stop-new' && raw.yield !== 'pause-all') p.add(`${where}.yield must be stop-new or pause-all`);
  return { windows, processes: Array.isArray(processes) ? processes.filter((v): v is string => typeof v === 'string') : [], gpuBusyPct: typeof gpu === 'number' ? gpu : undefined, yield: raw.yield === 'pause-all' ? 'pause-all' : 'stop-new' };
}

const pauseFile = (config: GlobalConfig) => path.join(path.dirname(config.path), 'host-pauses.json');
function readPauses(config: GlobalConfig): Record<string, number | null> {
  try { return JSON.parse(fs.readFileSync(pauseFile(config), 'utf8')); } catch { return {}; }
}

export function hostPauseUntil(value: string | undefined, now: number): number | null {
  if (!value) return null;
  let end: number;
  const duration = /^(\d+)(m|h)$/.exec(value);
  if (duration) end = now + Number(duration[1]) * (duration[2] === 'h' ? 3600_000 : 60_000);
  else if (CLOCK_TIME.test(value)) {
    const date = new Date(now);
    date.setHours(Number(value.slice(0, 2)), Number(value.slice(3)), 0, 0);
    if (date.getTime() <= now) date.setDate(date.getDate() + 1);
    end = date.getTime();
  } else end = Date.parse(value);
  if (!Number.isFinite(end) || end <= now) throw new AgentctlError('--until must be a future HH:MM, ISO date or duration (3h)');
  return end;
}

export function assertHost(config: GlobalConfig, name: string): void {
  if (name !== 'local' && !Object.hasOwn(config.hosts, name)) throw new AgentctlError(`unknown host ${name}`);
}

export async function setHostPause(ctx: Context, name: string, pause: boolean, until?: string): Promise<string> {
  assertHost(ctx.config, name);
  if (!pause && until) throw new AgentctlError('--until is valid with pause');
  const end = hostPauseUntil(until, ctx.runner.now());
  const file = pauseFile(ctx.config);
  await withFileLock(`${file}.lock`, async () => {
    const values = readPauses(ctx.config);
    if (pause) values[name] = end;
    else delete values[name];
    await ctx.runner.writeFile(file, JSON.stringify(values));
  });
  const text = pause ? `[${name}] wstrzymany${end ? ` do ${new Date(end).toLocaleString('pl-PL')}` : ''}` : `[${name}] wznowiony`;
  await recordJournal(ctx, { kind: 'host-availability', text });
  return text;
}

export function manualHostPause(config: GlobalConfig, name: string): number | null | undefined {
  return readPauses(config)[name];
}

export function hostManuallyPaused(config: GlobalConfig, name: string, now: number): boolean {
  const until = manualHostPause(config, name);
  return until === null || (until !== undefined && until > now);
}

export function hostAvailability(config: GlobalConfig, name: string, health: HostHealth | undefined, now: number): string | undefined {
  const paused = readPauses(config)[name];
  if (paused === null || (paused !== undefined && paused > now)) return `[${name}] zajęty przez właściciela${paused ? ` do ${new Date(paused).toLocaleString('pl-PL')}` : ''}`;
  const availability = (name === 'local' ? config.localHost : config.hosts[name])?.availability;
  if (!availability) return undefined;
  const time = new Date(now);
  const day = time.getDay(), minute = time.getHours() * 60 + time.getMinutes();
  if (availability.windows && !availability.windows.some(w => w.end > w.start
    ? day === w.day && minute >= w.start && minute < w.end
    : (day === w.day && minute >= w.start) || (day === (w.day + 1) % 7 && minute < w.end))) return `[${name}] poza oknem dostępności`;
  if ((availability.processes.length || availability.gpuBusyPct !== undefined) && (!health || now - Date.parse(health.probedAt) > 60_000)) return `[${name}] brak aktualnej próbki zajętości`;
  if (availability.processes.length && !health?.processes) return `[${name}] nie można odczytać procesów właściciela`;
  const process = health?.processes?.find(p => availability.processes.some(name => name.toLowerCase().replace(/\.exe$/, '') === p.toLowerCase().replace(/\.exe$/, '')));
  if (process) return `[${name}] zajęty przez właściciela (${process})`;
  if (availability.gpuBusyPct !== undefined && health?.gpu?.utilizationPct === undefined) return `[${name}] brak odczytu zajętości GPU`;
  if (availability.gpuBusyPct !== undefined && health!.gpu!.utilizationPct! > availability.gpuBusyPct) return `[${name}] zajęty przez właściciela (GPU ${health!.gpu!.utilizationPct}%)`;
  return undefined;
}
