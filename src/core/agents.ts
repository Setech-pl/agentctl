import { provider, PROVIDER_IDS } from './providers/registry.ts';
import { OUTPUT_PROTOCOL } from './outputs.ts';
import type { AgentSettings } from './config.ts';
import type { ResolvedSpec } from './spec.ts';
import path from 'node:path';
import { resolvePath, shellLine } from './util.ts';

export const DEFAULT_MODEL = 'default';

/**
 * Command line (argv) that starts the agent for a spec.
 *
 * - claude: `claude --model <model> --effort <effort>`; Claude Code has a native --effort flag.
 * - codex:  `codex --sandbox danger-full-access [-m <model>] -c model_reasoning_effort=<effort>`.
 *
 * `--model`/`-m` is omitted when the model is "default". No auto-accept flag is ever added.
 * `remoteControl` (Claude): `--remote-control <TASK>` after the flags and before `extra`. The task ID is always given as the name, so the
 * optional value of the flag never takes the next flag. It is an interactive session, so `--settings` of the event hooks, `--model` and
 * `--effort` go with it (the server mode `claude remote-control` would refuse `--settings` before it).
 * `extra` (event wiring: `--settings <file>` for Claude, `-c notify=[…]` for Codex) goes last.
 */
export function buildAgentArgv(spec: Pick<ResolvedSpec, 'agent' | 'model' | 'effort'> & { remoteControl?: boolean | undefined; task?: string | undefined }, settings: AgentSettings, extra: string[] = []): string[] {
  return provider(spec.agent).argv({ ...spec, task: spec.task ?? '' }, settings, extra);
}

/**
 * The command line that takes a task's conversation up again, with the same model, effort, flags and event wiring as when it was started
 * (no prompt: the conversation has it).
 *
 * - claude: `… --resume <session id>` when a session of the task is known (hooks and the usage tap record it), else `… --continue`
 *   (the most recent conversation of the worktree).
 * - codex:  `codex resume <session id> …` or `codex resume --last …` (the most recent session of the worktree); the flags follow `resume`.
 */
export function buildResumeArgv(spec: Pick<ResolvedSpec, 'agent' | 'model' | 'effort'> & { remoteControl?: boolean | undefined; task?: string | undefined }, settings: AgentSettings, extra: string[] = [], sessionId?: string): string[] {
  return provider(spec.agent).resumeArgv({ ...spec, task: spec.task ?? '' }, settings, extra, sessionId);
}

export function agentCommandLine(argv: string[]): string {
  const [cmd, ...args] = argv;
  return shellLine(cmd as string, args);
}

/** Every prompt agentctl delivers starts with this line, whatever flags the agent took. */
export const reportInstructions = (attemptId = 'current', report?: string) => `Report protocol: write the report${report ? ` to the canonical absolute path ${resolvePath(report)} (filename: ${path.basename(report)})` : ''} for attempt ${attemptId}. Include <!-- agentctl:attempt ${attemptId} --> and append <!-- agentctl:report-end --> as the final line only after the entire report is written.\n${OUTPUT_PROTOCOL}`;

export function promptWithHeader(spec: Pick<ResolvedSpec, 'model' | 'effort' | 'prompt'> & { report?: string }, attemptId?: string): string {
  return `Model: ${spec.model} · effort ${spec.effort}\n\n${spec.prompt}\n\n${reportInstructions(attemptId, spec.report)}`;
}

export const INSTALL_HINTS: Record<string, string> = Object.defineProperties({
  tmux: 'Install tmux: "brew install tmux" (macOS) or "sudo apt install tmux" (Debian/Ubuntu).',
  git: 'Install git: https://git-scm.com/downloads',
}, Object.fromEntries(PROVIDER_IDS.map(id => [id, { enumerable: true, get: () => provider(id).installHint }])));
