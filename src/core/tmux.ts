import { PATTERN_FLAGS } from './config.ts';
import { DEFAULT_WINDOW_ICONS, stripIcon } from './icons.ts';
import type { ExecResult, Runner } from './runner.ts';

/** Pause between pasting a prompt and pressing Enter, so the TUI has consumed the bracketed paste. */
export const PASTE_SETTLE_MS = 300;

/** A window of the session as tmux reports it. */
export interface WindowInfo {
  /** tmux's window ID ("@12"); empty when the listing did not carry one. */
  id: string;
  /** The name as it is now, with a state icon in front when `watch` put one there. */
  name: string;
  /** The name without the icon: the task's window name. */
  plain: string;
}

export interface TmuxOptions {
  /** Icons that may stand in front of a window name (see `stripIcon`). */
  icons?: string[];
  /** The window ID recorded in the task's state, if any. */
  idFor?: (window: string) => string | undefined;
}

/**
 * Thin wrapper that builds the tmux invocations agentctl needs.
 *
 * Windows are told apart by their task name, never by their literal tmux name: `watch` puts a state icon in front of it
 * ("⚙ nc-42"). Every operation looks the window up first and targets its tmux ID (or, without one, its current name).
 */
export class Tmux {
  readonly runner: Runner;
  readonly session: string;
  private readonly icons: string[];
  private readonly idFor: (window: string) => string | undefined;

  constructor(runner: Runner, session: string, options: TmuxOptions = {}) {
    this.runner = runner;
    this.session = session;
    this.icons = options.icons ?? Object.values(DEFAULT_WINDOW_ICONS);
    this.idFor = options.idFor ?? (() => undefined);
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

  /** The windows of the agentctl session (empty when the session does not exist). */
  async windows(): Promise<WindowInfo[]> {
    const r = await this.runner.exec('tmux', ['list-windows', '-t', `=${this.session}`, '-F', '#{window_id}\t#{window_name}'], {
      readOnly: true,
      dryResult: { code: 1 },
    });
    if (r.code !== 0) return [];
    const infos: WindowInfo[] = [];
    for (const line of r.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const tab = line.indexOf('\t');
      const id = tab >= 0 ? line.slice(0, tab).trim() : '';
      const name = (tab >= 0 ? line.slice(tab + 1) : line).trim();
      infos.push({ id, name, plain: stripIcon(name, this.icons) });
    }
    return infos;
  }

  /** Task window names of the session (state icons removed). */
  async listWindows(): Promise<string[]> {
    return (await this.windows()).map((w) => w.plain);
  }

  /**
   * The window of `window` (a task's window name) in `infos`: by its recorded tmux ID while that ID still carries the
   * same name (tmux reuses IDs after a restart), otherwise by name, ignoring the icon.
   */
  resolve(window: string, infos: WindowInfo[], hintId?: string | undefined): WindowInfo | undefined {
    const id = hintId ?? this.idFor(window);
    return (id ? infos.find((w) => w.id === id && w.plain === window) : undefined) ?? infos.find((w) => w.plain === window);
  }

  /** What to pass to `-t` for this window: its tmux ID, else its current name; the plain name when it is not listed. */
  async targetFor(window: string, infos?: WindowInfo[], hintId?: string): Promise<string> {
    const found = this.resolve(window, infos ?? (await this.windows()), hintId);
    if (!found) return this.target(window);
    return found.id !== '' ? found.id : this.target(found.name);
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

  /**
   * Create a window (or, without the session, the session with it) that RUNS `commandLine` as its process, instead of typing the command into a
   * shell: the window does not depend on the shell being ready, and what the command prints when it fails is not lost. `remain-on-exit failed`
   * (set in the same tmux invocation, before the process can end) keeps the window with its output when the command fails.
   */
  async startWindow(window: string, cwd: string, commandLine: string, sessionUp: boolean): Promise<ExecResult> {
    const create = sessionUp
      ? ['new-window', '-d', '-t', `=${this.session}:`, '-n', window, '-c', cwd, commandLine]
      : ['new-session', '-d', '-s', this.session, '-n', window, '-c', cwd, commandLine];
    const r = await this.runner.exec('tmux', [...create, ';', 'set-option', '-w', '-t', this.target(window), 'remain-on-exit', 'failed']);
    if (r.code === 0 || !/remain-on-exit|invalid|unknown/i.test(r.stderr)) return r;
    // tmux before 3.3 has no "failed": keep every ended window (a quit board then stays as a dead pane, which is better than a lost error).
    return this.runner.exec('tmux', ['set-option', '-w', '-t', this.target(window), 'remain-on-exit', 'on']);
  }

  /** The process of the window has ended and the window was kept (remain-on-exit). */
  async paneDead(window: string): Promise<boolean> {
    const r = await this.runner.exec('tmux', ['display-message', '-p', '-t', await this.targetFor(window), '#{pane_dead}'], { readOnly: true, dryResult: { code: 1 } });
    return r.code === 0 && r.stdout.trim() === '1';
  }

  /** Run `commandLine` again in a window whose process has ended. */
  async respawn(window: string, cwd: string, commandLine: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['respawn-pane', '-k', '-t', await this.targetFor(window), '-c', cwd, commandLine]);
  }

  /** Type a command line into the window's shell and press Enter. */
  async typeCommand(window: string, commandLine: string): Promise<void> {
    await this.runner.exec('tmux', ['send-keys', '-t', await this.targetFor(window), '-l', '--', commandLine]);
    await this.pressEnter(window);
  }

  /** Send one named key (e.g. Escape) to the window. */
  async sendKey(window: string, key: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['send-keys', '-t', await this.targetFor(window), key]);
  }

  async pressEnter(window: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['send-keys', '-t', await this.targetFor(window), 'Enter']);
  }

  /**
   * Paste multi-line text as a single bracketed paste so the agent receives it as one
   * input instead of submitting line by line. Enter is sent separately by the caller.
   */
  async pasteText(window: string, text: string): Promise<void> {
    const buffer = `agentctl-${window}`;
    await this.runner.exec('tmux', ['load-buffer', '-b', buffer, '-'], { input: text });
    await this.runner.exec('tmux', ['paste-buffer', '-p', '-d', '-b', buffer, '-t', await this.targetFor(window)]);
  }

  /** Paste, give the TUI a moment to take the paste in, then submit with a separate Enter. */
  async submitPrompt(window: string, text: string): Promise<void> {
    await this.pasteText(window, text);
    this.runner.note(`wait ${PASTE_SETTLE_MS}ms for the agent to take in the paste`);
    await this.runner.sleep(PASTE_SETTLE_MS);
    await this.pressEnter(window);
  }

  /** Visible screen (or the last `lines` lines of scrollback + screen) of the window. */
  async capture(window: string, lines?: number, infos?: WindowInfo[], hintId?: string): Promise<ExecResult> {
    const args = ['capture-pane', '-p', '-t', await this.targetFor(window, infos, hintId)];
    if (lines !== undefined) args.push('-S', `-${lines}`);
    return this.runner.exec('tmux', args, { readOnly: true });
  }

  /** Make `window` the current window of the session (what a client attached to the session then shows). */
  async selectWindow(window: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['select-window', '-t', await this.targetFor(window)]);
  }

  /** Inside tmux: move the current client to the agentctl session. */
  switchClient(): Promise<ExecResult> {
    return this.runner.exec('tmux', ['switch-client', '-t', `=${this.session}`]);
  }

  /** Clients attached to the session, the most recently active first. */
  async clients(): Promise<string[]> {
    const r = await this.runner.exec('tmux', ['list-clients', '-t', `=${this.session}`, '-F', '#{client_activity}\t#{client_name}'], {
      readOnly: true,
      dryResult: { code: 1 },
    });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((p): p is [string, string] => p.length === 2 && p[1]!.trim() !== '')
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .map((p) => p[1].trim());
  }

  /** Move one attached client to the session (its current window is the one `selectWindow` chose). */
  switchClientTo(client: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['switch-client', '-c', client, '-t', `=${this.session}`]);
  }

  /** `TERM_PROGRAM` of the environment the tmux server was started from ("Apple_Terminal", "iTerm.app"); undefined if unset. */
  async serverTermProgram(): Promise<string | undefined> {
    const r = await this.runner.exec('tmux', ['show-environment', '-g', 'TERM_PROGRAM'], { readOnly: true, dryResult: { code: 1 } });
    const m = r.code === 0 ? /^TERM_PROGRAM=(.+)$/m.exec(r.stdout) : null;
    return m?.[1]?.trim();
  }

  /** Outside tmux: attach this terminal to the session; returns when the user detaches. */
  attachSession(): Promise<ExecResult> {
    return this.runner.exec('tmux', ['attach-session', '-t', `=${this.session}`], { interactive: true });
  }

  async killWindow(window: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['kill-window', '-t', await this.targetFor(window)]);
  }

  /** What `key` is bound to in the root key table (no prefix); empty when nothing is. */
  async rootBinding(key: string): Promise<string> {
    const r = await this.runner.exec('tmux', ['list-keys', '-T', 'root', key], { readOnly: true, dryResult: { code: 1 } });
    return r.code === 0 ? r.stdout.trim() : '';
  }

  /** Bind `key` (no prefix, every session of the server): `thenCommand` when the format is true, else `elseCommand`. */
  bindRootKey(key: string, condition: string, thenCommand: string, elseCommand: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['bind-key', '-n', key, 'if-shell', '-F', condition, thenCommand, elseCommand]);
  }

  /** A tmux option of this session only (no `-g`: other sessions keep theirs). */
  setSessionOption(option: string, value: string): Promise<ExecResult> {
    // set-option takes a pane target: "=session:" is that session's current pane, so the option lands on the session.
    return this.runner.exec('tmux', ['set-option', '-t', `=${this.session}:`, option, value]);
  }

  /** Give a window a new name (the state icon in front of it, or the plain name again). `target` comes from `targetFor`. */
  renameWindow(target: string, name: string): Promise<ExecResult> {
    return this.runner.exec('tmux', ['rename-window', '-t', target, name]);
  }
}

export function lastNonEmptyLine(screen: string): string {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.length ? (lines[lines.length - 1] as string).trim() : '';
}

/** A line made only of box-drawing characters and spaces: borders and separators around the input field. */
const BORDER_LINE = /^[\s─━═│┃║╭╮╰╯┌┐└┘├┤┬┴┼╌╍┄┅┈┉-]*$/u;

/**
 * The last line of real content: skips blank lines, borders, the agent's footer lines (`footerPatterns`,
 * regexes matched per line, case-insensitive) and empty input fields. Empty when nothing else is on screen.
 */
export function lastContentLine(screen: string, footerPatterns: string[]): string {
  const footers = footerPatterns.map((p) => new RegExp(p, PATTERN_FLAGS));
  const lines = screen.split('\n').map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (BORDER_LINE.test(l) || footers.some((f) => f.test(l))) continue;
    return l.trim();
  }
  return '';
}

/**
 * The last `count` lines of real content of a captured screen: no footer lines (`footerPatterns`), no borders and no
 * empty input fields (the same filter as `lastContentLine`), no blank lines at the end. Blank lines inside stay.
 */
export function contentLines(screen: string, footerPatterns: string[], count: number): string[] {
  const footers = footerPatterns.map((p) => new RegExp(p, PATTERN_FLAGS));
  const kept = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => (l === '' || !BORDER_LINE.test(l)) && !footers.some((f) => f.test(l)));
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  while (kept.length > 0 && kept[0] === '') kept.shift();
  return kept.slice(-count);
}
