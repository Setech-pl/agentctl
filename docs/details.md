# Details

How the pieces work, and what was checked on the real tools (Claude Code 2.1.309, Codex 0.166.0). The overview is in the [README](../README.md); the options of each command are in [commands.md](commands.md) and every key in [configuration.md](configuration.md). Status-bar and notification texts quoted below are those of the code and are in Polish in places.

The npm runtime is JavaScript emitted into `dist/` by `npm run build`, with `.ts` imports rewritten to `.js`. Sources and tests run directly with Node 22.14+ type stripping. Installed packages need no type stripping inside `node_modules`.

## Setup

`setup` is a list of shell commands (spec > project `.agentctl.yaml` > global config; the first layer that sets it wins, `setup: []` switches it off).
`new` runs them (per repository, each in its own worktree: `repos[].setup`, else that repository's `.agentctl.yaml`; the spec/global `setup` is the first repository's), one `sh -c` each, in this order: `git worktree add` → **setup** → links → TASK.md → window → agent.

- Output goes to `<state_dir>/<task>/setup.log`.
- A failing command stops `new` with its exit code and the last 15 lines of output. The worktree stays, no window is created; fix the cause and run `agentctl new --reuse` (setup runs again).
- `--dry-run` prints the commands as `(cd <worktree> && sh -c '…')`.
- `new --no-agent` stops after setup and links: no TASK.md, window or agent. Handy to check a project's setup.

For a Node project that needs dependencies installed in each worktree, add to its `.agentctl.yaml`:

```yaml
setup:
  - npm ci --prefer-offline --no-audit --no-fund
```

## Links

Links are the glue that lets a worktree use *another* worktree's code (for example a client against a backend under test).

- `from` is relative to the first worktree, `to` is what it should point at.
- `to` must exist (checked before anything is created), otherwise `new` stops with the list of missing targets.
- `to` without `*`: every match of the glob `from` becomes a symlink to `to`. A `from` without glob characters is a **literal path**: it is linked even if nothing exists there yet, and its parent directories are created (`mkdir -p`), so `from: node_modules/@scope/protocol` works in a worktree without `node_modules`.
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
- **Adopt.** `agentctl adopt NC-42 --report ~/workspace/cache/nc-42/NC-42.md` writes a new state file. The prompt is lost, and so are
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

## Report detection

The spec says where the report goes (`report:`, default `<cache>/<task>/<TASK>.md`), but agents write it where they like: `docs/reports/<…>.md` in the worktree, `~/workspace/cache/<other name>/…`. A task then hangs as `waiting` and `pull --ready` does not see it. agentctl looks for the report itself.

- **When.** After every end of a turn (the Claude `Stop` hook with `last_assistant_message`, the Codex `notify` with `last-assistant-message`) and at every `watch` tick for a task in state `waiting`. Nothing is searched while the canonical file is already there (written after the task started), including copies made by agentctl.
- **Where.** Only the configured alternative report paths/globs, resolved against the worktrees. Mentioned paths are never searched.
- **Candidates.** Only files matching configured report alternatives, modified in the current attempt and containing the task ID in the basename. Prompt/pane mentions are ignored. Copying requires explicit `report --from` / `report_from`.
- **The list.** `report:` in a spec, `.agentctl.yaml` or `config.yaml` may be a list. The first entry is the canonical path; the others are places to look, paths or globs (`*`, `?`, `**`), absolute, `~/…` or relative to the worktree, with `{task}`/`{TASK}`: `report: [~/workspace/cache/{task}/{TASK}.md, docs/reports/*{task}*.md, docs/reports/*{TASK}*.md]`.
- **What happens.** Discovery records a candidate flag and journal entry without copying. Explicit --from copies to canonical and stores report_source, report_copied and report_source_mtime. A fresh canonical file wins unless explicitly overridden with --force.
- **By hand.** `agentctl report <TASK>` shows the canonical path, the source and what the search finds now (it copies nothing). `agentctl report <TASK> --from <path>` makes that file the source and copies it (`--force` also over a report the agent wrote; `--dry-run` copies nothing). `pull <TASK>` runs the search when the report is missing.
- **Where you see it.** `status` (the report column: `yes (z <path>)`; `--json`: `reportSource`), the board (a note under the preview: `report from <path>`), the MCP `list_reports` (`source`) and `task_spec` (`report_source`).

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

**Claude Code 2.1.x.** `new` writes `<state_dir>/<task>/claude-settings.json` with hooks `UserPromptSubmit`, `Notification`, `Stop` and `StopFailure`, each running
`<this agentctl> event --task <TASK> --agent claude --kind <user-prompt-submit|notification|stop|stop-failure>` (the hook JSON arrives on stdin), and starts `claude … --settings <that file>`.
*Historical 2.1.309 check:* `--settings` **merges** with the other sources. With a user hook set in `~/.claude/settings.json` (example hook set: SessionStart, UserPromptSubmit, PreToolUse, Stop), a project `.claude/settings.json` with a Stop hook, and `--settings` with its own Stop and Notification hooks,
one `claude -p` run executed all of them (`--debug-file` lists every `Hooks: Stop [...] finished with status 0`; markers from the project and the injected hook were both written). No existing hook is disabled or replaced, and the file holds only the event hooks.
`UserPromptSubmit` is documented since 1.0.54; fix P verifies the new acknowledgement path only with isolated doubles ([hooks](https://code.claude.com/docs/en/hooks), [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).

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

**Verdict.** The `report-ready` notification quotes the verdict of the report, markdown removed, at most 100 characters, in this order: the `verdict` of the `agentctl-outputs` block, the first line `notify.verdict_pattern` matches (a regex; its first group, else the whole line),
then a verdict line in the header of the report (before the first `##` heading, code block or line of prose; fenced blocks and quotes are skipped): `Werdykt`, `Verdict` or `Status` after `:`, `-`, `–` or `—` (`**Werdykt:** PASS`; as a label on its own the next line is the value). Never an arbitrary line of text.

## Phone notifications

A copy of the events the Mac gets goes to a phone through [ntfy](https://ntfy.sh) while away is on. The overview and the setup steps are in the [README](../README.md#phone-notifications); this is how it works.

- **One place.** Every announced event is written to the journal (`<config dir>/journal.jsonl`) once, after the de-duplication of the Mac (the agent's event and the watcher's screen reading of the same transition are one). The write goes through `notifyPhone`: if a topic is set, away is on (or `notify.ntfy.always`) and the event is in `notify.ntfy.events`, it sends the request. So the phone cannot get an event twice, or one the Mac did not announce. The journal entry gets `phone: sent` or `phone: queued` (`events` prints 📱 behind it). `orphan` and `usage-critical` (a plan window over `usage.critical`) became journal events for this; a plain `usage` warning stays on the Mac.
- **Away.** `<config dir>/away.json` holds `{on, since, by}`; `by` is `cli`, `board`, `mcp` or `auto`. The watcher, the event hooks, the board and the MCP server read the same file, so a change is seen at once everywhere. With `away.auto_idle: N` every watch tick asks `ioreg -c IOHIDSystem` for `HIDIdleTime`: idle for N minutes turns away on (`by: auto`), the first activity turns it off again, but only what `auto` turned on. A hand-made `away off` while the Mac is still idle is not undone until there was activity in between. Where `ioreg` fails nothing happens.
- **The request.** `POST <server>/<topic>`; the text is the body; headers `Title`, `Priority` (`min`, `low`, `default`, `high`, `urgent`), `Tags` (an emoji short code per event: `white_check_mark` for a report, `question` for a question, `skull` for a vanished window …), `Click` (`click_url`) and `Authorization: Bearer <token>`. A header with a character outside ASCII (the Polish title) is sent as RFC 2047 (`=?UTF-8?B?…?=`), which ntfy decodes; `fetch` would refuse it raw. The timeout is 5 seconds.
- **The text.** Built from the kind of event and from the task ID, the name of a cohort and (`report-ready`, `include_verdict`) the verdict line: `NC-42: raport gotowy – Werdykt: PASS`. The verdict line is the same one the Mac shows, shortened to 100 characters, with every word that looks like a path or a file name replaced by `…`. Questions stay local by default (`notify.ntfy.include_question: false`): the phone gets only opening instructions (count and binding for collapsed Codex questions) and existing manager/Remote Control hints; `true` opts into question text clipped to 120 characters, and changes reload live, including retries. On public ntfy.sh the topic is the only protection, so keep it secret and enable question text only if you accept sending work content there. Error text and report content beyond the verdict are never included; the tests check that a report full of secrets and paths leaks none of them into a request.
- **Failures.** The first request is made at once. When it fails (no network, a timeout, a status other than 2xx) the message goes to `<config dir>/phone-queue.json`, and the watcher tries again at each tick when it is due: after 30 seconds, then 2 minutes, then 10 minutes. After the third retry it is dropped with a line in `<config dir>/phone.log`. Each failure is a line in `phone.log`; the watch log gets one warning an hour. A process that is not the watcher (`agentctl event`) only makes the first try, queues, and never waits.
- **Setup.** `agentctl ntfy-setup` edits `config.yaml` with the YAML document API, like `limits set` (comments and the order of the keys stay, `config.yaml.bak`, the result is loaded to check it). The topic is `agentctl-` and 24 random hex digits (96 bits from `crypto.randomBytes`). `doctor` calls a topic weak when it is shorter than 24 characters, has no digits or repeats a few characters, and warns about a private server without a token.
- **Checked live** (sandbox of `scripts/live-harness.ts`, `scripts/live-phone.ts`): a `report-ready` event of a fake agent with away on gives one request to a mock server (Bearer, Priority, Tags, Click, the body without the report), none with away off, none extra from the watcher; a dead server queues the request and the watcher delivers it after 30 seconds; `notify-test --phone` also gets HTTP 200 from a local mock, without contacting public ntfy.sh. The subscription link `ntfy://<host>/<topic>` of `--show-qr` was not tried on a phone.

## Remote control and the manager

The overview and the steps are in the [README](../README.md#remote-control-from-your-phone); this is how it works and what was (and was not) checked. Sources: the Remote Control page of the Claude Code documentation (https://code.claude.com/docs/en/remote-control, the CLI reference and the error reference), and `claude --help` and `claude remote-control --help` of the installed Claude Code 2.1.309 - only the help texts were read; no real session was started.

| Way | What it is | Used by agentctl |
|---|---|---|
| `claude remote-control` | Server mode: no local session, several on demand. A global flag before `remote-control` that it cannot hand on to its sessions (`--settings`, for one) stops it with an error. | No: it cannot carry the event hooks, the role or the MCP configuration |
| `claude --remote-control [name]` (`--rc`) | An ordinary interactive session with Remote Control switched on; the global flags (`--settings`, `--model`, `--effort`, `--mcp-config`, `--append-system-prompt-file`) are the session's own. | Yes: the manager, and `remote_control: true` in a spec |
| `/remote-control [name]` | Switches Remote Control on in a running session. | No: it would mean typing into a window |
| `remoteControlAtStartup: true` (`/config`, user settings) | Every interactive session connects by itself. | No: agentctl never changes your Claude settings; set it yourself if you want every task window in the app |

- **The command.** Always an interactive session, the name always given (so the optional value of `--remote-control` never takes the next flag), the variadic `--mcp-config` before another flag, and never an auto-accept flag:

```sh
claude --model sonnet --effort medium --mcp-config ~/.agentctl/manager/mcp.json \
  --remote-control "agentctl manager" --settings ~/.agentctl/manager/settings.json \
  --append-system-prompt-file ~/.agentctl/manager/role.md
```

- **The files** are written at every start into `<config dir>/manager/`: `role.md` (the role, the write tools `mcp.allow` lets through, and the text of `manager.guide` up to 60 000 characters), `settings.json` (`permissions.allow` with the read tools of the MCP server, so the phone is not asked about `status`; the tools that change something are not listed, so Claude Code asks you first) and `mcp.json` (the same server entry `agentctl mcp install --claude-code` registers, under the same name, so the tools are `mcp__agentctl__*`). Nothing is written into the project. A conversation that is resumed keeps the system prompt it was started with (`--system-prompt-snapshot`), so a changed role applies to a new manager session; `agentctl manager stop` and `agentctl manager` make one.
- **The window.** `manager` in the agentctl session, in `manager.project` (else `--project`, else where you are), made with `new-window` and the command typed into its shell, like a task. `status`, `close`, `cancel`, `gc` and `limits` do not see it as a task (like `watch` and `board` it is a reserved window name); it is untagged in the window list, so it is no place against a provider limit, and the processes in it are inside a window of agentctl, so `limits.count_external` does not count them either. A task cannot be called `MANAGER`.
- **Dialogs.** The folder trust and the one-time "Enable Remote Control" are the human's: `agentctl manager` waits for the input prompt, and when a dialog is on the screen it stops there and tells you which window to go to. `agentctl up` (with `manager.autostart`) does not wait at all.
- **What agentctl reads on the screen** (from the documentation, never seen on a real screen):

| State | The screen shows | The board says |
|---|---|---|
| `connected` | `/rc active` | połączony |
| `waiting` | the input prompt, no indicator (a few seconds after the start it is normal) | czeka na połączenie |
| `confirm` | the folder-trust dialog, or `Enable Remote Control` (not the row "Enable Remote Control for all sessions" of `/config`) | czeka na potwierdzenie w oknie |
| `failed` | `Remote Control failed`, `Remote Control disconnected` and the other refusals of the error reference | połączenie nie działa |
| `starting` | anything else: Claude Code is not at its input yet | uruchamia się |
| `missing` | no window | nie działa |

- **`manager --url`** reads the last 600 lines of the window and prints the last `https://claude.ai/code/…` address and a QR code (a run of at least 12 lines of block characters). It types nothing into the window. When there is neither, it says to type `/remote-control` there, or to open the Claude app, tap Code and pick the session by its name.
- **A task with `remote_control: true`** starts with `--remote-control <TASK>` after `agents.claude.flags` and before `--settings`, so the event hooks, `--model` and `--effort` are unchanged; the session in the app is named after the task. The same dialogs apply (`new` waits for the human, as for the folder trust). `remote_control` is kept in `TASK.md` and used again by `resume` (before `--resume`/`--continue`; Claude Code reconnects the session of a resumed conversation by itself). A Codex task cannot have it (an error); `defaults.remote_control` applies to Claude tasks only; a task moved to Codex by `move` or a limit loses it. `agents.claude.flags` must not hold `--remote-control`, `--rc` or `remote-control` (an error).
- **The phone.** With the manager window up, `needs-input`, `report-ready` and `cohort-done` end with "Otwórz sesję „<manager.name>” w aplikacji Claude."; a `needs-input` of a task with `remote_control` ends with "Odpowiesz w aplikacji Claude: <TASK>" instead. Only text: no link, no path, no session address. Nothing is added while the window is not there.
- **Sleep and the network** (documentation): the session talks to Anthropic over outbound HTTPS only and opens no port; when the Mac sleeps or the network drops, an interactive session reconnects when the Mac is back, the server mode would give up after about ten minutes. The `claude` process has to keep running, so closing the window or restarting the Mac ends it; `agentctl manager` (or `up` with `manager.autostart`) brings it back as a new conversation.
- **Requirements and refusals** (documentation): a claude.ai login (`claude auth login`) on Pro, Max, Team or Enterprise; not an API key, `CLAUDE_CODE_OAUTH_TOKEN` from `setup-token`, Bedrock, Vertex, Foundry or an `ANTHROPIC_BASE_URL` other than api.anthropic.com; not with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` or `DISABLE_GROWTHBOOK`. `doctor` warns when one of these variables is set in its environment (a tmux server started from such a shell passes them on). Team and Enterprise: an Owner switches Remote Control on, and Trusted Devices may ask the phone to enrol. While connected, the transcript is stored on Anthropic's servers; `disableRemoteControl` in the settings turns the whole feature off.
- **Checked** (sandbox of `scripts/live-harness.ts`, `scripts/live-manager.ts`, a fake `claude` that answers `--help` with the flags and prints `/rc active` when started with `--remote-control`): the exact command line of the manager and of a task, the files, the project left alone, no second window, `--url` with an address on the screen, `stop`, `up` with `manager.autostart`, `resume` with the flag, the refusal of a Codex task, `doctor` exit 0. **Not checked on a real Claude Code** (it would use the plan and register sessions on the account): that `--remote-control` is accepted together with `--settings`, `--mcp-config` and `--append-system-prompt-file` (the documentation calls it an ordinary interactive session and the help lists them as options of the same command), the texts of the screen above, that a first start shows the "Enable Remote Control" dialog at all, how the permission prompts of the MCP tools look on the phone, and how the manager line behaves after a sleep of the Mac.

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

`agentctl status --tmux-line` prints the number of tasks per state as one line, `2⚙ 1✓ 1?`, followed by the tasks in the queue as `3⧗` (`2⚙ 1⏳ 3⧗`; zero counts left out; reports you already pulled do not count as `✓`;
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

## Cancelling tasks

Work is sometimes abandoned half way. `agentctl cancel <TASK…> [--reason "…"] [--rm-worktree] [-y]` (board: `X`; MCP: `cancel`) shows the list and asks y/N, then:

- **A task at work:** the agent's interrupt key is sent (like `interrupt`), agentctl waits `cancel.grace` seconds (default 5, once for all the tasks of one command), then the window is closed. `TASK.md` gets `cancelled: true`, `cancelled_at`, `cancel_reason` (if one was given) and `cancel_source` (`cli`, `board` or `mcp`).
- **A task in the queue:** it is taken out of the queue (`queue rm` is the same without a reason) and gets a `TASK.md` of its own with the same fields, so that it shows in `status --all` and the tasks that wait for it can see that it is gone. A leftover live window of its failed start is closed with it, so the cancelled task does not read as "waiting".
- **A task you moved** (`agentctl move`): the old task (`superseded`) and its successor are one piece of work, so both are cancelled, after the one question.
- **The worktree and the branch stay**, because partial work is often worth keeping. `--rm-worktree` runs `git worktree remove` (never `--force`; an unclean worktree is reported and left); a branch is never deleted.

`cancelled` is a state of its own, not `closed`. A cancelled task leaves `status` and the board (`status --all` and the board key `a` list it under **Cancelled**), does not count against the [window limits](#window-limits-and-cross-review), is never taken by `pull --ready` and gives no "window vanished" alarm. A report the agent had written stays: `agentctl pull <TASK>` and the MCP `get_report` read it. A cancel from the terminal or the board announces nothing; one that the chat asks for (MCP `cancel`, `queue_rm`) shows the usual desktop notice.

## Cohorts

Tasks can be grouped under a name you chose: `cohort: sprint-1` in a spec, `--cohort sprint-1` on `new` and `queue` (the flag wins over the spec), or `agentctl cohort add sprint-1 NC-41 NC-42` for tasks that exist already. A task with no name belongs to **no cohort**: there is no default cohort and agentctl never makes one up.

- **Names.** Letters, digits, `-`, `_` and `.`, at most 40 characters, starting with a letter, a digit or `_`. Comparison ignores case; the name is shown the way it was written the first time. The cohort is made by its first task; `<config dir>/cohorts/<name>.json` keeps when it was created and an optional description (`agentctl cohort note sprint-1 "…"`).
- **Where a task keeps it.** `cohort:` in its `TASK.md` (and in its queue entry while it waits), next to `cancelled`/`cancel_reason`, so that a later usage or stats milestone can count tasks per cohort and cancellations.
- **Commands.** `cohort list` (tasks per cohort by state: active, queued, reports, closed, cancelled; since when), `cohort show <name>` (the tasks as in `status`), `cohort add <name> <TASK…>`, `cohort remove <TASK…>`, `cohort note <name> "…"`.
- **Filters.** `--cohort <name>` on `status` (also `--json` and `--clip`), `pull --ready`, `close`, `cancel` and `queue list`. Without it every task is meant, as before. `close --cohort X` and `cancel --cohort X` show the list and ask y/N.
- **Notification.** When every task of a cohort that was not cancelled has a report (the queued ones too), the watcher says `kohorta <nazwa>: wszystkie raporty gotowe (N)`: once per cohort, and again only when a task has joined since.

## Live limits and the config reload

- **`agentctl limits`** counts per provider: the windows of the agentctl session (attributed through `TASK.md`), plus the reserved places, plus the external sessions when `limits.count_external` is on; free = limit − used. The same count decides `new` (error or switch offer), `queue` (what the summary says), the queue ticks of `watch` and `queue list`.
- **`limits set`** edits the file with the `yaml` package's document API: comments, order of the keys and the other values stay (an inline comment is written after one space). The old file is copied to `config.yaml.bak`; the result is loaded once to check it, and the old text comes back if it does not load. `none` (or `0`) deletes a key; `off` writes `off` and disables the provider — no window of it starts until the limit is removed or raised.
- **Reservations** are `<config dir>/reservations.json`: per provider a count and a note. `reserve` adds, `release claude=1` subtracts, `release claude` drops all of them.
- **External sessions** (`limits.count_external: true`): `ps -U <uid> -o pid=,ppid=,command=` lists the processes. A process counts when its command is `claude` or `codex` (or `node …/claude-code/….js`, `node …/@openai/codex/….js`) without `mcp`, `mcp-server`, `app-server`, `exec`, `-p`, `--print`, `usage-tap` or `agentctl` among its arguments, when no ancestor is a pane process of the agentctl session (`tmux list-panes -s`), and when no ancestor is itself a counted session (a helper process of a session is not a second session). The directory comes from `lsof -a -d cwd`. Nothing is killed or touched.
- **The reload.** A `ConfigStore` keeps the configuration in force and the text it was loaded from. `watch` calls it at every tick and from `fs.watch` of the config folder; the MCP server calls it on every tool call (it always read the file again; now a file that does not load no longer takes the server down). A text that loads replaces the configuration in force (`Context.setConfig`: the tmux client follows a changed `session` or window icons) and the watch log says `config: reloaded (limits, mcp)`. A text that does not load is reported once (`config: config.yaml does not load, the previous settings stay in force: …`), `config-state.json` records it, `doctor` shows a `config reload` warning, the MCP `status` and `version` carry the warning, and a CLI command that cannot load the file mentions that the watcher keeps the previous settings. A `notify` change makes the watcher build its notifier again.

## Events for the chat

- **The journal** `<config dir>/journal.jsonl`: `{at, kind, task?, cohort?, text, verdict?, level?, phone?}` (`level` of a `usage` entry: `warn` or `critical`; `phone`: `sent` or `queued`, see [Phone notifications](#phone-notifications)). Kinds: `report-ready`, `queue-start`, `queue-failed`, `needs-input`, `needs-trust`, `blocked`, `cancelled`, `limited`, `dead`, `orphan`, `cohort-done`, `usage`, `limits-changed`. Writers: the watcher (a transition that was not already announced by the agent's own event), the event command, the queue (start, failed start, blocked), `cancel`, the cohort check, the plan thresholds, `limits set`/`reserve`/`release` and the config reload (written once if both saw the same change). A task event gets the cohort of the task.
- **The marker** `<config dir>/events-seen.json`: a delivered journal position per stable client (CLI and each initialized MCP identity). `since: last` means after that time; the first call of a client looks back 24 hours; `--keep` / `peek: true` and `--clip` leave the marker. A dry run leaves it too.
- **The summary line** counts the tasks with a window that are not finished (and how many work), the tasks that wait for you (needs-input, needs-trust, waiting), the queue and the reports ready and not pulled.
- Events exist only while `agentctl watch` runs (or when a command writes them itself: cancel, limits). A chat that calls `events_since` after a night without a watcher still gets the summary of the state now.

## Clean-up (`gc`)

- **What is looked at:** the task records of `state_dir` and of the archive, for tasks that are `closed`, `cancelled` or archived and have no window. Everything else is out of reach: an active task, a worktree that another unfinished task also uses (a `move` shares one), a folder of the cache that belongs to no record.
- **Worktrees:** `git status --porcelain` must be empty, the checked-out branch must not be `main`/`master`, the main checkout is never a candidate; the removal is `git worktree remove <path>` without `--force`. `git worktree list --porcelain` also names worktrees of the same repositories that no task owns; they are only listed as skipped.
- **Files next to the reports:** in the folder of the report of such a task, every entry that is not `*.md` and whose newest file is older than `--older-than`. A folder counts by the newest thing in it.
- **State:** the `<state_dir>/<task>/` of closed tasks moves to the archive (the same move as `agentctl archive`); the history (`history.jsonl`) and the reports are not touched.
- **Branches** (`--branches`): the branch of the task's repo entry, if it still exists, is not `main`/`master`/the current branch/the base, is not used by an unfinished task, is not checked out in another worktree (one that gc removes in the same run does not count), and `git merge-base --is-ancestor <branch> <base>` succeeds. Then `git branch -d`; git's own check is the second safety net. Remote branches are never touched.
- `--apply` shows the list, asks y/N (`-y` skips it without a terminal), does worktrees, files, archive moves, then branches, and reports what was freed and what failed. A failure of one item does not stop the others and makes the exit code 1.

## Resume and `up`

- **Which tasks:** not closed, not cancelled, not archived, not hidden, not superseded, with a record that names an agent, a worktree that exists, no tmux window, and no report (`--all` also takes tasks with one). Typed task IDs must be among them.
- **What is started:** the window is made like `new` makes it (the task's env, a new session when the old one is gone), the event wiring is written again (the settings file with hooks and the usage tap, the Codex `notify`), then the agent: Claude `claude --model … --effort … --settings … --resume <id>` / `--continue`, Codex `codex resume <id> …` / `codex resume --last …` followed by the same flags as at the start (checked with `codex resume --help` of 0.166.0: the options come after `resume`). The session id is the last one recorded in `<state_dir>/<task>/sessions.json` by the hooks or the usage tap. No prompt is pasted and the folder-trust dialog is not answered.
- **Limits:** the places of a provider are counted as for `new`; a task that does not fit is skipped and said so.
- **`agentctl up`:** `watch --tmux` and `board --tmux` (each only if its window is missing), the resume hint, then `attach`/`switch-client` to the board window; with no terminal (or `--no-attach`) it prints `tmux attach -t <session> \; select-window -t board`.

## Usage and limits

`agentctl usage [--cohort X] [--since 7d] [--json] [--clip]` answers two questions before you hand out more work: how many tokens do the tasks use, and how close are the plans of Claude Code and Codex to their limits. What a provider does not tell is **n/d**; no number is ever estimated.

**What the sources give.** Checked against Claude Code 2.1.309 and Codex 0.166.0 (the formats are the agents' own, not a documented interface: they may change).

| | Claude Code | Codex |
|---|---|---|
| Session log | `<claude home>/projects/<cwd, every non-alphanumeric character as "-">/<session id>.jsonl`; subagents in `<session id>/subagents/agent-*.jsonl` | `<codex home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl` |
| Tokens | `message.usage` of every `assistant` line: `input_tokens`, `output_tokens` (thinking included), `cache_read_input_tokens`, `cache_creation_input_tokens`; `message.model`. A message is written once per content block with the same `message.id` and usage: it is counted once | `event_msg` `token_count`: `info.total_token_usage`, cumulative for the session (`input_tokens` contains `cached_input_tokens`); the model is in `turn_context`. The difference between two counts is the work in between |
| Which task | `cwd` in every line (the worktree or a folder below it), `sessionId`; `transcript_path` and `session_id` in the input of the hooks and of the statusLine | `session_meta.cwd` (the worktree), `session_meta.id`; `thread-id` in the argument of `notify` |
| Plan limits | `rate_limits.five_hour` and `.seven_day` (`used_percentage`, `resets_at` in epoch seconds) in the JSON that a **statusLine** command gets on stdin; only for claude.ai Pro, Max and Ultra, and only after the first answer of a session. Not in the transcripts, no local file | `rate_limits` in every `token_count`: `primary` and `secondary` windows with `used_percent`, `window_minutes` (300 = 5 hours, 10080 = a week) and `resets_at`, plus `plan_type`. Some plans have one window only; a limit without windows (`premium`) says nothing |
| Reliability | Reliable: tokens and models. Reliable only through the tap: the limits | Reliable: tokens, models and the limits (the newest log says; it is the account, not the task) |

- **Tokens.** The number shown (`TOKENS` in `status` and on the board, `usage`) is input + output + cache writes. Cache reads are left out: a long session re-reads its context on every turn and they would drown the rest; they are in `--json` and in the *by model* table. A Codex count is split so that `input` is only the fresh part. Plan accounting is not public, so this is a choice, not the provider's bill.
- **Which sessions belong to a task.** The sessions of the task's agent whose working directory is the task's worktree (or a folder below it) and that began after the task started (a minute of slack) and before it ended: the start of the task that continues it after `move` (which shares the worktree), its `close` or its `cancel`. Of several tasks that could own a session, the one that started last before it wins. `<state_dir>/<task>/sessions.json` lists the sessions that the agent's events and the statusLine named; they count whatever the directory says. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in the spec `env` move the lookup to that home. Sessions you start by hand are not counted, and a Codex session resumed or forked from another one counts its whole history again.
- **Cache.** `<config dir>/usage-cache.json` keeps per log file the offset read so far and the totals per day and model. A log only grows, so the next read starts at the offset (a shorter file is read again from the start); a half written last line waits. `watch`, the board and the tmux line can therefore ask every few seconds. Delete the file to have everything read again.
- **Claude's plan: the tap.** `new` puts a `statusLine` into the settings file of a Claude window (`--settings`, the same file as the event hooks): `agentctl usage-tap --task <ID> [--forward '<your command>']`. On every update of the status line it keeps the windows in `<config dir>/usage/claude-plan.json`, remembers the session, then runs your own `statusLine` (from the worktree's `.claude/settings.local.json` or `settings.json`, else `~/.claude/settings.json`) with the same input and prints its output, so what you see does not change. A statusLine of another type than `command` is left alone and the tap is not set. Limits are the account's, so any window feeds them; the file is as fresh as the last answer of a Claude window agentctl started. To feed it from your own sessions too, set your global `statusLine` to `agentctl usage-tap --task none --forward '<your command>'` (an unknown task only skips remembering the session). `usage.claude_tap: false` leaves status lines alone.
- **n/d.** Claude's limits are n/d until a task window has answered once, with no claude.ai subscription, or with `usage.claude_tap: false`; Codex's, when no log of the last three days has a window. A window whose reset time has passed since the reading is dropped (its percentage is not the current one). A reading older than 30 minutes is shown with its time.
- **Warnings.** `watch` looks at the plans on every tick. When a window reaches `usage.warn` (default 80) it sends one notification, when it reaches `usage.critical` (95) one more; "Codex: 85% limitu 5h (reset 12:07) – blisko limitu; claude ma zapas (62%): --agent claude". One per threshold and per window period (provider, window, reset time), kept in `<config dir>/usage-alerts.json`, so a restart of the watcher does not repeat it. Both are percentages for both providers or per provider (`{claude: 80, codex: 70}`).
- **Hint before a start.** The summary of `new --clip` and `queue` has a `plan:` line per provider used, and for each task whose provider is at or above its `usage.warn` while the other is below its own: `hint: NC-42: claude blisko limitu (83%), codex ma zapas (15%): --agent codex`. A plain `new` prints these lines when there is something to say. It only says so: `--agent` stays your decision, and a `pin: true` task is told that it stays.
- **Queue hold.** `usage.queue_hold: 90` (or per provider): the watcher starts no queued task of a provider whose plan is above that percentage in any window; `queue list`, `status` and the board show `wstrzymane: codex 96% limitu 5h (reset 12:10) > usage.queue_hold 90%`, and the watch log says it once. A provider with n/d is never held. Off by default. The config is read when `watch` starts: restart it after changing it.
- **Where.** Only the configured alternative report paths/globs, resolved against the worktrees. Mentioned paths are never searched.

## History and stats

Which model and effort work for what is only visible over many tasks. agentctl appends one JSON object per line to `<config dir>/history.jsonl`:

- when a task's **report is ready** (the watcher or the agent's own event, whichever sees it first; the same report once), when it is **closed**, **cancelled** or **moved**, and when you **mark** it;
- the record: `event`, `at`, `task`, `cohort`, `project` (folder of the first repository), `requested` and `effective` agent/model/effort, `started`, `reportAt`, `closedAt`/`cancelledAt` and `cancelReason`, `durationMs` (start to report, else to the close or cancel), `tokens` (input, output, cacheRead, cacheWrite and `fresh`; `null` when no log was found), `progress` (commits and files; `null` when git could not tell), `verdict` (the first line, as in the notification), `movedFrom` and `movedTo`, `result`, `note`.

`agentctl mark <TASK> ok|partial|fail [--note "…"]` records your judgement; the last mark wins. `agentctl log [--since 7d] [--cohort X] [--json] [--clip]` folds the records to one line per task, newest first (a later empty value never wipes one that was known). `agentctl stats [--since 30d] [--cohort X] [--json] [--clip]` groups the tasks by agent/model/effort: tasks, median time and median tokens (n/d without any), the share of ok, partial and fail **among the marked ones**, unmarked, cancelled, and moved (tasks of the group that hit a limit and were handed to the other provider). A history is as good as the marks: an unmarked task counts as unmarked, never as ok.

On the board **`l`** opens the log (`↑↓` scroll, `Esc` back) and **`o`** / **`p`** / **`f`** mark the selected finished task (a task without a window, a closed or cancelled one, or one with a report ready); `p` keeps pausing the queue while no finished task is selected. The menu of a finished task (`Enter`) offers the same marks. The MCP server has `log`, `stats` and `usage` (read) and `mark` (write; `mcp.allow`, audited, single-task marks are immediate; multiple tasks require a scope preview/confirmation).

## Navigation

`agentctl board --tmux` and `agentctl watch --tmux` start their command **as the process of the window** (`tmux new-window … <command>`), not by typing it into a shell, and set `remain-on-exit` in the same tmux call (`failed` for board, `on` for watch): failed board commands and every ended watch process leave their output on screen, and `~/.agentctl/board.log` / `watch.log` have the start (terminal size, `CI`, tty flags) and the end or the stack of the failure. Running `board --tmux` again starts a window whose process has ended in place. The board waits for a terminal size (a window without a client can report 0x0 for a moment) and draws even when a `CI` variable is in the environment (Ink would otherwise draw nothing).

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
- **A failed start** (setup failed, repository gone, agent not ready) puts the task at the end of the line as `failed`, with the error in `queue list` and the log of the attempt in `<config dir>/queue/<n>-<TASK>.log`, and sends a notification. It is not tried again by itself; `queue retry` is your decision (it reuses a worktree the failed start left). A window whose agent never showed its input (a startup dialog such as the Codex "Update available" modal, or a readiness timeout) is closed by the watcher, so it holds no provider slot; with the worktree kept, the task then also shows in "to resume" (`agentctl resume`). The same reconciliation applies to a start interrupted by a watcher restart: the record and the queue entry never disagree.
- The queue only moves while `agentctl watch` runs (`watch --tmux`); `watch` reads the config again when the file changes ([live limits](#live-limits-and-the-config-reload)), so a changed `limits` needs no restart. `queue.enabled: false` in the config switches starting off; `queue.parallel_starts` bounds the starts in progress ([configuration](configuration.md#queue)).

A trust wait that expires keeps the live task and its pending prompt under watch; it does not leave a failed queue entry. After you answer the dialog, watch delivers the original prompt once. Queue ticks also remove stale failed entries belonging to live tasks already waiting or delivering, even while the queue is paused.

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

**A dependency that was cancelled** can never get a report. `queue` and `new` refuse an `after` that names a cancelled task, and a task that is already waiting becomes **blocked** (⛓): `status`, `queue list` and the board say `⛓ zablokowane – NC-42 anulowane` (`blocked: true` in `queue list --json`, `blocked` in the MCP `queue_list`), it never starts (a task that waits for a blocked one is blocked too), and `watch` sends one notification per cancelled author, `NC-43 zablokowane – NC-42 anulowane`, remembered in the queue entry so that a restart repeats nothing. Two ways out: `agentctl cancel NC-43`, or `agentctl unblock NC-43 [--drop-after NC-42]`, which removes the cancelled task (or only the one named) from `after`, in the entry and in its spec; the task is back in the line and waits for the rest of its `after`, or starts.

## Collisions

Two tasks that change the same files in the same repository will meet in a merge conflict. agentctl says so early.

- **What is compared.** For each active task (its window runs) the files changed since its worktree left the base (`git diff --name-only <base>...HEAD`) plus the files with uncommitted changes, per source repository (`repos[].path`). Two tasks collide when the sets share files. `collisions.ignore` leaves out lock files and the like.
- **`agentctl status`** gets a `COLLIDE` column while something collides: `⚠ LANDING-QS-1: 2` is "2 shared files with LANDING-QS-1". `status --json` has the same in `collide`.
- **`agentctl watch`** asks git every `collisions.interval` (300 s) and sends one notification for each new pair ("⚠ A i B zmieniają te same pliki (2): …"). The pair is remembered in `<config dir>/collisions.json`, so neither the next check nor a restart of the watcher repeats it; when the files stop overlapping and later overlap again, it is new again.
- **`agentctl overlap [TASK]`** lists the shared files of every pair (or of the pairs with TASK), computed right now.
- **`touches: [globs]`** in a spec says what the task is going to change. `queue` and `new` then warn, and ask y/N, when an active task already changes matching files (`new -y` does not ask; without a terminal the warning is only printed).
- The board marks a colliding task with `⚠` in the first column and says with whom in the preview ([board](#board)).

## Board

`agentctl board` is a full-screen overview of all tasks, refreshed every 2 seconds (every 5 seconds when nothing is running any more). `agentctl board --tmux` opens it in window `board` of the agentctl session
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
↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?
```

Below 110 columns the preview is hidden and the list takes the whole width (this is 80 columns):

```
agentctl board  agentctl-test · 3 tasks · 09:40:39
  TASK       AGENT              STATE          TIME    PROGRESS REPORT
▸ AC5-A      claude opus/high   ⚙ working      13s     2c 3f    -
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 13s     1c 1f    ready
  AC5-C      claude sonnet/med… ? needs-input  12s     2c 2f    -

Enter – open the agent · F12 – back to the list
↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?
```

The list shows task, agent/model/effort, state icon, time, `PROGRESS` and the report (`-` none, `ready` not pulled yet, `pulled`). From 110 columns the right column
shows the last 30 lines of the selected window (as `peek`, without the footer); below that the list takes the whole width and works down to 80 columns.

| Key | Action |
|---|---|
| `↑` `↓` (`j`) | select a task (`k` is the cohort filter now and no longer moves up) |
| `Enter` | go to the task's window (`select-window` + `switch-client`); `F12` (or `Ctrl-b l`) comes back to the board. On a task without a window it opens a menu instead: `c` copy the report, `x` close, `h` hide, `Esc` |
| `m` | type a message and send it to the agent as `send` does (`Enter` sends, `Esc` cancels) |
| `M` | move the task to the other provider after a usage limit (`agentctl move`), after a `[y/N]` question; refused for pinned and already moved tasks |
| `i` | interrupt the current turn, after a `[y/N]` question |
| `c` | copy the selected task's report (`pull`) |
| `r` | copy all new reports (`pull --ready`) |
| `x` | close the window, after a `[y/N]` question; if the task has a worktree, a second question asks whether to remove it too (`git worktree remove`, never `--force`, the branch stays; `Esc` cancels) |
| `X` | cancel the selected task ([Cancelling tasks](#cancelling-tasks)): asks for a reason (optional; `Enter` goes on, `Esc` stops), then `[y/N]`. Works on a queued task too; a task from a `move` is cancelled with its other half. The worktree and the branch stay |
| `l` | the log of the tasks (`agentctl log`): `↑↓` scroll, `Esc` back |
| `o` / `p` / `f` | mark the selected finished task ok / partial / fail ([History and stats](#history-and-stats)); `p` pauses the queue when no finished task is selected |
| `k` | pick the cohort to show: `wszystkie` (all), a cohort, or `bez kohorty` (the tasks in no cohort); `↑↓` and `Enter`, or its number. The header says `cohort: <name>`; the lists, the queue and the sections follow the filter |
| `g` / `E` | fold the cohort group of the selected task / open every group |
| `L` | the limits (`agentctl limits`) |
| `G` | preview of the clean-up (`agentctl gc`; nothing is deleted from the board) |
| `R` | resume the tasks under "Do wznowienia" (after y/N) |
| `h` | hide the selected task (or show a hidden one); nothing is closed or removed |
| `u` | on a task of the **Queue (N)** section: move it to the front of the queue |
| `d` | on a task of the **Queue (N)** section: remove it from the queue, after a `[y/N]` question |
| `p` | pause or resume the queue (`queue pause` / `queue resume`) |
| `z` | open or close the **Finished (N)** section |
| `a` | list hidden tasks too (dimmed, marked `·`) and the closed and the cancelled ones, in their own **Closed (N)** and **Cancelled (N)** sections |
| `?` / `q` | help / leave (the agents keep running) |

The **Queue (N)** section stands under the active tasks (see [the queue](#the-queue)): each queued task shows its place in line and what it waits for (`1. czeka na miejsce: claude 2/2`, `2. czeka na NC-42`, `✗ failed: …`), and the preview shows its spec. A task that changes files another active task changes too has `⚠` in the first column, and its preview title says with whom (`⚠ LANDING-QS-1: 2`; [collisions](#collisions)).

**Cohorts.** As soon as one task has a cohort, the active list is grouped: a header per cohort in name order (`- sprint-1 (4) 2⚙ 1✓ 1⧗`: tasks, then the number of tasks per state, queued ones last as `⧗`), the tasks of no cohort last under `- bez kohorty (N)`. `g` folds a group (`+` in front, its rows leave the cursor path), `G` opens all of them. The queued tasks of a cohort are counted in its header but stay in the **Queue** section. Without any cohort the list is flat, as before. The tmux status bar is not grouped: it counts all tasks.

The tasks that still have a window come first. Tasks without a window (and without `close`: `dead`, `report-ready` after you closed the agent in its window, `superseded`) wait dimmed under a closed **Finished (N)** title; `z` opens it. Enter on one of them does not try to switch to a window that is not there. See [Closing and hiding tasks](#closing-and-hiding-tasks).

Nothing destructive runs on a single key. The board reuses the core functions of the commands (`sendPrompts`, `interruptTask`, `pullTask`, `pullReady`, `closeTask`, `moveTask`); git is asked for
the progress at most every 10 seconds. It needs a terminal; without tmux `Enter` tells you to use `agentctl attach`.

> **Why Ink, and why `React.createElement` instead of JSX or `htm`?** The project runs on Node's type stripping with sources run directly during development, and JSX is not
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
| `report-ready` | current-attempt report is complete (report-end or settled after turn end), agent idle or window gone |
| `superseded` | the task was moved to the other provider with `agentctl move`; this is the old window, which you close yourself |
| `dead` | the window is gone and there is no report |
| `closed` | `agentctl close` was run (or the state folder is in the archive): listed only by `status --all` and the board key `a`, see [Closing and hiding tasks](#closing-and-hiding-tasks) |
| `cancelled` | `agentctl cancel` was run (the work was abandoned, at work or in the queue): listed only by `status --all` and the board key `a` (section **Cancelled**), see [Cancelling tasks](#cancelling-tasks). It wins over `closed` |
| `orphan` | a window of the agentctl session has no state file (lost or never created) |

Precedence for a live window: `needs-trust`, then `needs-input`, then `working`, then `limited`, then `background`, then `report-ready`, then `waiting` (`superseded` overrides all of them; `closed` and `cancelled` apply only to a task without a window).
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

**Does trusting a parent directory help?** Checked live on 2026-10-31 (Claude Code 2.1.309 with `~/workspace` trusted, Codex 0.166.0 with `~` trusted), in new directories below the trusted one:

| New directory | Claude Code | Codex |
|---|---|---|
| plain folder (no git) | no dialog (inherits) | no dialog (inherits) |
| new git repository | **dialog** | **dialog** |
| `git worktree add` of that repository | **dialog** | **dialog**; says "trusting will apply to the repository root" |

So trusting `worktree_root` (for example `~/workspace/wt`) does **not** cover git worktrees, and `doctor` has nothing to check there. Codex keys a worktree's trust to the repository root, so a trusted main checkout probably covers its worktrees (not tested live: that needs a trusted repository and a new worktree on it, which would change your Codex config); Claude Code asked for a worktree of a trusted checkout too (iteration 1). Hence the wait.

**Kimi (checked 2026-11-08, Kimi Code CLI 2.5.2):** no parent-directory trust and no trusted-roots list. A trust record is an exact workspace path in `~/.kimi-code/workspace-trust/wd_<slug>_<sha256-of-path>`; the CLI checks the record of the exact canonical path only (readWorkspaceTrust in the bundled `agent-core-v2`), so every new worktree asks. The documented ways around the prompt are off-limits for agentctl: `[workspace] require_trust = false` is a global edit of the Kimi config (agentctl never edits it), and `KIMI_CODE_TRUST_WORKSPACE=1` is documented as "equivalent to choosing Trust this folder" (agentctl never answers that dialog). Instead the wait is made cheap: the desktop notification comes **once per task** (`<state_dir>/<task>/trust-notified.json` remembers it, so a re-entry or a watch restart does not notify again) and says what to do, on the board the row **jumps to the top** (a cohort with a trust wait leads the groups) and **Enter on it switches to the window**, where the dialog waits for you.

## Mirror

Off by default. Set `mirror_dir` and `status` and `pull` copy every task report (new or changed) to
`<mirror_dir>/<task>/` and write `<mirror_dir>/status.json` (the same rows as `status --json`). Point it at a synced
folder to read reports and the fleet state from another device. Nothing runs in the background: the mirror is refreshed
when you call `status` or `pull`.

## Safety rules

- `git` is only ever called with `worktree add`, `worktree remove`, read-only queries (`rev-parse`, `status --porcelain`, `merge-base --is-ancestor`, `worktree list`) and, for `gc --branches` only, `branch -d` on a branch that is merged. No merge, rebase, push, `--force` or `branch -D`.
- No auto-accept mode: agentctl adds no such flag and rejects configs that try to. Your own agent settings still apply (for example a default permission mode in `~/.claude/settings.json`); agentctl does not override them.
- Files go to `state_dir` (agentctl's own state) and the cache directory (reports) only. Nothing is written to `~/.claude` or `/tmp`.
- Messages that name a tmux target quote it (`-t '=agentctl:nc-42'`): zsh expands a word starting with `=` to a program path.
- Error messages are short and say what to do next.

## Window limits and cross-review

- `limits.<agent>` caps simultaneous tmux windows per provider; the error lists the live windows. Windows are attributed to a provider through their `TASK.md`. Reserved places and (with `limits.count_external`) external sessions count too ([live limits](#live-limits-and-the-config-reload)).
- `review_of: NC-6` looks up the author in `<state_dir>/nc-6/TASK.md` (or in the same file) and requires a different agent **or** a different model. `default` counts as a model name of its own.

## Stable install and updates

Recommended: `npm i -g @setech-pl/agentctl`. The packaged `agentctl-update` runs `npm install -g @setech-pl/agentctl@latest`, without git or tmux restart. Clone options `--ref`, `--no-watch`, `--no-link` are rejected in npm mode. `doctor` shows the installation source and warns about PATH conflicts. MCP uses the absolute installed JavaScript path. The clone mode below remains available for development.

Use a **stable copy** for daily work and keep `~/workspace/agentctl` for development only. (`npm link` from the repo made the global
`agentctl` run whatever branch was checked out there, finished or not.) The stable copy is a detached git worktree of the repo,
by default `~/workspace/agentctl-stable`; `bin/agentctl-update` creates and updates it.

```sh
~/workspace/agentctl/bin/agentctl-update     # first installation
agentctl-update                             # later, after a PR is merged
```

It does, in this order: `git fetch origin` in the repo; `git worktree add --detach <stable> <ref>` (or, when the copy exists, a refusal
if it has local changes, else `git checkout --detach <ref>`); `npm ci`, `npm run build` and `npm link` in the stable copy, so the global `agentctl` and
`agentctl-update` point at it; `agentctl doctor` (a failure makes the script exit non-zero); if a window with `@agentctl-role=watch` (or the legacy name `watch`) exists in the tmux session
`agentctl`, it kills that window by ID and starts `agentctl watch --tmux` from the new version (no other window is touched); finally it prints the
previous and new commit and whether watch was restarted.

| Option / variable | Meaning |
|---|---|
| `--ref <ref>` | what to install, default `origin/main` |
| `--dry-run` | print the commands, run none |
| `--no-watch` | do not restart the watch window |
| `--no-link` | skip `npm link` (for testing the script without re-pointing the global commands) |
| `AGENTCTL_REPO` | the repo; default: the directory above the script's `bin/` (symlinks resolved) |
| `AGENTCTL_STABLE_DIR` | the stable copy, default `~/workspace/agentctl-stable` |
| `AGENTCTL_SESSION` | tmux session of the watch window, default `agentctl` |

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md): tests, typecheck, `npm run docs`, how the code is organised and how a milestone is closed.

Codex: collapsed questions show their count and the shortcut read from “to answer”. `needs-input` takes priority while Codex keeps working; after answering, the screen determines the state again. Board preview, peek, status/MCP `question` and macOS show the question or opening instructions. ntfy sends only opening instructions by default; `notify.ntfy.include_question: true` opts into question text.

Session fallback: a pending `request_user_input` function call can supply its first question when a Codex event has already attributed the session ID to the task. Reads are bounded to 256 KiB per matching session; missing, unowned, completed or code-mode-only calls fall back to the screen instructions. No personal sessions were inspected for this milestone.

## Dispatcher capacity and estimates

`capacity` reads current sources on every call. Claude uses the statusline JSON captured by usage-tap; Codex first tries the documented app-server read RPC (initialize → initialized → account/rateLimits/read), with no thread/start or turn/start, then existing session logs. Provenance and the original reading age survive fallback. There is no long-lived capacity response cache. Missing or expired windows are n/d, never assumed zero. A provider need not expose both a 5 h and a weekly window.

Each usage read records a distinct source timestamp in a bounded sample journal. Pace is the percentage delta divided by elapsed hours, with at least two samples and 60 seconds in a monotone sequence in the same window/reset. A reset or decreasing percentage starts a new segment. Positive pace gives projectedExhaustAt from the last reading; zero/insufficient pace gives n/d. This is a projection at observed pace, not a provider prediction. Samples and event dedup are shared by CLI, board, watch and MCP. Watch observes thresholds, stale readings with active provider windows, and window resets; observing commands also record available facts. Observation cannot reconstruct thresholds crossed and reset entirely between samples.

`estimate.tokensPerPercent` divides the growth in fresh tokens of agentctl tasks by the increase in percentage in the same sample interval. `remainingTokens` multiplies that ratio by remaining percent. Minimum: three samples, five minutes, two percentage points, growing token counters, and token capture within 60 seconds of every source reading. Old logs first read later cannot establish this correspondence. Sample retention, delayed transcript writes, cache accounting, changed model mix, provider weighting and outside usage limit accuracy. Input + output + cache writes count as fresh tokens; cache reads are reported elsewhere and excluded here.

`estimate.basis` includes start/end, sample count, percent increase, agentctl token delta and agentctlTokenShare. The account-wide token denominator is not available from the supported plan readings, so the share is **n/d (`null`)**, never 100% by assumption. Confidence rules: **low** for a valid correlation with unknown outside share (all estimates in 0.17); **medium** requires a measured share >=80%, >=10 samples and >=30 min; **high** requires a measured share >=95%, >=30 samples and >=2 h. Medium/high are deliberately unavailable until a compatible source measures the account denominator. Percent covers use outside agentctl: the estimate is not a provider token quota. Without sufficient evidence the entire estimate is n/d.

Capacity includes slots (active, limit, reservations, external counted sessions, free), queue count/next entry, equivalent model/effort pairs and seven-day stats. `null` slot limit/free means unbounded configuration. It excludes task-history rows; `usage`, `log` and `stats` retain that history. New and queue include a compact snapshot of both providers; set `capacity.snapshot: false` to disable it. The ordering agent, not the tool, chooses the allocation. [Shared guide](dispatcher.md).

### Stable service windows and delivery ownership

Watch and board windows carry `@agentctl-role`, so renaming a window does not make a second service. Use `agentctl watch --tmux --restart` or `agentctl board --tmux --restart`, and `agentctl up --no-attach` from a terminal that should stay free. Watch uses remain-on-exit on even for an exit without error; quick unexpected exit becomes an error and sends a local notification. Doctor checks the watch pane and prints its full start command. MCP registrations prefer the Node symlink outside Homebrew Cellar; doctor flags version-pinned entries with `agentctl mcp install --desktop --claude-code`. Clone updater uses checkout --detach so another worktree may own main.

Event/watch delivery takes a process-shared per-task lock before re-reading notified.json and holds it through desktop delivery/fallback and ledger commit. The second source then observes the committed state. Independent task transitions remain parallel; repeated same-source permission events remain distinct. The phone queue has a separate process-shared lock covering read/change/write and retry HTTP delivery so enqueue and retry cannot overwrite each other. Definite HTTP failures retry with existing backoff and a visible final failure. No client can promise exactly-once HTTP delivery after a timeout where the remote server accepted the request but the response was lost; process death between an external send and local commit has the same limitation. These are not silently described as exactly-once guarantees.

Since 0.17.1 MCP covers queue retry/control, cohorts, `gc` and diagnostics. Check `capacity.disk` before dispatching work. For a failed queue entry, read the reason and propose a repair or `queue_retry`. At disk-warn propose `gc_preview`; at disk-critical seek approval for `gc`, or use it within the user’s authorization. Starts and removals require preview and confirmation; `mcp.allow` alone does not replace confirmation. See [MCP](mcp.md).

## 0.17.2: economy and reliability / ekonomia i niezawodność

`report-candidate` is a report flag, never a task state. Questions and needs-input/working/waiting remain visible. Candidates cannot release after or complete cohorts. Explicit confirmation: `agentctl report TASK --from FILE` / MCP `report_from`. Historical report_source differing from canonical produces a status/doctor warning without altering files.

`overloaded` is separate from `limited`: provider capacity problems never trigger a provider switch. Technical retry is bounded and requires a visible, empty, idle input; background monitors/shells block retry. `N monitors/shells still running` means `background`, not `waiting`. Claude 529 / overloaded_error is documented by Anthropic; Codex capacity/server overload messages are covered by fixtures, with no real inference agent executed during verification.

History records requested, resolved and observed model/effort (from the session; otherwise unknown), plus the agent CLI version (session metadata, else start preflight). An observed/requested difference is a factual warning. Codex `reasoning_output_tokens` is a subset of output and is never added again. `self_verdict` comes only from the first nonempty `Werdykt:` line and remains separate from the human `mark`. Stats shows both and unmarked counts; events_since reminds about unmarked reports.

Queue retries only explicit transient OS/network failures: ETIMEDOUT, EAGAIN, ECONNRESET, ECONNREFUSED, ENETUNREACH, EAI_AGAIN, a temporarily busy lock and transient network setup timeouts. Delays: 1, 5, 15 minutes, then failed; invalid specs, missing paths and branch conflicts fail immediately. `agentctl queue show TASK` / MCP `queue_show` includes the full spec, reason and attempt history. Automatic reuse passes the same residue safety check as a manual retry.

In `links.to`, `{task:TASK-ID,repo:REPO-NAME}/sub/path` resolves to that task's recorded worktree for the repository basename, independent of this spec's `repos`. Current records take precedence over archived records. Unknown tasks, absent or ambiguous repositories, and closed/archived tasks without a retained worktree produce preview errors. A retained closed worktree is allowed when explicitly referenced. This composes with `{worktree:repo|fallback}` (including a task placeholder in the fallback); P18 recursion checks and missing-target validation still apply. Example: `to: "{task:BACK-12,repo:backend}/packages/sim"`.

When the spec has no links of its own, new/queue previews warn about inherited project default links whose targets are missing or belong to closed/cancelled/archived tasks, even if the old worktree still exists. The warning names the resolved stale target and suggests `{task:TASK-ID,repo:REPO-NAME}/sub/path` or `{worktree:repo|fallback}`; defaults are never silently retargeted. Existing missing-target checks still block creation when the target is absent.

Verified sources: [Anthropic API errors](https://platform.claude.com/docs/en/api/errors) documents 529/overloaded_error; [Codex error definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/error.rs) maps the selected-model capacity message to ServerOverloaded. No real inference agents were run. Bare monitor/shell wording and raw error-code variants are fixture-tested; installed current runtime wording remains unverified.

0.17.2 review correction / poprawka po przeglądzie: summary_delivered ≠ pulled ≠ mark. Use full report pages or explicit ack; reports require current attempt plus report-end or settled ended turn. Stable client event cursors and bounded pages are described in [mcp.md](mcp.md); report.settle_s and overload.give_up_after in [configuration.md](configuration.md).

Overload episodes survive short working/waiting transitions; only 600 s continuous work (overload.reset_after_s) or completion/report resets the budget. Claude requires a prefixed error directly below its block. Default MCP sessions consume events independently; successors inherit the saved client high-water mark, while explicit client intentionally shares. A crashed pane alone does not confirm report completeness.

Since 0.17.3 cohort completion waits 300 seconds after the last membership/state change (`cohort.done_grace_s`); adding a task cancels the pending notice. MCP responses default to 8 KiB (`mcp.max_response_kb`) with continuation through `response_page`. Disk shows totals, count and the five largest worktrees; full paths require detail and pagination. The updater restarts watch and board by role even after window renames. Generated hooks and notify use stable Node paths.

## Post-live fixes in 0.17.3

Initial prompts (also from queue/move) and resume instructions name the absolute canonical report file. TASK.md persists pending_prompt, prompt_delivery and prompt_sent_at. After folder trust, new/watch sends the saved prompt once under a process-shared lock. The adapter pastes once, checks only the visible screen, and retries Enter at most twice while its own draft remains. Working or new assistant output acknowledges delivery; otherwise start/send succeeds with “dostarczenie niepotwierdzone – sprawdzam”. Watch checks for up to delivery_confirm_s (default 60 s) from the paste, then emits needs-attention once if no evidence arrives. A later hook, working screen, completed turn or current canonical report clears attention automatically; a completed canonical report remains available to events_since, pull_ready, after and cohorts. Claude UserPromptSubmit (matching the current prompt), Stop and Notification and Codex notify are checked before screens. Delivery generations reject old acknowledgements. Adapter working_pattern recognizes Claude 2.1.x spinner progress without requiring “esc to interrupt”; delivery_pattern recognizes new assistant output. A submitted transcript echo followed by an empty composer also confirms delivery. Dialogs are never answered automatically.

Explicit report_from records report_confirmed; detail retains the source while the historical-copy warning disappears. Report candidates generate no local/phone notification: journal/status/board retain the flag so it does not compete with a question. Large pull_ready full responses continue through response_page and are not marked pulled until contiguous delivery completes. Plain shells are not orphans; an agent process or task role is required.

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

The answer of `send` and `delivery_result` (TASK.md, `status --json`, MCP `status`) say what happened: delivered (`delivered`, with its source), `w kolejce agenta – niepotwierdzone` (queued-in-agent: the screen shows the message in the agent’s queue, nothing has confirmed it) , `w kolejce agenta – potwierdzone` (`queued-in-agent-confirmed`: an exact enqueue is recorded, pending stays until injection) or `nie dostarczono – tekst w polu wpisywania` (not-delivered-in-field: the paste stands in the input field). **Delivered is said only on an exact source**, compared literally (line ends are the one normalisation; no run of white space is squeezed): the UserPromptSubmit hook (its prompt for a collapsed paste is wrapped in `<pasted_content id=…>`; the wrapper is taken off the hook’s text only, by pairs of ids, and nested, mismatching or stray tags are ambiguous = no proof; the pending prompt is compared as written), the notify payload of Codex, or the session transcript of the task itself (Claude Code: the `user` line; for `promptSource:"queued"`, it must correlate uniquely with an unconsumed enqueue from after delivery started; Codex: the `response_item` / `item_completed` line, or `user_message` in older versions) holding a message written after the delivery began that is exactly the pending one (for a collapsed paste the full text, not the label). Only the transcript files of the task’s own sessions are read: the session named by its hook/statusLine/notify for this attempt, with one pinned file identity. Missing, replaced or rotated files never fall back to another session. An enqueue alone confirms only the agent queue; pending stays even after the turn or timeout, with an explicit note until injection or a matching hook. What the agents themselves do to a message is not part of it: the white space at its end is dropped, the newlines around a collapsed paste are the wrapper’s padding, Claude Code stores a tab as four spaces. The screen confirms nothing for a working agent: an echo of Codex or the queue sign of Claude Code (the dim “Press up to edit queued messages”, the queued message with “ctrl+x ctrl+s to send now”) only classifies the state as `w kolejce agenta – niepotwierdzone` (the sign only when it was not on the screen just before our own Enter and appeared after it with our paste gone from the field); the pending prompt stays, and the delivery goes on to wait for the hook or the transcript. For an idle agent that was pasted into, the older signs of the first prompt of every task remain (the turn started, the canonical report changed, the message echoed whole above an empty composer). **agentctl presses Enter only in the call that pastes**: up to three times, and before each one it captures the screen and compares the whole area of the input field, byte for byte (empty lines inside included), with the image taken right after the paste, which must itself be our paste (one placeholder, or the lines of the text); the same capture must show no dialog. The area ends at a structural composer boundary (Claude borders or the recorded Codex model/hints region), never at footer-like text inside the field; an unreadable or truncated structure refuses Enter. A difference, a changed first image or an open dialog means no Enter and `nie dostarczono – tekst w polu wpisywania` (needs-attention at the next watch tick, with the two ways out). `watch` never presses Enter. `agentctl send --enter-only TASK` shows the exact text of the field, the screen state and a token for those bytes; `agentctl send --enter-only TASK --confirm TOKEN` captures again and presses Enter only if the area is still byte for byte the previewed text and the image recorded after our paste (so agentctl pasted it for this delivery) and the screen shows no dialog; anything else is refused with the reason. MCP: `send` with `enter_only: true` and no text needs its own permission `send_enter` in `mcp.allow` (`send` alone does not allow it); without `confirm: true` it only previews (text, state, `token`), with `confirm: true` and that `token` it presses; a refusal and a failed key (tmux `send-keys` error) are `isError` answers with the reason, the failed key is audited `failed` and never announced as sent, a pressed Enter is audited as executed (`enter-sent`, with the delivery) and announced, and the answer keeps “Enter sent” apart from “delivery confirmed”. With an open Codex question nothing is pasted: the answer names the question (“Codex ma otwarte pytanie „…” (zwinięte, N)”) and the message stays in the FIFO. The journal (`events_since`, kind WIADOMOŚĆ) records every change of the result of a follow-up with its delivery id: queued, not delivered, delivered (the first prompt of a task: only the first two).

A provider limit emits one notice per episode with the known reset (otherwise `n/d`). Fresh remaining capacity above `limited.resume_above_percent` (5 by default), or an elapsed known reset, permits `limited.message` (`kontynuuj`) to the idle empty window. The overload guards check again before paste and Enter; attempts and limits survive restarts. `limited.auto_resume: false` disables sending. Provider and model stay the same.

`agentctl mark --cohort NC ok --note "reviewed"` previews its exact range; `--yes` confirms. MCP accepts `task`, `tasks` or `cohort`; more than one task requires preview/confirm. With a cohort filter, board `o/p/f` previews its IDs before marking. Agentctl records the user's result. Closing every cohort task emits `gc_suggest` with that cohort's protected cleanup preview; it never deletes automatically.

MCP previews have independent `preview_token` values, expire after ten minutes and refuse a changed range. Pass the token and identical arguments with `confirm: true` — or the token alone, which executes the stored arguments (for `new`/`queue` the spec need not be resent); omitting a token uses the latest matching preview for compatibility. `gc_preview` with a cohort gives only the count of foreign worktrees; confirmed `gc` returns its results without repeating the plan. `notify.mcp_writes` defaults to `summary`, at most once per 60 seconds; `all` and `off` are explicit alternatives. Audit remains complete. F12 returns to the board of the current configured session, including a parallel dev session. Duration includes checkout/setup before the agent starts; stale plan notices are once per reading.

## Provider adapters

The registry separates registered IDs from active `providers`. Claude/Codex are required and preserve their 0.17.4 behavior. Optional Kimi Code 2.5.0 owns launch/resume, TOML model/permission metadata, screen patterns, passive wire protocol 1.5 and usage parsing. Unknown protocol falls back to screen classification and a doctor warning. Kimi log/session locations and wire interaction records remain hypotheses.

With Kimi active, limits/reservations, capacity, usage, stats, alerts, queue holds, board and MCP include its third column. `move` requires `--agent` when more than two providers are active; choices include free places and known percentages. `review.prefer` or provider order selects the first active installed mappable reviewer other than the author. Model labels use catalog display names and explicit version overrides, never guessed versions of server-managed aliases.

Kimi has no sandbox. Agentctl never edits its config, answers trust/login/update dialogs or enables auto-accept. It disables updates per process and defaults telemetry off. Task data (prompt, files, command output, diffs) still goes to Moonshot AI. Permission rules match the whole Bash command string; see exact-match examples in configuration.md. The optional `/usage` probe uses a neutral session with manual trust and `/exit`, never a task window, credentials or API. Missing plan data is n/d.

## Development gates

Export the prompt's absolute `AGENTCTL_LIVE_CACHE` before any other shell command, then use `npm run gate -- quick` for fixes/features and reviews, `full` for integration merges, and `release` for release candidates. Do not invent runners or repeat a recorded PASS for the same SHA and scope.

`quick` runs typecheck, build, diff whitespace checks and affected tests on the current Node. `--base <ref>` overrides the default merge-base with `agentctl-0181-rc1`; relative import closure and exact test names select tests, with a full single-Node fallback whenever mapping is uncertain. `full` runs all tests on Node 22.14.0 then Homebrew Node 26, sequentially. `release` builds and packs, runs installed-tarball smoke (12 checks) and the isolated doctor matrix (10 cases) on each Node, then runs every `scripts/live-*.ts` entry sequentially, stopping on failure; `--skip-live` records skipped entries. Real provider inference still requires explicit permission.

`--dry-run` prints the plan without provisioning runtimes or executing checks. Full/release refuse dirty trees unless `--allow-dirty` is recorded. Heavy commands use `nice -n 10` and macOS `taskpolicy -b`; there is no load polling. Full/release wait for `~/Projects/cache-dev/runtimes/.gate.lock`, printing its owner. `AGENTCTL_RUNTIMES_DIR` overrides that shared directory. Node 22.14.0 (darwin-arm64) is downloaded only when absent, checked against nodejs.org SHASUMS256, and retained; Node 26 comes from Homebrew. A stale lock requires verifying its owner has stopped before removing it.

Results and logs are under `$AGENTCTL_LIVE_CACHE/gate-results/<sha>/`; `<tier>.json` records SHA, dirty/exception flags, Node versions, counts, retries and duration. Failed test files run once more; both attempts remain in the logs and result steps. A passing retry can recover the gate while original failure counts remain visible. Dry runs are marked explicitly and do not count as executed gates. Task scratch is removed automatically; retain evidence and shared runtimes.

Report digest reuse always revalidates the current task owner, allowed roots and every symlink component; authorization is never cached.

TASK.md and report cache versions include device, inode, size and nanosecond modification/change times. Coarse (millisecond-aligned) change times disable reuse; known header writes and report copies explicitly invalidate their entries.

When a task ID exists in current state and the archive, board progress and worktrees use the current record.

Live board rows always retain token details, even with closed/cancelled flags or an archived duplicate. Token collection skips only the same nonlive shallow rows that skip outputs and prompt queues.

Expanding hidden/closed sections with `a` requests full row details immediately, even if the active selection does not change; an in-flight refresh queues the deep follow-up.
