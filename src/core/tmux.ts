import type { ExecResult, Runner } from './runner.ts';

/** Pause between pasting a prompt and pressing Enter, so the TUI has consumed the bracketed paste. */
export const PASTE_SETTLE_MS = 300;

/** Thin wrapper that builds the tmux invocations agentctl needs. */
export class Tmux {
  readonly runner: Runner;
  readonly session: string;

  constructor(runner: Runner, session: string) {
    this.runner = runner;
    this.session = session;
  }

  /** `=` makes tmux match session and window names exactly instead of by prefix. */
  target(window: string): string {
    return `=${this.session}:${window}`;
  }

  version(): Promise<ExecResult> {
    return this.runner.exec('tmux', ['-V'], { readOnly: true });
  }

  async hasSession(): Promise<boolean> {
    const r = await this.runner.exec('tmux', ['has-session', '-t', `=${this.session}`], {
      readOnly: true,
      dryResult: { code: 1 },
    });
    return r.code === 0;
  }

  /** Names of the windows in the agentctl session (empty when the session does not exist). */
  async listWindows(): Promise<string[]> {
    const r = await this.runner.exec('tmux', ['list-windows', '-t', `=${this.session}`, '-F', '#{window_name}'], {
      readOnly: true,
      dryResult: { code: 1 },
    });
    if (r.code !== 0) return [];
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  private envArgs(env: Record<string, string>): string[] {
    return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  }

  /** Create the session with its first window. */
  newSession(window: string, cwd: string, env: Record<string, string>): Promise<ExecResult> {
    return this.runner.exec('tmux', ['new-session', '-d', '-s', this.session, '-n', window, '-c', cwd, ...this.envArgs(env)]);
  }

  /** Add a window to an existing session without switching to it. */
  newWindow(window: string, cwd: string, env: Record<string, string>): Promise<ExecResult> {
    return this.runner.exec('tmux', ['new-window', '-d', '-t', `=${this.session}:`, '-n', window, '-c', cwd, ...this.envArgs(env)]);
  }

  /** Type a command line into the window's shell and press Enter. */
  async typeCommand(window: string, commandLine: string): Promise<void> {
    await this.runner.exec('tmux', ['send-keys', '-t', this.target(window), '-l', '--', commandLine]);
    await this.pressEnter(window);
  }

  /** Send one named key (e.g. Escape) to the window. */
  sendKey(window: string, key: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['send-keys', '-t', this.target(window), key]);
  }

  pressEnter(window: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['send-keys', '-t', this.target(window), 'Enter']);
  }

  /**
   * Paste multi-line text as a single bracketed paste so the agent receives it as one
   * input instead of submitting line by line. Enter is sent separately by the caller.
   */
  async pasteText(window: string, text: string): Promise<void> {
    const buffer = `agentctl-${window}`;
    await this.runner.exec('tmux', ['load-buffer', '-b', buffer, '-'], { input: text });
    await this.runner.exec('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', this.target(window)]);
  }

  /** Paste, give the TUI a moment to take the paste in, then submit with a separate Enter. */
  async submitPrompt(window: string, text: string): Promise<void> {
    await this.pasteText(window, text);
    this.runner.note(`wait ${PASTE_SETTLE_MS}ms for the agent to take in the paste`);
    await this.runner.sleep(PASTE_SETTLE_MS);
    await this.pressEnter(window);
  }

  /** Visible screen (or the last `lines` lines of scrollback + screen) of the window. */
  async capture(window: string, lines?: number): Promise<ExecResult> {
    const args = ['capture-pane', '-p', '-t', this.target(window)];
    if (lines !== undefined) args.push('-S', `-${lines}`);
    return this.runner.exec('tmux', args, { readOnly: true });
  }

  killWindow(window: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['kill-window', '-t', this.target(window)]);
  }
}

export function lastNonEmptyLine(screen: string): string {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.length ? (lines[lines.length - 1] as string).trim() : '';
}
