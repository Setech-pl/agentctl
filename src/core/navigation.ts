import type { Context } from './context.ts';
import { BOARD_WINDOW } from './windows.ts';

/**
 * The tmux key binding is server-wide, so it is conditional: in the agentctl session the key selects the board, in every other session it
 * is passed on to the program in the pane as if no binding existed.
 */
export function returnKeyCondition(session: string): string {
  return `#{==:#{session_name},${session}}`;
}

export type NavigationResult =
  | { session: false }
  | {
      session: true;
      mouse: 'on' | 'left-alone' | { failed: string };
      key: { name: string; state: 'bound' | 'taken' | { failed: string } } | null;
    };

/**
 * Make the agentctl session easy to move around in: `mouse on` (this session only, so a click on a window name in the status bar
 * switches to it) and one key without the tmux prefix that returns to the board. A key that something else is bound to is left alone.
 * Safe to run again.
 */
export async function applyNavigation(ctx: Context): Promise<NavigationResult> {
  const { tmux, config } = ctx;
  if (!(await tmux.hasSession())) return { session: false };
  let mouse: 'on' | 'left-alone' | { failed: string } = 'left-alone';
  if (config.board.mouse) {
    const r = await tmux.setSessionOption('mouse', 'on');
    mouse = r.code === 0 ? 'on' : { failed: r.stderr.trim() || `exit ${r.code}` };
  }
  const name = config.board.returnKey;
  if (!name) return { session: true, mouse, key: null };
  const condition = returnKeyCondition(config.session);
  const existing = await tmux.rootBinding(name);
  if (existing !== '' && !existing.includes(condition)) return { session: true, mouse, key: { name, state: 'taken' } };
  const r = await tmux.bindRootKey(name, condition, `select-window -t '=${config.session}:${BOARD_WINDOW}'`, `send-keys ${name}`);
  return { session: true, mouse, key: { name, state: r.code === 0 ? 'bound' : { failed: r.stderr.trim() || `exit ${r.code}` } } };
}

/** What the CLI says after `applyNavigation`; empty when there was no session. `onlyProblems`: say nothing when all went well (every `new` applies it again). */
export function describeNavigation(result: NavigationResult, session: string, onlyProblems = false): string[] {
  if (!result.session) return [];
  const lines: string[] = [];
  if (result.mouse === 'on') onlyProblems || lines.push(`Mouse on in session ${session} only: click a window name in the status bar. To select text hold fn (Terminal.app). Off: board.mouse: false.`);
  else if (typeof result.mouse === 'object') lines.push(`Mouse not set – ${result.mouse.failed}`);
  if (result.key) {
    const { name, state } = result.key;
    if (state === 'bound') onlyProblems || lines.push(`${name} goes back to the board from any window of session ${session} (other sessions keep ${name} for their programs). Another key: board.return_key; none: board.return_key: false.`);
    else if (state === 'taken') lines.push(`${name} is already bound to something else in tmux, left alone. Pick another key with board.return_key (Ctrl-b l still goes to the last window).`);
    else lines.push(`${name} not bound – ${state.failed}`);
  }
  return lines;
}

/** The board's own reminder: Enter goes to the agent, the key comes back. Empty key: only the prefix way is left. */
export function navigationHint(returnKey: string | null): string {
  return returnKey ? `Enter – open the agent · ${returnKey} – back to the list` : 'Enter – open the agent · Ctrl-b l – back to the list';
}
