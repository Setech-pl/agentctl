import os from 'node:os';
import type { Runner } from './runner.ts';

/** What a click on a notification does (terminal-notifier only). */
export interface NotifyClick {
  /** Shell command run on click. */
  execute?: string;
  /** Bundle ID of the app to bring to the front on click. */
  activate?: string;
  /** Notifications of one group replace each other. */
  group?: string;
}

export interface Notifier {
  /** Notifications can carry a click action (terminal-notifier); the osascript fallback cannot. */
  readonly clickable?: boolean;
  notify(title: string, message: string, click?: NotifyClick): Promise<void>;
}

const appleScriptString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

/** `TERM_PROGRAM` values of the macOS terminals that tmux can run in, and their bundle IDs. */
const TERMINAL_APPS: Record<string, string> = {
  Apple_Terminal: 'com.apple.Terminal',
  'iTerm.app': 'com.googlecode.iterm2',
};

/** Bundle ID for a `TERM_PROGRAM`; undefined for anything else ("tmux" itself, unknown terminals): then a click does not activate an app. */
export function terminalAppFor(termProgram: string | undefined): string | undefined {
  return termProgram ? TERMINAL_APPS[termProgram] : undefined;
}

/** Where Homebrew puts terminal-notifier when it is not on the PATH of a hook or a launchd job. */
const TERMINAL_NOTIFIER_PATHS = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

/** Path of terminal-notifier (macOS only), or undefined when it is not installed. */
export async function findTerminalNotifier(runner: Runner, platform: string = os.platform()): Promise<string | undefined> {
  if (platform !== 'darwin') return undefined;
  const script = `command -v terminal-notifier || for p in ${TERMINAL_NOTIFIER_PATHS.join(' ')}; do [ -x "$p" ] && echo "$p" && break; done`;
  const r = await runner.exec('sh', ['-c', script], { readOnly: true });
  const found = r.code === 0 ? r.stdout.split('\n')[0]?.trim() : '';
  return found ? found : undefined;
}

/**
 * Desktop notification: terminal-notifier on macOS when installed (clickable), else osascript (with a sound), notify-send
 * elsewhere. Failures are swallowed: a missing notifier must not stop the watch.
 */
export class DesktopNotifier implements Notifier {
  private runner: Runner;
  private platform: string;
  private terminalNotifier: string | undefined;

  constructor(runner: Runner, platform: string = os.platform(), terminalNotifier?: string) {
    this.runner = runner;
    this.platform = platform;
    this.terminalNotifier = platform === 'darwin' ? terminalNotifier : undefined;
  }

  /** The notifier for this machine: terminal-notifier if it is there. */
  static async detect(runner: Runner, platform: string = os.platform()): Promise<DesktopNotifier> {
    return new DesktopNotifier(runner, platform, await findTerminalNotifier(runner, platform));
  }

  get clickable(): boolean {
    return this.terminalNotifier !== undefined;
  }

  async notify(title: string, message: string, click: NotifyClick = {}): Promise<void> {
    if (this.terminalNotifier) {
      const args = ['-title', title, '-message', message, '-sound', 'Glass'];
      if (click.group) args.push('-group', click.group);
      if (click.execute) args.push('-execute', click.execute);
      if (click.activate) args.push('-activate', click.activate);
      await this.runner.exec(this.terminalNotifier, args);
    } else if (this.platform === 'darwin') {
      const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} sound name "Glass"`;
      await this.runner.exec('osascript', ['-e', script]);
    } else {
      await this.runner.exec('notify-send', [title, message]);
    }
  }
}
