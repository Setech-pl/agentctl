/*
 * What agentctl knows about Claude Code's Remote Control (https://code.claude.com/docs/en/remote-control), in one place: the patterns of its screen
 * and the hints for the user. The patterns are a reading of the documentation of Claude Code 2.1.309 - they were never seen on a real screen,
 * because agentctl's tests and its live harness never start the real claude.
 */

/** The indicator an interactive session shows while Remote Control is connected. */
export const RC_CONNECTED = '/rc active';

/** Claude Code says the connection failed, was lost or is not possible for this account. */
export const RC_FAILED = 'Remote Control (?:failed|disconnected)|Remote Control (?:requires|is disabled|is only available|isn.t enabled)|Couldn.t (?:verify|reconnect)';

/** The one-time dialog that asks to switch Remote Control on (the row "Enable Remote Control for all sessions" of /config is not it). */
export const RC_CONFIRM = 'Enable Remote Control\\b(?! for all sessions)';

/** What the user does in the window the first time. */
export const RC_FIRST_TIME = 'answer the folder trust and, if asked, "Enable Remote Control" in that window (agentctl never answers these dialogs)';

/** The ending of a phone notification of a task that has a session in the Claude app: where to answer. */
export const rcAnswerHint = (task: string): string => `Odpowiesz w aplikacji Claude: ${task}`;

/** The ending of a phone notification when the manager runs: where to ask. */
export const managerPhoneHint = (name: string): string => `Otwórz sesję „${name}” w aplikacji Claude.`;

export function remoteControlSupport(help: string): { remoteControl: boolean; roleFile: boolean } {
  return { remoteControl: /--remote-control\b/.test(help), roleFile: /--append-system-prompt(?:-file\b|\[-file\])/.test(help) };
}
export const RC_BLOCKING_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_GROWTHBOOK',
] as const;

/** The variables of `env` that block Remote Control (set and not empty). */
export function blockingEnv(env: NodeJS.ProcessEnv): string[] {
  return RC_BLOCKING_ENV.filter((name) => (env[name] ?? '') !== '');
}
