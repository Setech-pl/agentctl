import { provider } from './providers/registry.ts';
import type { AgentName, GlobalConfig } from './config.ts';
import type { ClaudeKind } from './providers/claude-events.ts';
export { CLAUDE_KINDS, parseClaudeEvent, claudeSettingsPath, buildClaudeSettings } from './providers/claude-events.ts';
export type { ClaudeKind } from './providers/claude-events.ts';
export { parseCodexEvent, tomlArray, buildCodexNotify, parseTomlNotify, userCodexNotify } from './providers/codex-events.ts';

/*
 * Events the agents send about themselves, instead of agentctl reading their screens.
 *
 * Claude Code (2.1.309) runs hooks: `Notification` (a permission dialog or a question is open), `Stop` (the turn ended) and
 * `StopFailure` (the turn ended with an API error such as rate_limit). They get a JSON object on stdin.
 * Codex (0.166.0) runs `notify` with a JSON argument, but only for `agent-turn-complete` (checked live); a request for approval
 * sends nothing, and its hooks need a human to trust them, so approvals and questions stay with the screen reader.
 */

/** Longest question or message that goes into a notification. */
export const MAX_QUESTION = 120;
const MAX_SNIPPET = 100;

export type EventOutcome = 'error' | 'overloaded' | 'needs-input' | 'turn-complete' | 'limited' | 'idle' | 'ignored';

/** One event of an agent, normalised. */
export interface AgentEvent {
  agent: AgentName;
  outcome: EventOutcome;
  /** What the agent called it: "notification:permission_prompt", "stop", "agent-turn-complete" … (for the log). */
  type: string;
  /** The question (needs-input), the last thing the agent said (turn-complete) or the reason (limited); may be empty. */
  text: string;
}

export const stripMarkdown = (s: string): string =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]+/g, '')
    .replace(/^\s*(?:#{1,6}|>|[-+*]|\d+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** First line with words in it, without markdown, at most `max` characters. */
export function firstLine(text: string, max: number = MAX_SNIPPET): string {
  for (const line of text.split('\n')) {
    const clean = stripMarkdown(line);
    if (/[\p{L}\p{N}]/u.test(clean)) return clip(clean, max);
  }
  return '';
}


/** Parse the JSON of a hook (stdin) or of Codex's notify argument; a broken one gives undefined. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---- the question on the screen

const BORDER = /^[\s─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼╌╍┄┅┈┉-]*$/u;
/** "❯ 1. Yes", "  2. No", "› 1. Yes, proceed (y)" */
const OPTION = /^\s*[❯›>▸]?\s*\d+[.)]\s+\S/u;
/** A question that is only the frame of the real content: the command or the file is in the lines around it. */
const GENERIC_QUESTION = /^(?:do you want|would you like|allow|proceed|continue)\b/i;

/**
 * The question a dialog on the screen asks: the last line ending with "?" above the numbered options, as a short text.
 * A generic question ("Do you want to proceed?", "Would you like to run the following command?") gets what it is about:
 * the "$ command" line of Codex, or the line above it in Claude's dialog. Undefined when no option list is on screen.
 */
export function extractQuestion(screen: string, max: number = MAX_QUESTION): string | undefined {
  const lines = screen.split('\n').map((l) => l.trimEnd());
  // peek includes scrollback: a wrapped UUID such as "56. Include..." there can look like an old option.
  // The latest question UI wins; old options must not hide a newer collapsed question.
  const collapsedAt = lines.findLastIndex(l => /^\s*\?\s+\d+ questions?\b/i.test(l));
  if (collapsedAt > lines.findLastIndex(l => OPTION.test(l))) {
    const collapsed = collapsedQuestion(screen)!;
    return clip(`Codex ma pytanie (zwinięte, ${collapsed.count}) – Enter → okno agenta, potem ${collapsed.shortcut ?? 'skrót przy „to answer” na ekranie'}`, max);
  }
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (OPTION.test(l)) first = i;
    else if (first >= 0 && l.trim() !== '' && !/^\s{3,}\S/.test(l) && !BORDER.test(l)) break; // a line that is not an option, its wrapped text or a gap
  }
  if (first < 0) {
    const collapsed = collapsedQuestion(screen);
    return collapsed ? clip(`Codex ma pytanie (zwinięte, ${collapsed.count}) – Enter → okno agenta, potem ${collapsed.shortcut ?? 'skrót przy „to answer” na ekranie'}`, max) : undefined;
  }
  // Lines above the options that end with "?": the generic frame ("Would you like to run…?") wins over a "?" in the reason that
  // follows it, otherwise the one nearest to the options.
  const candidates: number[] = [];
  for (let i = first - 1; i >= Math.max(0, first - 12); i--) {
    const l = (lines[i] as string).trim();
    if (l !== '' && !BORDER.test(l) && /\?\s*$/.test(l)) candidates.push(i);
  }
  const q = candidates.find((i) => GENERIC_QUESTION.test(stripMarkdown(lines[i] as string))) ?? candidates[0] ?? -1;
  if (q < 0) return undefined;
  const question = stripMarkdown(lines[q] as string);
  if (!GENERIC_QUESTION.test(question)) return clip(question, max);
  // The command Codex asks about ("$ printf …") sits between the question and the options; Claude puts it above the question.
  const below = lines.slice(q + 1, first).map((l) => l.trim()).find((l) => l.startsWith('$ '));
  const above = lines.slice(Math.max(0, q - 4), q).map((l) => l.trim()).filter((l) => l !== '' && !BORDER.test(l)).pop();
  const about = below ?? above;
  return clip(about ? `${question} ${about}` : question, max);
}

// ---- the wiring: what `new` hands to the agent

/** The command line (argv) that starts this very agentctl: absolute node and script, and the config directory of this run. */
export type SelfArgv = string[];

export function eventArgs(task: string, agent: AgentName, kind?: ClaudeKind): string[] {
  return ['event', '--task', task, '--agent', agent, ...(kind ? ['--kind', kind] : [])];
}

export interface EventWiring {
  /** Extra arguments for the agent command line. */
  args: string[];
  /** Files to write before the agent starts. */
  files: { path: string; content: string }[];
  /** For the log of `new`. */
  note: string;
}

export interface WiringInput {
  attempt?: string | undefined;
  agent: AgentName;
  task: string;
  window: string;
  config: GlobalConfig;
  self: SelfArgv;
  /** The environment of the window (spec env): `CODEX_HOME` decides which config.toml holds the notify to keep. */
  env: Record<string, string>;
  /** The primary worktree: its `.claude/settings*.json` may hold the statusLine that the usage tap passes on. */
  worktree?: string | undefined;
  readConfig?: (file: string) => string | undefined;
}

/**
 * What `new` adds so that the agent reports its own events to `agentctl event`:
 * Claude: `--settings <state_dir>/<task>/claude-settings.json` (Claude merges it with the user's and the project's settings,
 * so their hooks keep running: checked live). Codex: `-c notify=[…]`, which replaces the user's own `notify`, so that one is
 * passed along to run after ours.
 */
export function planEventWiring(input: WiringInput): EventWiring {
  return provider(input.agent).events.plan(input);
}

/** Read the live queue marker; a queued message alone is not a question. */
export function collapsedQuestion(screen: string): { count: number; shortcut: string | null } | undefined {
  const marker = [...screen.matchAll(/^\s*\?\s+(\d+) questions?\b/gim)].at(-1);
  if (!marker) return undefined;
  const tail = screen.slice(marker.index + marker[0].length).split('\n').slice(0, 5).join('\n');
  const shortcut = /^\s*(.+?)\s+to answer\s*$/im.exec(tail)?.[1]?.trim() ?? null;
  return { count: Number(marker[1]), shortcut };
}
