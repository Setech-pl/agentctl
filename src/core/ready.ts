import os from 'node:os';
import { inspectField, plainScreen } from './input-field.ts';
import type { DeliveryAgent } from './paste-wrapper.ts';
import { screenMetadata } from './tmux.ts';
import { PATTERN_FLAGS } from './config.ts';
import { startupDialogShown } from './state.ts';
import type { Runner } from './runner.ts';
import type { Tmux } from './tmux.ts';
import { shellLine } from './util.ts';

/** A fresh Kimi session is created by the first message. The welcome text can outlive startup. */
export function kimiWelcomeShown(screen: string): boolean {
  return /^\s*No session yet(?:\s|$)/m.test(screen) || /^.*Welcome to Kimi Code!/m.test(screen);
}

/** Compare the whole composer and the content above it, excluding Kimi's rotating footer. */
export function kimiSettledView(screen: string): string | undefined {
  const field = inspectField(screen, 'kimi');
  if (!field.readable || field.bottom === undefined) return undefined;
  return screen.split('\n').slice(0, field.bottom + 1).map(line => line.trimEnd()).join('\n');
}

/** Upper bound of the load-scaled ready timeout (seconds); a larger configured value is kept as it is. */
export const READY_TIMEOUT_CAP_S = 180;

/**
 * The machine load the ready timeout scales with. `AGENTCTL_READY_LOAD` ("<load1>,<cores>") replaces the live sample;
 * the test isolation sets it, so fixtures do not depend on the load of the host that runs them.
 */
export function readyLoadSample(): { load1: number; cores: number } {
  const forced = /^\s*([\d.]+)\s*,\s*(\d+)\s*$/.exec(process.env.AGENTCTL_READY_LOAD ?? '');
  if (forced) return { load1: Number(forced[1]), cores: Math.max(1, Number(forced[2])) };
  return { load1: os.loadavg()[0] ?? 0, cores: Math.max(1, os.cpus().length) };
}

/**
 * Seconds to wait for the agent's input prompt: the configured base (default 60), scaled by load1/cores (factor 1..3)
 * and capped at 180 s. A loaded machine starts an agent's TUI slower; an idle one keeps the base.
 */
export function scaledReadyTimeout(baseS: number, sample = readyLoadSample()): number {
  const factor = Math.min(3, Math.max(1, sample.load1 / Math.max(1, sample.cores)));
  return Math.round(Math.max(baseS, Math.min(READY_TIMEOUT_CAP_S, baseS * factor)));
}

export interface TrustWait {
  /** How long to wait for a human to answer the dialog. */
  timeoutMs: number;
  /** Called once, when the dialog first shows up. */
  onWaiting: () => void | Promise<void>;
}

export interface ReadyOptions {
  pattern: string;
  emptyInput?: boolean;
  structuralComposer?: boolean;
  /** Whose composer `structuralComposer` reads: Kimi draws its own box, and its empty box (not the generic draft reading) is the empty input. */
  agent?: DeliveryAgent;
  /** If the screen matches this (folder-trust dialog), the human has to answer it: stop waiting, or wait for them (`waitTrust`). */
  trustPattern?: string;
  /** If the screen matches this (another startup dialog, e.g. Codex "Update available"), stop waiting at once: a human has to answer it. */
  dialogPattern?: string;
  timeoutMs: number;
  intervalMs?: number;
  trackExit?: boolean;
  /** Keep polling while the trust dialog is up instead of returning; the dialog is never answered. */
  waitTrust?: TrustWait;
  /** Aborting (Ctrl-C) ends the wait; the result has `aborted: true`. */
  signal?: AbortSignal;
}

export interface ReadyResult {
  ready: boolean;
  /** The agent is showing its folder-trust dialog (still, when the wait ended). agentctl never answers it. */
  trust: boolean;
  /** The agent is showing another startup dialog (e.g. "Update available"). agentctl never answers it. */
  dialog?: boolean;
  /** The wait was aborted through `signal`. */
  aborted?: boolean;
  exitCode?: number | null;
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
    runner.note(`poll "${shellLine('tmux', ['capture-pane', '-p', '-t', tmux.target(window)])}" every ${opts.intervalMs ?? 500}ms until /${opts.pattern}/ matches (timeout ${opts.timeoutMs / 1000}s)`);
    if (opts.waitTrust) runner.note(`if the agent shows its folder-trust dialog, keep polling (up to ${opts.waitTrust.timeoutMs / 1000}s) until it is answered by a human`);
    return { ready: true, trust: false, screen: '' };
  }
  const regex = new RegExp(opts.pattern, PATTERN_FLAGS);
  const trust = opts.trustPattern ? new RegExp(opts.trustPattern, PATTERN_FLAGS) : undefined;
  const interval = opts.intervalMs ?? 500;
  let deadline = runner.now() + opts.timeoutMs;
  let inTrust = false;
  let screen = '';
  let welcome = false;
  let previousKimiView: string | undefined;
  // 0.26.3: the deadline is followed by one more capture before the wait gives up (a prompt drawn in the last interval is not lost).
  let finalLook = false;
  for (;;) {
    if (opts.signal?.aborted) return { ready: false, trust: inTrust, aborted: true, screen };
    const infos = opts.trackExit ? await tmux.windows() : undefined;
    const pane = infos && tmux.resolve(window, infos);
    if (infos && !pane) return { ready: false, trust: false, exitCode: null, screen };
    const r = await tmux.capture(window, undefined, infos);
    if (pane && pane.exitCode !== undefined) return { ready: false, trust: false, exitCode: pane.exitCode, screen: r.code === 0 ? r.stdout : screen };
    const previous = previousKimiView;
    previousKimiView = undefined;
    if (r.code === 0) {
      screen = plainScreen(r.stdout);
      if (trust?.test(screen)) {
        if (!opts.waitTrust) return { ready: false, trust: true, screen };
        if (!inTrust) {
          inTrust = true;
          deadline = runner.now() + opts.waitTrust.timeoutMs;
          await opts.waitTrust.onWaiting();
        }
      } else {
        if (inTrust) {
          inTrust = false;
          finalLook = false;
          deadline = runner.now() + opts.timeoutMs;
        }
        if (startupDialogShown(screen, { dialogPattern: opts.dialogPattern, readyPattern: opts.pattern })) return { ready: false, trust: false, dialog: true, screen };
        const composer = opts.structuralComposer ? inspectField(screen, opts.agent) : undefined;
        const draft = opts.agent === 'kimi' && composer ? composer.area.length > 0 : Boolean(screenMetadata(screen).draft_input);
        if (opts.agent === 'kimi') welcome ||= kimiWelcomeShown(screen);
        if ((!composer || composer.readable) && regex.test(screen) && (!opts.emptyInput || !draft)) {
          if (!welcome) return { ready: true, trust: false, screen };
          previousKimiView = kimiSettledView(screen);
          if (previousKimiView !== undefined && previousKimiView === previous) return { ready: true, trust: false, screen };
        }
      }
    }
    if (runner.now() >= deadline) {
      if (finalLook || inTrust) return { ready: false, trust: inTrust, screen };
      finalLook = true;
    }
    await runner.sleep(interval);
  }
}
