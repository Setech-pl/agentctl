import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import { terminalAppFor } from './notify.ts';
import type { Notifier, NotifyClick } from './notify.ts';
import type { SelfArgv } from './events.ts';
import { taskDir } from './taskstore.ts';
import { isObject, shellLine } from './util.ts';

/** Title of every notification. */
export const ALERT_TITLE = 'agentctl';

/** Two notifications for the same state from the two sources (the agent's event, the watcher's screen reading) within this time are one. */
export const DEDUP_MIN_MS = 90_000;

export type AlertSource = 'event' | 'watch';

/** Who announced which state of a task last, and when. Lives in `<state_dir>/<task>/notified.json`. */
interface Ledger {
  state: string;
  source: AlertSource;
  at: number;
}

export function ledgerPath(ctx: Context, window: string): string {
  return path.join(taskDir(ctx.config, window), 'notified.json');
}

export function readLedger(ctx: Context, window: string): Ledger | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(ledgerPath(ctx, window), 'utf8'));
    if (isObject(data) && typeof data.state === 'string' && (data.source === 'event' || data.source === 'watch') && typeof data.at === 'number') {
      return { state: data.state, source: data.source, at: data.at };
    }
  } catch {
    // no ledger yet
  }
  return undefined;
}

export interface AlertTarget {
  task: string;
  window: string;
}

export interface AlertOptions {
  /** This very agentctl as a command line (absolute node and script): the click action runs `attach` with it. */
  self?: SelfArgv | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Sends the notifications of the event command and of the watcher, so that one transition is announced once.
 * With terminal-notifier a click brings the terminal to the front and switches the tmux client to the task window.
 */
export class Alerts {
  private readonly ctx: Context;
  private readonly notifier: Notifier;
  private readonly self: SelfArgv | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(ctx: Context, notifier: Notifier, options: AlertOptions = {}) {
    this.ctx = ctx;
    this.notifier = notifier;
    this.self = options.self;
    this.env = options.env ?? process.env;
  }

  /** The other source already announced this state a moment ago. */
  isDuplicate(target: AlertTarget, state: string, source: AlertSource): boolean {
    const last = readLedger(this.ctx, target.window);
    if (!last || last.state !== state || last.source === source) return false;
    const within = Math.max(DEDUP_MIN_MS, this.ctx.config.watch.interval * 3000);
    return this.ctx.runner.now() - last.at < within;
  }

  /** Terminal to bring forward: the configured one, else the terminal this runs in, else the one the tmux server was started from. */
  private async terminalApp(): Promise<string | undefined> {
    return this.ctx.config.notify.terminalApp ?? terminalAppFor(this.env.TERM_PROGRAM) ?? terminalAppFor(await this.ctx.tmux.serverTermProgram());
  }

  /**
   * What a click does, and the text that goes with it. A client attached to the agentctl session is switched to the task window;
   * with none attached the click only brings the terminal forward and the text says how to attach.
   */
  async clickFor(target: AlertTarget, text: string): Promise<{ click: NotifyClick; text: string }> {
    if (!this.notifier.clickable) return { click: {}, text };
    const click: NotifyClick = { group: `agentctl-${target.task}` };
    const app = await this.terminalApp();
    if (app) click.activate = app;
    const attached = (await this.ctx.tmux.clients()).length > 0;
    if (!attached) return { click, text: `${text} · agentctl attach ${target.task}` };
    if (this.self) click.execute = shellLine(this.self[0] as string, [...this.self.slice(1), 'attach', target.task, '--switch-client']);
    return { click, text };
  }

  /** Announce `state` of the task with `text` unless the other source did it just now. */
  async send(target: AlertTarget, state: string, text: string, source: AlertSource): Promise<'sent' | 'duplicate'> {
    if (this.isDuplicate(target, state, source)) return 'duplicate';
    const { click, text: message } = await this.clickFor(target, text);
    await this.notifier.notify(ALERT_TITLE, message, click);
    const ledger: Ledger = { state, source, at: this.ctx.runner.now() };
    await this.ctx.runner.writeFile(ledgerPath(this.ctx, target.window), `${JSON.stringify(ledger)}\n`);
    return 'sent';
  }
}
