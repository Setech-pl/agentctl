import { provider, PROVIDER_IDS } from './providers/registry.ts';
import { DEFAULT_AGENT_SETTINGS, PATTERN_FLAGS } from './config.ts';
import type { AgentSettings } from './config.ts';

/**
 * What a task is doing right now.
 * - needs-trust: the agent shows its folder-trust dialog (a human must answer it)
 * - needs-input: the agent asked the user a question and waits for the answer
 * - working:     a turn is running
 * - waiting:     the agent is idle and waits for input
 * - background:  the agent is idle but its own background work is running ("1 shell, 6 monitors"); counts as working, no "waiting" notice
 * - report-ready: the report file is there (and the agent is not mid-turn, or the window is gone)
 * - limited:     the agent says its usage limit is used up (or it is rate limited); `agentctl move` hands the task to the other provider
 * - superseded:  the task was moved to the other provider (`agentctl move`); this window is the old one and is closed by hand
 * - dead:        the window is gone and there is no report
 * - closed:      `agentctl close` was run (or the state folder was moved to the archive): off every list except `status --all`
 * - cancelled:   `agentctl cancel` was run (the work was abandoned, it may have been in the middle of a turn, or never started): off every list except `status --all`; its report, if one was written, stays
 * - orphan:      a window of the agentctl session has no state file (lost or never created); see `agentctl adopt`
 */
export type TaskState = 'needs-attention' | 'overloaded' | 'working' | 'background' | 'waiting' | 'needs-trust' | 'needs-input' | 'limited' | 'report-ready' | 'superseded' | 'dead' | 'orphan' | 'closed' | 'cancelled';

export type ScreenState = 'overloaded' | 'needs-trust' | 'needs-input' | 'limited' | 'working' | 'background' | 'idle';

const matches = (pattern: string, screen: string): boolean => new RegExp(pattern, PATTERN_FLAGS).test(screen);

/**
 * Classify a `tmux capture-pane` screen with the agent's configured patterns. Trust beats a pending question, which beats
 * working; a limit message only counts when the agent is not working (a retry after the reset may leave the old message on screen).
 */
export function classifyScreen(
  screen: string,
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns'> & Partial<Pick<AgentSettings, 'backgroundPatterns' | 'overloadPatterns'>>,
): ScreenState {
  if (matches(settings.trustPattern, screen)) return 'needs-trust';
  if (matches(settings.questionPattern, screen)) return 'needs-input';
  if (matches(settings.workingPattern, screen)) return 'working';
  if (isOverloaded(screen, settings.overloadPatterns)) return 'overloaded';
  if (settings.limitPatterns.some((p) => matches(p, screen))) return 'limited';
  if ((settings.backgroundPatterns ?? []).some((p) => matches(p, screen))) return 'background';
  return 'idle';
}

/** The agent's input box is on the screen: no dialog (permission, question) covers it. */
export function inputVisible(screen: string, settings: Pick<AgentSettings, 'readyPattern'>): boolean {
  return matches(settings.readyPattern, screen);
}

/** What the agent itself reported last (see events.ts); it fills in what the screen cannot show. */
export type EventKind = 'overloaded' | 'needs-input' | 'turn-complete' | 'limited';

export interface StateInput {
  alive: boolean;
  /** Screen of the window; ignored when the window is gone. */
  screen: string;
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns' | 'readyPattern'> & Partial<Pick<AgentSettings, 'backgroundPatterns' | 'overloadPatterns'>>;
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
  if (screen === 'needs-trust' || screen === 'needs-input') return screen;
  if (input.reportReady && screen === 'overloaded') return 'report-ready';
  if (screen === 'limited' || screen === 'overloaded') return screen;
  if (screen === 'working') return 'working';
  // Idle, but its own shells and monitors run: the turn ends every few minutes and a new one starts by itself.
  if (screen === 'background') return 'background';
  if (input.event === 'needs-input' && !inputVisible(input.screen, input.settings)) return 'needs-input';
  // An old hook cannot override the current visible screen after autonomous recovery.
  if (input.event === 'limited') return 'limited';
  return input.reportReady ? 'report-ready' : 'waiting';
}

/** Claude 529/Overloaded and selected-model capacity messages; Codex capacity text is verified in protocol/src/error.rs; raw error-code variants are fixture-tested. */
export function isOverloaded(screen: string, patterns: string[] = PROVIDER_IDS.flatMap(id => provider(id).defaultSettings().overloadPatterns)): boolean {
  let fence: { char: string; size: number } | null = null;
  let last = '';
  let lastIndex = -1;
  let lastInCode = false;
  const lines = screen.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = { char: marker[0]!, size: marker.length }; else if (marker[0] === fence.char && marker.length >= fence.size) fence = null; last = line; lastIndex = index; lastInCode = true; continue; }
    if (!line.trim() || /^[\s─━═│╭╮╰╯┌┐└┘-]+$/.test(line) || /^\s*[❯›](?:\s|$)/.test(line) || /\? for shortcuts|shift\+tab to cycle|^\s*[⏵⏸]|(?:weekly|usage|session).*limit.*(?:left|remaining|reset)/i.test(line)) continue;
    last = line; lastIndex = index; lastInCode = fence !== null;
  }
  if (lastInCode) return false;
  // Claude's error belongs directly to an assistant block. A pasted error in prose (even with ⎿) is not a banner.
  if (/^\s*⎿/.test(last) && !/^\s*⏺(?:\s|$)/.test(lines[lastIndex - 1] ?? '')) return false;
  if (!/^\s*[⎿■]/.test(last)) return false;
  for (let i = lastIndex - 1; i >= 0 && lines[i]!.trim(); i--) {
    if (/^\s*[⏺●•]\s*(?:Bash|Read|Grep|Search|Run|Ran|Shell)(?:\(|\s|:)/i.test(lines[i]!)) return false;
  }
  return patterns.some(p => new RegExp(p, 'i').test(last));
}
