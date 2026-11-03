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
| `report` | path or list | `{cache}/{task}/{TASK}.md` | g p s | Where the agent writes its report. Used by `status`, `pull` and the notifications. A list: the first entry is the canonical path, the others are places to look (paths and globs `*`, `?`, `**`; absolute, `~/` or relative to the worktree; `{task}` and `{TASK}` work), e.g. `[~/workspace/cache/{task}/{TASK}.md, docs/reports/*{task}*.md, docs/reports/*{TASK}*.md]`. A report found in another place (also by itself, see [Report detection](details.md#report-detection)) is copied to the canonical path. |
| `setup` | list of strings | `[]` | g p s | Shell commands run in the first worktree after `git worktree add` and before the links. A failing command stops `new`. |
| `defaults` | mapping | `{}` | g p | Values for a spec that leaves them out: `agent`, `model`, `effort`. |
| `defaults.agent` | `claude` or `codex` | none | g p | Agent when the spec has no `agent`. |
| `defaults.model` | string | `default` | g p | Model when the spec has none. `default` passes no model flag. |
| `defaults.effort` | `low` `medium` `high` `xhigh` `max` | `high` | g p | Effort when the spec has none. |
| `defaults.remote_control` | boolean | `false` | g p | `true`: Claude tasks start with Remote Control (see the spec key `remote_control`) unless the spec says `remote_control: false`. A Codex task is not affected. |

## Keys of the global config only

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `cache` | path | `~/workspace/cache` | g | Directory with one folder per task, `<cache>/<task>/`: the only place the agents write to (reports). |
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
| `away` | mapping | see below | g | When the phone gets notifications: `away.auto_idle`. See also `notify.ntfy`. |
| `manager` | mapping | see below | g | The dispatcher session you talk to from the Claude app on the phone (`agentctl manager`). |
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
| `notify.ntfy` | mapping | none | g | Notifications to a phone through [ntfy](https://ntfy.sh); the keys below. Without `topic` nothing is sent. `agentctl ntfy-setup` writes it for you. |
| `notify.ntfy.server` | URL | `https://ntfy.sh` | g | The ntfy server; your own for a private one. |
| `notify.ntfy.topic` | text | none | g | The topic the phone subscribes to (letters, digits, `_`, `-`). On the public server its name is the only protection: keep it long and random. |
| `notify.ntfy.token` | text | none | g | Bearer token for a private server or an ntfy account. |
| `notify.ntfy.events` | list | all ten | g | `needs-input`, `needs-trust`, `limited`, `blocked`, `report-ready`, `cohort-done`, `queue-failed`, `orphan`, `dead`, `usage-critical`. |
| `notify.ntfy.priority` | mapping | `needs-input`, `limited`, `usage-critical`: `high`; the rest `default` | g | ntfy priority per event: `min`, `low`, `default`, `high`, `urgent`. |
| `notify.ntfy.include_question` | boolean | `false` | g | Opt in to sending question text to the phone (clipped to 120 characters). By default only the opening instructions and session hints are sent; local notifications, board, peek and status/MCP retain the question. Reloads live, including queued retries. |
| `notify.ntfy.include_verdict` | boolean | `true` | g | The first line of the verdict goes into "report ready". Never more of the report; no paths or file names. |
| `notify.ntfy.click_url` | URL | none | g | Opened by a tap on the notification, for example the address of the chat. |
| `notify.ntfy.always` | boolean | `false` | g | Send always, not only while `agentctl away` is on. |

### `away`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `away.auto_idle` | minutes | none | g | The Mac counts as away after this many minutes without keyboard or mouse (macOS, `HIDIdleTime`), and back at the first touch. Off by default; `agentctl away on|off` always works. |

### `manager`

The session started by `agentctl manager`: Claude Code with [Remote Control](https://code.claude.com/docs/en/remote-control), the agentctl MCP server and a role that makes it a dispatcher. See [Remote control from your phone](../README.md#remote-control-from-your-phone) and [the details](details.md#remote-control-and-the-manager).

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `manager.project` | path | none | g | The directory the session runs in (it should be a folder you have trusted in Claude Code, e.g. `~/src/sample-app`). Without it the manager runs in the directory where `agentctl manager` is typed. `--project` overrides it. |
| `manager.name` | string | `agentctl manager` | g | The name of the session in the Claude app (`claude --remote-control <name>`). One line, at most 80 characters. |
| `manager.model` | string | `sonnet` | g | `--model` of the session; `default` passes none. |
| `manager.effort` | `low` `medium` `high` `xhigh` `max` | `medium` | g | `--effort` of the session. |
| `manager.guide` | path | none | g | A local copy of the rules for writing specs (`claude/AGENTCTL-SPEC-GUIDE`): its text is appended to the role of the manager. Optional; a missing file is a warning, not an error. |
| `manager.autostart` | boolean | `false` | g | `agentctl up` starts the manager too. |

### `board`

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `board.auto_hide_pulled_dead` | boolean | `true` | g | A task without a window whose report was pulled hides by itself. |
| `board.mouse` | boolean | `true` | g | `mouse on` in the agentctl tmux session (this session only). |
| `board.return_key` | tmux key name or `false` | `F12` | g | Key (no prefix) that goes back to the board from any window of the session. `false`: none. |
| `board.selected_color` | Ink color name | `blue` | g | Color for the selected board row, manager line and queue entry. State and result cells keep their own colors. `NO_COLOR` disables color; the selection stays bold (manager line uses inverse video). |

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
| `report` | path or list | project, else global | s | Report path of this task, or the list described under the global key. |
| `remote_control` | boolean | `false` | s | `true` (Claude only): the agent starts with `claude --remote-control <TASK>`, so the task shows up as a session named after it in the Claude app (Code) and can be answered from the phone. It goes with `--settings` (the event hooks), `--model` and `--effort`: it is an interactive session, not the server mode `claude remote-control`. The first start asks in the window once to "Enable Remote Control" (agentctl does not answer it, like the folder trust). A `needs-input` notification to the phone then says where to answer. `remote_control: true` on a Codex task is an error. Needs a claude.ai login (Pro, Max, Team, Enterprise), not an API key. |
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
| `AGENTCTL_REPO`, `AGENTCTL_STABLE_DIR`, `AGENTCTL_SESSION` | Only for `bin/agentctl-update`: the repo, the stable copy (default `~/workspace/agentctl-stable`) and the tmux session of the watch window. |

In 0.15.0, installed runtime commands use `dist/bin/agentctl.js`. Status `question` includes collapsed Codex question count and the shortcut read from the screen. A visible pending question takes precedence over working. No configuration migration is required.

### Dispatcher guide and capacity

| Key | Type | Default | Layers | Meaning |
|---|---|---|---|---|
| `guide` | mapping (global), path (project) | `{lang: en}` globally | g, p | Global guide settings; project `.agentctl.yaml` uses `guide: docs/agent-dispatch.md` (repository-relative or `~/…`) as a trusted project overlay. A missing file warns in guide and doctor, and does not fail an order. |
| `guide.lang` | en or pl | en | g | Default language for CLI, MCP and manager shared guide. |
| `capacity` | mapping | see below | g | Dispatcher capacity settings. |
| `capacity.snapshot` | boolean | true | g | Add both providers' capacity to new and queue responses. |
| `capacity.stale_minutes` | integer 1–10080 | 30 | g | Reading age that sets stale; emits one event per reading while that provider has active task windows. |
| `capacity.sample_limit` | integer 2–10000 | 2048 | g | Maximum combined provider samples in `usage-samples.jsonl` (under 10 MB even at maximum). Each distinct usage reading is sampled; repeated timestamps do not create samples. |
| `capacity.thresholds` | percentage list | `[80, 95]` | g | Up to 20 thresholds applied to each provider window. Crossings and reset events are deduplicated per provider, window and reset boundary. `usage.warn`/`critical` independently control desktop/phone warnings. |
| `capacity.codex_refresh` | boolean | true | g | For capacity, query Codex app-server account/rateLimits/read (3 s deadline), without a thread or agent turn. False uses existing session readings only. Failure retains the original timestamp and provenance of the last known reading. |

```yaml
guide: {lang: en}
capacity:
  snapshot: true
  stale_minutes: 30
  sample_limit: 2048
  thresholds: [80, 95]
  codex_refresh: true
```

The guide ships in npm `docs/dispatcher*.md`, with no dependency on a development checkout. See [the example project config](examples/project-guide.yaml).

## Disk and git start limits (0.17.1)

| Key | Default | Meaning |
|---|---|---|
| `disk` | mapping | Disk thresholds, in GiB (1024³ bytes). |
| `disk.warn_gb` | `50` | Warn below this available space on any known filesystem. |
| `disk.critical_gb` | `20` | Critical below this space; must not exceed warn_gb. |
| `git` | mapping | Worktree checkout and setup limits. |
| `git.timeout_s` | `600` | Positive timeout in seconds for worktree add (including checkout) and each setup command. |

`capacity` (including JSON/MCP), MCP `status`, CLI `status`, `doctor`, and the board show disk facts. Unknown readings are `null` / `n/d`. Filesystems holding the global worktree root, known projects' `.agentctl.yaml` roots, recorded worktrees, cache and state are deduplicated by device. `statfs` falls back to `df -kP`. Worktree sizes are cached for five minutes; symlinks are not followed. The watcher checks every five minutes, persists the previous level, and records `disk-warn`, `disk-critical`, `disk-ok` once per transition. These events can be selected in `notify.ntfy.events`.

A critical reading warns before `new` or queue insertion. The terminal asks y/N (`--yes` acknowledges the warning); MCP shows it before confirmation. It does not impose a capacity limit or switch providers.

MCP write permissions accept exact tool names and explicit groups: `queue:*`, `cohort`, `manager:*`. Existing `queue` still permits only insertion. All previous names keep their permission scope. Group membership is generated in docs/mcp.md; reads remain available without allow.

Worktree checkout and setup release the event loop while running, so independent repositories can start concurrently. A timed-out checkout/setup stops its own process group (including children). Per-repository locks remain held only for Git worktree creation. A new branch is created by a separate `git branch` command, which is also visible in `new --dry-run`, before attaching the worktree.

## Overload recovery (0.17.2)

| Key | Default / behavior |
|---|---|
| `overload` | Technical recovery of provider overload; independent of usage limits. |
| `overload.auto_retry` | `true`; retry only at a visible idle prompt with no draft or background work. |
| `overload.retry_after` | `300` seconds between attempts; recheck busy windows next watch tick. |
| `overload.max_retries` | `3`; then keep overloaded and notify “wymaga uwagi”. Attempts persist and are journaled. |
| `overload.message` | `kontynuuj`; submitted as a prompt, never a command. |

Queue transient starts retry after 1, 5, 15 minutes, then fail. Explicit ETIMEDOUT, EAGAIN, ECONNRESET, ECONNREFUSED, ENETUNREACH, EAI_AGAIN, temporarily busy locks and transient network setup timeouts qualify. Missing paths, branch conflicts and invalid specs fail immediately. `queue show TASK` / MCP `queue_show` exposes the spec, reason and attempt history.

### Task worktree placeholders / placeholdery worktree zadania

In links `to`, links `from` (inside the primary worktree only) and env use `{worktree:repo-basename}`. It resolves against `repos[].path` of this task, never another task. Fallback syntax: `{worktree:repo-basename|~/Projects/wt/fallback}`. A present repo always wins; a missing repo without fallback is an error. Duplicate basenames are ambiguous. Example: `to: "{worktree:neon-city-backend|~/Projects/wt/neon-city-backend-integration-12}/packages/sim"`. Targets are checked after task worktrees/setup exist; external fallback targets are also checked before mutation. New/queue previews show every resolved link.

MCP od 0.17.2 domyślnie zwraca zwięzły tekst dla events_since/status/queue_list/cohort_show/limits/capacity; pełne dane przez `format: "json"` lub `detail: true`. `pull_ready` daje skrót (1500 znaków/raport, 16000 bajtów razem), pełny tekst przez `mode: "full"` (200 KiB), offset/limit paginują raporty. `get_report` section wybiera nagłówek Markdown, offset/limit paginują linie od zera, limit odpowiedzi 200 KiB. `usage_hint` i `draft_input` są metadanymi ekranu, a lastLine pokazuje pracę agenta.

Additional Claude background pattern (fixture-tested; current runtime wording unverified):

```text
^\s*\d+ (?:monitors?|shells?)(?:, \d+ (?:monitors?|shells?))? still running\b
```

## Complete MCP write allow-list (0.17.2)

Each write needs its exact name in `mcp.allow` (or the listed group). No wildcard grants other tools. Start/stop/removal operations preview first, then require identical `confirm: true`.

| Tool | mcp.allow entry | Group |
|---|---|---|
| `send` | `send` | — |
| `new` | `new` | — |
| `interrupt` | `interrupt` | — |
| `close` | `close` | — |
| `move` | `move` | — |
| `queue` | `queue` | `queue:*` |
| `queue_rm` | `queue_rm` | `queue:*` |
| `cancel` | `cancel` | — |
| `mark` | `mark` | — |
| `set_limits` | `set_limits` | — |
| `reserve` | `reserve` | — |
| `resume` | `resume` | — |
| `away` | `away` | — |
| `queue_retry` | `queue_retry` | `queue:*` |
| `queue_up` | `queue_up` | `queue:*` |
| `queue_pause` | `queue_pause` | `queue:*` |
| `queue_resume` | `queue_resume` | `queue:*` |
| `unblock` | `unblock` | — |
| `cohort_add` | `cohort_add` | `cohort` |
| `cohort_remove` | `cohort_remove` | `cohort` |
| `cohort_note` | `cohort_note` | `cohort` |
| `hide` | `hide` | — |
| `unhide` | `unhide` | — |
| `archive` | `archive` | — |
| `adopt` | `adopt` | — |
| `report_from` | `report_from` | — |
| `limits_release` | `limits_release` | — |
| `manager_start` | `manager_start` | `manager:*` |
| `manager_stop` | `manager_stop` | `manager:*` |
| `notify_test` | `notify_test` | — |
| `gc` | `gc` | — |

Groups: `queue:*` = `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume`; `cohort` = `cohort_add`, `cohort_remove`, `cohort_note`; `manager:*` = `manager_start`, `manager_stop`. `queue:*` includes `queue_retry`; retry is technical and retains the same provider.

## Review corrections: delivery, attempts and overload safety

| Key | Default / meaning |
|---|---|
| `agents.<agent>.overload_patterns` | Adapter-specific regexes matched only against the last non-chrome error element, outside fenced code. Claude: ⎿ API Error: 529 or ⎿ Overloaded directly below a ⏺ block (not tool output or intervening prose); Codex: ■ Selected model is at capacity. Mentions, test output and stale errors do not match. `[]` disables screen overload detection for this adapter. |
| `overload.give_up_after` | 1800 seconds from the start of an overload episode, including time when retry is unsafe. Independent of max_retries. Brief working/waiting does not reset it; watcher restarts preserve it. Completion/report clears it. |
| `overload.reset_after_s` | 600 seconds of continuous working without another overload before clearing the episode. Waiting/background/question interrupts the recovery timer. |
| `mcp.client` | Optional stable suffix to clientInfo.name that intentionally shares a cursor between sessions. Tool parameter client overrides it. By default each session consumes independently from its initialization checkpoint; new sessions inherit the client high-water mark. |
| `report.settle_s` | 30 seconds without report changes after an ended agent turn. Set with mapping syntax below. Zero disables the settling delay, not attempt checks. |
| `report.path` | Canonical path in mapping syntax, compatible with legacy report: path. |
| `report.paths` | Canonical first path and detection alternatives in mapping syntax, compatible with legacy report: [paths]. |

```yaml
report:
  paths: ["{cache}/{task}/{TASK}.md", "docs/reports/*{task}*.md"]
  settle_s: 30
overload:
  auto_retry: true
  retry_after: 300
  max_retries: 3
  give_up_after: 1800
  reset_after_s: 600
  message: kontynuuj
```

The final report line `<!-- agentctl:report-end -->` explicitly completes a write. Without it the report needs an ended turn and settle_s; a partial canonical file is a candidate. new/queue prompts include report instructions and current attempt ID. TASK.md keeps attempt, attempt_id, attempt_started and the previous report fingerprint; resume starts another attempt, move/new/retry get fresh identities. Old report content cannot complete a new attempt just by touching its mtime. A FAIL report still satisfies after; agent self assessment and user mark remain independent.

Auto-retry rechecks report/candidate, window identity, prompt, draft, work, trust and question before paste and again before Enter. A failure is journaled and watch continues. Retry of a timed-out checkout requires registration, toplevel, successful clean tracked git status, no index.lock, expected HEAD/branch and no task/git process or window. Uncertain residue is preserved with repair instructions.

PL: Domyślnie raport wymaga końcowej linii `<!-- agentctl:report-end -->` albo zakończonej tury i 30 sekund stabilności. Nowa próba nie korzysta ze starego raportu. Przeciążenie ma limit czasu i prób, nie wygrywa z potwierdzonym raportem ani pytaniem; ponowienie sprawdza stan także tuż przed Enter. Skrót MCP nie oznacza pobrania pełnego raportu ani oceny użytkownika.

Adapter overload patterns (terminal status/error context only):

```text
^\s*⎿\s*API Error:\s*529(?:\s|$)
^\s*⎿\s*(?:API Error:\s*)?Overloaded(?:[.:]|$)
^\s*■\s*Selected model is at capacity(?:\.|$)
```

PL: Krótkie przejście przez working nie kasuje limitu przeciążenia. Epizod kończy się po 600 s ciągłej pracy (`overload.reset_after_s`) albo po zakończeniu/raporcie. `give_up_after` biegnie od pierwszej awarii. Po limicie jedno powiadomienie „wymaga uwagi” i brak dalszych wysyłek w tym epizodzie. Samotna linia API Error: 529 bez kontekstu banera jest pomijana; wolimy przeoczyć nieznaną formę błędu niż wznowić zakończoną pracę. Nie zweryfikowano formy bez prefiksu w rzeczywistym CLI.

A closed pane is not evidence that a current-attempt report finished writing. Without a report-end marker or recorded turn completion it remains a candidate, even after settling. Once the owner verifies completeness, append the final report-end marker or record the turn-complete event; do not infer completion from a crash. Legacy records without attempt IDs retain their conservative compatibility rules. PL: Zniknięcie okna nie potwierdza kompletności raportu bieżącej próby; po sprawdzeniu pliku właściciel może dodać końcowy znacznik albo jawnie zarejestrować koniec tury.
