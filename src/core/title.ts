/*
 * The title of the terminal window that shows the board (`board.window_title`). The board writes it with OSC 2 and, where the terminal knows
 * the xterm title stack (CSI 22/23 t), puts the previous title back when it leaves. In the agentctl tmux session the outer terminal's title is
 * set through the session options set-titles and set-titles-string (this session only, never -g).
 */

/** "agentctl 0.17.2 · board" */
export const boardTitle = (version: string): string => `agentctl ${version} · board`;

/** The tmux value of `set-titles-string`: the window name is tmux's own format. */
export const tmuxTitleString = (version: string): string => `agentctl ${version} · #W`;

/** Save the current title on the terminal's stack, then set ours. */
export const titleStart = (version: string): string => `\u001b[22;0t\u001b]2;${boardTitle(version)}\u0007`;

/** Put the saved title back. */
export const titleEnd = (): string => '\u001b[23;0t';
