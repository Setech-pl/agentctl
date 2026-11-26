import { quotaError } from '../quota-error.ts';
import type { AgentEvent, EventOutcome, SelfArgv } from '../events.ts';
import { clip, firstLine, eventArgs, MAX_QUESTION } from '../events.ts';
import { stableSelfArgv } from '../mcp-install.ts';
import { isObject, resolvePath } from '../util.ts';
import type { EventWiringInput, EventWiring } from './types.ts';
import type { AgentName, GlobalConfig } from '../config.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const str = (v: unknown): string => typeof v === 'string' ? v : '';
import { taskDir } from '../taskstore.ts';
import { buildTapStatusLine } from '../usage-tap.ts';
import { agentHomes } from '../usage-sources.ts';
/** The `--kind` of `agentctl event` for Claude hooks. */
export const CLAUDE_KINDS = ['notification', 'stop', 'stop-failure', 'user-prompt-submit', 'session-start'] as const;
export type ClaudeKind = (typeof CLAUDE_KINDS)[number];

const CLAUDE_HOOK_NAME: Record<ClaudeKind, string> = { 'session-start': 'SessionStart', notification: 'Notification', stop: 'Stop', 'stop-failure': 'StopFailure', 'user-prompt-submit': 'UserPromptSubmit' };

/** Claude `Notification` types that mean "a human has to answer". `idle_prompt` ("Claude is waiting for your input") follows a Stop; it is not a new question. */
const CLAUDE_ASKING = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']);
/** Claude `StopFailure` errors that mean the plan is used up or throttled. */
const CLAUDE_LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);

export function parseClaudeEvent(kind: ClaudeKind, input: unknown, agent: AgentName = 'claude'): AgentEvent {
  const data = isObject(input) ? input : {};
  if (kind === 'session-start') return { agent, outcome: 'ignored', type: kind, text: '' };
  if (kind === 'user-prompt-submit') return { agent, outcome: 'ignored', type: kind, text: '' };
  if (kind === 'notification') {
    const type = str(data.notification_type);
    const outcome: EventOutcome = CLAUDE_ASKING.has(type) ? 'needs-input' : type === 'idle_prompt' ? 'idle' : 'ignored';
    return { agent, outcome, type: `notification:${type || 'unknown'}`, text: clip(str(data.message), MAX_QUESTION) };
  }
  if (kind === 'stop') return { agent, outcome: 'turn-complete', type: 'stop', text: firstLine(str(data.last_assistant_message)) };
  const error = str(data.error);
  const detail = clip(str(data.error_details) || str(data.last_assistant_message) || error, 4096);
  return { agent, outcome: ['overloaded', 'overloaded_error'].includes(error) || /^API Error:\s*529\b/.test(detail) ? 'overloaded' : (CLAUDE_LIMIT_ERRORS.has(error) || quotaError(`${error} ${str(data.error_details)}`, true)) ? 'limited' : 'ignored', type: `stop-failure:${error || 'unknown'}`, text: detail };
}

export function claudeSettingsPath(config: GlobalConfig, window: string, agent: AgentName = 'claude'): string {
  return path.join(taskDir(config, window), `${agent}-settings.json`);
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The settings file for one Claude-family window: the event hooks, merged by Claude with the user's and the project's own. */
export function buildClaudeSettings(task: string, self: SelfArgv, statusLine?: Record<string, unknown>, attempt?: string, agent: AgentName = 'claude'): Record<string, unknown> {
  self = stableSelfArgv(self);
  const hooks: Record<string, unknown> = {};
  for (const kind of CLAUDE_KINDS) {
    const command = [...self, ...eventArgs(task, agent, kind), ...(attempt ? ['--attempt', attempt] : [])].map(shellWord).join(' ');
    hooks[CLAUDE_HOOK_NAME[kind]] = [{ hooks: [{ type: 'command', command, timeout: 15 }] }];
  }
  // Every entry is a command hook, SessionStart included: the only type every supported Claude Code version (2.1.309 … 2.1.332) accepts for
  // every event (2.1.332 refuses prompt-type SessionStart hooks). The first prompt never waits for a hook: screen readiness pastes it and the
  // transcript confirms it (transcript.ts attemptTranscript, host-mirror.ts).
  // Claude Code shows a dim suggestion of the next prompt in the empty field; it is not the human's text, so it is switched off for the tasks agentctl starts.
  return statusLine ? { hooks, statusLine, promptSuggestionEnabled: false } : { hooks, promptSuggestionEnabled: false };
}


export function planClaudeEvents(input: EventWiringInput): EventWiring {
    const file = claudeSettingsPath(input.config, input.window, input.agent);
    const statusLine = buildTapStatusLine(input.agent, input.task, input.self, input.config, input.worktree, input.env, input.attempt);
    const label = input.agent === 'glm' ? 'GLM (claude-glm)' : 'Claude';
    return {
      args: ['--settings', file],
      files: [{ path: file, content: `${JSON.stringify(buildClaudeSettings(input.task, input.self, statusLine, input.attempt, input.agent), null, 2)}\n` }],
      note: `events: ${label} hooks SessionStart, UserPromptSubmit, Notification, Stop and StopFailure${statusLine ? ', statusLine (usage-tap)' : ''} in ${file}${unsupportedText(unsupportedSessionStartHooks(claudeSettingsFiles(input.worktree, input.env.CLAUDE_CONFIG_DIR ?? agentHomes(input.config, { ...process.env, ...input.env }).claude), input.readConfig))}`,
    };
}

/** The settings files Claude Code merges for a window in this worktree (local, project, user). */
export function claudeSettingsFiles(worktree: string | undefined, claudeHome: string): string[] {
  return [...(worktree ? [path.join(worktree, '.claude', 'settings.local.json'), path.join(worktree, '.claude', 'settings.json')] : []), path.join(claudeHome, 'settings.json')];
}

/**
 * SessionStart hooks of another type than `command` in the owner's or the project's Claude settings. Claude Code 2.1.332 refuses them at
 * startup ("prompt-type hooks are not supported for SessionStart events"); agentctl cannot change those files, so the start says where they are.
 */
export function unsupportedSessionStartHooks(files: string[], read: (file: string) => string | undefined = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }): string[] {
  const found: string[] = [];
  for (const file of files) {
    let data: unknown;
    try { const text = read(file); if (text === undefined) continue; data = JSON.parse(text); } catch { continue; }
    const groups = isObject(data) && isObject(data.hooks) ? data.hooks.SessionStart : undefined;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
      const type = isObject(hook) ? hook.type : undefined;
      if (type !== 'command') found.push(`${file} (${typeof type === 'string' ? type : 'no type'})`);
    }
  }
  return [...new Set(found)];
}

const unsupportedText = (found: string[]) => found.length ? `; WARNING: SessionStart hooks that are not command-type (Claude Code 2.1.332 rejects them at startup; the prompt is still delivered by screen readiness and the transcript): ${found.join(', ')}` : '';
