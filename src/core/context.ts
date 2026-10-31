import type { GlobalConfig } from './config.ts';
import type { Runner } from './runner.ts';
import { Tmux } from './tmux.ts';

/** Everything a command needs: where side effects go, the config, and where to print. */
export class Context {
  readonly runner: Runner;
  readonly config: GlobalConfig;
  readonly tmux: Tmux;
  private sink: (line: string) => void;

  constructor(runner: Runner, config: GlobalConfig, out: (line: string) => void) {
    this.runner = runner;
    this.config = config;
    this.tmux = new Tmux(runner, config.session);
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
