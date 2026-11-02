import type { AgentSettings } from './config.ts';
import type { ResolvedSpec } from './spec.ts';
import { shellLine } from './util.ts';

export const DEFAULT_MODEL = 'default';

/**
 * Command line (argv) that starts the agent for a spec.
 *
 * - claude: `claude --model <model> --effort <effort>`; Claude Code has a native --effort flag.
 * - codex:  `codex --sandbox danger-full-access [-m <model>] -c model_reasoning_effort=<effort>`.
 *
 * `--model`/`-m` is omitted when the model is "default". No auto-accept flag is ever added.
 * `extra` (event wiring: `--settings <file>` for Claude, `-c notify=[…]` for Codex) goes last.
 */
export function buildAgentArgv(spec: Pick<ResolvedSpec, 'agent' | 'model' | 'effort'>, settings: AgentSettings, extra: string[] = []): string[] {
  const hasModel = spec.model !== DEFAULT_MODEL;
  const effortArgs = settings.effortArgs.map((a) => a.replaceAll('{effort}', spec.effort));
  if (spec.agent === 'claude') {
    return ['claude', ...(hasModel ? ['--model', spec.model] : []), ...effortArgs, ...settings.flags, ...extra];
  }
  return ['codex', '--sandbox', 'danger-full-access', ...(hasModel ? ['-m', spec.model] : []), ...effortArgs, ...settings.flags, ...extra];
}

/**
 * The command line that takes a task's conversation up again, with the same model, effort, flags and event wiring as when it was started
 * (no prompt: the conversation has it).
 *
 * - claude: `… --resume <session id>` when a session of the task is known (hooks and the usage tap record it), else `… --continue`
 *   (the most recent conversation of the worktree).
 * - codex:  `codex resume <session id> …` or `codex resume --last …` (the most recent session of the worktree); the flags follow `resume`.
 */
export function buildResumeArgv(spec: Pick<ResolvedSpec, 'agent' | 'model' | 'effort'>, settings: AgentSettings, extra: string[] = [], sessionId?: string): string[] {
  const argv = buildAgentArgv(spec, settings, extra);
  if (spec.agent === 'claude') return [...argv, ...(sessionId ? ['--resume', sessionId] : ['--continue'])];
  const [cmd, ...rest] = argv as [string, ...string[]];
  return [cmd, 'resume', ...(sessionId ? [sessionId] : ['--last']), ...rest];
}

export function agentCommandLine(argv: string[]): string {
  const [cmd, ...args] = argv;
  return shellLine(cmd as string, args);
}

/** Every prompt agentctl delivers starts with this line, whatever flags the agent took. */
export function promptWithHeader(spec: Pick<ResolvedSpec, 'model' | 'effort' | 'prompt'>): string {
  return `Model: ${spec.model} · effort ${spec.effort}\n\n${spec.prompt}`;
}

export const INSTALL_HINTS: Record<string, string> = {
  tmux: 'Install tmux: "brew install tmux" (macOS) or "sudo apt install tmux" (Debian/Ubuntu).',
  git: 'Install git: https://git-scm.com/downloads',
  claude: 'Install Claude Code: https://docs.claude.com/en/docs/claude-code (npm i -g @anthropic-ai/claude-code).',
  codex: 'Install Codex CLI: npm i -g @openai/codex (https://github.com/openai/codex).',
};
