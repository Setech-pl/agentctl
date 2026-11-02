import type { Command } from 'commander';

/*
 * Examples per command, keyed by the command path ("new", "mcp install"). They are shown at the end of `agentctl <command> --help`
 * and in docs/commands.md (npm run docs), so the two cannot drift apart.
 */
export const COMMAND_EXAMPLES: Record<string, string[]> = {
  new: [
    'agentctl new --dry-run nc-42.md        # print every command, run nothing',
    'agentctl new nc-42.md                  # start the tasks of the file',
    'agentctl new --clip                    # spec from the clipboard, summary, y/N',
    'agentctl new --agent codex nc-42.md    # run the specs on Codex (models through the equivalents table)',
    'agentctl new --no-agent nc-42.md       # only worktree, setup and links',
    'agentctl new --cohort sprint-1 nc-42.md   # the tasks of the file join the cohort',
  ],
  queue: [
    'agentctl queue nc-42.md                # summary, y/N, then the tasks wait for a free window',
    'agentctl queue --clip -y               # spec from the clipboard, no question',
    'agentctl queue --agent codex nc-42.md  # run them on Codex (through the equivalents table)',
    'agentctl queue --cohort sprint-1 nc-42.md   # the tasks of the file join the cohort',
  ],
  'queue list': ['agentctl queue list', 'agentctl queue list --json', 'agentctl queue list --cohort sprint-1'],
  'queue rm': ['agentctl queue rm NC-42'],
  'queue up': ['agentctl queue up NC-42                # first in line (priority: high still goes first)'],
  'queue retry': ['agentctl queue retry NC-42             # after a failed start: back at the end of the line'],
  'queue pause': ['agentctl queue pause                  # nothing new starts; running tasks are not touched'],
  'queue resume': ['agentctl queue resume'],
  limits: ['agentctl limits                           # the same as limits show'],
  'limits show': ['agentctl limits show', 'agentctl limits show --json'],
  'limits set': ['agentctl limits set claude=3 codex=5     # summary, y/N, takes effect at once', 'agentctl limits set codex=off -y         # no limit for Codex, no question'],
  'limits reserve': ['agentctl limits reserve claude=1 --note "my own session"   # a place for an agent you start by hand'],
  'limits release': ['agentctl limits release claude=1', 'agentctl limits release claude        # all reserved places of Claude'],
  cohort: ['agentctl cohort                           # the same as cohort list'],
  'cohort list': ['agentctl cohort list', 'agentctl cohort list --json'],
  'cohort show': ['agentctl cohort show sprint-1'],
  'cohort add': ['agentctl cohort add sprint-1 NC-41 NC-42    # the cohort is made if it is new'],
  'cohort remove': ['agentctl cohort remove NC-42'],
  'cohort note': ['agentctl cohort note sprint-1 "landing page and menu"'],
  unblock: ['agentctl unblock NC-43                           # drop every cancelled task from its after', 'agentctl unblock NC-43 --drop-after NC-42        # drop only this one'],
  overlap: ['agentctl overlap                        # every pair of active tasks that changed the same files', 'agentctl overlap LANDING-QS-1           # only the pairs with this task'],
  send: [
    'agentctl send follow-up.md             # header: only "task:"; the prompt below it is pasted',
    'agentctl send --clip -y                # follow-up from the clipboard, no question',
  ],
  status: [
    'agentctl status',
    'agentctl status --json                 # rows with started (UTC) and startedLocal',
    'agentctl status --clip                 # Markdown table to paste into a chat',
    'agentctl status --all                  # hidden, closed, cancelled and archived tasks too',
    'agentctl status --cohort sprint-1      # only the tasks of one cohort (also with --json, --clip)',
  ],
  archive: ['agentctl archive --older-than 7d --dry-run'],
  hide: ['agentctl hide NC-41 NC-42'],
  unhide: ['agentctl unhide NC-42'],
  pull: ['agentctl pull NC-42                    # one report to the clipboard', 'agentctl pull --ready                    # all new reports in one text', 'agentctl pull --ready --all              # also the ones pulled before', 'agentctl pull --ready --cohort sprint-1  # only the reports of one cohort'],
  close: ['agentctl close NC-41 NC-42 --rm-worktree', 'agentctl close NC-42 --dry-run', 'agentctl close --cohort sprint-1        # the open tasks of a cohort: list, y/N'],
  cancel: [
    'agentctl cancel NC-42 --reason "wrong approach"   # interrupt, close the window; worktree and branch stay',
    'agentctl cancel NC-41 NC-42 --rm-worktree -y      # also remove the worktrees (branches stay)',
    'agentctl cancel NC-43                             # a queued task: taken out of the queue',
    'agentctl cancel --cohort sprint-1 --reason "scrapped"   # the whole cohort: list, y/N',
  ],
  watch: ['agentctl watch --tmux                  # in window "watch" of the agentctl session', 'agentctl watch                         # in this terminal'],
  board: ['agentctl board --tmux                  # in window "board" of the agentctl session', 'agentctl board'],
  'notify-test': ['agentctl notify-test'],
  adopt: ['agentctl adopt NC-42 --report ~/Projects/cache/nc-42/NC-42.md --agent claude --worktree ~/Projects/wt/app-nc-42'],
  interrupt: ['agentctl interrupt NC-42'],
  attach: ['agentctl attach NC-42', 'agentctl attach nc-4                    # a unique prefix is enough'],
  usage: [
    'agentctl usage                         # plans, tokens today and in 7 days, active tasks, cohorts',
    'agentctl usage --since 30d             # the token columns over 30 days',
    'agentctl usage --cohort sprint-1       # only the tasks of one cohort',
    'agentctl usage --json',
    'agentctl usage --clip                  # Markdown table to the clipboard',
  ],
  mark: ['agentctl mark NC-42 ok', 'agentctl mark NC-42 partial --note "missed the edge case"', 'agentctl mark NC-42 fail'],
  log: ['agentctl log                            # every task of the history, newest first', 'agentctl log --since 7d --cohort sprint-1', 'agentctl log --json', 'agentctl log --clip'],
  stats: ['agentctl stats                          # per agent/model/effort', 'agentctl stats --since 30d', 'agentctl stats --cohort sprint-1 --json', 'agentctl stats --clip'],
  'usage-tap': ['echo \'{"session_id":"x","rate_limits":{}}\' | agentctl usage-tap --task NC-42   # what the statusLine of a task window runs'],
  move: ['agentctl move NC-42                    # to the other provider, asks y/N', 'agentctl move NC-42 --agent codex -y'],
  peek: ['agentctl peek NC-42', 'agentctl peek NC-42 -n 80'],
  'mcp check': ['agentctl mcp check                      # after agentctl-update: does the Claude app still run the old server?'],
  'mcp install': ['agentctl mcp install --desktop --dry-run', 'agentctl mcp install --desktop', 'agentctl mcp install --claude-code', 'agentctl mcp install --desktop --config ./copy.json --dry-run'],
  'mcp uninstall': ['agentctl mcp uninstall                 # both', 'agentctl mcp uninstall --desktop'],
  doctor: ['agentctl doctor'],
  'spec example': ['agentctl spec example > nc-42.md'],
};

/** The path of a command as typed after `agentctl` ("mcp install"). */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Append the examples to the help of every command that has some. */
export function applyExamples(program: Command): void {
  const walk = (cmd: Command): void => {
    const examples = COMMAND_EXAMPLES[commandPath(cmd)];
    if (examples && examples.length > 0) cmd.addHelpText('after', `\nExamples:\n${examples.map((e) => `  ${e}`).join('\n')}\n`);
    cmd.commands.forEach(walk);
  };
  walk(program);
}
