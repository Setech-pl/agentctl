import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { BudgetClock } from './response-budget.ts';
import { errorMessage } from './util.ts';

export const WATCH_STEP_TIMEOUT_MS = 20_000;
const clock: BudgetClock = {
  now: Date.now,
  schedule(expire, delay) {
    const timer = setTimeout(expire, delay);
    return () => clearTimeout(timer);
  },
};

/** Skip late steps without starting another copy, or allowing a late snapshot to overwrite a newer one. */
export class WatchSteps {
  private readonly running = new Map<string, number>();

  async run<T>(ctx: Context, log: string, name: string, step: (signal: AbortSignal) => Promise<T>, timer = clock): Promise<T | undefined> {
    const at = ctx.runner.now();
    const heartbeat = (state: string, since: number, reason?: string): void => {
      if (!ctx.runner.dryRun) {
        try {
          fs.mkdirSync(ctx.config.stateDir, { recursive: true });
          // Diagnostic telemetry does not need a durable flush at every step boundary.
          fs.writeFileSync(path.join(ctx.config.stateDir, 'watch-heartbeat.json'), JSON.stringify({
            pid: process.pid, step: name, state, at: ctx.runner.now(), since, reason, running: Object.fromEntries(this.running),
          }), { mode: 0o600 });
        } catch (error) { ctx.out(`watch heartbeat: ${errorMessage(error)}`); }
      }
      if (reason) {
        const line = `${new Date(ctx.runner.now()).toISOString()}  watch ${name}: ${reason}`;
        ctx.out(line);
        if (!ctx.runner.dryRun) {
          try { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, line + '\n'); }
          catch (error) { ctx.out(`watch log: ${errorMessage(error)}`); }
        }
      }
    };
    const previous = this.running.get(name);
    if (previous !== undefined) {
      // The original timeout already logged the reason. Avoid repeating it on every tick.
      heartbeat('skipped', previous);
      return undefined;
    }
    this.running.set(name, at);
    heartbeat('running', at);
    const abort = new AbortController();
    const deadline = timer.now() + WATCH_STEP_TIMEOUT_MS;
    let cancel = () => {};
    const expired = new Promise<undefined>(resolve => {
      cancel = timer.schedule(() => {
        abort.abort();
        resolve(undefined);
      }, WATCH_STEP_TIMEOUT_MS);
    });
    try {
      const work = Promise.resolve().then(() => step(abort.signal)).finally(() => this.running.delete(name));
      const result = await Promise.race([work, expired]);
      if (abort.signal.aborted || timer.now() >= deadline) {
        heartbeat('skipped', at, `timed out after ${WATCH_STEP_TIMEOUT_MS} ms`);
        return undefined;
      }
      heartbeat('done', at);
      return result;
    } catch (error) {
      heartbeat('skipped', at, errorMessage(error));
      return undefined;
    } finally { cancel(); }
  }
}
