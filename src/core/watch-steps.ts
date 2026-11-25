import fs from 'node:fs';
import path from 'node:path';
import type { Context } from './context.ts';
import type { BudgetClock } from './response-budget.ts';
import { errorMessage } from './util.ts';
import { watchHeartbeatPath } from './watch-snapshot.ts';
import { recordJournal } from './journal.ts';
import { appendStartLog, startLogPath } from './boardstart.ts';

export const WATCH_STEP_TIMEOUT_MS = 20_000;
export const WATCH_STALL_MS = 600_000;
export class WatchStalled extends Error {}
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
  private readonly skipped = new Map<string, number>();
  private readonly missedTicks = new Map<string, number>();

  check(ctx: Context, log: string): void {
    for (const [name, since] of this.running) {
      const ticks = (this.missedTicks.get(name) ?? 0) + 1;
      this.missedTicks.set(name, ticks);
      if (ticks === 4) {
        const text = `Watch: etap „${name}” nie zakończył się przez ponad 3 cykle (PID ${process.pid}).`;
        void recordJournal(ctx, { kind: 'watch-stalled', text }).catch(() => undefined);
      }
      if (ctx.runner.now() - since >= WATCH_STALL_MS) {
        const text = `Watch exiting: stage "${name}" stalled for 10 minutes (PID ${process.pid})`;
        ctx.out(text);
        if (!ctx.runner.dryRun) {
          appendStartLog(log, text);
          appendStartLog(startLogPath(ctx.config, 'watch'), text);
        }
        throw new WatchStalled(text);
      }
    }
  }

  async run<T>(ctx: Context, log: string, name: string, step: (signal: AbortSignal) => Promise<T>, timer = clock): Promise<T | undefined> {
    const at = ctx.runner.now();
    const heartbeat = (state: string, since: number, reason?: string): void => {
      if (state === 'skipped' && !this.skipped.has(name)) this.skipped.set(name, since);
      if (state === 'done') this.skipped.delete(name);
      if (!ctx.runner.dryRun) {
        try {
          fs.mkdirSync(ctx.config.stateDir, { recursive: true });
          // Diagnostic telemetry does not need a durable flush at every step boundary.
          fs.writeFileSync(watchHeartbeatPath(ctx.config), JSON.stringify({
            pid: process.pid, step: name, state, at: ctx.runner.now(), since, reason, running: Object.fromEntries(this.running),
            skipped: Object.fromEntries(this.skipped),
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
      const work = Promise.resolve().then(() => step(abort.signal)).finally(() => {
        this.running.delete(name);
        this.missedTicks.delete(name);
        // When a timed-out step finishes between ticks its earlier skip is no longer current.
        if (abort.signal.aborted) this.skipped.delete(name);
      });
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
