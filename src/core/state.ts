import { PATTERN_FLAGS } from './config.ts';
import type { AgentSettings } from './config.ts';

/**
 * What a task is doing right now.
 * - needs-trust: the agent shows its folder-trust dialog (a human must answer it)
 * - needs-input: the agent asked the user a question and waits for the answer
 * - working:     a turn is running
 * - waiting:     the agent is idle and waits for input
 * - report-ready: the report file is there (and the agent is not mid-turn, or the window is gone)
 * - limited:     the agent says its usage limit is used up (or it is rate limited); `agentctl move` hands the task to the other provider
 * - superseded:  the task was moved to the other provider (`agentctl move`); this window is the old one and is closed by hand
 * - dead:        the window is gone and there is no report
 * - closed:      `agentctl close` was run (or the state folder was moved to the archive): off every list except `status --all`
 * - orphan:      a window of the agentctl session has no state file (lost or never created); see `agentctl adopt`
 */
export type TaskState = 'working' | 'waiting' | 'needs-trust' | 'needs-input' | 'limited' | 'report-ready' | 'superseded' | 'dead' | 'orphan' | 'closed';

export type ScreenState = 'needs-trust' | 'needs-input' | 'limited' | 'working' | 'idle';

const matches = (pattern: string, screen: string): boolean => new RegExp(pattern, PATTERN_FLAGS).test(screen);

/**
 * Classify a `tmux capture-pane` screen with the agent's configured patterns. Trust beats a pending question, which beats
 * working; a limit message only counts when the agent is not working (a retry after the reset may leave the old message on screen).
 */
export function classifyScreen(
  screen: string,
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns'>,
): ScreenState {
  if (matches(settings.trustPattern, screen)) return 'needs-trust';
  if (matches(settings.questionPattern, screen)) return 'needs-input';
  if (matches(settings.workingPattern, screen)) return 'working';
  if (settings.limitPatterns.some((p) => matches(p, screen))) return 'limited';
  return 'idle';
}

/** The agent's input box is on the screen: no dialog (permission, question) covers it. */
export function inputVisible(screen: string, settings: Pick<AgentSettings, 'readyPattern'>): boolean {
  return matches(settings.readyPattern, screen);
}

/** What the agent itself reported last (see events.ts); it fills in what the screen cannot show. */
export type EventKind = 'needs-input' | 'turn-complete' | 'limited';

export interface StateInput {
  alive: boolean;
  /** Screen of the window; ignored when the window is gone. */
  screen: string;
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns' | 'readyPattern'>;
  /** The report file exists and was written after the task started. */
  reportReady: boolean;
  /** The last event the agent sent, if any. */
  event?: EventKind | undefined;
}

/**
 * The state of a task. The screen is the base; an event decides only what the screen leaves open: a permission dialog that
 * none of the patterns knows (needs-input while the input box is hidden) and a limit the patterns missed. Working always wins.
 */
export function taskState(input: StateInput): TaskState {
  if (!input.alive) return input.reportReady ? 'report-ready' : 'dead';
  const screen = classifyScreen(input.screen, input.settings);
  if (screen === 'needs-trust' || screen === 'needs-input' || screen === 'limited') return screen;
  if (screen === 'working') return 'working';
  if (input.event === 'needs-input' && !inputVisible(input.screen, input.settings)) return 'needs-input';
  if (input.event === 'limited') return 'limited';
  return input.reportReady ? 'report-ready' : 'waiting';
}
