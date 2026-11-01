import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import { taskDir } from './taskstore.ts';
import { isObject, resolvePath } from './util.ts';

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

export type EventOutcome = 'needs-input' | 'turn-complete' | 'limited' | 'idle' | 'ignored';

/** One event of an agent, normalised. */
export interface AgentEvent {
  agent: AgentName;
  outcome: EventOutcome;
  /** What the agent called it: "notification:permission_prompt", "stop", "agent-turn-complete" … (for the log). */
  type: string;
  /** The question (needs-input), the last thing the agent said (turn-complete) or the reason (limited); may be empty. */
  text: string;
}

/** The `--kind` of `agentctl event` for Claude hooks. */
export const CLAUDE_KINDS = ['notification', 'stop', 'stop-failure'] as const;
export type ClaudeKind = (typeof CLAUDE_KINDS)[number];

const CLAUDE_HOOK_NAME: Record<ClaudeKind, string> = { notification: 'Notification', stop: 'Stop', 'stop-failure': 'StopFailure' };

/** Claude `Notification` types that mean "a human has to answer". `idle_prompt` ("Claude is waiting for your input") follows a Stop; it is not a new question. */
const CLAUDE_ASKING = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']);
/** Claude `StopFailure` errors that mean the plan is used up or throttled. */
const CLAUDE_LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);

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

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseClaudeEvent(kind: ClaudeKind, input: unknown): AgentEvent {
  const data = isObject(input) ? input : {};
  if (kind === 'notification') {
    const type = str(data.notification_type);
    const outcome: EventOutcome = CLAUDE_ASKING.has(type) ? 'needs-input' : type === 'idle_prompt' ? 'idle' : 'ignored';
    return { agent: 'claude', outcome, type: `notification:${type || 'unknown'}`, text: clip(str(data.message), MAX_QUESTION) };
  }
  if (kind === 'stop') return { agent: 'claude', outcome: 'turn-complete', type: 'stop', text: firstLine(str(data.last_assistant_message)) };
  const error = str(data.error);
  const detail = clip(str(data.error_details) || str(data.last_assistant_message) || error, MAX_QUESTION);
  return { agent: 'claude', outcome: CLAUDE_LIMIT_ERRORS.has(error) ? 'limited' : 'ignored', type: `stop-failure:${error || 'unknown'}`, text: detail };
}

/** Codex also runs the notify command for the turn that writes the session title: a one-key JSON object, not a real turn. */
function isCodexTitleTurn(data: Record<string, unknown>): boolean {
  const inputs = Array.isArray(data['input-messages']) ? data['input-messages'] : [];
  if (str(inputs[0]).startsWith('Generate a concise, single-line task title')) return true;
  const last = str(data['last-assistant-message']).trim();
  if (!last.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(last);
    return isObject(parsed) && Object.keys(parsed).length === 1 && typeof parsed.title === 'string';
  } catch {
    return false;
  }
}

/** Names a future Codex may send for "waiting for you" (its TUI uses approval-requested, plan-mode-prompt and async-question). 0.166.0 does not send them through notify. */
const CODEX_ASKING = /approval|permission|question|prompt|input[-_ ]requested|user-input/i;

export function parseCodexEvent(input: unknown): AgentEvent {
  const data = isObject(input) ? input : {};
  const type = str(data.type) || 'unknown';
  if (type === 'agent-turn-complete') {
    if (isCodexTitleTurn(data)) return { agent: 'codex', outcome: 'ignored', type: 'agent-turn-complete:title', text: '' };
    return { agent: 'codex', outcome: 'turn-complete', type, text: firstLine(str(data['last-assistant-message'])) };
  }
  if (CODEX_ASKING.test(type)) return { agent: 'codex', outcome: 'needs-input', type, text: clip(str(data.message) || str(data.question) || str(data.command), MAX_QUESTION) };
  return { agent: 'codex', outcome: 'ignored', type, text: '' };
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
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (OPTION.test(l)) first = i;
    else if (first >= 0 && l.trim() !== '' && !/^\s{3,}\S/.test(l) && !BORDER.test(l)) break; // a line that is not an option, its wrapped text or a gap
  }
  if (first < 0) return undefined;
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

export function claudeSettingsPath(config: GlobalConfig, window: string): string {
  return path.join(taskDir(config, window), 'claude-settings.json');
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The settings file for one Claude window: only the three event hooks, merged by Claude with the user's and the project's own. */
export function buildClaudeSettings(task: string, self: SelfArgv): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const kind of CLAUDE_KINDS) {
    const command = [...self, ...eventArgs(task, 'claude', kind)].map(shellWord).join(' ');
    hooks[CLAUDE_HOOK_NAME[kind]] = [{ hooks: [{ type: 'command', command, timeout: 15 }] }];
  }
  return { hooks };
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const tomlArray = (items: string[]): string => `[${items.map(tomlString).join(', ')}]`;

/** Codex's `-c notify=[…]` value: this agentctl's `event` command, and the notify command the user already has (run by `event` afterwards). */
export function buildCodexNotify(task: string, self: SelfArgv, forward: string[] | undefined): string[] {
  return [...self, ...eventArgs(task, 'codex'), ...(forward && forward.length > 0 ? ['--forward', JSON.stringify(forward)] : [])];
}

/**
 * The top-level `notify = ["cmd", "arg", …]` of a Codex config.toml (the one TOML key agentctl reads, so no TOML parser is
 * needed). Undefined when there is none or it is not a plain list of strings.
 */
export function parseTomlNotify(toml: string): string[] | undefined {
  const lines = toml.split('\n');
  let text = '';
  let collecting = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!collecting) {
      if (line.startsWith('[')) return undefined; // first table: no top-level notify before it
      if (!/^notify\s*=\s*\[/.test(line)) continue;
      collecting = true;
      text = line.slice(line.indexOf('[') + 1);
    } else {
      text += `\n${line}`;
    }
    const items = readStrings(text);
    if (items) return items;
    if (items === null) return undefined;
  }
  return undefined;
}

/** Strings of a TOML array body up to its "]": the list, null when the text is not a list of strings, undefined when it is not closed yet. */
function readStrings(body: string): string[] | null | undefined {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (i < body.length && /[\s,]/.test(body[i] as string)) i++;
    if (body[i] === '#') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (i >= body.length) return undefined;
    const c = body[i] as string;
    if (c === ']') return out;
    if (c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== '"') j += body[j] === '\\' ? 2 : 1;
      if (j >= body.length) return undefined;
      try {
        out.push(JSON.parse(body.slice(i, j + 1)) as string);
      } catch {
        return null;
      }
      i = j + 1;
    } else if (c === "'") {
      const j = body.indexOf("'", i + 1);
      if (j < 0) return undefined;
      out.push(body.slice(i + 1, j));
      i = j + 1;
    } else return null;
  }
}

/** The notify command of the user's Codex config (`$CODEX_HOME` of the window, else ~/.codex), which `-c notify=` would otherwise replace. */
export function userCodexNotify(env: Record<string, string>, read: (file: string) => string | undefined = readIfExists): string[] | undefined {
  const home = env.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const toml = read(path.join(resolvePath(home), 'config.toml'));
  return toml === undefined ? undefined : parseTomlNotify(toml);
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
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
  agent: AgentName;
  task: string;
  window: string;
  config: GlobalConfig;
  self: SelfArgv;
  /** The environment of the window (spec env): `CODEX_HOME` decides which config.toml holds the notify to keep. */
  env: Record<string, string>;
  readConfig?: (file: string) => string | undefined;
}

/**
 * What `new` adds so that the agent reports its own events to `agentctl event`:
 * Claude: `--settings <state_dir>/<task>/claude-settings.json` (Claude merges it with the user's and the project's settings,
 * so their hooks keep running: checked live). Codex: `-c notify=[…]`, which replaces the user's own `notify`, so that one is
 * passed along to run after ours.
 */
export function planEventWiring(input: WiringInput): EventWiring {
  if (input.agent === 'claude') {
    const file = claudeSettingsPath(input.config, input.window);
    return {
      args: ['--settings', file],
      files: [{ path: file, content: `${JSON.stringify(buildClaudeSettings(input.task, input.self), null, 2)}\n` }],
      note: `events: Claude hooks Notification, Stop and StopFailure in ${file}`,
    };
  }
  const forward = userCodexNotify(input.env, input.readConfig);
  return {
    args: ['-c', `notify=${tomlArray(buildCodexNotify(input.task, input.self, forward))}`],
    files: [],
    note: `events: Codex notify -> agentctl event${forward ? ` (then ${forward[0]}, your own notify)` : ''}`,
  };
}
