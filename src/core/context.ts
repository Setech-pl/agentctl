import type { GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { knownIcons } from './icons.ts';
import { readTaskRecord } from './taskstore.ts';
import { Tmux } from './tmux.ts';

/** Everything a command needs: where side effects go, the config, and where to print. */
export class Context {
  readonly runner: Runner;
  readonly config: GlobalConfig;
  readonly tmux: Tmux;
  /** Asks a yes/no question on the terminal; undefined when there is no TTY. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  private sink: (line: string) => void;

  constructor(runner: Runner, config: GlobalConfig, out: (line: string) => void, confirm?: (question: string) => Promise<boolean>) {
    this.confirm = confirm;
    this.runner = runner;
    this.config = config;
    this.tmux = new Tmux(runner, config.session, {
      icons: knownIcons(config.watch.windowIcons),
      idFor: (window) => readTaskRecord(config, window)?.windowId,
    });
    this.sink = out;
  }

  /** Normal output. */
  out(line: string): void {
    this.sink(line);
  }

  /** Progress message: a `# comment` line in a dry run, a plain line otherwise. */
  info(line: string): void {
    if (this.runner.dryRun) this.runner.note(line);
    else this.sink(line);
  }
}
