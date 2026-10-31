import { PATTERN_FLAGS } from './config.ts';
import type { AgentSettings } from './config.ts';

/**
 * What a task is doing right now.
 * - needs-trust: the agent shows its folder-trust dialog (a human must answer it)
 * - working:     a turn is running
 * - waiting:     the agent is idle and waits for input
 * - report-ready: the report file is there (and the agent is not mid-turn, or the window is gone)
 * - dead:        the window is gone and there is no report
 */
export type TaskState = 'working' | 'waiting' | 'needs-trust' | 'report-ready' | 'dead';

export type ScreenState = 'needs-trust' | 'working' | 'idle';

const matches = (pattern: string, screen: string): boolean => new RegExp(pattern, PATTERN_FLAGS).test(screen);

/** Classify a `tmux capture-pane` screen with the agent's configured patterns. Trust beats working. */
export function classifyScreen(screen: string, settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern'>): ScreenState {
  if (matches(settings.trustPattern, screen)) return 'needs-trust';
  if (matches(settings.workingPattern, screen)) return 'working';
  return 'idle';
}

export interface StateInput {
  alive: boolean;
  /** Screen of the window; ignored when the window is gone. */
  screen: string;
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern'>;
  /** The report file exists and was written after the task started. */
  reportReady: boolean;
}

export function taskState(input: StateInput): TaskState {
  if (!input.alive) return input.reportReady ? 'report-ready' : 'dead';
  const screen = classifyScreen(input.screen, input.settings);
  if (screen === 'needs-trust') return 'needs-trust';
  if (screen === 'working') return 'working';
  return input.reportReady ? 'report-ready' : 'waiting';
}
