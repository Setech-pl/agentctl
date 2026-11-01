import os from 'node:os';
import type { Runner } from './runner.ts';

export interface Notifier {
  notify(title: string, message: string): Promise<void>;
}

const appleScriptString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;

/** Desktop notification: osascript on macOS (with a sound), notify-send elsewhere. Failures are swallowed: a missing notifier must not stop the watch. */
export class DesktopNotifier implements Notifier {
  private runner: Runner;
  private platform: string;

  constructor(runner: Runner, platform: string = os.platform()) {
    this.runner = runner;
    this.platform = platform;
  }

  async notify(title: string, message: string): Promise<void> {
    if (this.platform === 'darwin') {
      const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} sound name "Glass"`;
      await this.runner.exec('osascript', ['-e', script]);
    } else {
      await this.runner.exec('notify-send', [title, message]);
    }
  }
}
