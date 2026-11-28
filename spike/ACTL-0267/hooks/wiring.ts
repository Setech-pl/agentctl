// ACTL-0267 spike: per-task hook wiring that never edits the owner's global settings.
// Claude: agentctl already passes `--settings <taskdir>/claude-settings.json` (merged by Claude with user/project/local settings).
//         Proposal: add PermissionRequest + SessionEnd, and stop ignoring SessionStart/UserPromptSubmit (they carry session_id and the prompt).
// Codex:  `-c hooks.<Event>=[…]` is accepted as source "sessionFlags" (codex-cli 0.167.0, hooks/list) but reported trustStatus "untrusted":
//         it does not run until trusted. Trust is per command hash, so the command must be byte-identical for every task: task/attempt
//         travel in the environment (AGENTCTL_TASK, AGENTCTL_ATTEMPT set by the launch script), not in argv.

export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'PermissionRequest', 'Stop', 'StopFailure', 'SessionEnd'] as const;
/** What each event gives the screen driver (replacing a screen guess). */
export const CLAUDE_EVENT_USE: Record<(typeof CLAUDE_EVENTS)[number], string> = {
  SessionStart: 'process up + session_id/transcript_path pinned (source startup|resume|clear|compact); NOT input-ready',
  UserPromptSubmit: 'delivery ack: the prompt (attempt marker) was taken; replaces echo/paste guessing',
  Notification: 'permission_prompt / elicitation_dialog → needs-input; idle_prompt → idle (already used)',
  PermissionRequest: 'needs-approval with tool_name + tool_input (structured question for `answer`)',
  Stop: 'turn-done + last_assistant_message (already used)',
  StopFailure: 'limited / overloaded classification (already used)',
  SessionEnd: 'dead/closed with reason (clear|logout|prompt_input_exit|other)',
};

export function claudeHooks(selfArgv: string[]): Record<string, unknown> {
  const hooks: Record<string, unknown> = {};
  for (const ev of CLAUDE_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: [...selfArgv, 'event', '--from-env', '--kind', ev].join(' '), timeout: 15 }] }];
  return { hooks }; // command type only: 2.1.332 rejects prompt-type SessionStart hooks
}

export const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'] as const;
/** `-c` arguments for a Codex window. Identical for every task → one trust decision per agentctl install + Codex minor version. */
export function codexHookArgs(selfArgv: string[]): string[] {
  const cmd = JSON.stringify([...selfArgv, 'event', '--from-env', '--agent', 'codex'].join(' '));
  return CODEX_EVENTS.flatMap(ev => ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${cmd},timeout=15}]}]`]);
}

/**
 * Whether agentctl may add `--dangerously-bypass-hook-trust` (it vets its own hooks): only when `hooks/list` for the worktree shows no
 * hook from any other source (a project's .codex hooks would otherwise run untrusted too). Otherwise: hooks stay untrusted → notify only.
 */
export function mayBypassTrust(list: { source: string }[]): boolean {
  return list.every(h => h.source === 'sessionFlags');
}

/** The env the launch script exports so the stable hook command knows its task. */
export const hookEnv = (task: string, attempt?: string): Record<string, string> => ({ AGENTCTL_TASK: task, ...(attempt ? { AGENTCTL_ATTEMPT: attempt } : {}) });
