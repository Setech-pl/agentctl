import type { TaskState } from './state.ts';

export const TASK_STATES: readonly TaskState[] = ['working', 'waiting', 'needs-input', 'needs-trust', 'limited', 'report-ready', 'superseded', 'orphan', 'dead'];

/** `watch.window_icons`: the icon in front of a tmux window name, per state. */
export const DEFAULT_WINDOW_ICONS: Record<TaskState, string> = {
  working: '⚙',
  waiting: '⏸',
  'needs-input': '?',
  'needs-trust': '🔒',
  limited: '⛔',
  'report-ready': '✓',
  superseded: '↪',
  orphan: '✗',
  dead: '✗',
};

/** Every icon a window name may carry: the configured ones and the defaults (a config change leaves old icons on windows). */
export function knownIcons(configured: Record<TaskState, string> | null): string[] {
  return [...new Set([...Object.values(configured ?? {}), ...Object.values(DEFAULT_WINDOW_ICONS)])];
}

/** "⚙ nc-42" */
export function decorateName(plain: string, icon: string): string {
  return `${icon} ${plain}`;
}

/** Symbols only (emoji, punctuation, dingbats), then a space: an icon nobody configured but something like the ones above. */
const SYMBOL_PREFIX = /^[^\p{L}\p{N}\s]+\s+(\S.*)$/u;

/**
 * The window name without the icon in front of it. A known icon is cut off first (any characters); otherwise a prefix that
 * consists of symbols only is. A task window is a lowercase ID, so it never starts with either.
 */
export function stripIcon(name: string, icons: string[]): string {
  for (const icon of [...icons].sort((a, b) => b.length - a.length)) {
    if (name.length > icon.length + 1 && name.startsWith(`${icon} `)) return name.slice(icon.length + 1);
  }
  return SYMBOL_PREFIX.exec(name)?.[1] ?? name;
}
