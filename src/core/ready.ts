import type { Runner } from './runner.ts';
import type { Tmux } from './tmux.ts';

export interface ReadyOptions {
  pattern: string;
  timeoutMs: number;
  intervalMs?: number;
}

export interface ReadyResult {
  ready: boolean;
  /** The last screen that was captured. */
  screen: string;
}

/**
 * Poll `tmux capture-pane` until the screen matches `pattern` (the agent's input prompt is
 * showing) or `timeoutMs` passes. Uses the runner's clock and sleep, so tests can feed scripted
 * screens and run without waiting. A dry run has nothing to poll and reports ready.
 */
export async function waitForReady(runner: Runner, tmux: Tmux, window: string, opts: ReadyOptions): Promise<ReadyResult> {
  if (runner.dryRun) {
    runner.note(`poll "tmux capture-pane -p -t ${tmux.target(window)}" every ${opts.intervalMs ?? 500}ms until /${opts.pattern}/ matches (timeout ${opts.timeoutMs / 1000}s)`);
    return { ready: true, screen: '' };
  }
  const regex = new RegExp(opts.pattern, 'm');
  const interval = opts.intervalMs ?? 500;
  const deadline = runner.now() + opts.timeoutMs;
  let screen = '';
  for (;;) {
    const r = await tmux.capture(window);
    if (r.code === 0) {
      screen = r.stdout;
      if (regex.test(screen)) return { ready: true, screen };
    }
    if (runner.now() >= deadline) return { ready: false, screen };
    await runner.sleep(interval);
  }
}
