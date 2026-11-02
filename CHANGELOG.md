# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) while it is below 1.0 (minor versions may change behaviour).

Versions 0.1.0 to 0.7.0 correspond to pull requests #1 to #7; their dates are the merge dates. The version numbers were assigned afterwards, when this changelog was written.

## [Unreleased]

Nothing yet.

## [0.13.0] - 2026-11-02

Pull request: phone notifications through ntfy and away mode, `docs/details.pl.md`. The date is the day it was prepared; set it to the merge date.

### Added
- **Phone notifications.** `notify.ntfy` (`server` default `https://ntfy.sh`, `topic`, `token` as a Bearer header, `events` default all ten: `needs-input`, `needs-trust`, `limited`, `blocked`, `report-ready`, `cohort-done`, `queue-failed`, `orphan`, `dead`, `usage-critical`; `priority` per event, `high` for `needs-input`, `limited` and `usage-critical`; `include_verdict` default true; `click_url`; `always`). The request is `POST <server>/<topic>` with `Title`, `Priority`, `Tags`, `Click` and `Authorization`; a title with non-ASCII characters is sent as RFC 2047. The message holds only the task ID, the name of a cohort and the first line of the verdict, with path-like words cut; never a report, a question, a path or a file name. It is sent from the journal write, so the phone gets exactly what the Mac announced (the de-duplication of the Mac applies); the journal entry gets `phone: sent|queued` and `events` marks it with 📱. A failed request is queued in `phone-queue.json` and retried by the watcher three times (30 s, 2 min, 10 min), then dropped with a line in `phone.log`; the watch log warns once an hour; a network error never stops the watcher. `orphan` is a journal kind now, and a `usage` entry carries `level`.
- **Away.** `agentctl away [status|on|off]` (state in `<config dir>/away.json`, `--json` for status); the phone is quiet while away is off unless `notify.ntfy.always: true`; the Mac is not affected. `away.auto_idle: <minutes>` (macOS, `ioreg` `HIDIdleTime`) turns it on when the Mac is idle and off at the first activity; a hand-made `off` is not undone while the Mac stays idle. Off by default.
- **`agentctl ntfy-setup [--server URL] [--regenerate] [--show-qr] [--dry-run]`**: a random topic (`agentctl-` and 24 hex digits) written to `config.yaml` with comments and key order kept (the YAML edit is shared with `limits set` now: `config-edit.ts`), steps for iOS and Android and for a server of your own, the warning that on the public ntfy.sh the topic is the only protection. `--show-qr` uses `qrencode` when installed; no dependency was added. `doctor` warns about a weak topic and a private server without a token, and shows away.
- **`agentctl notify-test [--local|--phone|--all]`**: the channel, the result and the time of each; the phone test ignores away and never prints the whole topic.
- Board: `📱 away` / `📱 always` / dimmed `📱 off` in the header and key **`w`** (after y/N). tmux status line: `📱` in front while away is on. MCP: `status` and `events_since` carry the away state; write tool **`away`** (`on`) behind `mcp.allow`, no confirm step, audited and announced.
- **`docs/details.pl.md`**: the full Polish equivalent of `docs/details.md`; `README.pl.md` links to it. The link test covers both and a test keeps their headings, tables and code blocks in step.
- Live scenarios `scripts/live-phone.ts` through the harness: a mock ntfy server on localhost (one request, headers, no report text, no duplicate from the watcher, none with away off, queue and retry after a dead server) and one request to the public ntfy.sh on a random temporary topic (HTTP 200).
- Documentation: Phone notifications in both READMEs and both details files, `docs/configuration.md` (`notify.ntfy.*`, `away.*`), `docs/mcp.md`; the sequence and architecture diagrams show the phone.

### Changed
- The board key line is `m M move i int c/r pull x close X cancel k cohort h hide l log L G R w u/d/p ?` (it must fit 80 columns).
- `Context` has a `fetch` for the phone (tests give a mock).

### Limitations
- On the public ntfy.sh the name of the topic is the only protection. The `ntfy://` link of `--show-qr` was not tried on a phone. `away.auto_idle` needs macOS (`ioreg`). Texts on the phone are in Polish, like those of the Mac.

## [0.12.0] - 2026-11-02

Pull request: live limits, events for the chat, gc, resume, `agentctl up`, a safe harness for live tests. The date is the day it was prepared; set it to the merge date.

### Added
- **Limits.** `agentctl limits` (limit, used and free per provider; the windows of agentctl, the reserved places and the external sessions; the queue), `limits set claude=3 codex=5 [-y]` (edits `config.yaml` with the YAML document API: comments and the order of the keys stay; `config.yaml.bak`; the result is loaded to check it; `codex=off` removes a limit), `limits reserve claude=1 [--note]` / `limits release` (places for agents started by hand, `<config dir>/reservations.json`), and `limits.count_external: true` (claude/codex terminal sessions outside the agentctl session, found with `ps`, `tmux list-panes` and `lsof`; MCP servers, headless runs, `usage-tap` and agentctl itself are not counted). Reserved and external places count in `new`, `queue`, `queue list`, `resume` and the board.
- **Config reload.** `watch` and the MCP server read `config.yaml` again when its text changes (`fs.watch` and a check at every tick), for every key. A raised limit starts waiting queue tasks at the next tick. A file that does not load changes nothing: the previous settings stay, the watch log warns once, `config-state.json` records it, and `doctor` (warning `config reload`), the MCP `status` / `version` and the CLI error say so. A `notify` change rebuilds the notifier.
- **Events for the chat.** `<config dir>/journal.jsonl` (reports ready with the verdict, starts from the queue, failed starts, questions, folder trust, blocked, cancelled and limited tasks, vanished windows, finished cohorts, plan thresholds, changed limits), `agentctl events [--since last|30m|2h|HH:MM|ISO] [--cohort X] [--keep] [--json] [--clip]` and the MCP read tool **`events_since`** (`since`, `cohort`, `peek`): the events after a time or after the previous call of the client (a marker per client, `cli` and `mcp`; the first call looks back 24 hours) and a line with the state now (active, queued, reports to pull, tasks that wait for you). The tool description tells a chat to call it at the start of every answer about the agents' work.
- **gc.** `agentctl gc [--apply] [--older-than 7d] [--branches] [--cohort X] [-y] [--json]`: a dry run with sizes; worktrees of closed, cancelled and archived tasks without uncommitted changes (`git worktree remove`, never forced), files next to the reports older than the age (the `*.md` stay), the state of closed tasks moved to the archive, and with `--branches` merged branches (`git branch -d`, never `-D`, never `main`/`master`, the current or a remote branch). Uncommitted work, worktrees of others, unmerged branches and too new files are listed as skipped with the reason; a cache folder that belongs to no agentctl task is not touched; history and reports stay. `--apply` lists, asks y/N and reports what was freed. Board key **`G`** (preview), MCP read tool **`gc_preview`** (`older_than`, `merged`, `cohort`). `Runner` gets `remove`.
- **Resume.** `agentctl resume [TASK…] [--all] [-y] [--dry-run]`: for active tasks that have a worktree and no window (after a restart), the window comes back and the agent starts in resume mode with the same model, effort, flags, hooks and usage tap, without the prompt: Claude `--resume <session>` (recorded by the hooks / usage tap) or `--continue`, Codex `resume <session>` or `resume --last` (flags after `resume`, checked against `codex resume --help` of 0.166.0). Tasks with a report are skipped unless `--all`; provider limits are respected. `watch` sends one notification at its start, "N zadań do wznowienia". Board: section **"Do wznowienia"** and key **`R`** (after y/N). MCP write tool **`resume`** (`tasks`, `all`, `confirm`).
- **`agentctl up`.** The start of the day: `watch --tmux` and `board --tmux` (each only when its window is missing), the resume hint, then attach / switch-client to the board; without a terminal (or with `--no-attach`) it prints the command.
- MCP: read tools `events_since`, `limits`, `gc_preview`; write tools `set_limits`, `reserve` and `resume`, behind `mcp.allow`, with a summary first and `confirm: true`, audited and announced.
- **Live-test harness** `scripts/live-harness.ts`: an isolated tmux server (`TMUX` unset, own `TMUX_TMPDIR`, `tmux.conf` with `default-command` and an explicit PATH), own `AGENTCTL_HOME`, `CODEX_HOME` (no `notify` chain), `CLAUDE_CONFIG_DIR` and `HOME`, a PATH of fake `claude`, `codex`, `pbcopy`, `pbpaste`, `terminal-notifier`, `osascript` and no directory with a real `claude` or `codex`; it refuses to start when `command -v` or the tmux socket point at the real thing. `scripts/live-scenarios.ts` runs the live checks of this release through it. Documented in CONTRIBUTING.md; the refusals are tested.
- Documentation: the Limits, Events for the chat, Cleaning up and Resuming sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the architecture and flow diagrams show the reload, the journal, `ps`, resume and gc.

### Changed
- The board key **`G`** (open all cohort groups) is now **`E`**; **`G`** is the clean-up preview. The key line is `m msg M move i int c/r pull x close X cancel k cohort h hide l log L G R u/d/p ?`.
- The only branch deletion agentctl does is `gc --branches` with `git branch -d`.
- `Context.config` can be replaced while a process runs (`Context.setConfig`).
- Board tests of the log and result keys are in one place (the copy in `history.test.ts` is merged into `usage-board.test.ts`).

### Limitations
- Events are recorded while `agentctl watch` runs (and by the commands that write them themselves). External sessions are found by process name: a renamed wrapper is not seen. `resume` starts the agent but does not check that it came up; a folder-trust dialog, if one shows, is for a human.

## [0.11.0] - 2026-11-02

Pull request: token usage, plan limits, task history and stats. The date is the day it was prepared; set it to the merge date.

### Added
- **Usage.** `agentctl usage [--cohort X] [--since 7d] [--json] [--clip]`: per provider the 5 hour and weekly window (percentage used and reset time, or n/d) and the tokens today and in the period; the active tasks with their tokens; the cohorts; the models. Tokens are read from the agents' own logs, incrementally (a cache of file offsets in `<config dir>/usage-cache.json`): Claude Code transcripts (`~/.claude/projects/…`, subagents included) and Codex session logs (`~/.codex/sessions/…`). A session belongs to the task whose worktree it ran in, between the task's start and its end (also across `move`); the sessions named by the agent's events (`<state_dir>/<task>/sessions.json`) count too. The number shown is input + output + cache writes; cache reads are kept apart.
- **Plan limits.** Codex: from the `rate_limits` of the newest session log. Claude Code: only a statusLine command gets them, so `new` sets the `statusLine` of a Claude window to the new command **`agentctl usage-tap`**, which stores the windows, remembers the session and runs your own statusLine afterwards with the same input (your status line does not change; a statusLine that is not a `command` is left alone). What is not known is **n/d** (no reading yet, no subscription, a window reset since the reading, no log): nothing is guessed.
- `status`: a `TOKENS` column (`1.2M`) when a session log is found (n/d for a task without one), `tokens` in `--json`, a column in `--clip`.
- Board: a usage panel under the title (bar, percentage and reset per provider; green, yellow, red by the thresholds), a `TOKENS` column, **`l`** the log, **`o`** / **`p`** / **`f`** mark the selected finished task. The tmux status line adds `C 62% · X 18%` (`usage.status_line`).
- **Warnings.** `watch` notifies once when a plan window crosses `usage.warn` (80) and once when it crosses `usage.critical` (95), per provider and window period (`<config dir>/usage-alerts.json`). The summary of `new --clip` and `queue` shows the plan of the task's provider and the hint "claude blisko limitu (83%), codex ma zapas (15%): --agent codex" (nothing is switched; a pinned task stays). **`usage.queue_hold`** (off by default) keeps the queue from starting tasks of a provider above that percentage; `queue list`, `status` and the board say why.
- **History.** `<config dir>/history.jsonl` gets a record when a report is ready, and when a task is closed, cancelled, moved or marked: task, cohort, project, requested and effective agent/model/effort, start, report, close or cancel with the reason, duration, tokens (null when unknown), commits and files, the first line of the verdict, the move, the result. **`agentctl mark <TASK> ok|partial|fail [--note]`**, **`agentctl log [--since] [--cohort] [--json] [--clip]`**, **`agentctl stats [--since 30d] [--cohort] [--json] [--clip]`** (per agent/model/effort: tasks, median time and tokens, shares of ok/partial/fail among the marked, unmarked, cancelled, moved after a limit).
- MCP: read tools **`usage`**, **`log`**, **`stats`** (`cohort`, `since`), write tool **`mark`** behind `mcp.allow` (audited, no confirm step), a one-line plan summary in `status`.
- Config: the `usage` section (`warn`, `critical`, `queue_hold`, `status_line`, `claude_tap`, `claude_dir`, `codex_dir`).
- Documentation: the Usage and limits and History and stats sections of both READMEs and `docs/details.md` (formats that were checked, what is n/d), `docs/configuration.md`, `docs/mcp.md`; the architecture diagram shows the readers of the agents' logs and the usage tap.

### Changed
- The board key line is `m msg M move i int c/r pull x close X cancel k cohort h hide l log o/f u/d/p ?` (the arrows and Enter are in the help). The board list has a `TOKENS` column from 69 columns on.
- Tests read the agents' logs from the scratch directory (`usage.claude_dir`, `usage.codex_dir`), never from the real `~/.claude` and `~/.codex`.

### Limitations
- Tokens are those of the sessions agentctl can bind to a task; sessions you start by hand and Claude's limits outside task windows are not seen. A Codex session resumed or forked from another counts the inherited history again. The formats are the agents' own and undocumented: a change in them shows as n/d.

## [0.10.0] - 2026-11-02

Pull request: task cancellation and cohorts. The date is the day it was prepared; set it to the merge date.

### Added
- **Cancelling.** `agentctl cancel <TASK…> [--reason "…"] [--rm-worktree] [-y] [--dry-run]`: shows the list and asks y/N. A task at work gets the agent's interrupt key, then `cancel.grace` seconds (default 5, one wait per command), then its window is closed; a finished task without a window is only marked; a task in the queue is taken out of it (`queue rm` is its alias, without a reason). The task is **`cancelled`** (new state ✕, not `closed`): `cancelled`, `cancelled_at`, `cancel_reason` and `cancel_source` (`cli`, `board`, `mcp`) in `TASK.md`. The worktree and the branch stay; `--rm-worktree` runs `git worktree remove` (never `--force`, never a branch). A task from `move` is cancelled together with its other half, after one question.
- A cancelled task leaves `status` and the board (`status --all` and the board key `a`: section **Cancelled**; `cancelled`, `cancelledAt`, `cancelReason` in `status --json`), does not count against the window limits, is not taken by `pull --ready`, gives no "window vanished" notification and no collision. Its report, if one was written, stays (`pull <TASK>`).
- **Blocked tasks.** A queued task whose `after` names a cancelled task is blocked (⛓): `status`, `queue list` (`blocked` in `--json`) and the board show `⛓ zablokowane – NC-42 anulowane`; it never starts (a task that waits for a blocked one is blocked too). `watch` sends one notification per cancelled author, "NC-43 zablokowane – NC-42 anulowane". `queue` and `new` refuse an `after` that names a cancelled task. **`agentctl unblock <TASK> [--drop-after <TASK>]`** removes the dependency; `agentctl cancel` is the other way out.
- **Cohorts.** Spec field `cohort: <name>` and `--cohort <name>` on `new` and `queue` (the flag wins). No name, no cohort: there is no default and none is made up. Names: letters, digits, `-`, `_`, `.`, compared without regard to case, shown as first written; the first task makes the cohort (`<config dir>/cohorts/<name>.json`: created, optional note). `cohort` of a task is in its `TASK.md` and queue entry.
- `agentctl cohort list [--json]` (tasks per cohort: active, queued, reports, closed, cancelled; since when), `cohort show <name> [--json]`, `cohort add <name> <TASK…>`, `cohort remove <TASK…>`, `cohort note <name> "…"`.
- `--cohort <name>` filter on `status` (with `--json` and `--clip`), `pull --ready`, `close`, `cancel` and `queue list`; `close --cohort` and `cancel --cohort` list the tasks and ask y/N. `status` has a `COHORT` column once any task has a cohort.
- `watch`: "kohorta <nazwa>: wszystkie raporty gotowe (N)" when every task of a cohort that was not cancelled (queued ones included) has a report; once per cohort, again only when a task joins.
- Board: **`X`** cancels (optional reason, then y/N; also on queued tasks and in the menu of a finished task), grouping by cohort with foldable headers that carry the counts of states (`g` folds, `G` opens all, "bez kohorty" last), **`k`** picks the cohort to show, **Cancelled (N)** section under `a`, ⛓ in the Queue section.
- MCP: write tool **`cancel`** (`task` or `cohort`, `reason`, `remove_worktree` behind `mcp.allow_rm_worktree`, `confirm: true` after a description; audited and announced with the reason), read tools `cohort_list`, `cohort_show` and `version`, `cohort` argument of `status` and `pull_ready`; `cohort`, `cancelled`, `cancelReason` in the status rows. `mcp.allow` accepts `cancel`.
- Config: `cancel.grace`; `cancelled` among the keys of `watch.window_icons` (default ✕).
- Documentation: the Cancelling tasks and Cohorts sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the flow, architecture and state diagrams show cancelling, blocked tasks and cohorts.
- `agentctl mcp check` and the MCP `version` tool: see Fixed.

### Changed
- On the board **`k` no longer moves the selection up**: it is the cohort filter. The arrow moves up, `j` still moves down. The key line is `↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?`.
- `queue rm` makes the task `cancelled` (it used to leave nothing behind) and says which waiting tasks became blocked.

### Fixed
- **One unknown name in `mcp.allow` switched the whole MCP server off** (for example `queue` read by an older server): nothing worked, not even `status`. Unknown names, unknown keys and wrong types in the `mcp` section are now warnings: the entry is ignored, the rest works, and `status`, `version` and `agentctl doctor` show the warning. Only a config that cannot be read at all stops the server.
- **The Claude app kept the old MCP server process after `agentctl-update`.** The server now tells its version and script (MCP `version` and a line in `status`, with a hint when the stable copy on disk is newer). `agentctl doctor` and, at its end, `agentctl-update` run `agentctl mcp check`: it finds `agentctl … mcp` processes that started before the stable copy was last updated and warns "serwer MCP w aplikacji działa na starej wersji – zamknij aplikację Claude (⌘Q) i otwórz ponownie". Nothing is stopped for you; `docs/mcp.md` describes the update as quitting the app.

### Known limits
- `cancel` does not undo what the agent did; an unclean worktree is refused by `--rm-worktree`, as by `close`.
- The staleness check compares process start times with the update time of the stable copy (`package.json`, `node_modules`); a server of another checkout is not judged.
- Cohort and cancellation data are kept per task for a later usage and stats milestone; nothing counts them yet.

## [0.9.0] - 2026-11-02

Pull request: queue, dependencies, collision warnings. The date is the day it was prepared; set it to the merge date.

### Added
- **Queue.** `agentctl queue [file|-|--clip] [-y] [--agent]`: the same checks as `new` (review_of, pin, `--agent` mapping, Codex efforts, duplicates, repositories) except the provider limit, a summary, y/N, then one JSON entry per task in `<config dir>/queue/`. `queue list [--json]`, `queue rm`, `queue up`, `queue pause`, `queue resume`, `queue retry`.
- `agentctl watch` starts the next queued task (high priority first, then first come, first served) when its provider has a free window, by the path of `new`, in the background: a start that waits for the folder-trust dialog (`needs-trust` is notified) does not stop the rest of the queue. Notification "Uruchomiono TASK z kolejki". The queue never switches provider by itself.
- A start that fails puts the task at the end of the line as `failed`, with a log (`queue/<n>-<TASK>.log`) and a notification; it is not retried in a loop.
- `new` with a full provider limit asks "add to the queue? [y/N]" (without a terminal the error names `agentctl queue`).
- **Dependencies.** Spec field `after: <TASK or list>`: a queued task starts when each named task has a report (`report-ready`, or closed with a report). `status`, `queue list` and the board say "czeka na TASK". An unknown task, a self reference and a circle are errors at adding; `new` refuses a task whose `after` is not met. A review (`review_of`) without `after` gets a hint in the summary.
- **Collisions.** `watch` compares, every `collisions.interval` (300 s), the files changed by each active task (commits over the base plus uncommitted) per source repository: `COLLIDE` column in `status` (`⚠ LANDING-QS-1: 2`, also `collide` in `--json`), `⚠` on the board, one notification per new pair (remembered in `collisions.json`). `agentctl overlap [TASK] [--json]` lists the shared files.
- Spec fields `priority: high|normal` and `touches: [globs]`; `queue` and `new` warn (and ask y/N) when an active task already changes files matching `touches`.
- Board: **Queue (N)** section under the active tasks (`u` front, `d` remove after a question, `p` pause or resume), the preview of a queued task, `⚠` marker and the colliding tasks in the preview title. The tmux status line counts the queue (`2⚙ 1⏳ 3⧗`).
- MCP: read tools `queue_list` and `overlap`; write tools `queue` (summary first, `confirm: true` to queue; `setup` refused) and `queue_rm`, both behind `mcp.allow`, audited and announced; `status` carries short `Queue` and `Collisions` lines and `collidesWith` per task.
- Config: `queue.enabled`, `queue.parallel_starts`, `collisions.enabled`, `collisions.interval`, `collisions.notify`, `collisions.ignore`. Documentation: the Queue, Dependencies and Collisions sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the flow, architecture and state diagrams show the queue.

### Changed
- The board key line is shorter (`c/r pull`, `u/d/p`) to stay within 80 columns.
- `mcp.allow` accepts `queue` and `queue_rm`.

### Known limits
- The queue moves only while `agentctl watch` runs; `watch` reads the config when it starts.
- Collisions compare file names, not hunks.

## [0.8.0] - 2026-11-02

Documentation and help. The date is the day it was prepared; set it to the merge date.

### Added
- `README.md` rewritten as a project home page, with a Polish counterpart `README.pl.md`: problem, key features, quick start, daily loop, spec format, configuration, board, notifications, model equivalents, MCP, comparison with other tools, safety model, limitations and roadmap.
- Mermaid diagrams (end-to-end sequence, architecture, task states) in both READMEs and in `docs/diagrams.md`.
- `docs/commands.md`: every command, subcommand and option, generated from the command definitions by `npm run docs` (`scripts/gen-docs.ts`). A test fails when the file is out of date.
- `docs/configuration.md`: every key of the global config, the project config and the spec, with type, default and meaning. A test fails when a key in the code is not described, and when a built-in screen pattern differs from the one shown.
- `docs/mcp.md`: the MCP tools, the allow-list, `confirm`, the audit log, install, what has been checked and the limits.
- `docs/details.md`: the long-form sections of the old README (events, notifications, limits and move, window icons, navigation, board, folder trust, stable install and others).
- `agentctl <command> --help` ends with examples for every command; the same examples appear in `docs/commands.md`.
- `CONTRIBUTING.md`, with the rule that closes every milestone.
- Test that relative links and anchors in the documents resolve, and that the README and its Polish counterpart link to each other.
- `package.json`: `description`, `keywords`, `homepage`, `bugs`; `docs` and the Polish README in `files`.

### Changed
- MCP: `status`, `task_spec` and `list_reports` return local times (`startedLocal`, `pulledLocal`, `modifiedLocal`) next to the UTC values, as `status --json` does. A chat had shown the UTC time as the start time.
- `agentctl new --help` mentions the setup commands.
- The lists of accepted config and spec keys are exported constants (used by the tests that check the documentation); behaviour is unchanged.

## [0.7.0] - 2026-11-01

Pull request #7: daily-use reliability, finished tasks in the board, local MCP server.

### Added
- `agentctl mcp`: a local MCP server on stdio (official SDK) for the Claude app, Claude Code and VS Code. Read tools `status`, `peek`, `list_reports`, `get_report`, `pull_ready`, `task_spec`; write tools `send`, `new`, `interrupt`, `close`, `move`, off unless listed in `mcp.allow`, audited in `mcp-audit.log`. `agentctl mcp install` and `uninstall` register it in the desktop app (diff, y/N, dated backup, other servers kept) and in Claude Code; `doctor` checks the registration.
- `agentctl hide` and `unhide`; `board.auto_hide_pulled_dead`.
- `agentctl close` marks the task closed (`closed`, `closed_at`): it leaves `status`, the board, `pull --ready`, `watch` and the window limits. `status --all` lists closed and archived tasks. `agentctl archive [--older-than]` moves the state of closed tasks to the archive folder.
- Board: tasks without a window sit in their own **Finished** section; Enter on one opens a menu; closed tasks have their own section (key `a`).
- State `background`: the agent idle at its prompt while its own shells and monitors run. Its end of turn is not announced and `watch` does not call it waiting.
- `notify.backend` (`auto`, `terminal-notifier`, `osascript`): when terminal-notifier cannot show notifications, the same notification goes out through `osascript`, and terminal-notifier is left alone for an hour. `agentctl notify-test` says which channel carried a test message.
- Navigation: `mouse on` in the agentctl tmux session (`board.mouse`) and a key back to the board from any window (`board.return_key`, default F12).

### Changed
- `board --tmux` and `watch --tmux` start their command as the process of the window, with `remain-on-exit failed`, so a failed start stays on the screen; the board waits for a terminal size, draws even with `CI` set, and logs to `board.log`.
- `mcp install --dry-run` says that nothing was written and names the backup a real run would make.
- The Finished and Closed titles of the board use `+` and `-`, so they are not taken for the selection marker.

### Fixed
- No state folder is created for an orphan window just because it was announced.

## [0.6.0] - 2026-11-01

Pull request #6: event notifications, click-to-window, verdict, limits.

### Added
- Events from the agents themselves: Claude Code hooks (`Notification`, `Stop`, `StopFailure`) through `--settings`, Codex through `-c notify=…` (the user's own `notify` command is forwarded). `agentctl event` records them, updates the task state at once and notifies. `notify.events` and `notify.turn_end` switch them off.
- States `limited` (usage limit used up; `agents.<agent>.limit_patterns`) and `superseded`.
- `agentctl move`: hands a task that hit its limit to the other provider in the same worktree.
- Notifications through `terminal-notifier` with click-to-window (`agentctl attach --switch-client`); the "report ready" text quotes the verdict line of the report (`notify.verdict_pattern`); one transition is announced once, whichever of the event and the watcher sees it first.

### Fixed
- Fixes from the live runs, with tests for events, deduplication, click, verdict, limits and move.
- `doctor` warns when terminal-notifier cannot show notifications yet.

## [0.5.0] - 2026-11-01

Pull request #5: board TUI, attach and peek, window icons, progress.

### Added
- `agentctl board`: a full-screen overview of the tasks (Ink) with a live preview of the selected window and keys to message, interrupt, move, pull and close.
- `agentctl attach` and `agentctl peek`; task names are case-insensitive and a unique prefix is enough.
- `PROGRESS` in `status`: commits over the base and changed files per worktree.
- State icons in front of the tmux window names while `watch` runs (`watch.window_icons`); operations find windows by task name or by tmux window ID.
- `agentctl status --tmux-line` and a task count in the status bar of the agentctl session (`watch --tmux`, `watch.status_line`).

### Fixed
- The status bar needed the pane target `=session:`, and its result must be checked.

## [0.4.0] - 2026-11-01

Pull request #4: pilot fixes.

### Added
- `state_dir`: agentctl's own state (`TASK.md`, `setup.log`, markers) moved out of the folder the agents write to, with an automatic migration; a Codex agent had deleted its `TASK.md` while tidying up.
- States `orphan` (a window without a state file) and `needs-input` (the agent asks a question); `agentctl adopt` restores a lost state file.
- `status` shows the start time in local time; `status --json` keeps the UTC `started` and adds `startedLocal`; the last line skips the agent's footer (`footer_patterns`).
- `bin/agentctl-update`: a stable copy of agentctl as a detached worktree (`npm ci`, `npm link`, `doctor`, restart of the watch window).
- `npm run typecheck`.

### Fixed
- tmux targets that start with `=` are quoted (zsh expands `=word` to a program path).

## [0.3.0] - 2026-11-01

Pull request #3: automation.

### Added
- `agentctl new --clip`, `send --clip` (spec or prompt from the clipboard, a summary and a y/N question; `-y` skips it) and `status --clip`.
- `agentctl pull --ready` (all new reports in one text, marked as pulled, `--all` for the others) and `close` for several tasks at once.
- `agentctl watch`: desktop notifications on state transitions (report ready, question, folder trust, waiting too long, died), a log, and `--tmux` to run it in its own window.

## [0.2.0] - 2026-10-31

Pull request #2: trust wait, setup step and literal links.

### Added
- `new` waits for you to answer the folder-trust dialog of a fresh worktree (`trust_timeout`, `--no-wait-trust`) instead of stopping at it. agentctl still never answers it.
- `setup`: shell commands run in the first worktree before the links, with output in `setup.log`.
- Links without a glob are literal paths and create their parent directories.
- `agentctl new --no-agent`: only worktree, setup and links.

## [0.1.0] - 2026-10-31

Pull request #1: iteration 1, core and CLI.

### Added
- Spec files (YAML header and prompt) and layered configuration (global, project, spec) with validation that reports all mistakes at once.
- `agentctl new` (git worktree, symlinks, environment, tmux window, agent, prompt), `send`, `status`, `pull`, `close`, `interrupt`, `doctor`, `spec example`, `--dry-run` through a recording runner.
- Support for Claude Code and Codex, with effort flags and a guard against auto-accept flags.
- Claude and Codex equivalents table, `new --agent`, switching when a provider's window limit is full, `pin`.
- Task states (`working`, `waiting`, `needs-trust`, `report-ready`, `dead`) and folder-trust detection.
- Per-provider window limits, the `review_of` cross-review rule, an optional mirror of the reports.

[Unreleased]: https://github.com/Setech-pl/agentctl/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/Setech-pl/agentctl/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Setech-pl/agentctl/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Setech-pl/agentctl/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Setech-pl/agentctl/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Setech-pl/agentctl/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Setech-pl/agentctl/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Setech-pl/agentctl/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Setech-pl/agentctl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Setech-pl/agentctl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Setech-pl/agentctl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Setech-pl/agentctl/releases/tag/v0.1.0
