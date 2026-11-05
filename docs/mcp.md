# Chat integration (MCP)

`agentctl mcp` is a local [MCP](https://modelcontextprotocol.io) server on stdio, built on the official `@modelcontextprotocol/sdk`. The Claude app, Claude Code and the VS Code extension start it themselves; nothing listens on a port. A chat can then read the status of your tasks, look into a window and read the reports without the clipboard.

The server is a thin front over the same core functions the CLI uses (`src/core/mcp-tools.ts` holds the tools, `src/mcp/server.ts` registers them). Stdout carries only protocol messages.

## What has been checked

| Where | Status |
|---|---|
| Claude app on macOS, chats inside a **Project** | Works for the read tools (checked by the author on 2 November 2026). |
| Claude Code, VS Code extension | Registered through the same user configuration; covered by tests of the install command (on copies of the config) and of the server over an in-memory transport. |
| Write tools from a chat in the app | Covered by tests; not yet tried by hand in the app. |
| Which approval screen the app shows for tools of a local server | Not confirmed. Tools are annotated (`readOnlyHint`, `destructiveHint`), but what the app does with them for a local server is not documented. |

## Read tools

These always work.

| Tool | Arguments | What it returns |
|---|---|---|
| `status` | `all?`, `cohort?` | One line ("3 tasks: 1 working, 1 report-ready, 1 waiting") and concise task rows (JSON only with format: json / detail: true): agent, model, effort, state, window, `started` (UTC) and `startedLocal`, duration, progress, report, whether it was pulled, last line, the open question, hint, finished, hidden, closed, archived. Hidden and closed tasks only with `all: true`. Start with events_since; request status only for task details. Before the rows, `status` says which server version answers (`MCP server: agentctl 0.10.0 (script, pid, started)`, with a hint when the stable copy on disk is newer) and any `Config warning:`. |
| `version` | none | The version of agentctl this server process runs, its script, pid and start time, the version of the stable copy on disk (`older: true` when they differ), the write tools the user allowed and the warnings about the MCP part of the config. Use it when a tool seems to be missing. |
| `peek` | `task`, `lines?` (1 to 200, default 40) | The last lines of a running task's window without the agent's footer. |
| `list_reports` | `all?` | Which tasks have a report: size, `modified` (UTC) and `modifiedLocal`, whether it was pulled, and `source` (where the agent wrote the report when the file is a copy, else `null`). |
| `get_report` | `task`, `section?`, `offset?`, `limit?` | A selected Markdown section or line/byte page, bounded by mcp.max_response_kb. It reads only the file that the task's `TASK.md` names, never a path from the chat, and refuses a report that is a symbolic link. A contiguous whole-file read marks it pulled only at EOF; sections do not. |
| `pull_ready` | `cohort?`, `mode?`, `offset?`, `limit?` | Summary by default: task/path/size/SHA, small reports whole or bounded excerpts. mode: full returns complete bodies through response_page fragments. Only mode full or explicit ack marks fully delivered reports as pulled. This is the only read tool that changes anything, and only in agentctl's own state. A chat should call it at the start of discussing finished work. |
| `queue_list` | none | The task queue: position, agent/model/effort, priority, `after`, what each task waits for (`startCondition`: `czeka na miejsce: claude 2/2`, `czeka na NC-42`, paused), since when, and the error of a start that failed. |
| `usage` | `cohort?`, `since?` | Token usage and the plan limits: per provider the 5 hour and weekly window (percentage used, reset time; `available: false` when the provider did not say, shown as n/d) and the tokens today and in the period, per task, cohort, model and day. `since` is an age such as `12h`, `7d`, `2w` (default `7d`). A chat should call it before the user orders more tasks. `status` carries a one-line `Plans:` summary. |
| `log` | `cohort?`, `since?` | The history of the tasks, newest first: agent/model/effort, start, report, duration, tokens (null: n/d), commits and files, the verdict line, cancel reason, move, and the result the user marked. |
| `stats` | `cohort?`, `since?` | The history grouped by agent/model/effort: tasks, median time and tokens, how many were marked ok, partial or fail, cancelled, and moved to the other provider after a limit. |
| `events_since` | `since?`, `cohort?`, `peek?` | What changed since the previous call of this client (or since a time: an age like `2h`, `HH:MM`, an ISO time): reports ready with the verdict, starts from the queue, questions, folder trust, blocked, cancelled and limited tasks, finished cohorts, plan thresholds, changed limits - and one line with the state now. **A chat should call it at the start of every answer about the agents' work**: it gets no notifications. The marker is kept per initialized MCP client identity or explicit client fallback (CLI has its own cursor); the first call looks back 24 hours; `peek: true` leaves the marker. Events are recorded while `agentctl watch` runs. |
| `gc_preview` | `older_than?`, `merged?`, `cohort?` | What `agentctl gc` would free now, with sizes, and what it skips and why: worktrees of finished tasks without uncommitted changes, old files next to the reports, state folders to archive, merged branches. Read only; use the separately allowed, two-step `gc` tool to apply the same plan. |
| `limits` | none | The limit per provider, what uses it up (windows of agentctl, reserved places, external sessions when `limits.count_external` is on), the free places and the tasks waiting in the queue. |
| `overlap` | `task?` | Pairs of active tasks of one repository that changed the same files, with the file lists (from git, now). `status` also carries a collision count per task, and short `Queue` and `Collisions` lines. |
| `cohort_list` | none | The cohorts (named groups of tasks): per cohort the number of tasks by state (`active`, `queued`, `reports`, `closed`, `cancelled`), `total`, `created` and the note. |
| `cohort_show` | `cohort` | One cohort: its note, every task in it as `status` shows it (closed and cancelled ones too) and its queued tasks with what each waits for. |
| `task_spec` | `task` | The header of a task (agent, model, effort, repos and worktrees, report path, `report_source` (see [Report detection](details.md#report-detection)), `started` and `startedLocal`, `pulled` and `pulledLocal`, `review_of`, `continues`, `superseded_by`, `pin`, `closed`, names of env variables without values) and the prompt from `TASK.md`. |

`task` is a task ID, case-insensitive; a unique prefix is enough.

All times are given twice: the ISO or `YYYY-MM-DD HH:MM` value in UTC, and the same moment in the local time zone of the machine (`startedLocal`, `pulledLocal`, `modifiedLocal`). A chat should show the local one.

## Write tools

Off until you list them in `~/.agentctl/config.yaml`. The list is read again on every call: a change works at once, and removing a name revokes it at once.

```yaml
mcp:
  allow: [send, interrupt]     # any of: send, new, interrupt, close, move, queue, queue_rm, cancel, mark, set_limits, reserve, resume, away
  allow_rm_worktree: false     # close may also remove the git worktree
```

| Tool | Arguments | What it does |
|---|---|---|
| `send` | `task`, `text` (up to 20,000 characters) | Pastes a prompt into the window of a running task and presses Enter. |
| `new` | `spec`, `confirm?` | Starts tasks from a spec text, validated like the CLI. The first call only returns the summary; tasks start only when it is called again with `confirm: true`. A spec with `setup` (shell commands) is refused, because a chat must not choose shell commands. A repository whose own `.agentctl.yaml` has `setup` is not set up inside the call: `confirm` registers the start and returns at once, the watcher does the checkout, the setup and the window (see "A start with setup" below). It never waits for a folder-trust dialog in the call (a human answers it in the window) and never switches provider. |
| `interrupt` | `task` | Sends the agent its interrupt key; the window stays open. |
| `close` | `task`, `remove_worktree?` | Closes the window and marks the task closed. The worktree and the branch stay, unless `remove_worktree: true` and `mcp.allow_rm_worktree` is set (`git worktree remove`, never forced). |
| `queue` | `spec`, `agent?`, `confirm?` | Puts the tasks of a spec text in the queue (`priority`, `after` and `touches` work as in the CLI). The first call only returns the summary (where each task will stand, the review hint, `touches` warnings); the tasks are queued when it is called again with `confirm: true`. `setup` is refused, as in `new`. They start by themselves while `agentctl watch` runs. |
| `queue_rm` | `task` | Takes a waiting or failed task out of the queue; it becomes cancelled (as `cancel` does for a queued task) and the tasks that wait for it become blocked. |
| `cancel` | `task` or `cohort`, `reason?`, `remove_worktree?`, `confirm?` | Abandons a task, or all open tasks of a cohort: a task at work is interrupted and its window closed after `cancel.grace` seconds, a queued task leaves the queue. The task becomes cancelled; the worktree, the branch and a written report stay. A move is cancelled with its other half. The first call only describes what would be cancelled; `confirm: true` does it. `remove_worktree` needs `mcp.allow_rm_worktree`, as in `close`. The desktop notice names the reason. |
| `mark` | `task?`, `tasks?`, `cohort?`, `result` (`ok`, `partial` or `fail`), `note?` | Records the result the user judged for a task in the history (`log`, `stats`); the last mark wins. Multiple tasks require preview/confirm; a single mark is immediate; a chat should record only what the user said. |
| `away` | `on` | Turns away mode on or off: while it is on, agentctl sends its notifications to the user's phone (ntfy) as well; the Mac is not affected. It costs nothing, so it has no confirm step, and it is recorded in the audit log. `status` and `events_since` say whether away is on. |
| `set_limits` | `claude?`, `codex?` (0 removes a limit), `confirm?` | Sets the most simultaneous agents per provider in `config.yaml` (comments stay, a `.bak` copy is kept). Takes effect at once, also in a running `watch`. The first call only describes the change; `confirm: true` writes it. |
| `reserve` | `claude?`, `codex?`, `note?`, `release?`, `confirm?` | Holds places of a provider for agents you start by hand (they count against the limit), or gives them back with `release: true`. The first call only describes it; `confirm: true` does it. |
| `resume` | `tasks?`, `all?`, `confirm?` | After a restart of the Mac or of tmux: gives the window back to active tasks that have a worktree and no window and starts the agent in resume mode (Claude `--resume <session>` or `--continue`, Codex `resume <session>` or `resume --last`), same model and effort, no prompt pasted again. Tasks with a ready report are left alone unless `all: true`. The first call only lists the tasks; `confirm: true` does it. |
| `move` | `task`, `agent?`, `confirm?` | Hands a task that hit its usage limit to the other provider. The first call only describes the move; `confirm: true` does it. |

## Safety model

- There is no tool for merge, push, rebase or running a shell command. The two-step `gc` tool can delete merged local branches with `git branch -d`; `report_from` and `adopt` accept explicit metadata/report paths.
- Every write is refused unless `mcp.allow` lists it. Refused calls are recorded too.
- **Audit log:** `~/.agentctl/mcp-audit.log` (next to the config), one JSON line per step: time, tool, task, outcome `requested`, then `done`, `error`, `denied` or `preview`. The `requested` line is written before the action, and a write that cannot be recorded is not done.
- **Notification:** `notify.mcp_writes` selects all, summary (default, at most once per 60 seconds), or off; each done write remains in the audit and journal.
- **Two-step tools:** `new`, `queue`, `move`, `set_limits`, `reserve` and `resume` change nothing on the first call; the chat has to show the summary and call again with `confirm: true`.
- The server runs as you and sees what you see. This is a trust decision about the chat, not a sandbox. Start with `allow: []`.

## Install

### Claude app (macOS)

```sh
agentctl mcp install --desktop --dry-run   # the exact entry and the diff, nothing written
agentctl mcp install --desktop             # shows both, asks y/N, keeps a dated .bak copy, keeps your other servers
```

This edits `~/Library/Application Support/Claude/claude_desktop_config.json`: `mcpServers.agentctl` with the absolute `node`, `--experimental-strip-types --no-warnings`, the absolute script of this agentctl, `mcp`, and the `PATH`, `AGENTCTL_HOME` and `TMUX_TMPDIR` of the run (the app starts servers with a bare environment).

Run it from the stable copy (the `agentctl` on your `PATH`, see [Stable install](details.md#stable-install-and-updates)), so that the entry does not point at a development checkout; it warns when it does. Then quit the app completely (Cmd+Q) and open it again. If the tools do not appear, `~/Library/Logs/Claude/mcp-server-agentctl.log` and `mcp.log` say why. `--config <file>` works on another file, to try it on a copy first.

### Claude Code and the VS Code extension

```sh
agentctl mcp install --claude-code --dry-run
agentctl mcp install --claude-code         # claude mcp add --scope user …
```

User scope makes the server available in every project; the VS Code extension reads the same configuration (`/mcp` in the chat panel shows it).

### The phone: the manager session

The Claude app on a phone cannot reach this server directly (local MCP servers work in the desktop app only). [`agentctl manager`](../README.md#remote-control-from-your-phone) goes round it: it starts a Claude Code session in the window `manager` with Remote Control, and that session gets this server through `--mcp-config <config dir>/manager/mcp.json` (the same entry as `mcp install --claude-code`, under the name `agentctl`, so you need no user-scope registration for it; `doctor` checks that the file's `node` and script still exist). The tools are the same; what changes is who asks you:

- The **read tools** are in `permissions.allow` of the `--settings` file of the manager, so the phone is not asked about `status` or `get_report`.
- The **write tools** are not, so Claude Code asks for your permission on the phone before each call, and `mcp.allow` decides whether the server does it at all (and `confirm: true` where a tool has that step). The role of the manager adds a third rule: your clear yes to that very action first.
- Everything is audited in `mcp-audit.log` as before; a tool call from the manager is a call like any other.

### After an update: quit the Claude app (Cmd+Q)

The app starts the server once and keeps that process for as long as it runs. `agentctl-update` replaces the files of the stable copy, but a process that is running keeps the code it loaded, so the chat goes on talking to the **old** version (new tools missing, old behaviour) until the app is quit completely (**Cmd+Q**, not just the window) and opened again. agentctl never stops the process for you.

- `agentctl doctor` and, at its end, `agentctl-update` run `agentctl mcp check`: it finds the `agentctl … mcp` processes (from `ps`) that started before the stable copy was last updated and prints `serwer MCP w aplikacji działa na starej wersji – zamknij aplikację Claude (⌘Q) i otwórz ponownie`.
- From inside the chat, `version` (and the first lines of `status`) show the version the running server has next to the one on disk.

### A config written for another version

`mcp.allow` may name a tool that this version does not know (a config from a newer or an older agentctl). That entry is ignored with a warning, and everything else works: `status` shows `Config warning: …` before its rows, `version` lists the warnings, `agentctl doctor` shows an `mcp config` line. The same goes for an unknown key or a wrong type inside `mcp`. Only a config that cannot be read at all (invalid YAML, not a mapping) stops the server.

### Remove and check

```sh
agentctl mcp uninstall                     # both; --desktop or --claude-code for one
agentctl doctor                            # registered? runs the stable copy? what may the chat write?
```

## Questions to try

- "What is running, and who is waiting for me?"
- "Pull the new reports and give me a verdict on each."
- "What is NC-42 doing right now? Look into its window."
- "Show me the prompt of NC-40 and its report side by side."
- With `send` allowed: "Tell NC-42 to add a test for the empty case."
- With `new` allowed: "Draft a spec for the next task and show me the summary before you start it."

## Limitations

- Local only. A server that claude.ai on the web or a phone could reach would need a tunnel and authentication, and would make everything above reachable from outside the machine. That is a different threat model and is not part of agentctl today.
- The chat cannot answer a folder-trust dialog; a task it starts waits for you in its window.
- Every answer is bounded by mcp.max_response_kb (default 8 KiB). Large pull_ready full results continue through response_page without losing a report or marking it read before complete delivery.

In 0.15.0, installed runtime commands use `dist/bin/agentctl.js`. Status `question` includes collapsed Codex question count and the shortcut read from the screen. A visible pending question takes precedence over working. No configuration migration is required.

### Dispatcher read tools

| Tool | Input | Result |
|---|---|---|
| `guide` | optional project repository path, lang en/pl | Shared dispatcher manual plus the trusted project guide from .agentctl.yaml; a missing overlay warns. This tool explicitly permits reading the configured overlay of the requested project. |
| `capacity` | none | Current windows/age/stale, pace/projection, labeled token estimates, slots, queue, equivalents and seven-day stats; null is n/d. |

Both are always readable without mcp.allow. New/queue previews and executed responses append capacity snapshots without removing existing result fields; disable with capacity.snapshot: false. Start an ordering chat with guide then capacity, and use events_since → status → pull_ready → get_report as work proceeds. See [dispatcher guide](dispatcher.md) and [Polish](dispatcher.pl.md).

<!-- BEGIN GENERATED MCP PARITY -->

| CLI | MCP | Exception / reason |
|---|---|---|
| `version` | `version` |  |
| `guide` | `guide` |  |
| `capacity` | `capacity` |  |
| `new` | `new` |  |
| `queue` | `queue` |  |
| `queue list` | `queue_list` |  |
| `queue show` | `queue_show` |  |
| `queue rm` | `queue_rm` |  |
| `queue up` | `queue_up` |  |
| `queue retry` | `queue_retry` |  |
| `queue pause` | `queue_pause` |  |
| `queue resume` | `queue_resume` |  |
| `unblock` | `unblock` |  |
| `cohort` | `cohort_list` |  |
| `cohort list` | `cohort_list` |  |
| `cohort show` | `cohort_show` |  |
| `cohort add` | `cohort_add` |  |
| `cohort remove` | `cohort_remove` |  |
| `cohort archive` | `cohort_archive` |  |
| `cohort note` | `cohort_note` |  |
| `overlap` | `overlap` |  |
| `send` | `send` |  |
| `status` | `status` |  |
| `limits` | `limits` |  |
| `limits show` | `limits` |  |
| `limits set` | `set_limits` |  |
| `limits reserve` | `reserve` |  |
| `limits release` | `limits_release` |  |
| `events` | `events_since` |  |
| `usage` | `usage` |  |
| `resume` | `resume` |  |
| `up` | — | Interactive terminal orchestration: opens watch/board and optionally manager; use the CLI. |
| `mark` | `mark` |  |
| `log` | `log` |  |
| `stats` | `stats` |  |
| `gc` | `gc_preview`, `gc` |  |
| `archive` | `archive` |  |
| `hide` | `hide` |  |
| `unhide` | `unhide` |  |
| `pull` | `get_report`, `pull_ready` |  |
| `close` | `close` |  |
| `cancel` | `cancel` |  |
| `watch` | — | Long-running terminal watcher, started and supervised locally. |
| `board` | — | Interactive terminal UI. |
| `report` | `report`, `report_from` |  |
| `away` | `away_status`, `away` |  |
| `away status` | `away_status` |  |
| `away on` | `away` |  |
| `away off` | `away` |  |
| `manager` | `manager_start`, `manager_status` |  |
| `manager stop` | `manager_stop` |  |
| `ntfy-setup` | — | Generates and saves a subscription secret; run locally. |
| `notify-test` | `notify_test` |  |
| `adopt` | `adopt` |  |
| `interrupt` | `interrupt` |  |
| `attach` | — | Attaches or switches a human terminal. |
| `event` | — | Internal agent callback; accepts forwarding hooks and must not be callable by chat. |
| `usage-tap` | — | Internal agent statusLine callback; may forward a local shell command. |
| `move` | `move` |  |
| `peek` | `peek` |  |
| `mcp` | — | MCP server transport itself; cannot start a nested server over a tool call. |
| `mcp serve` | — | MCP server transport itself. |
| `mcp check` | `mcp_check` |  |
| `mcp install` | — | Changes MCP client configuration. |
| `mcp uninstall` | — | Changes MCP client configuration. |
| `doctor` | `doctor` |  |
| `spec` | `spec_example` |  |
| `spec example` | `spec_example` |  |

CLI arguments and options are generated in [commands.md](commands.md). MCP arguments:

| Tool | Kind | Arguments |
|---|---|---|
| `status` | read | `all?`, `cohort?`, `format?`, `detail?`, `offset?`, `limit?` |
| `events_since` | read | `cursor?`, `limit?`, `client?`, `since?`, `cohort?`, `peek?`, `format?`, `detail?` |
| `gc_preview` | read | `detail?`, `offset?`, `limit?`, `older_than?`, `merged?`, `cohort?` |
| `limits` | read | `format?`, `detail?` |
| `set_limits` | write | `claude?`, `codex?`, `confirm?` |
| `reserve` | write | `claude?`, `codex?`, `note?`, `release?`, `confirm?` |
| `version` | read |  |
| `peek` | read | `task`, `lines?` |
| `list_reports` | read | `all?` |
| `get_report` | read | `task`, `section?`, `byte_offset?`, `offset?`, `limit?` |
| `pull_ready` | read | `cohort?`, `all?`, `mode?`, `ack?`, `cursor?`, `offset?`, `limit?` |
| `task_spec` | read | `task` |
| `queue_list` | read | `cohort?`, `format?`, `detail?` |
| `cohort_list` | read | `all?` |
| `cohort_show` | read | `cohort`, `format?`, `detail?` |
| `guide` | read | `project?`, `lang?` |
| `capacity` | read | `format?`, `detail?`, `offset?`, `limit?` |
| `usage` | read | `cohort?`, `since?` |
| `log` | read | `cohort?`, `since?` |
| `stats` | read | `cohort?`, `since?` |
| `overlap` | read | `task?` |
| `resume` | write | `tasks?`, `all?`, `confirm?`, `preview_token?` |
| `send` | write | `task`, `text` |
| `new` | write | `spec`, `agent?`, `reuse?`, `no_agent?`, `cohort?`, `wait_trust?`, `confirm?`, `preview_token?` |
| `queue` | write | `spec`, `cohort?`, `agent?`, `confirm?`, `preview_token?` |
| `queue_rm` | write | `task`, `confirm?`, `preview_token?` |
| `cancel` | write | `task?`, `tasks?`, `cohort?`, `reason?`, `remove_worktree?`, `confirm?`, `preview_token?` |
| `mark` | write | `task?`, `tasks?`, `cohort?`, `result`, `note?`, `confirm?`, `preview_token?` |
| `away` | write | `on` |
| `interrupt` | write | `task`, `confirm?`, `preview_token?` |
| `close` | write | `task?`, `tasks?`, `cohort?`, `remove_worktree?`, `confirm?`, `preview_token?` |
| `move` | write | `task`, `agent?`, `confirm?`, `preview_token?` |
| `queue_show` | read | `task` |
| `mcp_check` | read |  |
| `spec_example` | read |  |
| `doctor` | read | `project?` |
| `equivalents` | read |  |
| `config_show` | read |  |
| `manager_status` | read |  |
| `away_status` | read |  |
| `report` | read | `task` |
| `queue_retry` | write | `task`, `confirm?`, `preview_token?` |
| `queue_up` | write | `task`, `confirm?`, `preview_token?` |
| `queue_pause` | write | `confirm?`, `preview_token?` |
| `queue_resume` | write | `confirm?`, `preview_token?` |
| `unblock` | write | `task`, `drop_after?`, `confirm?`, `preview_token?` |
| `cohort_add` | write | `cohort`, `tasks`, `confirm?`, `preview_token?` |
| `cohort_remove` | write | `tasks`, `confirm?`, `preview_token?` |
| `cohort_archive` | write | `cohorts?`, `older_than?`, `confirm?`, `preview_token?` |
| `cohort_note` | write | `cohort`, `text`, `confirm?`, `preview_token?` |
| `hide` | write | `tasks`, `confirm?`, `preview_token?` |
| `unhide` | write | `tasks`, `confirm?`, `preview_token?` |
| `archive` | write | `older_than?`, `cohort?`, `confirm?`, `preview_token?` |
| `adopt` | write | `task`, `report`, `window?`, `worktree?`, `agent?`, `model?`, `effort?`, `confirm?`, `preview_token?` |
| `report_from` | write | `task`, `from`, `force?`, `confirm?`, `preview_token?` |
| `limits_release` | write | `claude?`, `codex?`, `confirm?`, `preview_token?` |
| `manager_start` | write | `project?`, `name?`, `model?`, `effort?`, `confirm?`, `preview_token?` |
| `manager_stop` | write | `confirm?`, `preview_token?` |
| `notify_test` | write | `phone?`, `confirm?`, `preview_token?` |
| `gc` | write | `detail?`, `offset?`, `limit?`, `cohort?`, `older_than?`, `branches?`, `confirm?`, `preview_token?` |
| `response_page` | read | `response_id`, `response_offset` |

- `guide`: `--project &lt;repo&gt;`, `--lang &lt;lang&gt;`, `--clip`, `--json`
- `capacity`: `--json`, `--clip`
- `new`: `--dry-run`, `--json`, `--reuse`, `--agent &lt;agent&gt;`, `--no-switch`, `--no-agent`, `--no-wait-trust`, `--clip`, `-y, --yes`, `--cohort &lt;name&gt;`
- `queue`: `--clip`, `--agent &lt;agent&gt;`, `-y, --yes`, `--json`, `--cohort &lt;name&gt;`
- `queue list`: `--json`, `--cohort &lt;name&gt;`
- `unblock`: `--drop-after &lt;task&gt;`
- `cohort list`: `--json`, `--all`
- `cohort show`: `--json`
- `cohort archive`: `--older-than &lt;age&gt;`, `--yes`
- `overlap`: `--json`
- `send`: `--dry-run`, `--clip`, `-y, --yes`
- `status`: `--json`, `--clip`, `--tmux-line`, `--all`, `--cohort &lt;name&gt;`
- `limits show`: `--json`
- `limits set`: `-y, --yes`, `--dry-run`
- `limits reserve`: `--note &lt;text&gt;`
- `events`: `--since &lt;time&gt;`, `--cohort &lt;name&gt;`, `--keep`, `--json`, `--clip`
- `usage`: `--cohort &lt;name&gt;`, `--since &lt;age&gt;`, `--json`, `--clip`
- `resume`: `--all`, `-y, --yes`, `--dry-run`
- `up`: `--no-attach`
- `mark`: `--cohort &lt;name&gt;`, `--note &lt;text&gt;`, `-y, --yes`
- `log`: `--since &lt;age&gt;`, `--cohort &lt;name&gt;`, `--json`, `--clip`
- `stats`: `--since &lt;age&gt;`, `--cohort &lt;name&gt;`, `--json`, `--clip`
- `gc`: `--preview`, `--dry-run`, `--verbose`, `--offset &lt;n&gt;`, `--limit &lt;n&gt;`, `--force-links`, `--apply`, `--older-than &lt;age&gt;`, `--branches`, `--cohort &lt;name&gt;`, `-y, --yes`, `--json`
- `archive`: `--older-than &lt;age&gt;`, `--dry-run`
- `pull`: `--ready`, `--all`, `--cohort &lt;name&gt;`
- `close`: `--cohort &lt;name&gt;`, `--rm-worktree`, `-y, --yes`, `--dry-run`
- `cancel`: `--cohort &lt;name&gt;`, `--reason &lt;text&gt;`, `--rm-worktree`, `-y, --yes`, `--dry-run`
- `watch`: `--tmux`, `--restart`, `--no-status-line`
- `board`: `--restart`, `--tmux`
- `report`: `--from &lt;path&gt;`, `--force`, `--json`, `--dry-run`
- `away status`: `--json`
- `manager`: `--name &lt;name&gt;`, `--project &lt;dir&gt;`, `--model &lt;model&gt;`, `--effort &lt;level&gt;`, `--url`, `--dry-run`
- `ntfy-setup`: `--server &lt;url&gt;`, `--regenerate`, `--show-qr`, `--dry-run`
- `notify-test`: `--local`, `--phone`, `--all`
- `adopt`: `--report &lt;path&gt;`, `--window &lt;name&gt;`, `--worktree &lt;path&gt;`, `--agent &lt;agent&gt;`, `--model &lt;model&gt;`, `--effort &lt;effort&gt;`, `--dry-run`
- `interrupt`: `--dry-run`
- `attach`: `--switch-client`
- `event`: `--task &lt;task&gt;`, `--agent &lt;agent&gt;`, `--kind &lt;kind&gt;`, `--forward &lt;json&gt;`
- `usage-tap`: `--task &lt;task&gt;`, `--forward &lt;command&gt;`
- `move`: `--agent &lt;agent&gt;`, `-y, --yes`
- `peek`: `-n, --lines &lt;n&gt;`
- `mcp install`: `--desktop`, `--claude-code`, `--config &lt;file&gt;`, `--dry-run`, `-y, --yes`
- `mcp uninstall`: `--desktop`, `--claude-code`, `--config &lt;file&gt;`, `--dry-run`, `-y, --yes`

<!-- END GENERATED MCP PARITY -->

## Parity and permissions in 0.17.1

Read tools always work. Write tools require their exact name in `mcp.allow`, or an explicit group:

| Group | Expands to |
|---|---|
| `queue:*` | `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume` |
| `cohort` | `cohort_add`, `cohort_remove`, `cohort_note`, `cohort_archive` |
| `manager:*` | `manager_start`, `manager_stop` |

Existing entries `new`, `queue`, `send`, `close`, `cancel`, `set_limits`, `reserve` retain their permission scope. In particular, `queue` does **not** implicitly grant retries or removal. `doctor` explains the change to confirmation: `interrupt`, `close`, and `queue_rm` now require a preview followed by `confirm: true`, as do new parity writes. The existing two-step start/cancel/move/resume tools now enforce a prior preview in this server session. Arguments must be identical; a preview expires after ten minutes and is consumed once. A changed task/queue/window/config scope or GC plan requires a fresh preview, so the scope cannot silently expand. Restarting the server discards previews.

Every write request is recorded in `mcp-audit.log`; successful executions also write `mcp-write` to the journal and notify the desktop. Permission revocation takes effect on the next call. `pull_ready` and `events_since` retain their documented read-tool exception for report-read markers and per-client cursors; they never start or remove work.

`queue_list` includes the complete failed reason and a `queue_retry` hint. Read that reason first. Retry validates remaining directories against Git worktree registrations; an unregistered partial directory is refused. `gc_preview` uses `merged` for its legacy branch option; `gc` uses `branches` (default false). Both call the CLI's `planGc`; confirmation executes that validated plan through `applyGc`. The tool never uses force, merges or pushes. Dirty worktrees, foreign work, protected/current branches and unmerged branches are skipped. A changed plan requires a new preview.

`status` returns a text summary followed by JSON `{disk, tasks}`. `capacity.disk` contains device-deduplicated filesystem readings and the cached size of recorded worktrees. `config_show` masks environment values and ntfy token, topic and credential-bearing URL parts. `report_from` accepts only a regular source inside task worktrees or config.cache; symlink components and outside paths are refused even with force. `force` only permits replacing the canonical report. new/queue enforce the same area for report paths during preview, and report reads recheck the path and opened file. `adopt` accepts explicit metadata paths. `notify_test` is local by default; `phone: true` explicitly sends a phone test.

The generated table above lists every commander command, tool arguments, and justified exceptions. Terminal UI, local installation, internal callbacks and secret generation remain CLI-only. The separate `agentctl-update` executable remains CLI-only because it replaces running code. There is no interactive setup command in the current commander tree. `npm run docs` regenerates the inventory; the guard test fails if a new CLI command has neither tools nor a documented exception.

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
| `cohort_archive` | `cohort_archive` | `cohort` |
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

Groups: `queue:*` = `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume`; `cohort` = `cohort_add`, `cohort_remove`, `cohort_note`, `cohort_archive`; `manager:*` = `manager_start`, `manager_stop`. `queue:*` includes `queue_retry`; retry is technical and retains the same provider.

## Concise reads and report pagination (0.17.2)

| Tool | Read behavior |
|---|---|
| `queue_show` | Full queued/failed spec, start reason and attempt history. |

`events_since`, `status`, `queue_list`, `cohort_show`, `limits`, `capacity`: text only by default; `format: "json"` or `detail: true` returns JSON only. Status rows carry task, agent/model/effort, state, duration, cohort, report (yes/candidate/missing) and open question; overlap detail lives in `overlap`.

`events_since` identifies clients from initialize stable clientInfo.name plus an optional configured/explicit client suffix; non-protocol callers may supply `client`. Each initialized session snapshots the saved client high-water mark and then consumes independently, so concurrent sessions of the same name receive every new event. Later sessions start at the greatest position delivered to any earlier session. An existing legacy mcp marker seeds migration and is removed; new clients use the normal 24h first look. Explicit client (or mcp.client) intentionally shares a cursor within the named client instead. Session checkpoints stay in memory; only the high-water mark is persisted.

`pull_ready`: summary default includes task/path/bytes/first nonempty verdict line, SHA/branch lines and Streszczenie/Summary/Decyzje (otherwise first 40 lines, capped at 1500 characters). Excerpt responses obey mcp.max_response_kb; omitted summaries remain new and are named. `mode: "full"` returns complete report snapshots through response_page. `offset`/`limit` paginate report selection. Summary delivery and full-file acknowledgment are separate. `get_report`: `section` is a Markdown heading (case-insensitive, ends at next same/higher heading); `offset` and `limit` select lines within it, zero based, within mcp.max_response_kb per response. Only a contiguous full-file read marks pulled at EOF; reading a section does not.

Begin work discussion with `events_since`; no separate status is required. Use pull_ready summaries; get_report only for the needed section. Provider percentages, reset and stats inform allocation; token estimates are informational. `self_verdict` is agent self assessment, independent from the human mark; events remind about unmarked reports. `usage_hint` and `draft_input` hold usage footers and unsent input, never lastLine.

## Review corrections: receipt, full delivery and user evaluation

`pull_ready` summary delivery records `summary_delivered` only. It **does not** set pulled and remains visible among reports to read. Each excerpt carries task/attempt, verdict, SHA/branch facts, blockers/questions/errors, decisions, path/size, truncation and detail availability. `ack: true` explicitly attests that the full reports delivered in this response were read through another channel; it sets pulled but never mark. `mode: "full"` marks only fully delivered bodies; oversized reports stay unread and use get_report pagination. CLI pull --ready still copies complete reports and marks on successful clipboard delivery. Human `mark` remains a separate judgment.

`pull_ready` selection is snapshotted per server session/scope. Continue with next_cursor (cursor argument) or offset/limit against that same snapshot; marking earlier reports cannot shrink it and skip later ones. Restart at offset 0 after an expired snapshot. Large single first lines are clipped and labeled in the excerpt, so a report cannot be permanently omitted because of its verdict line.

`get_report` returns page metadata after `--- page ---`: total_lines, returned_bytes, has_more, next_offset and next_byte_offset. offset is zero-based line index; byte_offset is UTF-8 offset inside an oversized single line. Pass both returned offsets to continue. Fenced code headings are not section boundaries. Only contiguous, complete whole-report delivery (same client/attempt/fingerprint) sets pulled at EOF. A section or a jump to EOF does not acknowledge the whole file. Explicit ack remains available after reading outside MCP.

`events_since` prepares event pages up to 16000 UTF-8 bytes; the shared mcp.max_response_kb transport budget further bounds every delivered fragment. limit (default 100, max 200) bounds events per page. has_more/next_cursor are always supplied; continue with cursor. The persistent stable client marker advances only over delivered events. Same-time events have distinct journal positions. A single oversized event is transported in numbered JSON fragments (fragment.offset, total, encoding=json); concatenate text fragments and parse the complete JSON event. The marker does not skip a suffix. Cohort cursors are scoped independently. The client high-water mark survives restarts. Default session cursors are independent; explicit client/config opts into a shared cursor. Legacy mcp migration is consumed once. Obsolete process/session keys are removed and the marker map is bounded to 256 entries.

`queue_show` is always redacted through MCP: all env values, secret-key fields (TOKEN/KEY/SECRET/PASSWORD/PASS/AUTH/COOKIE), known configured secret values, credential URLs and their occurrences in prompt/stderr become ***. CLI queue show retains owner access to the original values. Status JSON again includes collidesWith; the concise text shows counts only.

PL: Dostarczenie skrótu, pełne pobranie i ocena mark to trzy różne fakty. Skrót zostawia raport do przeczytania. ack jest jawnym potwierdzeniem pełnego odczytu inną drogą. Strony events_since nie przesuwają kursora za niedostarczone dane, a get_report podaje oba offsety i oznacza pobranie dopiero po ciągłym odczycie całości. queue_show przez MCP zawsze redaguje sekrety.

PL: Równoległe sesje MCP tej samej nazwy otrzymują niezależnie wszystkie nowe zdarzenia. Nowa sesja zaczyna od najwyższej pozycji dostarczonej poprzednim sesjom tego klienta. Parametr `client` lub `mcp.client` wymusza współdzielony kursor, więc używaj go tylko świadomie.

## A start with setup (0.17.5)

An install (`npm ci` in two repositories) takes minutes; the chat gives a tool call about a minute, and while the call was held the whole server was held with it. Since 0.17.5 `new` with `confirm: true` for a task whose repositories have `setup` does not run it in the MCP server:

- **Hand-over.** The confirm writes an explicit start into the queue directory (`direct`: it does not wait for `after`, a paused queue or `usage.queue_hold`, but still for a free window of its provider and for `queue.parallel_starts`) and returns "Registered: …" within a second. The `MCP new` line is in the journal at once. `agentctl watch` picks the entry up at its next tick (`watch.interval`, 15 s by default) and does the same as for a queued task: worktrees, setup, links, TASK.md, window, prompt. Because the watcher owns it, the setup survives the end of the MCP server (the app quit with ⌘Q).
- **Watcher required.** The watcher leaves a heartbeat every tick. When it is not running (or `queue.enabled` is false) the confirm is refused before anything is created, with "agentctl watch --tmux" as the remedy; the preview already warns. A start from the terminal (`agentctl new`) is unchanged and runs the setup in place, printing its output.
- **Progress.** `status` and `queue_list` show the start as `uruchamiane – setup w toku (repo 1/2 backend: npm ci, 12 s); log: …/setup.log` (the phase before and after: `tworzenie worktree`, `okno i agent`). `events_since` carries `SETUP` when it begins, `BŁĄD SETUPU` (repository, command, exit code, log path; the worktree stays) and `START` when the task is up; the state file is `<state_dir>/<task>/setup.json` while it lasts.
- **Failure.** A failed setup leaves the entry `failed` with the reason (`queue_list`), the worktrees where they are, and `queue_retry` starts it again over them (a transient error such as a timeout is retried by the watcher itself, three times).
- **Repeated calls.** `new` (preview or confirm, with or without the token) for a task whose start is in progress or failed answers with its state ("already being started – setup w toku …", or the failure) and starts nothing a second time.
- **No_agent.** With `no_agent: true` the watcher prepares the worktrees and runs the setup and links, and starts no agent.

Reads do not wait for any of this, or for each other: tmux and git queries are asynchronous child processes, and the size of the worktrees in `status`, `capacity`, `new` and `queue` previews is measured in the background (about one second of waiting at most). When a measurement is still running the answer carries the last reading marked `measuring` ("agentctl worktrees 31.2 GiB (measuring, last reading)"), or n/d the very first time. `gc` and `close` with a worktree removal give `git worktree remove` the `git.timeout_s` allowance instead of 30 s.

## Bounded responses (0.17.3)

Every tool response, including previews, JSON and errors, fits `mcp.max_response_kb` (default 8 KiB, including serialized content overhead). A large response is a JSON envelope with `truncated: true`, `fragment`, `response_id`, `next_response_offset` and `has_more`. Call `response_page` with `response_id` and `response_offset: next_response_offset`; concatenate the fragments to recover the original text or JSON. Offsets here count JavaScript string units. These session-local snapshots retain the most recent 16 responses; expired snapshots require another read or preview, never blindly repeat a confirmed write.

| Tool | Purpose |
|---|---|
| `response_page` | Retrieve the next cached fragment without rerunning a tool, write or event read. |

Write previews show only affected tasks. Global queue pause/resume previews show counts and at most five queued tasks; `queue_list` provides the queue. The private confirmation fingerprint still guards the full observed scope. Closed tasks are absent from ordinary operation previews (archive explicitly targets closed state).

`status` and `capacity` disk data defaults to total size, worktree count and the five largest worktrees. `format: json` does not expand paths. For inventory use `detail: true, offset: 0, limit: 20`; continue with `disk.pathsNextOffset` (each page can also use the response envelope).

`get_report.next_byte_offset` always equals `end_byte`, including EOF. Supply it as absolute `byte_offset` for the next page of the same whole file or selected section; `has_more` tells whether another page exists. Report reads are sized before delivery and only contiguous whole-file delivery marks pulled. Oversized `pull_ready` full reports return response_page fragments and stay unread until contiguous complete delivery.

`guide(project)` reads `<project>/.agentctl.yaml`, appends its `guide` overlay, or explicitly warns about the missing overlay. MCP `doctor` accepts `project`; omitted means “bez projektu”, independent of server cwd. New/queue resolve the project layer from the first repo in each spec.

Report discovery ignores all paths mentioned in prompts and pane text. Only fresh configured report alternatives with the task ID in the basename become candidates. A candidate is a report flag, never a task state; questions remain visible in status and events. Only explicit `report_from` / `agentctl report --from` copies to the canonical path. Status and doctor warn about stored `report_source` copies for human review; they do not alter old files.

## Post-live confirmation fixes

`close(cohort)` previews list the same task IDs as execution. `cancel`, `gc` and `archive` honor the cohort selector; `cohort_add` and `cohort_note` use cohort as a destination/name, not a task selector. Large previews retain all IDs through bounded response fragments; no task is silently omitted. `report_from` previews expose source_exists/source_bytes, canonical_exists, would_overwrite and requires_force. Existing canonical files require force to overwrite. Explicit confirmation clears the legacy provenance warning, retaining reportSource/reportConfirmed in JSON detail.

Initial dispatch is acknowledged by the screen. `needs-attention` reports an unconfirmed paste after at most two additional Enter attempts. Folder-trust deferral is stored in TASK.md and delivered once by new/watch, including the canonical report path and attempt protocol. Dev contexts are labeled “środowisko dev”; differences from stable do not request ⌘Q. Small summaries use truncated:false when delivering the full report and expose sha even when the hash is a standalone backticked value.


### Prompt delivery confirmation

`new` and queue starts succeed even when delivery is uncertain: “dostarczenie niepotwierdzone – sprawdzam”. Do not repeat the order. `send` uses the same adapter confirmation. Watch checks hooks/notify first, then adapter screen progress, transcript echo or a completed canonical report within `delivery_confirm_s` (default 60 s); if none arrives it announces needs-attention once. Later evidence clears that state automatically. Canonical reports unblock events_since, pull_ready, after and cohort completion. Configure `agents.<agent>.working_pattern` and `delivery_pattern` for TUI changes; Claude 2.1.x spinner progress is included by default. Watch must be running to resolve uncertainty.

## NC workflow: reports, reviews and follow-ups

A complete report requests a versioned YAML data block before `<!-- agentctl:report-end -->`:

```agentctl-outputs
version: 1
verdict: PASS
commits: [{repo: app, branch: feature, sha: aaaaaaa}]
integrate: [{repo: app, branch: feature, sha: aaaaaaa, note: proposed integration}]
decisions: [Choose a deployment time]
actions: [{title: Deploy after approval, shell: "echo proposed command"}]
checks: [{name: unit tests, result: PASS}]
preview: https://example.invalid/preview
notes: []
```

`outputs`, `outputs_valid` and `outputs_errors` are shared facts. Branches and SHAs must exist in task repositories. Missing/invalid data warns without making a complete report incomplete. Actions are proposed text; agentctl never runs their shell commands, judges a result, or merges. `status` counts decisions/actions; `pull_ready` and `get_report` include the data. `cohort_show` aggregates integration refs (duplicate/conflicting branch tips flagged), decisions, actions and checks with task IDs. `events_since` includes new decisions/actions in `needYou`, once per report hash. Validation is per section and per entry: a bad entry is dropped with a warning in `outputs_errors`, the valid rest stays in `outputs` (`outputs_partial: true`, `outputs_valid: false`), and `status`/`cohort_show` count the kept decisions and actions. Only a wrong `version`/`verdict` refuses the whole block. `checks` entries are `{name, result: PASS|FAIL|WARN|SKIP, note?}` (the standard form); a plain text (`"unit: PASS"`) or a one-key map (`- unit: PASS`, which is what unquoted YAML gives) is accepted and normalized to it, in any letter case.

```yaml
review: auto
# Or in .agentctl.yaml:
# review: {default: auto, rerun: true, template: review.md}
after: [{task: IMPLEMENT, verdict: [PASS, PARTIAL]}]
repos:
  - path: ~/code/app
    worktree: ~/work/app-check
    branch: check
    base: "@IMPLEMENT:app"
```

Automatic review adds `TASK-REV` after the author report, on the author branch and in the same cohort. It prefers another available provider, using `review.*` or `equivalents`; otherwise it needs another configured model. No valid pairing leaves a visible pending review error. The reviewer gets its own detached worktree (`<worktree_root>/<repo>-<task>-rev`, one per repository of the author, pinned to the author's commit) and writes its own report at `cache/<task-rev>/<TASK-REV>.md`; it never shares the author's checkout or branch. It starts only after the author's turn is over (report-end, report settle time, no follow-up queued or unconfirmed, no draft, no git running in the author's checkout); until then the queue shows `czeka na autora …`. If the author commits again before the review starts, the review is re-pinned to the new SHA (delta and heads updated, journal `review-repinned`). `review.rerun: true` schedules `REV2` for a new report, with the previous review's scheduled SHA as the delta base. The first base is the author's recorded base. See the review template in `docs/examples/` and the configuration reference for overrides.

`base: "@TASK"` resolves at start to that task's output commit, otherwise its branch HEAD; specify `:repo-name` for multiple repositories. The resolved commit is shown in the new preview and stored in TASK.md. Missing or ambiguous sources block start. A verdict condition blocks on another verdict or `brak werdyktu`; ordinary `after: TASK` still waits only for a complete report.

`send` pastes a follow-up immediately while Claude/Codex work. Delivery is confirmed from submission, a new working state, transcript/queued-message echo or a new complete report. `idle_prompt` and a late Stop alone do not confirm it; a stuck composer becomes `needs-attention` after `delivery_confirm_s`. An idle-only adapter (`accepts_busy_prompt: false`), or an unconfirmed previous message, keeps later messages in a durable FIFO. Status/peek show the queue; the response says pasted, queued position, or unconfirmed. The watcher drains it in order.

A provider limit emits one notice per episode with the known reset (otherwise `n/d`). Fresh remaining capacity above `limited.resume_above_percent` (5 by default), or an elapsed known reset, permits `limited.message` (`kontynuuj`) to the idle empty window. The overload guards check again before paste and Enter; attempts and limits survive restarts. `limited.auto_resume: false` disables sending. Provider and model stay the same.

`agentctl mark --cohort NC ok --note "reviewed"` previews its exact range; `--yes` confirms. MCP accepts `task`, `tasks` or `cohort`; more than one task requires preview/confirm. With a cohort filter, board `o/p/f` previews its IDs before marking. Agentctl records the user's result. Closing every cohort task emits `gc_suggest` with that cohort's protected cleanup preview; it never deletes automatically.

MCP previews have independent `preview_token` values, expire after ten minutes and refuse a changed range. Pass the token and identical arguments with `confirm: true`; omitting a token uses the latest matching preview for compatibility. `gc_preview` with a cohort gives only the count of foreign worktrees; confirmed `gc` returns its results without repeating the plan. `notify.mcp_writes` defaults to `summary`, at most once per 60 seconds; `all` and `off` are explicit alternatives. Audit remains complete. F12 returns to the board of the current configured session, including a parallel dev session. Duration includes checkout/setup before the agent starts; stale plan notices are once per reading.

### P19-FIX2: registered batches

A direct reviewer registered with its author, or while that author is in setup, waits with `waiting for author TASK: setup in progress` until the author's TASK.md exists. The reviewer is then checked against that record's effective provider/model. An author start failure fails the reviewer with the author's name and reason; fix/retry the author, then retry the reviewer. Waiting reviewers do not consume a provider slot or a parallel start. Provider limits and the existing direct-start priority policy still apply.

The idempotent `new` state response applies only when every requested task is already registered. Mixed batches are refused with the already-registered task names; preview the fresh tasks separately. `SETUP` is recorded for each repository command, and `SETUP OK` / `BŁĄD SETUPU` records its exit code; all include the command and setup log path.
