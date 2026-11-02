# Configuration reference

agentctl reads three layers. The later one wins:

1. **Global config**: `~/.agentctl/config.yaml` (the directory is `$AGENTCTL_HOME` when that is set). Without the file everything has its default.
2. **Project config**: `.agentctl.yaml` in the first repository of a spec.
3. **Spec**: the YAML header of the spec file (see [Spec keys](#spec-keys)).

**Changes take effect without a restart.** A running `agentctl watch` and the MCP server read the global config again when the file changes (every key: `limits`, `mcp.allow`, `usage.*`, `notify.*`, `watch.*`, …). A file that does not load is not applied: the previous settings stay in force, the watch log warns once, and `agentctl doctor` and the MCP `status` say so ([details](details.md#live-limits-and-the-config-reload)). `agentctl limits set` edits the `limits` keys for you and keeps comments and the order of the keys.

Unknown keys are errors everywhere, so a typo is reported instead of ignored. All problems of a file are listed at once.

Merging: `env` merges key by key; `links` merge, and for the same `from` the later layer wins; `setup` is taken whole from the first layer that sets it (`setup: []` switches it off); `report`, `worktree_root` and `defaults` are overridden by a later layer. Paths accept `~`.
Placeholders `{task}` (lowercase ID), `{TASK}` (uppercase ID) and `{cache}` work in `worktree`, `worktree_root`, `links`, `env` values, `setup` commands and `report`; other braces (globs) are left alone.

Column "Layers": **g** global config, **p** project config, **s** spec.

## Keys of every layer

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `worktree_root` | path | none | g p | Directory for new worktrees: `<worktree_root>/<repo-name>-<task>`. Without it every `repos[]` entry needs its own `worktree`. |
| `links` | list | `[]` | g p s | Symlinks created in the first worktree. |
| `links[].from` | path | required | g p s | Where the link goes, relative to the first worktree. A glob links every match. |
| `links[].to` | path | required | g p s | What it points at. Must exist. `from` and `to` ending in `/*` make one link per entry of the directory. |
| `env` | mapping | `{}` | g p s | Environment variables of the tmux window (strings, numbers or booleans). |
| `report` | path | `{cache}/{task}/{TASK}.md` | g p s | Where the agent writes its report. Used by `status`, `pull` and the notifications. |
| `setup` | list of strings | `[]` | g p s | Shell commands run in the first worktree after `git worktree add` and before the links. A failing command stops `new`. |
| `defaults` | mapping | `{}` | g p | Values for a spec that leaves them out: `agent`, `model`, `effort`. |
| `defaults.agent` | `claude` or `codex` | none | g p | Agent when the spec has no `agent`. |
| `defaults.model` | string | `default` | g p | Model when the spec has none. `default` passes no model flag. |
| `defaults.effort` | `low` `medium` `high` `xhigh` `max` | `high` | g p | Effort when the spec has none. |

## Keys of the global config only

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `cache` | path | `~/Projects/cache` | g | Directory with one folder per task, `<cache>/<task>/`: the only place the agents write to (reports). |
| `state_dir` | path | `<config dir>/tasks` | g | agentctl's own state per task (`TASK.md`, `setup.log`, `event.json`, `notified.json`), out of the agents' reach. Closed tasks are archived next to it, in `archive/`. |
| `session` | string | `agentctl` | g | Name of the tmux session. Letters, digits, `_` and `-`. |
| `limits` | mapping | none | g | Most simultaneous windows per provider. |
| `limits.claude` | positive integer | unlimited | g | Cap for Claude windows (agentctl windows + reserved places + external sessions when counted). `agentctl limits set claude=3` changes it. |
| `limits.codex` | positive integer | unlimited | g | Cap for Codex windows. |
| `limits.count_external` | boolean | `false` | g | Terminal sessions of `claude` / `codex` outside the windows of agentctl (found with `ps`, not MCP servers, headless runs or agentctl itself) count against the limit and show as "external" in `agentctl limits`. Places for agents you start by hand can also be held with `agentctl limits reserve`. |
| `agents` | mapping | see below | g | Settings per agent: `agents.claude`, `agents.codex`. |
| `equivalents` | list | `[]` | g | Extra Claude and Codex pairs, `{claude: "opus/medium", codex: "gpt-6-astra/low"}`, consulted before the built-in table. Both sides are `model/effort`. |
| `mirror_dir` | path | none (off) | g | `status` and `pull` copy reports and `status.json` there. |
| `watch` | mapping | see below | g | `agentctl watch` and the window icons. |
| `notify` | mapping | see below | g | Notifications and the events of the agents. |
| `board` | mapping | see below | g | The board and the navigation in the tmux session. |
| `mcp` | mapping | see below | g | The local MCP server. |
| `queue` | mapping | see below | g | The task queue (`agentctl queue`). |
| `collisions` | mapping | see below | g | Warnings about two active tasks changing the same files. |
| `cancel` | mapping | see below | g | `agentctl cancel`: how a task at work is stopped. |
| `usage` | mapping | see below | g | Token usage and plan limits: thresholds, queue hold, tmux status line, where the agents keep their logs. |

### `watch`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `watch.interval` | seconds | `15` | g | Time between two polls of the watcher. |
| `watch.waiting_after` | seconds | `120` | g | How long an idle task may wait before it is worth a notification. |
| `watch.window_icons` | `true`, `false` or mapping | `true` | g | State icon in front of tmux window names. A mapping replaces single icons by state name (`{working: "▶", needs-input: "❓"}`); `false` leaves the names alone. |
| `watch.status_line` | boolean | `true` | g | `watch --tmux` shows the task counts in the status bar of the agentctl session. |

Default icons: `working` ⚙, `background` ⏳, `waiting` ⏸, `needs-input` ?, `needs-trust` 🔒, `limited` ⛔, `report-ready` ✓, `superseded` ↪, `orphan` and `dead` ✗, `closed` ⊘.

### `notify`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `notify.backend` | `auto`, `terminal-notifier`, `osascript` | `auto` | g | Channel of desktop notifications. `auto` tries terminal-notifier (a click goes to the window) and falls back to osascript when it fails. |
| `notify.events` | boolean | `true` | g | The agents report questions, end of turn and limits to `agentctl event` (Claude hooks, Codex `notify`). `false`: screen reading only. |
| `notify.turn_end` | boolean | `true` | g | A notification when a turn ends and the agent waits. `false`: only questions, reports and limits. |
| `notify.terminal_app` | bundle ID | detected | g | The terminal app a click on a notification brings to the front, for example `com.apple.Terminal`. |
| `notify.verdict_pattern` | regex | none | g | Picks the report line quoted in the "report ready" notification; its first group, else the whole line. Without it a line starting with `Werdykt`, `Verdict` or `Status`, else the first line of text. |

### `board`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `board.auto_hide_pulled_dead` | boolean | `true` | g | A task without a window whose report was pulled hides by itself. |
| `board.mouse` | boolean | `true` | g | `mouse on` in the agentctl tmux session (this session only). |
| `board.return_key` | tmux key name or `false` | `F12` | g | Key (no prefix) that goes back to the board from any window of the session. `false`: none. |

### `mcp`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `mcp.allow` | list | `[]` | g | Write tools the chat may call: any of `send`, `new`, `interrupt`, `close`, `move`, `queue`, `queue_rm`, `cancel`, `mark`, `set_limits`, `reserve`, `resume`. Read again on every call. |
| `mcp.allow_rm_worktree` | boolean | `false` | g | `close` and `cancel` from the chat may also remove the git worktree (never forced). |

### `queue`

Queued tasks live in `<config dir>/queue/` (one JSON file each, with the spec text) and are started by `agentctl watch`. See [the queue](details.md#the-queue).

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `queue.enabled` | boolean | `true` | g | `false`: `watch` never starts a queued task (entries can still be added and listed). |
| `queue.parallel_starts` | positive integer | `2` | g | Most queued tasks that `watch` is in the middle of starting (worktree, setup, waiting for the agent or for the folder-trust dialog) at the same time. |

### `cancel`

`agentctl cancel` stops a task that works: the agent's interrupt key, a short wait, then the window is closed. See [cancelling tasks](details.md#cancelling-tasks).

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `cancel.grace` | seconds (0 or more) | `5` | g | Time between the interrupt key and the closing of the window of a task that is cancelled while it works. `0`: the window is closed at once. |

### `collisions`

`agentctl watch` checks every `collisions.interval` seconds which files each active task changed (commits over its base plus uncommitted files) and compares the tasks of one source repository. See [collisions](details.md#collisions).

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `collisions.enabled` | boolean | `true` | g | `false`: no `COLLIDE` column, no marker on the board, no notification. `agentctl overlap` still works. |
| `collisions.interval` | positive number | `300` | g | Seconds between two checks by `watch`. |
| `collisions.notify` | boolean | `true` | g | One notification for each new pair of colliding tasks. |
| `collisions.ignore` | list of globs | `[]` | g | Paths that never count as shared, e.g. `["**/package-lock.json", "dist/**"]`. |

### `usage`

`agentctl usage`, the board and the tmux status line show the tokens of the tasks and the state of the plans of Claude and Codex ([how it works](details.md#usage-and-limits)). A percentage here is `80` (both providers) or `{claude: 80, codex: 70}` (per provider).

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `usage.warn` | percentage or mapping | `80` | g | From this percentage of a plan window `watch` sends one notification per window and reset. |
| `usage.critical` | percentage or mapping | `95` | g | The same, louder; not below `warn`. |
| `usage.queue_hold` | percentage, mapping or `false` | `false` | g | The queue does not start a task of a provider whose plan is above this percentage (in any window); `queue list` says so. `false`: the plan never holds the queue. |
| `usage.status_line` | boolean | `true` | g | The plan percentages (`C 62% · X 18%`) in the tmux status line of the agentctl session. |
| `usage.claude_tap` | boolean | `true` | g | `new` sets the `statusLine` of a Claude window to `agentctl usage-tap`, which records the plan limits that Claude gives only to a statusLine and passes your own statusLine on. `false`: Claude's limits are n/d. |
| `usage.claude_dir` | path | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | g | Where Claude Code keeps `projects/` (the transcripts). |
| `usage.codex_dir` | path | `$CODEX_HOME`, else `~/.codex` | g | Where Codex keeps `sessions/`. |

## Keys per agent

`agents.claude.*` and `agents.codex.*` take the same keys. Patterns are regular expressions, case-insensitive, matched per line of the tmux screen. Flags and `effort_args` that switch on an auto-accept mode (`--dangerously-skip-permissions`, `--yolo`, `--full-auto`, `--permission-mode bypassPermissions`, `-a never` and similar) make the config invalid.

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `agents.<agent>.flags` | list of strings | `[]` | g | Extra flags appended to the agent command line. |
| `agents.<agent>.effort_args` | list of strings | claude `['--effort', '{effort}']`, codex `['-c', 'model_reasoning_effort={effort}']` | g | Flags that carry the effort; `{effort}` is replaced. `[]` passes nothing. |
| `agents.<agent>.ready_pattern` | regex | see below | g | The agent shows its input box. |
| `agents.<agent>.ready_timeout` | seconds | `60` | g | How long `new` waits for `ready_pattern`. |
| `agents.<agent>.trust_pattern` | regex | see below | g | The agent shows its folder-trust dialog. agentctl never answers it. |
| `agents.<agent>.trust_timeout` | seconds | `600` | g | How long `new` waits for you to answer the trust dialog. |
| `agents.<agent>.working_pattern` | regex | `esc to interrupt` | g | A turn is running. |
| `agents.<agent>.interrupt_key` | tmux key name | `Escape` | g | Key sent by `agentctl interrupt`. |
| `agents.<agent>.footer_patterns` | list of regexes | see below | g | Lines of TUI chrome that `status` and `peek` skip. |
| `agents.<agent>.question_pattern` | regex | see below | g | The agent asks you something and waits (state `needs-input`). |
| `agents.<agent>.limit_patterns` | list of regexes | see below | g | The usage limit is used up (state `limited`). A message has to open its line, so a diff or a quoted sentence is not taken for one. |
| `agents.<agent>.background_patterns` | list of regexes | see below | g | The agent waits for its own shells or monitors (state `background`). |

The built-in values, as the code has them (a test compares this block with `src/core/config.ts`). The Codex limit and background patterns come from strings in the binary, not from a real screen; see [Limitations](../README.md#limitations).

```yaml
claude:
  effort_args: ['--effort', '{effort}']
  ready_pattern: '^\s*❯\s(?!\d+\.)'
  trust_pattern: 'Quick safety check|Yes, I trust this folder'
  working_pattern: 'esc to interrupt'
  question_pattern: 'Enter to select\b.*Esc to cancel|Esc to cancel · Tab to amend'
  footer_patterns:
    - '\? for shortcuts'
    - '^\s*(⏵⏵|⏸)'
    - 'shift\+tab to cycle'
    - '^\s*[❯>]\s*(Try ".*")?$'
  limit_patterns:
    - '^[\s⎿●•■⚠!*>-]*You.ve hit your .{0,60}limit'
    - '^[\s⎿●•■⚠!*>-]*Usage limit reached'
    - '^[\s⎿●•■⚠!*>-]*You.re out of extra usage'
    - '^[\s⎿●•■⚠!*>-]*(?:API Error: )?Request rejected \(429\)'
  background_patterns:
    - '[·⏵].*\b\d+ (?:shells?|monitors?)\b(?: still running)?'
    - '[·⏵].*\b\d+ background\b'
codex:
  effort_args: ['-c', 'model_reasoning_effort={effort}']
  ready_pattern: '^›\s(?!\d+\.)|\? for shortcuts'
  trust_pattern: 'Trust this folder\?|Folder settings can run code automatically'
  working_pattern: 'esc to interrupt'
  question_pattern: 'Waiting for your answer|^\s*\?\s+\d+ questions?\b|to answer\s*$|Press enter to confirm or esc to cancel'
  footer_patterns:
    - '\? for shortcuts'
    - '⚠ \d+ warnings?'
    - 'f2 to view'
    - '^\s*[\w.-]+ (low|medium|high|xhigh|minimal|none) · '
    - '^\s*›\s*(Ask Codex to do anything)?\s*$'
    - 'Queued follow-up inputs|⇧.? (edit last queued message|to answer)'
  limit_patterns:
    - '^[\s⎿●•■⚠!*>-]*You.ve hit your usage limit'
    - '^[\s⎿●•■⚠!*>-]*Usage limit reached'
    - '^[\s⎿●•■⚠!*>-]*You.re out of credits'
    - '^[\s⎿●•■⚠!*>-]*Your workspace is out of credits'
    - '^[\s⎿●•■⚠!*>-]*You hit your spend cap'
  background_patterns:
    - '\b\d+ background terminals?\b'
```

## Spec keys

The header of a spec file, between `---` lines, followed by the prompt. Several specs may follow each other in one file.

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `task` | string | required | s | Task ID: uppercase letters, digits, `-`, `_`, starting with a letter, up to 40 characters (`NC-42`). The window is the lowercase ID. |
| `agent` | `claude` or `codex` | `defaults.agent` | s | Agent that runs the task. Required unless a `defaults.agent` is set. |
| `model` | string | `defaults.model`, else `default` | s | Model name passed to the agent. `default`: no model flag. |
| `effort` | `low` `medium` `high` `xhigh` `max` | `defaults.effort`, else `high` | s | Effort level. Codex has no `max`. |
| `repos` | list | required | s | At least one repository. The agent starts in the worktree of the first one. |
| `repos[].path` | path | required | s | The existing checkout. |
| `repos[].worktree` | path | `<worktree_root>/<repo>-<task>` | s | Where the new worktree goes. Must differ from `path`. |
| `repos[].base` | git ref | none | s | Start point of the worktree. |
| `repos[].branch` | string | none | s | Branch to create (or reuse). Without it the worktree is detached. |
| `links` | list | `[]` | s | Same as in the other layers; added to theirs. |
| `setup` | list of strings | project, else global | s | Same as in the other layers; replaces theirs. |
| `env` | mapping | `{}` | s | Same as in the other layers; merged over theirs. |
| `review_of` | task ID | none | s | The task under review. The reviewer must use another agent or another model than the author. |
| `report` | path | project, else global | s | Report path of this task. |
| `pin` | boolean | `false` | s | `true`: never move the task to the other provider, by `--agent` or by a limit. |
| `after` | task ID or list | none | s | The task starts only when every named task has a report (`report-ready`, or closed with a report). Meant for the queue; `new` refuses a task whose `after` is not met. Unknown tasks and circles are errors. |
| `touches` | glob or list of globs | none | s | Files the task will change. `queue` and `new` warn (and ask y/N) when an active task of the same repository already changes matching files. |
| `cohort` | name | none | s | The cohort of the task: letters, digits, `-`, `_` and `.` (at most 40 characters), compared without regard to case and shown as it was first written. The cohort is made by its first task; its file is `<config dir>/cohorts/<name>.json`. Without the key the task belongs to no cohort (there is no default one). `new --cohort` and `queue --cohort` override it for the whole file. See [cohorts](details.md#cohorts). |
| `priority` | `high` or `normal` | `normal` | s | Queue order: `high` tasks start before every `normal` one (first come, first served inside each class). `new` ignores it. |

## Environment variables

| Variable | Meaning |
|---|---|
| `AGENTCTL_HOME` | Directory of the global config instead of `~/.agentctl`. |
| `CODEX_HOME` | Where agentctl looks for the `notify` command of Codex's own `config.toml`, to forward to it (default `~/.codex`; a spec's `env` may set it). |
| `AGENTCTL_REPO`, `AGENTCTL_STABLE_DIR`, `AGENTCTL_SESSION` | Only for `bin/agentctl-update`: the repo, the stable copy (default `~/Projects/agentctl-stable`) and the tmux session of the watch window. |
