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
import { taskDir } from '../taskstore.ts';
import { buildTapStatusLine } from '../usage-tap.ts';
/** The `--kind` of `agentctl event` for Claude hooks. */
export const CLAUDE_KINDS = ['notification', 'stop', 'stop-failure', 'user-prompt-submit'] as const;
export type ClaudeKind = (typeof CLAUDE_KINDS)[number];

const CLAUDE_HOOK_NAME: Record<ClaudeKind, string> = { notification: 'Notification', stop: 'Stop', 'stop-failure': 'StopFailure', 'user-prompt-submit': 'UserPromptSubmit' };

/** Claude `Notification` types that mean "a human has to answer". `idle_prompt` ("Claude is waiting for your input") follows a Stop; it is not a new question. */
const CLAUDE_ASKING = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input', 'worker_permission_prompt']);
/** Claude `StopFailure` errors that mean the plan is used up or throttled. */
const CLAUDE_LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);

export function parseClaudeEvent(kind: ClaudeKind, input: unknown): AgentEvent {
  const data = isObject(input) ? input : {};
  if (kind === 'user-prompt-submit') return { agent: 'claude', outcome: 'ignored', type: kind, text: '' };
  if (kind === 'notification') {
    const type = str(data.notification_type);
    const outcome: EventOutcome = CLAUDE_ASKING.has(type) ? 'needs-input' : type === 'idle_prompt' ? 'idle' : 'ignored';
    return { agent: 'claude', outcome, type: `notification:${type || 'unknown'}`, text: clip(str(data.message), MAX_QUESTION) };
  }
  if (kind === 'stop') return { agent: 'claude', outcome: 'turn-complete', type: 'stop', text: firstLine(str(data.last_assistant_message)) };
  const error = str(data.error);
  const detail = clip(str(data.error_details) || str(data.last_assistant_message) || error, MAX_QUESTION);
  return { agent: 'claude', outcome: ['overloaded', 'overloaded_error'].includes(error) || /^API Error:\s*529\b/.test(detail) ? 'overloaded' : CLAUDE_LIMIT_ERRORS.has(error) ? 'limited' : 'ignored', type: `stop-failure:${error || 'unknown'}`, text: detail };
}

export function claudeSettingsPath(config: GlobalConfig, window: string): string {
  return path.join(taskDir(config, window), 'claude-settings.json');
}

const shellWord = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The settings file for one Claude window: the event hooks, merged by Claude with the user's and the project's own. */
export function buildClaudeSettings(task: string, self: SelfArgv, statusLine?: Record<string, unknown>, attempt?: string): Record<string, unknown> {
  self = stableSelfArgv(self);
  const hooks: Record<string, unknown> = {};
  for (const kind of CLAUDE_KINDS) {
    const command = [...self, ...eventArgs(task, 'claude', kind), ...(attempt ? ['--attempt', attempt] : [])].map(shellWord).join(' ');
    hooks[CLAUDE_HOOK_NAME[kind]] = [{ hooks: [{ type: 'command', command, timeout: 15 }] }];
  }
  // Claude Code shows a dim suggestion of the next prompt in the empty field; it is not the human's text, so it is switched off for the tasks agentctl starts.
  return statusLine ? { hooks, statusLine, promptSuggestionEnabled: false } : { hooks, promptSuggestionEnabled: false };
}


export function planClaudeEvents(input: EventWiringInput): EventWiring {
    const file = claudeSettingsPath(input.config, input.window);
    const statusLine = buildTapStatusLine(input.task, input.self, input.config, input.worktree, input.env, input.attempt);
    return {
      args: ['--settings', file],
      files: [{ path: file, content: `${JSON.stringify(buildClaudeSettings(input.task, input.self, statusLine, input.attempt), null, 2)}\n` }],
      note: `events: Claude hooks UserPromptSubmit, Notification, Stop and StopFailure${statusLine ? ', statusLine (usage-tap)' : ''} in ${file}`,
    };
}
