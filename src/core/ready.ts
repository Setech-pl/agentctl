import { PATTERN_FLAGS } from './config.ts';
import type { Runner } from './runner.ts';
import type { Tmux } from './tmux.ts';

export interface TrustWait {
  /** How long to wait for a human to answer the dialog. */
  timeoutMs: number;
  /** Called once, when the dialog first shows up. */
  onWaiting: () => void;
}

export interface ReadyOptions {
  pattern: string;
  /** If the screen matches this (folder-trust dialog), the human has to answer it: stop waiting, or wait for them (`waitTrust`). */
  trustPattern?: string;
  timeoutMs: number;
  intervalMs?: number;
  /** Keep polling while the trust dialog is up instead of returning; the dialog is never answered. */
  waitTrust?: TrustWait;
  /** Aborting (Ctrl-C) ends the wait; the result has `aborted: true`. */
  signal?: AbortSignal;
}

export interface ReadyResult {
  ready: boolean;
  /** The agent is showing its folder-trust dialog (still, when the wait ended). agentctl never answers it. */
  trust: boolean;
  /** The wait was aborted through `signal`. */
  aborted?: boolean;
  /** The last screen that was captured. */
  screen: string;
}

/**
 * Poll `tmux capture-pane` until the screen matches `pattern` (the agent's input prompt is
 * showing) or `timeoutMs` passes. Uses the runner's clock and sleep, so tests can feed scripted
 * screens and run without waiting. A dry run has nothing to poll and reports ready.
 *
 * A folder-trust dialog ends the wait at once, unless `waitTrust` is set: then the wait goes on for
 * `waitTrust.timeoutMs` while the dialog is up, and once it is gone the agent gets `timeoutMs` again
 * to show its input prompt.
 */
export async function waitForReady(runner: Runner, tmux: Tmux, window: string, opts: ReadyOptions): Promise<ReadyResult> {
  if (runner.dryRun) {
    runner.note(`poll "tmux capture-pane -p -t ${tmux.target(window)}" every ${opts.intervalMs ?? 500}ms until /${opts.pattern}/ matches (timeout ${opts.timeoutMs / 1000}s)`);
    if (opts.waitTrust) runner.note(`if the agent shows its folder-trust dialog, keep polling (up to ${opts.waitTrust.timeoutMs / 1000}s) until it is answered by a human`);
    return { ready: true, trust: false, screen: '' };
  }
  const regex = new RegExp(opts.pattern, PATTERN_FLAGS);
  const trust = opts.trustPattern ? new RegExp(opts.trustPattern, PATTERN_FLAGS) : undefined;
  const interval = opts.intervalMs ?? 500;
  let deadline = runner.now() + opts.timeoutMs;
  let inTrust = false;
  let screen = '';
  for (;;) {
    if (opts.signal?.aborted) return { ready: false, trust: inTrust, aborted: true, screen };
    const r = await tmux.capture(window);
    if (r.code === 0) {
      screen = r.stdout;
      if (trust?.test(screen)) {
        if (!opts.waitTrust) return { ready: false, trust: true, screen };
        if (!inTrust) {
          inTrust = true;
          deadline = runner.now() + opts.waitTrust.timeoutMs;
          opts.waitTrust.onWaiting();
        }
      } else {
        if (inTrust) {
          inTrust = false;
          deadline = runner.now() + opts.timeoutMs;
        }
        if (regex.test(screen)) return { ready: true, trust: false, screen };
      }
    }
    if (runner.now() >= deadline) return { ready: false, trust: inTrust, screen };
    await runner.sleep(interval);
  }
}
