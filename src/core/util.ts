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

/** Expand `~` and make the path absolute. */
export function resolvePath(p: string, base: string = process.cwd()): string {
  return path.resolve(base, expandHome(p));
}

/** Replace the known placeholders {task}, {TASK}, {cache}; leave everything else (e.g. glob braces) alone. */
export function fillPlaceholders(template: string, vars: { task: string; cache: string }): string {
  return template.replace(/\{(task|TASK|cache)\}/g, (_match, name: string) => {
    if (name === 'task') return vars.task.toLowerCase();
    if (name === 'TASK') return vars.task.toUpperCase();
    return vars.cache;
  });
}

export const TASK_ID = /^[A-Z][A-Z0-9_-]{0,39}$/;

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
