import { PATTERN_FLAGS } from './config.ts';
import type { Runner } from './runner.ts';
import type { Tmux } from './tmux.ts';

export interface ReadyOptions {
  pattern: string;
  /** If the screen matches this (folder-trust dialog), stop waiting: the human has to answer it. */
  trustPattern?: string;
  timeoutMs: number;
  intervalMs?: number;
}

export interface ReadyResult {
  ready: boolean;
  /** The agent is showing its folder-trust dialog. agentctl never answers it. */
  trust: boolean;
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
    return { ready: true, trust: false, screen: '' };
  }
  const regex = new RegExp(opts.pattern, PATTERN_FLAGS);
  const trust = opts.trustPattern ? new RegExp(opts.trustPattern, PATTERN_FLAGS) : undefined;
  const interval = opts.intervalMs ?? 500;
  const deadline = runner.now() + opts.timeoutMs;
  let screen = '';
  for (;;) {
    const r = await tmux.capture(window);
    if (r.code === 0) {
      screen = r.stdout;
      if (trust?.test(screen)) return { ready: false, trust: true, screen };
      if (regex.test(screen)) return { ready: true, trust: false, screen };
    }
    if (runner.now() >= deadline) return { ready: false, trust: false, screen };
    await runner.sleep(interval);
  }
}
