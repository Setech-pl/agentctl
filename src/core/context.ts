import { HostRuntime, taskTmux } from './host-runtime.ts';
import { budgetRunner, unwrapBudgetRunner } from './response-budget.ts';
import { socketRunner } from './tmux-socket.ts';
import type { GlobalConfig } from './config.ts';
import type { FetchLike } from './phone.ts';
import type { Runner } from './runner.ts';
import { knownIcons } from './icons.ts';
import { readTaskRecord } from './taskstore.ts';
import { Tmux } from './tmux.ts';

/** Everything a command needs: where side effects go, the config, and where to print. */
export class Context {
  readonly runner: Runner;
  private current: GlobalConfig;
  private tmuxClient: Tmux;
  private localTmuxClient: Tmux;
  hosts: HostRuntime;
  /** Asks a yes/no question on the terminal; undefined when there is no TTY. */
  readonly confirm: ((question: string) => Promise<boolean>) | undefined;
  private sink: (line: string) => void;
  /** HTTP for the phone notifications (ntfy); tests give a mock. */
  fetch: FetchLike = (url, init) => globalThis.fetch(url, init);

  constructor(runner: Runner, config: GlobalConfig, out: (line: string) => void, confirm?: (question: string) => Promise<boolean>) {
    this.confirm = confirm;
    this.runner = budgetRunner(socketRunner(unwrapBudgetRunner(runner), () => this.current.tmux?.socket));
    this.current = config;
    this.hosts = new HostRuntime(this.runner, config);
    this.localTmuxClient = Context.tmuxFor(this.runner, config);
    this.tmuxClient = taskTmux(this.localTmuxClient, this.hosts, config);
    this.sink = out;
  }

  private static tmuxFor(runner: Runner, config: GlobalConfig): Tmux {
    return new Tmux(runner, config.session, {
      icons: knownIcons(config.watch.windowIcons),
      idFor: (window) => readTaskRecord(config, window)?.windowId,
    });
  }

  /** The configuration in force. `watch` replaces it when the file changes (`setConfig`), so read it at the moment you need it. */
  get config(): GlobalConfig {
    return this.current;
  }

  get localTmux(): Tmux { return this.localTmuxClient; }

  get tmux(): Tmux {
    return this.tmuxClient;
  }

  /** Put a reloaded configuration in force (the tmux client follows the new session name and icons). */
  setConfig(config: GlobalConfig): void {
    this.current = config;
    this.hosts = new HostRuntime(this.runner, config);
    this.localTmuxClient = Context.tmuxFor(this.runner, config);
    this.tmuxClient = taskTmux(this.localTmuxClient, this.hosts, config);
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
