import { secretRedactor } from './secret-redaction.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { GlobalConfig } from './config.ts';
import type { Context } from './context.ts';
import { taskDir } from './taskstore.ts';
import { isObject, windowName } from './util.ts';

/*
 * What a task that is being started is doing right now: the checkout, the setup commands of each repository, the window. `new` writes it as it
 * goes (`<state_dir>/<window>/setup.json`), `status`, `queue_list` and the queue view read it, so that a chat that did not wait for the start
 * (the MCP `new` hands it to the watcher) sees "setup in progress (repo 1/2 …)" instead of nothing. It is removed when the start ends.
 */

export type StartPhase = 'worktree' | 'setup' | 'launching';

export interface SetupProgress {
  task: string;
  phase: StartPhase;
  /** ISO time the start began. */
  startedAt: string;
  /** ISO time the current repository / command began. */
  stepAt: string;
  /** `phase: setup`: the repository (its folder name), its place among the repositories that have setup, the command and its place. */
  repo?: string;
  repoIndex?: number;
  repoCount?: number;
  command?: string;
  commandIndex?: number;
  commandCount?: number;
  /** Where the output of the setup commands goes. */
  log?: string;
}

export const setupProgressFile = (config: Pick<GlobalConfig, 'stateDir'>, window: string): string => path.join(config.stateDir, window, 'setup.json');

export async function writeSetupProgress(ctx: Context, window: string, progress: SetupProgress): Promise<void> {
  if (ctx.runner.dryRun) return;
  try {
    await ctx.runner.mkdir(taskDir(ctx.config, window));
    await ctx.runner.writeFile(setupProgressFile(ctx.config, window), `${JSON.stringify(secretRedactor([ctx.config, process.env, progress])(progress))}\n`);
  } catch { /* progress is for the eyes; it never stops the start */ }
}

export function clearSetupProgress(config: Pick<GlobalConfig, 'stateDir'>, task: string): void {
  fs.rmSync(setupProgressFile(config, windowName(task)), { force: true });
}

export function readSetupProgress(config: Pick<GlobalConfig, 'stateDir'>, task: string, sources: unknown[] = []): SetupProgress | undefined {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(setupProgressFile(config, windowName(task)), 'utf8'));
    return isObject(data) && typeof data.phase === 'string' && typeof data.stepAt === 'string' ? (secretRedactor([config, process.env, ...sources, data])(data) as unknown as SetupProgress) : undefined;
  } catch {
    return undefined;
  }
}

const seconds = (since: string, nowMs: number): string => {
  const s = Math.max(0, Math.round((nowMs - Date.parse(since)) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
};
const short = (command: string): string => (command.length > 60 ? `${command.slice(0, 57)}...` : command);

/** "uruchamiane – setup w toku (repo 1/2 backend: npm ci, 12 s)": what the queue view and `status` say about a start in progress. */
export function startProgressText(progress: SetupProgress | undefined, nowMs: number): string {
  if (!progress) return 'uruchamiane – start w toku';
  if (progress.phase === 'worktree') return `uruchamiane – tworzenie worktree (${seconds(progress.startedAt, nowMs)})`;
  if (progress.phase === 'launching') return `uruchamiane – okno i agent (${seconds(progress.stepAt, nowMs)})`;
  const where = progress.repoCount && progress.repoCount > 0 ? `repo ${progress.repoIndex ?? 1}/${progress.repoCount}${progress.repo ? ` ${progress.repo}` : ''}` : (progress.repo ?? 'repo');
  const what = progress.command ? `${progress.commandCount && progress.commandCount > 1 ? `${progress.commandIndex ?? 1}/${progress.commandCount} ` : ''}${short(progress.command)}, ` : '';
  return `uruchamiane – setup w toku (${where}: ${what}${seconds(progress.stepAt, nowMs)}); log: ${progress.log ?? 'setup.log'}`;
}
