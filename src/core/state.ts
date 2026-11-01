import { PATTERN_FLAGS } from './config.ts';
import type { AgentSettings } from './config.ts';

/**
 * What a task is doing right now.
 * - needs-trust: the agent shows its folder-trust dialog (a human must answer it)
 * - needs-input: the agent asked the user a question and waits for the answer
 * - working:     a turn is running
 * - waiting:     the agent is idle and waits for input
 * - report-ready: the report file is there (and the agent is not mid-turn, or the window is gone)
 * - dead:        the window is gone and there is no report
 * - orphan:      a window of the agentctl session has no state file (lost or never created); see `agentctl adopt`
 */
export type TaskState = 'working' | 'waiting' | 'needs-trust' | 'needs-input' | 'report-ready' | 'dead' | 'orphan';

export type ScreenState = 'needs-trust' | 'needs-input' | 'working' | 'idle';

const matches = (pattern: string, screen: string): boolean => new RegExp(pattern, PATTERN_FLAGS).test(screen);

/** Classify a `tmux capture-pane` screen with the agent's configured patterns. Trust beats a pending question, which beats working. */
export function classifyScreen(screen: string, settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern'>): ScreenState {
  if (matches(settings.trustPattern, screen)) return 'needs-trust';
  if (matches(settings.questionPattern, screen)) return 'needs-input';
  if (matches(settings.workingPattern, screen)) return 'working';
  return 'idle';
}

export interface StateInput {
  alive: boolean;
  /** Screen of the window; ignored when the window is gone. */
  screen: string;
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern'>;
  /** The report file exists and was written after the task started. */
  reportReady: boolean;
}

export function taskState(input: StateInput): TaskState {
  if (!input.alive) return input.reportReady ? 'report-ready' : 'dead';
  const screen = classifyScreen(input.screen, input.settings);
  if (screen === 'needs-trust' || screen === 'needs-input') return screen;
  if (screen === 'working') return 'working';
  return input.reportReady ? 'report-ready' : 'waiting';
}
