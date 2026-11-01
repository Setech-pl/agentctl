import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalConfig, NotifyBackend } from './config.ts';
import { isObject } from './util.ts';
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

/** Which channel carried a notification, and whether it did. */
export interface NotifyResult {
  channel: 'terminal-notifier' | 'osascript' | 'notify-send';
  ok: boolean;
  /** terminal-notifier failed and this notification went through osascript instead. */
  fallbackFrom?: 'terminal-notifier';
  /** Why the channel (or the one it fell back from) failed. */
  error?: string;
  /** The notification went out through osascript and terminal-notifier is left alone until this ms timestamp. */
  skippedUntil?: number;
}

export interface Notifier {
  /** Notifications can carry a click action (terminal-notifier); the osascript fallback cannot. */
  readonly clickable?: boolean;
  notify(title: string, message: string, click?: NotifyClick): Promise<NotifyResult | void>;
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

/** After a failure terminal-notifier is not tried again for this long (osascript is used meanwhile). */
export const NOTIFIER_MEMORY_MS = 60 * 60_000;

/** `<config dir>/notifier.json`: when terminal-notifier last failed and until when it is left alone. */
export function notifierMemoryPath(configDir: string): string {
  return path.join(configDir, 'notifier.json');
}

export interface NotifierMemory {
  /** ms timestamp: terminal-notifier is not tried before this. */
  until: number;
  /** ms timestamp of the failure. */
  at: number;
  reason: string;
}

/** The remembered failure while it still counts; undefined when there is none or it has run out. */
export function readNotifierMemory(file: string | undefined, now: number): NotifierMemory | undefined {
  if (!file) return undefined;
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(data) && typeof data.until === 'number' && data.until > now) {
      return { until: data.until, at: typeof data.at === 'number' ? data.at : 0, reason: typeof data.reason === 'string' ? data.reason : '' };
    }
  } catch {
    // no memory yet
  }
  return undefined;
}

/** terminal-notifier 3.x prints this when macOS has not allowed it to show notifications; the permission cannot be given from the command line. */
const PERMISSION_TEXT = /notification permission|not allowed for this application|not authori[sz]ed|permission denied/i;

/** Why a terminal-notifier run failed, or undefined when it worked: a non-zero exit, or the permission message (also with exit 0). */
export function notifierFailure(r: { code: number; stdout: string; stderr: string }): string | undefined {
  const text = `${r.stderr}\n${r.stdout}`.trim();
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (r.code !== 0) return first || `exit code ${r.code}`;
  if (PERMISSION_TEXT.test(text)) return first;
  return undefined;
}

export interface DesktopNotifierOptions {
  /** `notify.backend`: auto (terminal-notifier, osascript when it fails), or one channel only. */
  backend?: NotifyBackend;
  /** `<config dir>/notifier.json`; without it nothing is remembered. */
  memoryFile?: string;
  /** `<config dir>/notifier.log`: the one warning when terminal-notifier is given up. */
  logFile?: string;
  /** Try terminal-notifier although it failed recently (`notify-test`). */
  retryBroken?: boolean;
}

/**
 * Desktop notification: terminal-notifier on macOS when installed (clickable), else osascript (with a sound), notify-send
 * elsewhere. With `backend: auto` a terminal-notifier that fails (exit code, or the "not allowed" permission message) hands the
 * same notification to osascript and is left alone for an hour. Failures never throw: a missing notifier must not stop the watch.
 */
export class DesktopNotifier implements Notifier {
  private runner: Runner;
  private platform: string;
  private terminalNotifier: string | undefined;
  private readonly options: DesktopNotifierOptions;

  constructor(runner: Runner, platform: string = os.platform(), terminalNotifier?: string, options: DesktopNotifierOptions = {}) {
    this.runner = runner;
    this.platform = platform;
    this.terminalNotifier = platform === 'darwin' ? terminalNotifier : undefined;
    this.options = options;
  }

  /** The notifier for this machine: terminal-notifier if it is there. */
  static async detect(runner: Runner, platform: string = os.platform(), options: DesktopNotifierOptions = {}): Promise<DesktopNotifier> {
    return new DesktopNotifier(runner, platform, await findTerminalNotifier(runner, platform), options);
  }

  private get backend(): NotifyBackend {
    return this.options.backend ?? 'auto';
  }

  private memory(): NotifierMemory | undefined {
    return this.backend === 'auto' && !this.options.retryBroken ? readNotifierMemory(this.options.memoryFile, this.runner.now()) : undefined;
  }

  get clickable(): boolean {
    return this.terminalNotifier !== undefined && this.backend !== 'osascript' && this.memory() === undefined;
  }

  private async warn(text: string): Promise<void> {
    if (this.options.logFile) await this.runner.appendFile(this.options.logFile, `${new Date(this.runner.now()).toISOString()}  ${text}\n`);
  }

  async notify(title: string, message: string, click: NotifyClick = {}): Promise<NotifyResult> {
    if (this.platform !== 'darwin') {
      const r = await this.runner.exec('notify-send', [title, message]);
      return { channel: 'notify-send', ok: r.code === 0, ...(r.code === 0 ? {} : { error: r.stderr.trim() || `exit code ${r.code}` }) };
    }
    let fallbackFrom: NotifyResult['fallbackFrom'];
    let error: string | undefined;
    let skippedUntil: number | undefined;
    if (this.terminalNotifier && this.backend !== 'osascript') {
      const remembered = this.memory();
      if (remembered) {
        fallbackFrom = 'terminal-notifier';
        error = remembered.reason;
        skippedUntil = remembered.until;
      } else {
        const args = ['-title', title, '-message', message, '-sound', 'Glass'];
        if (click.group) args.push('-group', click.group);
        if (click.execute) args.push('-execute', click.execute);
        if (click.activate) args.push('-activate', click.activate);
        const r = await this.runner.exec(this.terminalNotifier, args);
        const failure = notifierFailure(r);
        if (failure === undefined) {
          // It works again (a retry, or the permission was given meanwhile): forget the old failure.
          if (this.options.memoryFile && fs.existsSync(this.options.memoryFile)) await this.runner.writeFile(this.options.memoryFile, `${JSON.stringify({ until: 0, at: this.runner.now(), reason: '' })}\n`);
          return { channel: 'terminal-notifier', ok: true };
        }
        if (this.backend === 'terminal-notifier') {
          await this.warn(`terminal-notifier failed (${failure}); notify.backend is terminal-notifier, so there is no fallback`);
          return { channel: 'terminal-notifier', ok: false, error: failure };
        }
        fallbackFrom = 'terminal-notifier';
        error = failure;
        skippedUntil = this.runner.now() + NOTIFIER_MEMORY_MS;
        if (this.options.memoryFile) await this.runner.writeFile(this.options.memoryFile, `${JSON.stringify({ until: skippedUntil, at: this.runner.now(), reason: failure })}\n`);
        await this.warn(`terminal-notifier failed (${failure}); notifications go through osascript (no click action) until ${new Date(skippedUntil).toISOString()}. Fix: System Settings > Notifications > terminal-notifier > Allow Notifications, or set notify.backend: osascript`);
      }
    }
    const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} sound name "Glass"`;
    const r = await this.runner.exec('osascript', ['-e', script]);
    const result: NotifyResult = { channel: 'osascript', ok: r.code === 0 };
    if (fallbackFrom) result.fallbackFrom = fallbackFrom;
    if (skippedUntil !== undefined) result.skippedUntil = skippedUntil;
    const osaError = r.code === 0 ? undefined : r.stderr.trim() || `exit code ${r.code}`;
    if (osaError ?? error) result.error = osaError ?? (error as string);
    return result;
  }
}

/** Backend, memory and log of the notifier for this config (all in the config directory: `~/.agentctl`, or `AGENTCTL_HOME`). */
export function notifierOptionsFor(config: Pick<GlobalConfig, 'path' | 'notify'>, extra: Pick<DesktopNotifierOptions, 'retryBroken'> = {}): DesktopNotifierOptions {
  const dir = path.dirname(config.path);
  return { backend: config.notify.backend, memoryFile: notifierMemoryPath(dir), logFile: path.join(dir, 'notifier.log'), ...extra };
}
