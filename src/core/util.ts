import os from 'node:os';
import path from 'node:path';

/** User-facing error: a short message plus an optional "what to do" hint. */
export class AgentctlError extends Error {
  hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'AgentctlError';
    this.hint = hint;
  }
}

/** Collects validation problems so the user sees all of them at once. */
export class Problems {
  items: string[] = [];
  add(message: string): void {
    this.items.push(message);
  }
  get empty(): boolean {
    return this.items.length === 0;
  }
  throwIfAny(title: string, hint?: string): void {
    if (this.items.length === 0) return;
    const list = this.items.map((item) => `  - ${item}`).join('\n');
    throw new AgentctlError(`${title}\n${list}`, hint);
  }
}

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** The process working directory, or a user-facing explanation when it was deleted underneath us (gc removes worktrees). */
export function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    throw new AgentctlError('current directory no longer exists (removed by gc?) – cd elsewhere, e.g. cd ~');
  }
}

/** Expand `~` and make the path absolute. The cwd is consulted only for a relative path: it may have been deleted. */
export function resolvePath(p: string, base?: string): string {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(base ?? safeCwd(), expanded);
}

/** Replace the known placeholders {task}, {TASK}, {cache}; leave everything else (e.g. glob braces) alone. */
export function fillPlaceholders(template: string, vars: { task: string; cache: string }): string {
  return template.replace(/\{(task|TASK|cache)\}/g, (_match, name: string) => {
    if (name === 'task') return vars.task.toLowerCase();
    if (name === 'TASK') return vars.task.toUpperCase();
    return vars.cache;
  });
}

/** Polish noun after a number: 1 okno, 2–4 okna, 5+ okien (and 12–14, 22–24 … follow the same rule as their last digit, except 12–14 which are "many"). */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const last = n % 10, tens = n % 100;
  return last >= 2 && last <= 4 && !(tens >= 12 && tens <= 14) ? few : many;
}

export const TASK_ID = /^[A-Z][A-Z0-9_-]{0,39}$/;

/**
 * A cohort name: letters, digits, "-", "_" and "." (it is a file name in `<config dir>/cohorts/`). It starts with a letter, a digit or "_",
 * so it is never a flag, a hidden file or a path.
 */
export const COHORT_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,39}$/u;

/** Cohort names are compared without regard to case (and to Unicode composition). */
export function cohortKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The reason a cohort name is not valid, or undefined when it is. */
export function cohortNameProblem(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.trim() === '') return 'a cohort name cannot be empty (leave it out for a task without a cohort)';
  if (!COHORT_NAME.test(name.normalize('NFC'))) return `invalid cohort name ${JSON.stringify(name)}: letters, digits, "-", "_" and "." only, at most 40 characters, starting with a letter, a digit or "_"`;
  return undefined;
}

/** tmux window name for a task: always the lowercase task ID. */
export function windowName(task: string): string {
  return task.toLowerCase();
}

const SAFE_SHELL_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quote for a POSIX/zsh shell. A word starting with "=" is quoted too: zsh expands "=name" to a program path (tmux targets are "=session:window"). */
export function shellQuote(word: string): string {
  if (word !== '' && !word.startsWith('=') && SAFE_SHELL_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ');
}

/** "YYYY-MM-DD HH:MM" in the local time zone of an ISO timestamp; "-" when it is missing or not a date. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '-';
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
