import type { Command } from 'commander';

/*
 * Examples per command, keyed by the command path ("new", "mcp install"). They are shown at the end of `agentctl <command> --help`
 * and in docs/commands.md (npm run docs), so the two cannot drift apart.
 */
export const COMMAND_EXAMPLES: Record<string, string[]> = {
  new: [
    'agentctl new --dry-run task-42.md        # print every command, run nothing',
    'agentctl new task-42.md                  # start the tasks of the file',
    'agentctl new --clip                    # spec from the clipboard, summary, y/N',
    'agentctl new --agent codex task-42.md    # run the specs on Codex (models through the equivalents table)',
    'agentctl new --no-agent task-42.md       # only worktree, setup and links',
    'agentctl new --cohort sprint-1 task-42.md   # the tasks of the file join the cohort',
  ],
  queue: [
    'agentctl queue task-42.md                # summary, y/N, then the tasks wait for a free window',
    'agentctl queue --clip -y               # spec from the clipboard, no question',
    'agentctl queue --agent codex task-42.md  # run them on Codex (through the equivalents table)',
    'agentctl queue --cohort sprint-1 task-42.md   # the tasks of the file join the cohort',
  ],
  'queue list': ['agentctl queue list', 'agentctl queue list --json', 'agentctl queue list --cohort sprint-1'],
  'queue rm': ['agentctl queue rm TASK-42'],
  'queue up': ['agentctl queue up TASK-42                # first in line (priority: high still goes first)'],
  'queue retry': ['agentctl queue retry TASK-42             # after a failed start: back at the end of the line'],
  'queue pause': ['agentctl queue pause                  # nothing new starts; running tasks are not touched'],
  'queue resume': ['agentctl queue resume'],
  resume: ['agentctl resume                           # the list, y/N, then the windows come back', 'agentctl resume TASK-42 TASK-43 -y', 'agentctl resume --all                     # also tasks that have a report', 'agentctl resume --dry-run'],
  up: ['agentctl up                               # watcher and board in the session, hint about resume, then the board', 'agentctl up --no-attach                   # only print the command to open the board'],
  gc: ['agentctl gc                               # dry run: what would go, with sizes', 'agentctl gc --apply                       # the list, y/N, then it does it', 'agentctl gc --branches --older-than 3d --apply -y', 'agentctl gc --cohort sprint-1 --json'],
  events: ['agentctl events                           # since the last call of the cli', 'agentctl events --since 2h --cohort sprint-1', 'agentctl events --clip                    # to paste at the start of a chat (does not move the marker)'],
  limits: ['agentctl limits                           # the same as limits show'],
  'limits show': ['agentctl limits show', 'agentctl limits show --json'],
  'limits set': ['agentctl limits set claude=3 codex=5     # summary, y/N, takes effect at once', 'agentctl limits set codex=off -y         # no limit for Codex, no question'],
  'limits reserve': ['agentctl limits reserve claude=1 --note "my own session"   # a place for an agent you start by hand'],
  'limits release': ['agentctl limits release claude=1', 'agentctl limits release claude        # all reserved places of Claude'],
  cohort: ['agentctl cohort                           # the same as cohort list'],
  'cohort list': ['agentctl cohort list', 'agentctl cohort list --json'],
  'cohort show': ['agentctl cohort show sprint-1'],
  'cohort add': ['agentctl cohort add sprint-1 TASK-41 TASK-42    # the cohort is made if it is new'],
  'cohort remove': ['agentctl cohort remove TASK-42'],
  'cohort note': ['agentctl cohort note sprint-1 "landing page and menu"'],
  unblock: ['agentctl unblock TASK-43                           # drop every cancelled task from its after', 'agentctl unblock TASK-43 --drop-after TASK-42        # drop only this one'],
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
  hide: ['agentctl hide TASK-41 TASK-42'],
  unhide: ['agentctl unhide TASK-42'],
  report: ['agentctl report TASK-42                  # where the report is; what the search finds', 'agentctl report TASK-42 --from docs/reports/task-42-final.md   # use that file (copied to the canonical path)'],
  pull: ['agentctl pull TASK-42                    # one report to the clipboard', 'agentctl pull --ready                    # all new reports in one text', 'agentctl pull --ready --all              # also the ones pulled before', 'agentctl pull --ready --cohort sprint-1  # only the reports of one cohort'],
  close: ['agentctl close TASK-41 TASK-42 --rm-worktree', 'agentctl close TASK-42 --dry-run', 'agentctl close --cohort sprint-1        # the open tasks of a cohort: list, y/N'],
  cancel: [
    'agentctl cancel TASK-42 --reason "wrong approach"   # interrupt, close the window; worktree and branch stay',
    'agentctl cancel TASK-41 TASK-42 --rm-worktree -y      # also remove the worktrees (branches stay)',
    'agentctl cancel TASK-43                             # a queued task: taken out of the queue',
    'agentctl cancel --cohort sprint-1 --reason "scrapped"   # the whole cohort: list, y/N',
  ],
  watch: ['agentctl watch --tmux                  # in window "watch" of the agentctl session', 'agentctl watch                         # in this terminal'],
  board: ['agentctl board --tmux                  # in window "board" of the agentctl session', 'agentctl board'],
  manager: ['agentctl manager                       # start the session you open from the Claude app on the phone', 'agentctl manager --project ~/src/sample-app --model sonnet --effort medium', 'agentctl manager --url                 # the address / QR code, if the window shows them'],
  'manager stop': ['agentctl manager stop                  # closes the window; the session goes offline in the app'],
  'notify-test': ['agentctl notify-test                      # the Mac', 'agentctl notify-test --phone              # the phone through ntfy: code and time', 'agentctl notify-test --all                # both'],
  adopt: ['agentctl adopt TASK-42 --report ~/reports/task-42/TASK-42.md --agent claude --worktree ~/worktrees/app-task-42'],
  interrupt: ['agentctl interrupt TASK-42'],
  attach: ['agentctl attach TASK-42', 'agentctl attach task-4                    # a unique prefix is enough'],
  usage: [
    'agentctl usage                         # plans, tokens today and in 7 days, active tasks, cohorts',
    'agentctl usage --since 30d             # the token columns over 30 days',
    'agentctl usage --cohort sprint-1       # only the tasks of one cohort',
    'agentctl usage --json',
    'agentctl usage --clip                  # Markdown table to the clipboard',
  ],
  mark: ['agentctl mark TASK-42 ok', 'agentctl mark TASK-42 partial --note "missed the edge case"', 'agentctl mark TASK-42 fail'],
  log: ['agentctl log                            # every task of the history, newest first', 'agentctl log --since 7d --cohort sprint-1', 'agentctl log --json', 'agentctl log --clip'],
  stats: ['agentctl stats                          # per agent/model/effort', 'agentctl stats --since 30d', 'agentctl stats --cohort sprint-1 --json', 'agentctl stats --clip'],
  away: ['agentctl away                              # the same as away status'],
  'away status': ['agentctl away status', 'agentctl away status --json'],
  'away on': ['agentctl away on                           # leaving the Mac: the phone gets the notifications'],
  'away off': ['agentctl away off                          # back: the phone is quiet'],
  'ntfy-setup': ['agentctl ntfy-setup                       # random topic into config.yaml + what to do on the phone', 'agentctl ntfy-setup --server https://ntfy.example.com   # your own server', 'agentctl ntfy-setup --show-qr             # also the subscription link as a QR code'],
  'usage-tap': ['echo \'{"session_id":"x","rate_limits":{}}\' | agentctl usage-tap --task TASK-42   # what the statusLine of a task window runs'],
  move: ['agentctl move TASK-42                    # to the other provider, asks y/N', 'agentctl move TASK-42 --agent codex -y'],
  peek: ['agentctl peek TASK-42', 'agentctl peek TASK-42 -n 80'],
  'mcp check': ['agentctl mcp check                      # after agentctl-update: does the Claude app still run the old server?'],
  'mcp install': ['agentctl mcp install --desktop --dry-run', 'agentctl mcp install --desktop', 'agentctl mcp install --claude-code', 'agentctl mcp install --desktop --config ./copy.json --dry-run'],
  'mcp uninstall': ['agentctl mcp uninstall                 # both', 'agentctl mcp uninstall --desktop'],
  doctor: ['agentctl doctor'],
  'spec example': ['agentctl spec example > task-42.md'],
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
