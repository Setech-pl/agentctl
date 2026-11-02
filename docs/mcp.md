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
| `status` | `all?`, `cohort?` | One line ("3 tasks: 1 working, 1 report-ready, 1 waiting") and the rows as JSON: agent, model, effort, state, window, `started` (UTC) and `startedLocal`, duration, progress, report, whether it was pulled, last line, the open question, hint, finished, hidden, closed, archived. Hidden and closed tasks only with `all: true`. A chat should call it first. Before the rows, `status` says which server version answers (`MCP server: agentctl 0.10.0 (script, pid, started)`, with a hint when the stable copy on disk is newer) and any `Config warning:`. |
| `version` | none | The version of agentctl this server process runs, its script, pid and start time, the version of the stable copy on disk (`older: true` when they differ), the write tools the user allowed and the warnings about the MCP part of the config. Use it when a tool seems to be missing. |
| `peek` | `task`, `lines?` (1 to 200, default 40) | The last lines of a running task's window without the agent's footer. |
| `list_reports` | `all?` | Which tasks have a report: size, `modified` (UTC) and `modifiedLocal`, whether it was pulled. |
| `get_report` | `task` | One report, up to 200 KB. It reads only the file that the task's `TASK.md` names, never a path from the chat, and refuses a report that is a symbolic link. It does not mark the report as pulled. |
| `pull_ready` | `cohort?` | All reports that are ready and not yet pulled, each under `=== NC-42 (claude opus/high) ===`, in one answer (up to 200 KB; the rest stays new). Marks them as pulled. This is the only read tool that changes anything, and only in agentctl's own state. A chat should call it at the start of discussing finished work. |
| `queue_list` | none | The task queue: position, agent/model/effort, priority, `after`, what each task waits for (`startCondition`: `czeka na miejsce: claude 2/2`, `czeka na NC-42`, paused), since when, and the error of a start that failed. |
| `overlap` | `task?` | Pairs of active tasks of one repository that changed the same files, with the file lists (from git, now). `status` also carries `collidesWith` per task, and short `Queue` and `Collisions` lines. |
| `cohort_list` | none | The cohorts (named groups of tasks): per cohort the number of tasks by state (`active`, `queued`, `reports`, `closed`, `cancelled`), `total`, `created` and the note. |
| `cohort_show` | `cohort` | One cohort: its note, every task in it as `status` shows it (closed and cancelled ones too) and its queued tasks with what each waits for. |
| `task_spec` | `task` | The header of a task (agent, model, effort, repos and worktrees, report path, `started` and `startedLocal`, `pulled` and `pulledLocal`, `review_of`, `continues`, `superseded_by`, `pin`, `closed`, names of env variables without values) and the prompt from `TASK.md`. |

`task` is a task ID, case-insensitive; a unique prefix is enough.

All times are given twice: the ISO or `YYYY-MM-DD HH:MM` value in UTC, and the same moment in the local time zone of the machine (`startedLocal`, `pulledLocal`, `modifiedLocal`). A chat should show the local one.

## Write tools

Off until you list them in `~/.agentctl/config.yaml`. The list is read again on every call: a change works at once, and removing a name revokes it at once.

```yaml
mcp:
  allow: [send, interrupt]     # any of: send, new, interrupt, close, move, queue, queue_rm, cancel
  allow_rm_worktree: false     # close may also remove the git worktree
```

| Tool | Arguments | What it does |
|---|---|---|
| `send` | `task`, `text` (up to 20,000 characters) | Pastes a prompt into the window of a running task and presses Enter. |
| `new` | `spec`, `confirm?` | Starts tasks from a spec text, validated like the CLI. The first call only returns the summary; tasks start only when it is called again with `confirm: true`. A spec with `setup` (shell commands) is refused, because a chat must not choose shell commands. It never waits for a folder-trust dialog (a human answers it in the window) and never switches provider. |
| `interrupt` | `task` | Sends the agent its interrupt key; the window stays open. |
| `close` | `task`, `remove_worktree?` | Closes the window and marks the task closed. The worktree and the branch stay, unless `remove_worktree: true` and `mcp.allow_rm_worktree` is set (`git worktree remove`, never forced). |
| `queue` | `spec`, `agent?`, `confirm?` | Puts the tasks of a spec text in the queue (`priority`, `after` and `touches` work as in the CLI). The first call only returns the summary (where each task will stand, the review hint, `touches` warnings); the tasks are queued when it is called again with `confirm: true`. `setup` is refused, as in `new`. They start by themselves while `agentctl watch` runs. |
| `queue_rm` | `task` | Takes a waiting or failed task out of the queue; it becomes cancelled (as `cancel` does for a queued task) and the tasks that wait for it become blocked. |
| `cancel` | `task` or `cohort`, `reason?`, `remove_worktree?`, `confirm?` | Abandons a task, or all open tasks of a cohort: a task at work is interrupted and its window closed after `cancel.grace` seconds, a queued task leaves the queue. The task becomes cancelled; the worktree, the branch and a written report stay. A move is cancelled with its other half. The first call only describes what would be cancelled; `confirm: true` does it. `remove_worktree` needs `mcp.allow_rm_worktree`, as in `close`. The desktop notice names the reason. |
| `move` | `task`, `agent?`, `confirm?` | Hands a task that hit its usage limit to the other provider. The first call only describes the move; `confirm: true` does it. |

## Safety model

- There is no tool for merge, push, rebase, deleting a branch or running a shell command, and none that reads a file other than a report named by a task's `TASK.md` or the `TASK.md` itself. No argument is a path.
- Every write is refused unless `mcp.allow` lists it. Refused calls are recorded too.
- **Audit log:** `~/.agentctl/mcp-audit.log` (next to the config), one JSON line per step: time, tool, task, outcome `requested`, then `done`, `error`, `denied` or `preview`. The `requested` line is written before the action, and a write that cannot be recorded is not done.
- **Notification:** a done write is announced on the desktop (`czat zlecił: <action> <TASK>`).
- **Two-step tools:** `new`, `queue` and `move` change nothing on the first call; the chat has to show the summary and call again with `confirm: true`.
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
- The report limit is 200 KB per answer; larger reports are cut with a note, and `pull_ready` leaves what does not fit as new.
