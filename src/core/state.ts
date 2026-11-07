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

/** The offset of the last match of pattern in screen (-1: none). */
const lastMatchIndex = (pattern: string, screen: string): number => {
  const re = new RegExp(pattern, `${PATTERN_FLAGS}g`);
  let last = -1;
  for (let m = re.exec(screen); m !== null; m = re.exec(screen)) {
    last = m.index;
    if (re.lastIndex === m.index) break; // a zero-width match must not loop
  }
  return last;
};

const ERROR_BANNER = /^\s*(?:[■●]\s*)?Error:/;
/** A turn that goes on after an error (re-login resumes the queued task): input echo, an action, a success line. */
const RESUMED_AFTER_ERROR = /^\s*(?:❯|✓|●\s+(?!Error:))/;
/**
 * An error banner pins idle to needs-input only while it is the last thing that happened. A stale banner left in the pane
 * (the token was rejected, the human authorized the device, the queued task then ran to its report) must not block the transition.
 */
function errorAwaitingInput(screen: string, readyPattern: string | undefined): boolean {
  const lines = screen.split('\n');
  let error = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (ERROR_BANNER.test(lines[i]!)) { error = i; break; }
  if (error < 0) return false;
  for (let i = error + 1; i < lines.length; i++) {
    if (readyPattern && matches(readyPattern, lines[i]!)) continue;
    if (RESUMED_AFTER_ERROR.test(lines[i]!)) return false;
  }
  return true;
}

/**
 * Classify a `tmux capture-pane` screen with the agent's configured patterns. Trust beats a pending question, which beats
 * working; a limit message only counts when the agent is not working (a retry after the reset may leave the old message on screen).
 * Trust counts only while the dialog is the newest thing on the screen: a tall pane keeps an answered dialog above the fresh
 * input box, and a capture with scrollback carries it too — a ready line below the last trace of the dialog means it is history.
 */
export function classifyScreen(
  screen: string,
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns'> & Partial<Pick<AgentSettings, 'backgroundPatterns' | 'overloadPatterns' | 'approvalPattern' | 'idleRequiresInput' | 'readyPattern'>>,
): ScreenState {
  if (matches(settings.trustPattern, screen)) {
    const ready = settings.readyPattern ? lastMatchIndex(settings.readyPattern, screen) : -1;
    if (!(ready > lastMatchIndex(settings.trustPattern, screen))) return 'needs-trust';
  }
  if (settings.approvalPattern && matches(settings.approvalPattern, screen)) return 'needs-input';
  if (matches(settings.questionPattern, screen)) return 'needs-input';
  if (matches(settings.workingPattern, screen) || starSpinnerActive(screen)) return 'working';
  if (settings.approvalPattern && settings.overloadPatterns?.some(p => matches(p, screen))) return 'overloaded';
  if (isOverloaded(screen, settings.overloadPatterns)) return 'overloaded';
  if (settings.limitPatterns.some((p) => matches(p, screen))) return 'limited';
  if ((settings.backgroundPatterns ?? []).some((p) => matches(p, screen))) return 'background';
  if (settings.idleRequiresInput && (!settings.readyPattern || !matches(settings.readyPattern, screen) || errorAwaitingInput(screen, settings.readyPattern))) return 'needs-input';
  return 'idle';
}

const PROMPT_LINE = /^\s*[❯›>](?:\s|$)/;
/** "✳ Fluttering… (2s · thinking with high effort)": the glyph, a word, "…" and a bracket that starts with the elapsed time. */
const STAR_SPINNER = /^\s*✳\s+[^\s…][^…\n]*…\s*\((?:\d+m\s*)?\d+s\b[^)\n]*\)/;
const SPINNER_NEIGHBOUR = /^[\s─━═-]*$|^\s*⎿/u;

/**
 * Claude Code 2.1.311 cycles its spinner through ✳ as well; with the footer "esc to interrupt" hidden by a paste placeholder that frame is the only
 * sign of a running turn. It counts only where the TUI draws the spinner: the line right above the input box (a tip, an empty line or the border
 * may stand between), never a spinner line quoted further up in a report or an answer.
 */
export function starSpinnerActive(screen: string): boolean {
  const lines = screen.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_LINE.test(lines[i]!)) { at = i; break; }
  for (let i = at - 1; at >= 0 && i >= 0; i--) {
    if (SPINNER_NEIGHBOUR.test(lines[i]!)) continue;
    return STAR_SPINNER.test(lines[i]!);
  }
  return false;
}

/** The agent's input box is on the screen: no dialog (permission, question) covers it. */
export function inputVisible(screen: string, settings: Pick<AgentSettings, 'readyPattern'>): boolean {
  return matches(settings.readyPattern, screen);
}

/** What the agent itself reported last (see events.ts); it fills in what the screen cannot show. */
export type EventKind = 'error' | 'overloaded' | 'needs-input' | 'turn-complete' | 'limited';

export interface StateInput {
  alive: boolean;
  /** Screen of the window; ignored when the window is gone. */
  screen: string;
  settings: Pick<AgentSettings, 'trustPattern' | 'workingPattern' | 'questionPattern' | 'limitPatterns' | 'readyPattern'> & Partial<Pick<AgentSettings, 'backgroundPatterns' | 'overloadPatterns' | 'approvalPattern' | 'idleRequiresInput' | 'readyPattern'>>;
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
  if (input.event === 'error') return 'needs-attention';
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
