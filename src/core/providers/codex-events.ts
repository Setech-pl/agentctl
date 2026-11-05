import type { AgentEvent, EventOutcome, SelfArgv } from '../events.ts';
import { clip, firstLine, eventArgs, MAX_QUESTION } from '../events.ts';
import { stableSelfArgv } from '../mcp-install.ts';
import { isObject, resolvePath } from '../util.ts';
import type { EventWiringInput, EventWiring } from './types.ts';
import type { GlobalConfig } from '../config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const str = (v: unknown): string => typeof v === 'string' ? v : '';
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

const tomlString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
export const tomlArray = (items: string[]): string => `[${items.map(tomlString).join(', ')}]`;

/** Codex's `-c notify=[…]` value: this agentctl's `event` command, and the notify command the user already has (run by `event` afterwards). */
export function buildCodexNotify(task: string, self: SelfArgv, forward: string[] | undefined, attempt?: string): string[] {
  self = stableSelfArgv(self);
  return [...self, ...eventArgs(task, 'codex'), ...(attempt ? ['--attempt', attempt] : []), ...(forward && forward.length > 0 ? ['--forward', JSON.stringify(forward)] : [])];
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


export function planCodexEvents(input: EventWiringInput): EventWiring {
  const forward = userCodexNotify(input.env, input.readConfig);
  return {
    args: ['-c', `notify=${tomlArray(buildCodexNotify(input.task, input.self, forward, input.attempt))}`],
    files: [],
    note: `events: Codex notify -> agentctl event${forward ? ` (then ${forward[0]}, your own notify)` : ''}`,
  };
}
