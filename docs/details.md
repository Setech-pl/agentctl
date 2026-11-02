# Details

How the pieces work, and what was checked on the real tools (Claude Code 2.1.309, Codex 0.166.0). The overview is in the [README](../README.md); the options of each command are in [commands.md](commands.md) and every key in [configuration.md](configuration.md). Status-bar and notification texts quoted below are those of the code and are in Polish in places.

Why TypeScript with no build step? The code is TypeScript run directly by Node's built-in type stripping (`node --experimental-strip-types`, set in the shebang of `bin/agentctl.ts`). That was chosen over `tsx` because it adds no dependency and no build or loader layer, and it behaves the same under `npx`, `npm link` and in tests. The price: only *erasable* TypeScript (no `enum` or `namespace`), imports spell out `.ts`, and Node refuses to strip types inside `node_modules`, so install from a clone, not from a registry tarball. From Node 22.18 and 23.6 the flag is a no-op; it stays in the shebang so 22.6 to 22.17 keep working.

## Setup

`setup` is a list of shell commands (spec > project `.agentctl.yaml` > global config; the first layer that sets it wins, `setup: []` switches it off).
`new` runs them in the first worktree, one `sh -c` each, in this order: `git worktree add` → **setup** → links → TASK.md → window → agent.

- Output goes to `<state_dir>/<task>/setup.log`.
- A failing command stops `new` with its exit code and the last 15 lines of output. The worktree stays, no window is created; fix the cause and run `agentctl new --reuse` (setup runs again).
- `--dry-run` prints the commands as `(cd <worktree> && sh -c '…')`.
- `new --no-agent` stops after setup and links: no TASK.md, window or agent. Handy to check a project's setup.

Recommended for Neon City (checked live on 2026-10-31: `npm ci` works in a fresh worktree; `package.json` declares `@neon-city/*` as `file:../neon-city-backend/packages/*`, which does not resolve from `~/Projects/wt`, so the links point them at the backend worktree under test). Add to `~/Projects/neon-city/.agentctl.yaml`:

```yaml
setup:
  - npm ci --prefer-offline --no-audit --no-fund
```

The existing `links:` of that file (`node_modules/@neon-city/protocol` and `…/sim` -> `~/Projects/wt/neon-city-backend-merge3/packages/*`) then do the rest; they are literal paths, so they no longer depend on `node_modules` existing.

## Links

Links are the glue that lets a worktree use *another* worktree's code (for example a client against a backend under test).

- `from` is relative to the first worktree, `to` is what it should point at.
- `to` must exist (checked before anything is created), otherwise `new` stops with the list of missing targets.
- `to` without `*`: every match of the glob `from` becomes a symlink to `to`. A `from` without glob characters is a **literal path**: it is linked even if nothing exists there yet, and its parent directories are created (`mkdir -p`), so `from: node_modules/@neon-city/protocol` works in a worktree without `node_modules`.
- A glob that matches nothing only warns, and the warning points to literal paths.
- `to` ending in `/*` (and `from` ending in `/*`): one link per entry of that directory, named after the entry.
  `from: node_modules/@scope/*`, `to: ~/backend/packages/*` links `node_modules/@scope/foo` to `~/backend/packages/foo`, and so on.
- Existing **symlinks** are replaced. Anything that is not a symlink is never touched: `new` stops and tells you which path is in the way.

## Effort

The prompt always starts with the line `Model: <model> · effort <effort>`, whatever the flags do.
On top of that, the agent is started with its own effort setting where one exists. What I found on the installed versions:

| Agent | Version checked | Result |
|---|---|---|
| Claude Code | 2.1.309 | Native flag: `claude --effort <low\|medium\|high\|xhigh\|max>`. agentctl passes `--effort <effort>`. |
| Codex | 0.166.0 | No dedicated flag. `-c, --config <key=value>` overrides any `config.toml` key and `model_reasoning_effort` is the key `~/.codex/config.toml` uses. agentctl passes `-c model_reasoning_effort=<effort>`. |

The Codex override was checked live: `codex -c model_reasoning_effort=low` in an empty tmux session showed `GPT-6.1-Sol low`
in its footer although `~/.codex/config.toml` says `high`. Claude's `--effort low` showed `Opus 5.5 with low effort`.
If a future version changes this, set `agents.<name>.effort_args` (`[]` to pass nothing). `agentctl doctor` shows which
mechanism it detects.

## Model equivalents

Claude and Codex models are not interchangeable one to one, so agentctl keeps a table of pairs you consider equivalent
(`config.equivalents`, usable in both directions). The built-in table:

| Claude (`model/effort`) | Codex (`model/effort`) |
|---|---|
| `haiku/low` | `gpt-6-luna/medium` |
| `haiku/medium` | `gpt-6-luna/high` |
| `sonnet/medium` | `gpt-6.1-sol/medium` |
| `sonnet/high` | `gpt-6.1-sol/high` |
| `opus/high` | `gpt-6-astra/medium` |
| `opus/xhigh` | `gpt-6-astra/xhigh` |

Add your own pairs in `~/.agentctl/config.yaml`; they are consulted before the built-in ones:

```yaml
equivalents:
  - {claude: "opus/medium", codex: "gpt-6-astra/low"}
```

`fable` and effort `max` are deliberately not mapped. Where the table has no pair you get an error that tells you the line to add.

- `agentctl new --agent codex spec.md` runs every spec on Codex, translating `model/effort` through the table
  (`opus/high` becomes `gpt-6-astra/medium`). It is an explicit order, so nothing is asked.
- When the window limit of the ordered provider is full and the other provider has room, `new` **asks** whether to switch
  (`... Switch to codex gpt-6-astra/medium (equivalent of claude opus/high)? [y/N]`). Without a terminal, or with
  `--no-switch`, it fails with the list of live windows instead. It never switches silently.
- `pin: true` in a spec forbids every switch (limit or `--agent`).
- `TASK.md` and `status` keep both the **requested** and the **effective** agent/model/effort. `review_of` is checked on the
  effective values, after mapping: a reviewer pushed onto the author's agent and model is refused.

## Lost state: orphans and adopt

agentctl keeps its own files (`TASK.md`, `setup.log`, the `pulled` mark) in `state_dir` (default `~/.agentctl/tasks/<task>/`) and
leaves `<cache>/<task>/` to the agent, which gets only the report path. Older versions kept everything in the cache folder, and a Codex
agent that tidied up its folder deleted the `TASK.md`: the task vanished from `status`, `watch` and `pull`.

- **Migration.** Every command (except `--dry-run`) first looks for `TASK.md` files that agentctl wrote in `<cache>/<task>/` and moves them,
  with `setup.log`, to `<state_dir>/<task>/`, printing one `migration: moved …` line per task. Existing state is never overwritten.
- **Orphans.** A tmux window in the agentctl session (other than `watch`) without a state file shows up in `status` as state `orphan`
  with a hint line, and `watch` notifies about it once.
- **Adopt.** `agentctl adopt NC-42 --report ~/Projects/cache/nc-42/NC-42.md` writes a new state file. The prompt is lost, and so are
  agent, model and effort unless you pass `--agent`, `--model`, `--effort` (they show as `unknown`). Add `--worktree <path>` so that
  `close --rm-worktree` knows the worktree. `--window <name>` if the window is not the lowercase task ID. It refuses when a state file exists.

## Interrupt

`agentctl interrupt NC-42` sends the agent's interrupt key (`agents.<name>.interrupt_key`, default `Escape` for both) to the
task's window. It types nothing else and does not close the window. Only a single key is sent on purpose: checked live,
one `Escape` at an idle prompt does nothing in Claude Code 2.1.309 and Codex 0.166.0, while a double `Escape` in Codex
opens "edit previous message". `--dry-run` prints the `tmux send-keys` it would run.

## Attach and peek

`agentctl attach [TASK]` takes you to the task's window. Outside tmux it selects the window and runs `tmux attach-session`;
inside tmux (`$TMUX` is set) it selects the window and runs `tmux switch-client`. Before it hands over the terminal it prints one line:

```
Ctrl-b d – wyjście bez przerywania agenta; nie wciskaj Esc ani Ctrl-c
```

Detaching with `Ctrl-b d` leaves the agent running; `Esc` and `Ctrl-c` would reach the agent itself. Without an argument `attach` goes to the
only running task; with several it shows a numbered list to choose from (without a terminal: the list and an error).

`agentctl peek TASK [-n 40]` prints the last N lines of the window's content (screen and scrollback) without attaching. The agent's footer lines
(`footer_patterns`), the borders around the input field and empty input prompts are left out, the same filter `status` uses for `LAST LINE`.

`TASK` is case-insensitive in both, and a unique prefix is enough (`agentctl peek nc-4` finds `NC-42`). An exact ID always wins over a longer one it prefixes
(`NC-4` over `NC-42`). An ambiguous prefix is an error that lists the candidates; a task whose window is gone says so.
The other commands (`send`, `pull`, `close`, `interrupt`, …) still take the full ID.

## Progress

`PROGRESS` in `status` (table, `--json` as `progress`, `--clip`, the mirror's `status.json`) shows what each task has to show for itself:
`2c 7f` is 2 commits over the base and 7 changed files, summed over the task's worktrees. The base is the repo's `base` from the spec, else `main`, else `master`.
Commits are `git rev-list --count <base>..HEAD`. Files are the union of `git diff --name-only <base>...HEAD` (what this branch changed since it left the base; three dots,
so changes the base got meanwhile do not count) and `git status --porcelain` (uncommitted and untracked files, collapsed to the directory for a fully untracked directory),
each file counted once. Without a base the commits are `?` (`?c 3f`); a worktree that is gone is `-`. `--json` carries the per-worktree numbers.

## Events

Reading a screen every 15 seconds is a guess about what the agent is doing. `agentctl new` therefore also asks each agent to tell agentctl itself, and `agentctl event` (a command you never type) takes the message:
it appends a line to `<state_dir>/events.log`, writes `<state_dir>/<task>/event.json` (so `status` and the [board](#board) show the new state at once, the board even reloads when the file changes), and sends the notification right away.
It always exits 0 and prints nothing, so a broken hook can never disturb the agent. A task started without events (older tasks, `notify.events: false`) keeps working with the screen reading alone.

| Agent | Event | agentctl |
|---|---|---|
| Claude | `Notification` `permission_prompt` / `elicitation_dialog` (any permission dialog; an `AskUserQuestion` sends the same type) | `needs-input`, notification with the question |
| Claude | `Notification` `idle_prompt` ("Claude is waiting for your input", a minute after a Stop) | logged only |
| Claude | `Stop` (end of turn; not sent when you interrupt with Esc) | turn ends: `report-ready` if the report is there, else `waiting` |
| Claude | `StopFailure` with `rate_limit` or `billing_error` | `limited` (other errors are logged) |
| Codex | `agent-turn-complete` (end of turn; also fired once for the turn that writes the session title, which is ignored) | as `Stop` |
| Codex | approval request, `request_user_input` | **no event in 0.166.0**: the screen reading catches them (`question_pattern`) |

**Claude Code 2.1.309.** `new` writes `<state_dir>/<task>/claude-settings.json` with hooks `Notification`, `Stop` and `StopFailure`, each running
`<this agentctl> event --task <TASK> --agent claude --kind <notification|stop|stop-failure>` (the hook JSON arrives on stdin), and starts `claude … --settings <that file>`.
*Checked live:* `--settings` **merges** with the other sources. With a user hook set in `~/.claude/settings.json` (Neon City kit: SessionStart, UserPromptSubmit, PreToolUse, Stop), a project `.claude/settings.json` with a Stop hook, and `--settings` with its own Stop and Notification hooks,
one `claude -p` run executed all of them (`--debug-file` lists every `Hooks: Stop [...] finished with status 0`; markers from the project and the injected hook were both written). No existing hook is disabled or replaced, and the file holds only the three event hooks.

**Codex 0.166.0.** `new` adds `-c notify=["…agentctl", "event", "--task", "<TASK>", "--agent", "codex", "--forward", "<json>"]`; Codex appends the event as JSON to that argv. *Checked live:* `-c notify=` **replaces** the `notify` of `config.toml`
(the Computer Use app's `turn-ended` hook stopped running), so agentctl reads the top-level `notify` of `$CODEX_HOME/config.toml` (`~/.codex` unless the spec's `env` sets `CODEX_HOME`) and passes it as `--forward`:
`event` runs it afterwards with the same JSON, as Codex would have. `~/.codex/config.toml` is never changed.
Codex 0.166.0 also has hooks (`PermissionRequest`, `Stop`, …) that would report approvals, but they must be trusted first: Codex shows a "Hooks need review" dialog and stores the trust in `config.toml`. agentctl does not answer dialogs
or write your config, so it does not use them. The `request_user_input` tool is behind the feature flag `default_mode_request_user_input` ("under development", off), so it could not be exercised; its screen (`? <question>` … `Waiting for your answer`) stays covered by `question_pattern`.

**Needs-input text.** The question is taken from the screen when a dialog with numbered options is open: the last line ending in `?` above the options, plus what it is about for a generic one
(`Do you want to proceed? touch approved.txt`, `Would you like to run the following command? $ printf 'yes' > approved.txt`), at most 120 characters. The Claude hook JSON only says "Claude needs your permission".
An event decides the state only where the screen cannot: a permission dialog that no pattern knows counts as `needs-input` while the input box is hidden, and goes stale when the box is back. A running turn always wins.

## Notifications

Each notification has the title `agentctl` and a sound. Text per transition: `NC-42: <question>` (needs-input), `NC-42: raport gotowy – <verdict>` (report-ready), `NC-42: skończył turę i czeka na Ciebie – <last words>` (end of a turn without a report; off with `notify.turn_end: false`),
`NC-42: claude wyczerpał limit użycia – agentctl move NC-42 przeniesie zadanie na codex` (limited), plus `needs-trust`, `dead`, `orphan` and the reminder after `watch.waiting_after`.

**One transition, one notification.** An event and the watcher can both see the same transition. The notified state is kept in `<state_dir>/<task>/notified.json` with its source: when the other source announced the same state less than `max(90 s, 3 × watch.interval)` ago, the second one only writes to its log
(`already announced by the agent's event`). Two events of the agent are never merged (a second permission prompt is a new question).

**Click to the window.** With [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`; `doctor` tells you when it is missing) a click runs

```
<this agentctl> attach NC-42 --switch-client      # select the window, switch the tmux client attached to the agentctl session
```

and brings your terminal to the front (`-activate`): `notify.terminal_app`, else detected from `TERM_PROGRAM` (`Apple_Terminal` → `com.apple.Terminal`, `iTerm.app` → `com.googlecode.iterm2`), else from the environment the tmux server was started in; for any other terminal no app is activated.
When **no client is attached** to the agentctl session there is nothing to switch: the click only brings the terminal forward and the text ends with `· agentctl attach NC-42`. The click command carries absolute paths and its own `PATH`, `AGENTCTL_HOME` and `TMUX_TMPDIR`,
because a click runs with a bare environment (live: without `PATH` tmux was not found, and without `LANG` tmux printed the tab of its `-F` formats as `_`, so agentctl now gives tmux a UTF-8 locale itself).
Without terminal-notifier the notification is the old `osascript` one (`notify-send` on Linux), without an action. terminal-notifier 3.x shows nothing until macOS has given it permission (the first notification asks) and its alert style is not `None`
(System Settings > Notifications > terminal-notifier); `doctor` runs `terminal-notifier -diagnose` and warns about exactly that.

**Backend and fallback (`notify.backend`).** `auto` (the default) tries terminal-notifier first. terminal-notifier 3.x can exit with `Could not request notification permission: Notifications are not allowed for this application`, and that permission cannot be granted from the command line: when it exits non-zero or prints that message, the same notification goes out through `osascript` (no click action), and terminal-notifier is left alone for an hour (`<config dir>/notifier.json`, so that the watcher and the hooks all see it); the one-line warning is in `<config dir>/notifier.log`. `terminal-notifier` or `osascript` use only that channel (no fallback, nothing remembered).
`agentctl notify-test` sends one notification and tells you which channel carried it, tries terminal-notifier again even if it is remembered as broken, and exits 1 when no channel worked. To get click-to-window back: System Settings > Notifications > terminal-notifier > Allow Notifications, alert style Banners; if terminal-notifier is not on that list, set `notify: {backend: osascript}`. `doctor` shows this state and the steps.

**Verdict.** The `report-ready` notification quotes the first meaningful line of the report, markdown removed, at most 100 characters, in this order: the first line `notify.verdict_pattern` matches (a regex; its first group, else the whole line),
a line that starts with `Werdykt`, `Verdict` or `Status` (`**Werdykt:** PASS`; as a heading on its own the line under it follows), else the first line of text after the heading (front matter, rules and table rows skipped).

## Limits and move

When a provider's plan or rate limit runs out, the task shows state `limited` (icon `⛔`, board, `status --tmux-line`), you get a notification with the proposal, and `agentctl move` carries the task over. A limit comes from two sources: the Claude `StopFailure` event (`rate_limit`, `billing_error`)
and the screen, with `agents.<name>.limit_patterns` (regexes, case-insensitive, matched per line; a message has to **open** its line, after bullet marks such as `⎿ ● ■`, so a diff or a quoted sentence is not mistaken for one; a running turn is never `limited`).
The defaults are the strings found in the installed binaries; I did not trigger a real limit (that would use up the plan), so how they look in the TUI is **inferred, not observed**:

| Agent | Text (version) | Pattern | Confidence |
|---|---|---|---|
| Claude | `You've hit your session limit · resets 3pm`, `… weekly limit`, `… <model> limit`, `… monthly spend limit` (2.1.309) | `You.ve hit your .{0,60}limit` | high that the strings exist (template `You've hit your ${window}${reset}` in the binary); the placement in the TUI is not observed |
| Claude | `Usage limit reached`, `You're out of extra usage` | as written | medium: seen as strings, context not verified |
| Claude | `Request rejected (429)` (rate limit; also printed for a passing capacity problem) | `Request rejected \(429\)` | low: it can be transient, the state then clears by itself |
| Claude | `StopFailure` hook with `error: rate_limit` or `billing_error` | event | schema from the binary; the sample in the tests is synthetic |
| Codex | `You've hit your usage limit. …` (with U+2019; variants: `… for <model>. Switch to another model now`, `Upgrade to Plus …`, `… purchase more credits`) (0.166.0) | `You.ve hit your usage limit` | high that the strings exist; TUI placement not observed |
| Codex | `Usage limit reached`, `You're out of credits`, `Your workspace is out of credits`, `You hit your spend cap …` | as written | medium |

**`agentctl move <task> [--agent claude|codex] [-y]`** moves the task to the other provider (or the one in `--agent`):

- the model and effort come from the [equivalents table](#model-equivalents) (`claude opus/high` → `codex gpt-6-astra/medium`); no pair (Fable, `max`) is an error with a hint;
- `pin: true` in the spec (kept in `TASK.md` since this version; older tasks count as not pinned) is an error: pinned tasks never change provider;
- a new window `<task>-2` (`-3`, … if taken) starts in the **same worktree** with the same env and report path; its prompt is the original one from `TASK.md` plus
  `Poprzedni agent (<agent> <model>) przerwał przez limit. Kontynuuj od bieżącego stanu worktree: przeczytaj git log i git diff względem bazy, nie powtarzaj zrobionej pracy. Raport zapisz do <report>.`;
- it always asks y/N; without a terminal and without `-y` it is an error. The `limits` of the target provider still apply;
- the old window **stays**: `status` and the board show it as `superseded` (`↪`, no notifications) and you close it yourself, `agentctl close <task>`.

On the board, `M` does the same after a `[y/N]` question.

## Window icons and the tmux status bar

While `agentctl watch` runs it puts the state of each live window in front of its name, so `Ctrl-b w` and the status bar show what is going on:

| Icon | State |
|---|---|
| `⚙` | `working` |
| `⏸` | `waiting` |
| `?` | `needs-input` |
| `🔒` | `needs-trust` |
| `⛔` | `limited` |
| `✓` | `report-ready` |
| `↪` | `superseded` |
| `✗` | `orphan` (and `dead`, which has no window to name) |

A window then reads `⚙ nc-42`. It is renamed only when the state changes, and when the watcher stops (Ctrl-C, or the window being killed) the plain names are restored.
Turn it off with `watch.window_icons: false`, or replace single icons (`watch.window_icons: {working: "▶", needs-input: "❓"}`; quote `"?"` in YAML).
The `watch` and `board` windows are never renamed.

Every agentctl command finds a window by the task name, whatever stands in front of it. `new` and `adopt` also record tmux's own window ID (`@12`) as `window_id`
in `TASK.md`, and commands target that ID while the window still carries the task's name (tmux reuses IDs after a restart, so a stale ID is never trusted).
Tasks started before this version have no ID and are matched by name. If `watch` is killed hard (`kill -9`), the icons stay on the windows until the next `watch` run;
everything keeps working meanwhile. Change the icons while the watcher is stopped (it recognises its old icons only if they are symbols or in the config).

`agentctl status --tmux-line` prints the number of tasks per state as one line, `2⚙ 1✓ 1?` (zero counts left out; reports you already pulled do not count as `✓`;
`orphan` and `dead` share `✗`). It makes no git calls and prints nothing else, so tmux can run it. `agentctl watch --tmux` sets, **for the agentctl session only**
(`set-option -t =agentctl:`, never `-g`):

```
status-right    #(<this agentctl> status --tmux-line)
status-interval 10
```

`<this agentctl>` is the absolute path of node and of this checkout's script with the current `AGENTCTL_HOME`, not a bare `agentctl`, because the tmux server's `PATH` often does not
contain it. This replaces the session's `status-right`; undo with `tmux set-option -u -t agentctl: status-right`. Leave the bar alone with `watch --tmux --no-status-line` or `watch.status_line: false`.

## Closing and hiding tasks

Three different things, from the lightest:

- **Finished.** A task whose window is gone (you closed the agent inside the window, it crashed, or it was moved to the other provider) but that nobody closed with `agentctl close`. It stays in `status`, and on the board it sits under the closed **Finished (N)** title, dimmed. `Enter` there opens a menu (`c` copy the report, `x` close, `h` hide, `Esc`), because there is no window to go to.
- **Hidden.** `agentctl hide <task…>` (board: `h`) sets `hidden: true` in `TASK.md`. The task is off `status` and the board (`status --all` and the board key `a` bring it back, `agentctl unhide` / `h` shows it again). Nothing is closed and no worktree is touched. With `board.auto_hide_pulled_dead: true` (the default) a task **without a window whose report was pulled** (`pull`, `pull --ready`, `c` or `r` on the board, the MCP `pull_ready`) hides by itself; without a report it stays under Finished. `unhide` writes `hidden: false`, which keeps that task visible. agentctl never closes a task or removes a worktree by itself.
- **Closed.** `agentctl close` (board: `x`) kills the window and writes `closed: true` and `closed_at` into `TASK.md`. A closed task is gone from `status`, the board, `pull --ready`, `watch` (closing a task that has no report is not a "window vanished" alarm) and the [window limits](#window-limits-and-cross-review); `status --all` and the board key `a` list it as `closed`. State and report stay.
  `agentctl archive [--older-than 7d]` moves the state folder of closed tasks to `~/.agentctl/archive/<task>/` (next to the state folder). A folder that is in the archive, moved there by `archive` or by hand, is a closed task, never an orphan or an error; a live window with the same name wins over it.

## Navigation

`agentctl board --tmux` and `agentctl watch --tmux` start their command **as the process of the window** (`tmux new-window … <command>`), not by typing it into a shell, and set `remain-on-exit failed` for the window in the same tmux call: when the command fails, the window stays with its error on the screen, and `~/.agentctl/board.log` / `watch.log` have the start (terminal size, `CI`, tty flags) and the end or the stack of the failure. Running `board --tmux` again starts a window whose process has ended in place. The board waits for a terminal size (a window without a client can report 0x0 for a moment) and draws even when a `CI` variable is in the environment (Ink would otherwise draw nothing).

In the agentctl session (session options, never `-g`) agentctl sets:

- **`mouse on`** (`board.mouse`): click a window name in the status bar to switch to it. With the mouse on, selecting text in Terminal.app takes the **fn** key held down (iTerm2: Option).
- **`F12` goes back to the board** from any window of the session, without the tmux prefix (`board.return_key`, a tmux key name; `false` for none). The binding is server-wide in tmux, so it is conditional on the session: in every other session F12 reaches the program in the pane as before. Why F12: `⌥b` is "word back" in the input boxes of Claude Code and Codex and needs "Use Option as Meta" in Terminal.app; Ctrl and Cmd are what is mixed up; neither agent uses F12. On a MacBook it takes `fn`+F12 unless "Use F1, F2, etc. keys as standard function keys" is on. If the key is already bound to something else in tmux it is left alone and `board --tmux` says so. `Ctrl-b l` (last window) still works.

The board's footer says `Enter – open the agent · F12 – back to the list`.

## The queue

`limits.claude` and `limits.codex` cap the windows per provider. When you order more than fit, the extra tasks do not have to be started by hand later: put them in the queue and `agentctl watch` starts each one by itself as soon as a window of its provider is free.

```
agentctl queue nc-42.md          # validate like "new", summary, y/N
agentctl queue list              # position, task, agent/model/effort, priority, start condition, waiting time
agentctl queue up NC-42          # first in line
agentctl queue rm NC-42          # take it out
agentctl queue pause / resume    # stop / allow starting (running tasks are never touched)
agentctl queue retry NC-42       # a failed start, once more
```

- **Adding** goes through the same checks as `new` (`review_of`, `pin`, `--agent` mapping, Codex efforts, duplicates, repositories) except the provider limit: a full provider is exactly why a task is queued. The summary says whether the task starts at the next tick or waits, and the entry is written to `<config dir>/queue/` with a running number.
- **`new` with a full limit** asks "add to the queue? [y/N]" (after the offer to switch provider, if there is one). Without a terminal it stays an error, now naming `agentctl queue`.
- **Order**: `priority: high` before `priority: normal`, first come, first served inside a class; `queue up` puts a task first in its class. A task whose provider is full does not hold back a task of the other provider.
- **Never switches provider.** The queue starts a task on the agent and model it was ordered on (or on the `--agent` given when it was queued). Moving to the other provider stays an explicit act: `--agent`, `agentctl move`.
- **Starting** is the same path as `new` (worktree, `setup`, links, TASK.md, window, wait for the agent, prompt) and runs in the background of the watcher. When the agent waits for the folder-trust dialog, `needs-trust` is notified as usual and the rest of the queue goes on; the prompt follows once you confirm. A notification says "Uruchomiono TASK z kolejki".
- **A failed start** (setup failed, repository gone, agent not ready) puts the task at the end of the line as `failed`, with the error in `queue list` and the log of the attempt in `<config dir>/queue/<n>-<TASK>.log`, and sends a notification. It is not tried again by itself; `queue retry` is your decision (it reuses a worktree the failed start left).
- The queue only moves while `agentctl watch` runs (`watch --tmux`). `queue.enabled: false` in the config switches starting off; `queue.parallel_starts` bounds the starts in progress ([configuration](configuration.md#queue)).

### Dependencies: `after`

```yaml
---
task: NC-42-REVIEW
agent: codex
review_of: NC-42
after: NC-42            # or a list: [NC-41, NC-42]
repos: [...]
---
```

A queued task with `after` starts only when every task it names has a report: state `report-ready`, or closed with the report file still there. Until then `agentctl status`, `queue list` and the board say `czeka na NC-42`; a task that waits for a dependency does not take a place in the line, so the others go on. A review (`review_of`) without `after` gets a hint in the summary, because it would otherwise start as soon as a window is free, before the author has written anything.

At adding, a task named in `after` must exist (started, in the queue or in the same file), a task may not wait for itself, and tasks may not wait for each other in a circle; each of these is an error that names the path. `new` has no line to wait in: it refuses a task whose `after` is not met and points at `agentctl queue`. A dependency that failed to start stays unmet (`czeka na NC-42 (failed)`) until you `queue retry` or `queue rm` it.

## Collisions

Two tasks that change the same files in the same repository will meet in a merge conflict. agentctl says so early.

- **What is compared.** For each active task (its window runs) the files changed since its worktree left the base (`git diff --name-only <base>...HEAD`) plus the files with uncommitted changes, per source repository (`repos[].path`). Two tasks collide when the sets share files. `collisions.ignore` leaves out lock files and the like.
- **`agentctl status`** gets a `COLLIDE` column while something collides: `⚠ LANDING-QS-1: 2` is "2 shared files with LANDING-QS-1". `status --json` has the same in `collide`.
- **`agentctl watch`** asks git every `collisions.interval` (300 s) and sends one notification for each new pair ("⚠ A i B zmieniają te same pliki (2): …"). The pair is remembered in `<config dir>/collisions.json`, so neither the next check nor a restart of the watcher repeats it; when the files stop overlapping and later overlap again, it is new again.
- **`agentctl overlap [TASK]`** lists the shared files of every pair (or of the pairs with TASK), computed right now.
- **`touches: [globs]`** in a spec says what the task is going to change. `queue` and `new` then warn, and ask y/N, when an active task already changes matching files (`new -y` does not ask; without a terminal the warning is only printed).
- The board marks a colliding task with `⚠` in the first column and says with whom in the preview ([board](#board)).

## Board

`agentctl board` is a full-screen overview of all tasks, refreshed every 2 seconds. `agentctl board --tmux` opens it in window `board` of the agentctl session
(created if missing, never twice); the board and watch windows are not tasks.

```
agentctl board  agentctl-test · 3 tasks · 09:41:03
  TASK       AGENT              STATE          TIME    PROGRESS REPORT │ AC5-C · last 13 lines
  AC5-A      claude opus/high   ⏸ waiting      37s     2c 3f    -      │ bash-3.2$ claude --model sonnet --effort medium
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 37s     1c 1f    ready  │ Claude Code (fake) --model sonnet --effort medium
▸ AC5-C      claude sonnet/med… ? needs-input  36s     2c 2f    -      │
                                                                       │ ● got: Model: sonnet · effort medium
                                                                       │
                                                                       │ ● working on: Third fake task that asks you something. W…
                                                                       │ ● Edited file-1.txt
                                                                       │ ● Edited file-0.txt
                                                                       │ ? Tea or coffee?
                                                                       │   1. Tea
                                                                       │   2. Coffee
                                                                       │   Enter to select · Esc to cancel
                                                                       │ ● you chose: tea please

Enter – open the agent · F12 – back to the list
↑↓ ⏎ go  m msg  M move  i int  c pull  r new  x close  h hide  z done  a all  ?
```

Below 110 columns the preview is hidden and the list takes the whole width (this is 80 columns):

```
agentctl board  agentctl-test · 3 tasks · 09:40:39
  TASK       AGENT              STATE          TIME    PROGRESS REPORT
▸ AC5-A      claude opus/high   ⚙ working      13s     2c 3f    -
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 13s     1c 1f    ready
  AC5-C      claude sonnet/med… ? needs-input  12s     2c 2f    -

Enter – open the agent · F12 – back to the list
↑↓ ⏎ go  m msg  M move  i int  c pull  r new  x close  h hide  z done  a all  ?
```

The list shows task, agent/model/effort, state icon, time, `PROGRESS` and the report (`-` none, `ready` not pulled yet, `pulled`). From 110 columns the right column
shows the last 30 lines of the selected window (as `peek`, without the footer); below that the list takes the whole width and works down to 80 columns.

| Key | Action |
|---|---|
| `↑` `↓` (`k` `j`) | select a task |
| `Enter` | go to the task's window (`select-window` + `switch-client`); `F12` (or `Ctrl-b l`) comes back to the board. On a task without a window it opens a menu instead: `c` copy the report, `x` close, `h` hide, `Esc` |
| `m` | type a message and send it to the agent as `send` does (`Enter` sends, `Esc` cancels) |
| `M` | move the task to the other provider after a usage limit (`agentctl move`), after a `[y/N]` question; refused for pinned and already moved tasks |
| `i` | interrupt the current turn, after a `[y/N]` question |
| `c` | copy the selected task's report (`pull`) |
| `r` | copy all new reports (`pull --ready`) |
| `x` | close the window, after a `[y/N]` question; if the task has a worktree, a second question asks whether to remove it too (`git worktree remove`, never `--force`, the branch stays; `Esc` cancels) |
| `h` | hide the selected task (or show a hidden one); nothing is closed or removed |
| `z` | open or close the **Finished (N)** section |
| `a` | list hidden tasks too (dimmed, marked `·`) and the closed ones, in their own **Closed (N)** section |
| `?` / `q` | help / leave (the agents keep running) |

The tasks that still have a window come first. Tasks without a window (and without `close`: `dead`, `report-ready` after you closed the agent in its window, `superseded`) wait dimmed under a closed **Finished (N)** title; `z` opens it. Enter on one of them does not try to switch to a window that is not there. See [Closing and hiding tasks](#closing-and-hiding-tasks).

Nothing destructive runs on a single key. The board reuses the core functions of the commands (`sendPrompts`, `interruptTask`, `pullTask`, `pullReady`, `closeTask`, `moveTask`); git is asked for
the progress at most every 10 seconds. It needs a terminal; without tmux `Enter` tells you to use `agentctl attach`.

> **Why Ink, and why `React.createElement` instead of JSX or `htm`?** The project runs on Node's type stripping with no build step, and JSX is not
> erasable syntax, so it cannot run unprocessed. `htm` (tagged templates) would avoid the build, but it adds a dependency to write what is a few dozen lines of `createElement` calls,
> and its templates are plain strings that `tsc --noEmit` cannot check; with `createElement` the component props are type-checked like the rest of the code.
> Ink is only loaded when the board starts, so the other commands do not pay for React.

## Task states

`status` derives a state per task from the window (`tmux capture-pane`, patterns per agent in the config) and the report file:

| State | Meaning |
|---|---|
| `working` | a turn is running (`working_pattern`, default `esc to interrupt`) |
| `background` | the agent is idle at its prompt but its own background work runs (`background_patterns`; Claude Code shows `· 1 shell, 6 monitors` in its footer). It ends a turn every few minutes meanwhile, so the end of turn is not announced and `watch` does not call it waiting; the tmux status bar counts it with `working`; icon ⏳. The notification comes when the background work is gone. Codex has "background terminals" (`/ps`); its pattern is a best guess, the footer text with a count was not seen on a screen |
| `waiting` | the agent is idle at its prompt and there is no report yet |
| `needs-trust` | the agent shows its folder-trust dialog; a human must answer it |
| `needs-input` | the agent asked **you** a question or for a permission and waits (`question_pattern`; Codex: `? <question>` with options and `• Waiting for your answer.`, or the approval dialog; Claude Code: the `Enter to select · Esc to cancel` dialog or a permission dialog; or Claude's `Notification` [event](#events)) |
| `limited` | the agent says its usage limit is used up (`limit_patterns`, or Claude's `StopFailure` event); see [Limits and move](#limits-and-move) |
| `report-ready` | the report file exists and is newer than the start (the agent is idle, or the window is gone) |
| `superseded` | the task was moved to the other provider with `agentctl move`; this is the old window, which you close yourself |
| `dead` | the window is gone and there is no report |
| `closed` | `agentctl close` was run (or the state folder is in the archive): listed only by `status --all` and the board key `a`, see [Closing and hiding tasks](#closing-and-hiding-tasks) |
| `orphan` | a window of the agentctl session has no state file (lost or never created) |

Precedence for a live window: `needs-trust`, then `needs-input`, then `working`, then `limited`, then `background`, then `report-ready`, then `waiting` (`superseded` overrides all of them; `closed` applies only to a task without a window).
These are heuristics on screen text; if a CLI update changes its wording, adjust the patterns in the config.

## Folder trust

A fresh git worktree is a new project root, so Claude Code (checked live, 2.1.309) and Codex (0.166.0) ask "do you trust this folder?" for it, even when the main checkout or a parent directory is trusted. agentctl **never answers that dialog**, but `new` waits for you to:

```
NC-42: agent waits for folder trust – attach: tmux attach -t agentctl, confirm in window nc-42
```

`new` keeps polling the window (`tmux capture-pane`). When the dialog is gone and the agent shows its input, it pastes the prompt as usual; the agent then gets `ready_timeout` again to start. Specs in one file are handled one after another, so each dialog is waited for in turn.

- **Timeout:** `agents.<name>.trust_timeout` (seconds, default 600). On expiry `new` stops, leaves the window open and prints `agentctl send <cache>/<task>/TASK.md`.
- **Ctrl-C** ends the wait without closing the window, lists the specs that were not started and prints the same `agentctl send` command.
- **`--no-wait-trust`** keeps the iteration-1 behaviour: stop at the dialog at once, with the attach instructions.

In every case the prompt is only sent after the dialog is gone; deliver it by hand with `agentctl send <cache>/<task>/TASK.md`.

**Does trusting a parent directory help?** Checked live on 2026-10-31 (Claude Code 2.1.309 with `~/Projects` trusted, Codex 0.166.0 with `~` trusted), in new directories below the trusted one:

| New directory | Claude Code | Codex |
|---|---|---|
| plain folder (no git) | no dialog (inherits) | no dialog (inherits) |
| new git repository | **dialog** | **dialog** |
| `git worktree add` of that repository | **dialog** | **dialog**; says "trusting will apply to the repository root" |

So trusting `worktree_root` (for example `~/Projects/wt`) does **not** cover git worktrees, and `doctor` has nothing to check there. Codex keys a worktree's trust to the repository root, so a trusted main checkout probably covers its worktrees (not tested live: that needs a trusted repository and a new worktree on it, which would change your Codex config); Claude Code asked for a worktree of a trusted checkout too (iteration 1). Hence the wait.

## Mirror

Off by default. Set `mirror_dir` and `status` and `pull` copy every task report (new or changed) to
`<mirror_dir>/<task>/` and write `<mirror_dir>/status.json` (the same rows as `status --json`). Point it at a synced
folder to read reports and the fleet state from another device. Nothing runs in the background: the mirror is refreshed
when you call `status` or `pull`.

## Safety rules

- `git` is only ever called with `worktree add`, `worktree remove`, and read-only queries (`rev-parse`). No merge, rebase, push, `--force` or branch deletion.
- No auto-accept mode: agentctl adds no such flag and rejects configs that try to. Your own agent settings still apply (for example a default permission mode in `~/.claude/settings.json`); agentctl does not override them.
- Files go to `state_dir` (agentctl's own state) and the cache directory (reports) only. Nothing is written to `~/.claude` or `/tmp`.
- Messages that name a tmux target quote it (`-t '=agentctl:nc-42'`): zsh expands a word starting with `=` to a program path.
- Error messages are short and say what to do next.

## Window limits and cross-review

- `limits.<agent>` caps simultaneous tmux windows per provider; the error lists the live windows. Windows are attributed to a provider through their `TASK.md`.
- `review_of: NC-6` looks up the author in `<state_dir>/nc-6/TASK.md` (or in the same file) and requires a different agent **or** a different model. `default` counts as a model name of its own.

## Stable install and updates

Use a **stable copy** for daily work and keep `~/Projects/agentctl` for development only. (`npm link` from the repo made the global
`agentctl` run whatever branch was checked out there, finished or not.) The stable copy is a detached git worktree of the repo,
by default `~/Projects/agentctl-stable`; `bin/agentctl-update` creates and updates it.

```sh
~/Projects/agentctl/bin/agentctl-update     # first installation
agentctl-update                             # later, after a PR is merged
```

It does, in this order: `git fetch origin` in the repo; `git worktree add --detach <stable> <ref>` (or, when the copy exists, a refusal
if it has local changes, else `git checkout --detach <ref>`); `npm ci` and `npm link` in the stable copy, so the global `agentctl` and
`agentctl-update` point at it; `agentctl doctor` (a failure makes the script exit non-zero); if window `watch` exists in the tmux session
`agentctl`, it kills that window and starts `agentctl watch --tmux` from the new version (no other window is touched); finally it prints the
previous and new commit and whether watch was restarted.

| Option / variable | Meaning |
|---|---|
| `--ref <ref>` | what to install, default `origin/main` |
| `--dry-run` | print the commands, run none |
| `--no-watch` | do not restart the watch window |
| `--no-link` | skip `npm link` (for testing the script without re-pointing the global commands) |
| `AGENTCTL_REPO` | the repo; default: the directory above the script's `bin/` (symlinks resolved) |
| `AGENTCTL_STABLE_DIR` | the stable copy, default `~/Projects/agentctl-stable` |
| `AGENTCTL_SESSION` | tmux session of the watch window, default `agentctl` |

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md): tests, typecheck, `npm run docs`, how the code is organised and how a milestone is closed.
