# agentctl

A small dispatcher for CLI coding agents ([Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex)).
You write a **spec** (a Markdown file: YAML header + prompt). `agentctl new` turns it into a git worktree, symlinks,
environment variables, a tmux window with the agent already running, and your prompt pasted in.

```
spec.md ──► git worktree ──► symlinks ──► TASK.md in the state dir ──► tmux window ──► agent ──► prompt pasted
```

It is deliberately small: Node core plus a few dependencies (`commander`, `yaml`, and `ink` with `react` for the [board](#board)), no build step, no daemon.
It never runs `git merge`, `rebase` or `push`, and it has no auto-accept mode: the agent keeps asking you for permission.

## Install

Requirements: **Node 22.6+**, **git**, **tmux 3.2+**, and the agents you want to use (`claude`, `codex`).

```sh
git clone https://github.com/Setech-pl/agentctl.git
cd agentctl
npm install
npm link            # puts `agentctl` on your PATH
agentctl doctor     # checks tmux, node, claude, codex, gh, the cache directory and configs
```

That is fine to try it out. For daily use install a **stable copy** instead, so that a half-finished branch of the repo is never what
your global `agentctl` runs: see [Stable install and updates](#stable-install-and-updates).

Without `npm link` you can run `npx agentctl …` or `node bin/agentctl.ts …` from the checkout.

> **Why TypeScript with no build step?** The code is TypeScript run directly by Node's built-in type stripping
> (`node --experimental-strip-types`, set in the shebang of `bin/agentctl.ts`). I chose it over `tsx` because it adds no
> dependency and no build or loader layer, and it behaves the same under `npx`, `npm link` and in tests.
> The price: only *erasable* TypeScript (no `enum`/`namespace`), imports spell out `.ts`, and Node refuses to strip types
> inside `node_modules`, so install from a clone (`npm link`), not from a registry tarball. From Node 22.18 / 23.6 the flag
> is a no-op; it stays in the shebang so 22.6–22.17 keep working.

## Quick start

```sh
agentctl spec example > nc-42.md     # a ready-made spec, see "Example" below
$EDITOR nc-42.md
agentctl new --dry-run nc-42.md      # prints every command it would run, executes nothing
agentctl new nc-42.md                # for real
tmux attach -t agentctl              # watch the agent work (window "nc-42")
agentctl status                      # the whole fleet at a glance
agentctl pull NC-42                  # report to the clipboard (faster in bulk: see "Daily loop")
agentctl close NC-42 --rm-worktree   # window and worktree gone, the branch stays
```

## Daily loop

With a planning chat on one side and agentctl on the other, the loop needs no file juggling:

```
chat gives a spec ─► agentctl new --clip ─► agentctl watch notifies ─► agentctl pull --ready ─► paste into the chat ─► chat gives a close line
```

1. **The chat gives a spec.** Copy the one code block.
2. **`agentctl new --clip`** reads it from the clipboard (`pbpaste`; `wl-paste` or `xclip` on Linux), prints a summary
   (task, agent/model/effort, worktree, branch, setup, links) and asks `Start? [y/N]`. `-y` skips the question.
   An empty clipboard or text without a `---` YAML header is a plain error. The spec is stored in `<state_dir>/<task>/TASK.md` as usual.
   `agentctl send --clip` does the same for a follow-up prompt.
3. **`agentctl watch`** runs in its own tmux window called `watch` (`agentctl watch --tmux` creates it if it does not exist and
   never starts a second one). Every `watch.interval` seconds (default 15) it computes the [state](#task-states) of all tasks and sends **one**
   desktop notification per transition (macOS notification with a sound via `osascript`; `notify-send` on Linux):
   `NC-42: raport gotowy`, `NC-42 czeka na Ciebie` (waiting longer than `watch.waiting_after`, default 120 s), `needs-trust`, `needs-input` (the agent asked you a question), `orphan` (a window without a state file, see [Lost state](#lost-state-orphans-and-adopt)) and `dead`
   (window gone without a report). The first poll only records the current states, so starting the watcher does not replay old news.
   Transitions are logged to `<cache>/agentctl-watch.log`.
4. **`agentctl pull --ready`** joins every report in state `report-ready` that you have not pulled yet into one text, each under
   `=== NC-42 (claude opus/high) ===`, copies it to the clipboard and marks those tasks as pulled (`pulled:` in the `TASK.md` header in the state dir;
   a report the agent rewrites later counts as new again). It lists what it took and the total size, and warns above 100 KB.
   `--all` ignores the mark. Nothing is marked if the copy fails.
5. **Paste into the chat.** The chat judges the reports; agentctl never gives verdicts.
6. **The chat gives the closing line**, for example `agentctl close NC-41 NC-42 --rm-worktree`. `close` accepts several tasks, shows
   the list (tasks without a report are flagged) and asks `y/N`; `-y` skips the question. Branches are kept, nothing is merged.

At the start of a fresh chat session, `agentctl status --clip` copies a compact Markdown table of all tasks
(task, agent/model/effort, state, time, report, pulled?) for you to paste.

### How the planning chat should format specs

Ask the chat to give **each spec as exactly one code block** that starts with the `---` line, so the copy button copies the whole spec and nothing else:

````
```markdown
---
task: NC-42
agent: claude
model: opus
effort: high
repos:
  - {path: ~/Projects/neon-city, branch: nc-42-tram-bell, base: master}
---
Prompt for the agent, in the language you work in. End with where the report goes.
```
````

- One spec per block. Several specs in one block also work (`new --clip` starts them all), but the summary then lists them together.
- Nothing inside the block that is not part of the spec: no commentary, no second block for the same task.
- A surrounding code fence that ends up on the clipboard is stripped.
- Follow-ups for `send --clip` have the same shape, with only `task:` in the header.
- The closing line is one plain line, `agentctl close A B C [--rm-worktree]`, in a separate block from the specs.

## Spec format

A spec file is a YAML header between `---` lines, followed by the prompt. Put several specs in one file by repeating
the pattern; each header starts a new spec. (A `---` inside a prompt is fine: a fenced block only counts as a header when
it is a YAML mapping with a `task` or `agent` key.)

```markdown
---
task: NC-7
agent: codex
model: gpt-6.1-sol
review_of: NC-6
repos:
  - path: ~/code/app
---
Review the work of NC-6. Report only real problems.
---
task: NC-8
agent: claude
repos:
  - path: ~/code/app
---
Second spec in the same file.
```

| Key | Required | Meaning |
|---|---|---|
| `task` | yes | Task ID, UPPERCASE letters/digits/`-`/`_`, starting with a letter (`NC-42`). The tmux window is the lowercase ID (`nc-42`); the report folder is `<cache>/nc-42/`, agentctl's own state `<state_dir>/nc-42/`. |
| `agent` | yes* | `claude` or `codex`. (*or `defaults.agent` in a config) |
| `model` | no | Model name passed to the agent (`--model` / `-m`). Omitted or `default`: the agent's own default, no flag. |
| `effort` | no | `low`, `medium`, `high`, `xhigh` or `max` (default `high`; Codex has no `max`). See [Effort](#effort). |
| `repos[]` | yes | At least one `{path, worktree, base, branch}`. `path` is the existing checkout. `worktree` is where the new worktree goes (default: `<worktree_root>/<repo-name>-<task>`). `base` is the start point. `branch`, if given, is created (or reused if it exists); without it the worktree is detached. The agent starts in the **first** worktree. |
| `setup` | no | List of shell commands run in the first worktree after `git worktree add` and **before** the links (an install wipes `node_modules`), see [Setup](#setup). |
| `links[]` | no | `{from, to}` symlinks created in the first worktree, see [Links](#links). |
| `env` | no | Environment variables set in the tmux window (so the agent and everything it runs inherit them). |
| `review_of` | no | Task ID of the work being reviewed. The reviewer must use a different agent **or** a different model than the author, otherwise `new` refuses. |
| `pin` | no | `true` forbids moving the task to the other provider, whether by `--agent` or by a limit switch (see [Model equivalents](#model-equivalents)). |
| `report` | no | Where the agent is expected to write its report (default `<cache>/<task>/<TASK>.md`). Used by `status` and `pull`. |

All paths accept `~`. In `worktree`, `links`, `env` values and `report` you can use the placeholders `{task}` (lowercase),
`{TASK}` (uppercase) and `{cache}`; that is what makes them useful in the shared configs below.

Mistakes are reported all at once, in plain words:

```
error: Spec #1 (nc-3) is invalid:
  - invalid task ID "nc-3": use UPPERCASE letters, digits, "-" or "_", starting with a letter (e.g. NC-12)
  - agent must be one of claude, codex (got "gemini")
  - effort must be one of low, medium, high (got "extreme")
hint: Run "agentctl spec example" to see the format.
```

### Setup

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

### Links

Links are the glue that lets a worktree use *another* worktree's code (for example a client against a backend under test).

- `from` is relative to the first worktree, `to` is what it should point at.
- `to` must exist (checked before anything is created), otherwise `new` stops with the list of missing targets.
- `to` without `*`: every match of the glob `from` becomes a symlink to `to`. A `from` without glob characters is a **literal path**: it is linked even if nothing exists there yet, and its parent directories are created (`mkdir -p`), so `from: node_modules/@neon-city/protocol` works in a worktree without `node_modules`.
- A glob that matches nothing only warns, and the warning points to literal paths.
- `to` ending in `/*` (and `from` ending in `/*`): one link per entry of that directory, named after the entry.
  `from: node_modules/@scope/*`, `to: ~/backend/packages/*` links `node_modules/@scope/foo` to `~/backend/packages/foo`, and so on.
- Existing **symlinks** are replaced. Anything that is not a symlink is never touched: `new` stops and tells you which path is in the way.

### Configuration

Three layers, the later one wins: **`~/.agentctl/config.yaml`** (global) → **`.agentctl.yaml`** in the project repo
(the first repo of the spec) → the **spec**. `env` merges key by key, `links` merge (same `from`: later layer wins),
`report`, `worktree_root` and `defaults` are overridden. Unknown keys are errors, so typos do not go unnoticed.
Set `AGENTCTL_HOME` to use another directory than `~/.agentctl`.

```yaml
# ~/.agentctl/config.yaml
cache: ~/Projects/cache        # report folders live here, <cache>/<task>/ (default); this is the only place agents write to
state_dir: ~/.agentctl/tasks   # agentctl's own state per task: TASK.md, setup.log, markers (default; out of the agents' reach)
session: agentctl              # tmux session name (default)
limits:                        # max simultaneous windows per provider
  claude: 3
  codex: 3
defaults: {effort: high}       # agent, model, effort
equivalents: []                # extra Claude<->Codex pairs, see "Model equivalents"
mirror_dir: ~/Dropbox/agentctl # optional, off by default, see "Mirror"
watch:                         # `agentctl watch`, see "Daily loop"
  interval: 15                 # seconds between polls (default)
  waiting_after: 120           # seconds a task may wait before it is worth a notification (default)
  window_icons: true           # state icon in front of the tmux window names; false = off, or a mapping: {working: "▶", needs-input: "❓"}
  status_line: true            # `watch --tmux` shows the task counts in the status bar of the agentctl session; false = leave it alone
agents:
  claude:
    flags: []                  # extra flags appended to the claude command line
    ready_timeout: 60          # seconds to wait for the input prompt
    trust_timeout: 600         # seconds `new` waits for you to answer the folder-trust dialog
    interrupt_key: Escape      # tmux key name sent by `agentctl interrupt`
    # Regexes matched (case-insensitive, per line) against the tmux screen. Defaults shown for claude:
    # ready_pattern:   '^\s*❯\s(?!\d+\.)'                              # the input box, not a "❯ 1." menu line
    # trust_pattern:   'Quick safety check|Yes, I trust this folder'      # folder-trust dialog
    # working_pattern: 'esc to interrupt'                                 # a turn is running
    # question_pattern: 'Enter to select\b.*Esc to cancel'                # the agent asks you something -> needs-input
    # footer_patterns: ['\? for shortcuts', '^\s*(⏵⏵|⏸)', ...]            # TUI chrome that `status` skips for LAST LINE
  codex:
    flags: []
    interrupt_key: Escape
    # ready_pattern:   '^›\s(?!\d+\.)|\? for shortcuts'
    # trust_pattern:   'Trust this folder\?|Folder settings can run code automatically'
    # working_pattern: 'esc to interrupt'
    # question_pattern: 'Waiting for your answer|^\s*\?\s+\d+ questions?\b|to answer\s*$'
    # footer_patterns: ['\? for shortcuts', '⚠ \d+ warnings?', 'f2 to view', ...]
    # effort_args: ['-c', 'model_reasoning_effort={effort}']   # override if your version differs
```

```yaml
# .agentctl.yaml in the project repo
worktree_root: ~/Projects/wt           # worktrees default to <worktree_root>/<repo>-<task>
env:
  NEON_CITY_TASK: "{TASK}"
report: "{cache}/{task}/{TASK}.md"
links: []
setup: []                              # shell commands run in the first worktree before the links, see "Setup"
defaults: {agent: claude}
```

Flags in `agents.*.flags` and `effort_args` are checked: anything that switches on auto-accept
(`--dangerously-skip-permissions`, `--yolo`, `--full-auto`, `--permission-mode bypassPermissions`, `-a never`, …) makes the config invalid.

### Effort

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

## Commands

| Command | What it does |
|---|---|
| `agentctl new [file\|-] [--clip [-y]] [--dry-run] [--reuse] [--agent claude\|codex] [--no-switch] [--no-wait-trust] [--no-agent]` | For each spec: `git worktree add` (error if the worktree exists, unless `--reuse`), the [setup](#setup) commands, symlinks, `<state_dir>/<task>/TASK.md`, a tmux window named after the task in session `agentctl` (created if missing), starts the agent in the first worktree with the env, waits for the agent's prompt (polling `tmux capture-pane`; a folder-trust dialog is waited out, see [Folder trust](#folder-trust)), pastes the prompt as one bracketed paste (`tmux load-buffer -` + `paste-buffer -p`), then sends Enter separately. Everything is validated before anything starts. `--agent` runs the specs on that provider (see [Model equivalents](#model-equivalents)). `--no-agent` stops after setup and links. `--clip` reads the spec from the clipboard, shows a summary and asks y/N (`-y` skips). |
| `agentctl send [file\|-] [--clip [-y]] [--dry-run]` | Paste a follow-up prompt into the existing window (`task` from the header; the rest of the header is ignored). Errors if the window does not exist. The prompt is appended to `TASK.md` with a timestamp. |
| `agentctl status [--json] [--clip] [--tmux-line]` | Table: task, agent/model/effort (as ordered too, if switched), [state](#task-states), window alive?, start, duration, `PROGRESS` (`2c 7f`: 2 commits over the base, 7 changed files, see [Progress](#progress)), report present?, last line of real content in the window (the agent's footer lines such as `? for shortcuts`, mode and warning lines, and empty input prompts are skipped, see `footer_patterns`); start time in local time (`--json` keeps the UTC `started` and adds `startedLocal`). A window of the session with no state file is listed as [`orphan`](#lost-state-orphans-and-adopt), never skipped. Refreshes the [mirror](#mirror) if configured. `--clip` copies a compact Markdown table (task, agent/model/effort, state, time, progress, report, pulled?) to the clipboard. `--tmux-line` prints one short line for the tmux status bar, see [Window icons and the status bar](#window-icons-and-the-tmux-status-bar). |
| `agentctl pull <task>\|--ready [--all]` | Copies the report to the clipboard (`pbcopy` on macOS, `wl-copy` or `xclip` on Linux) and prints its path. No report yet: prints the last 40 lines of the window. Refreshes the [mirror](#mirror) if configured. `--ready` joins all not yet pulled `report-ready` reports into one text, copies it and marks them pulled; `--all` takes pulled ones too. See [Daily loop](#daily-loop). |
| `agentctl adopt <task> --report <path> [--window <name>] [--worktree <path>] [--agent claude\|codex] [--model <m>] [--effort <e>] [--dry-run]` | Restores the state file of a task whose own got lost. Agent, model and effort default to `unknown`. See [Lost state](#lost-state-orphans-and-adopt). |
| `agentctl attach [task]` | Goes to the task's window: `attach-session` outside tmux, `switch-client` inside. See [Attach and peek](#attach-and-peek). |
| `agentctl peek <task> [-n 40]` | Prints the last lines of the task's window without the agent's footer. See [Attach and peek](#attach-and-peek). |
| `agentctl board [--tmux]` | Full-screen overview of all tasks with a live preview and keys to switch, message, interrupt, pull and close. See [Board](#board). |
| `agentctl watch [--tmux] [--no-status-line]` | Foreground loop that sends desktop notifications on state transitions and puts a state icon in front of the tmux window names, see [Daily loop](#daily-loop) and [Window icons](#window-icons-and-the-tmux-status-bar). `--tmux` runs it in window `watch` of the agentctl session and shows the task counts in that session's status bar. |
| `agentctl interrupt <task> [--dry-run]` | Interrupts the current turn by sending the agent's interrupt key (default one `Escape`). The window stays open. See [Interrupt](#interrupt). |
| `agentctl close <task...> [--rm-worktree] [-y] [--dry-run]` | Lists the tasks (flagging those without a report), asks y/N (`-y` skips), then `tmux kill-window` for each; one failure does not stop the others. With `--rm-worktree` also `git worktree remove` (no `--force`; branches are never deleted; a worktree with `main`/`master` checked out is refused). |
| `agentctl doctor` | Versions of tmux, node, git, claude, codex, gh; effort mechanism detected for each agent; cache dir; mirror dir; configs; tmux session. |
| `agentctl spec example` | Prints the example spec below. |

`--dry-run` swaps the execution layer for a recorder: no command is run and no file is written, and it prints what would happen.
Lines starting with `#` are comments, `write`/`append` stand for file writes:

```
$ agentctl new --dry-run nc-42.md
git -C ~/Projects/neon-city worktree add -b nc-42-tram-bell ~/Projects/wt/neon-city-nc-42 master
ln -sfn ~/Projects/wt/neon-city-backend-merge3/packages/protocol ~/Projects/wt/neon-city-nc-42/node_modules/@neon-city/protocol
mkdir -p ~/.agentctl/tasks/nc-42
write ~/.agentctl/tasks/nc-42/TASK.md (805 bytes)
mkdir -p ~/Projects/cache/nc-42
tmux new-session -d -s agentctl -n nc-42 -c ~/Projects/wt/neon-city-nc-42 -e NEON_CITY_TASK=NC-42
tmux send-keys -t =agentctl:nc-42 -l -- 'claude --model opus --effort high'
tmux send-keys -t =agentctl:nc-42 Enter
tmux load-buffer -b agentctl-nc-42 -
tmux paste-buffer -p -d -b agentctl-nc-42 -t =agentctl:nc-42
tmux send-keys -t =agentctl:nc-42 Enter
…
```

(Output shortened; the real one prints absolute paths and the prompt as comments.)

Agent command lines:

- `claude --model <model> --effort <effort> [flags]`
- `codex --sandbox danger-full-access [-m <model>] -c model_reasoning_effort=<effort> [flags]`

Codex runs with `danger-full-access` as asked for, but without any bypass flag: its approval policy stays whatever you configured, so it still asks.

### Model equivalents

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

### Lost state: orphans and adopt

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

### Interrupt

`agentctl interrupt NC-42` sends the agent's interrupt key (`agents.<name>.interrupt_key`, default `Escape` for both) to the
task's window. It types nothing else and does not close the window. Only a single key is sent on purpose: checked live,
one `Escape` at an idle prompt does nothing in Claude Code 2.1.309 and Codex 0.166.0, while a double `Escape` in Codex
opens "edit previous message". `--dry-run` prints the `tmux send-keys` it would run.

### Attach and peek

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

### Progress

`PROGRESS` in `status` (table, `--json` as `progress`, `--clip`, the mirror's `status.json`) shows what each task has to show for itself:
`2c 7f` is 2 commits over the base and 7 changed files, summed over the task's worktrees. The base is the repo's `base` from the spec, else `main`, else `master`.
Commits are `git rev-list --count <base>..HEAD`. Files are the union of `git diff --name-only <base>...HEAD` (what this branch changed since it left the base; three dots,
so changes the base got meanwhile do not count) and `git status --porcelain` (uncommitted and untracked files, collapsed to the directory for a fully untracked directory),
each file counted once. Without a base the commits are `?` (`?c 3f`); a worktree that is gone is `-`. `--json` carries the per-worktree numbers.

### Window icons and the tmux status bar

While `agentctl watch` runs it puts the state of each live window in front of its name, so `Ctrl-b w` and the status bar show what is going on:

| Icon | State |
|---|---|
| `⚙` | `working` |
| `⏸` | `waiting` |
| `?` | `needs-input` |
| `🔒` | `needs-trust` |
| `✓` | `report-ready` |
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

### Board

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

↑↓ move  ⏎ open  m msg  i interrupt  c pull  r pull-new  x close  ? help  q quit
```

Below 110 columns the preview is hidden and the list takes the whole width (this is 80 columns):

```
agentctl board  agentctl-test · 3 tasks · 09:40:39
  TASK       AGENT              STATE          TIME    PROGRESS REPORT
▸ AC5-A      claude opus/high   ⚙ working      13s     2c 3f    -
  AC5-B      codex gpt-6.1-sol… ✓ report-ready 13s     1c 1f    ready
  AC5-C      claude sonnet/med… ? needs-input  12s     2c 2f    -

↑↓ move  ⏎ open  m msg  i interrupt  c pull  r pull-new  x close  ? help  q quit
```

The list shows task, agent/model/effort, state icon, time, `PROGRESS` and the report (`-` none, `ready` not pulled yet, `pulled`). From 110 columns the right column
shows the last 30 lines of the selected window (as `peek`, without the footer); below that the list takes the whole width and works down to 80 columns.

| Key | Action |
|---|---|
| `↑` `↓` (`k` `j`) | select a task |
| `Enter` | go to the task's window (`select-window` + `switch-client`); `Ctrl-b l` comes back to the board |
| `m` | type a message and send it to the agent as `send` does (`Enter` sends, `Esc` cancels) |
| `i` | interrupt the current turn, after a `[y/N]` question |
| `c` | copy the selected task's report (`pull`) |
| `r` | copy all new reports (`pull --ready`) |
| `x` | close the window, after a `[y/N]` question; if the task has a worktree, a second question asks whether to remove it too (`git worktree remove`, never `--force`, the branch stays; `Esc` cancels) |
| `?` / `q` | help / leave (the agents keep running) |

Nothing destructive runs on a single key. The board reuses the core functions of the commands (`sendPrompts`, `interruptTask`, `pullTask`, `pullReady`, `closeTask`); git is asked for
the progress at most every 10 seconds. It needs a terminal; without tmux `Enter` tells you to use `agentctl attach`.

> **Why Ink, and why `React.createElement` instead of JSX or `htm`?** The project runs on Node's type stripping with no build step, and JSX is not
> erasable syntax, so it cannot run unprocessed. `htm` (tagged templates) would avoid the build, but it adds a dependency to write what is a few dozen lines of `createElement` calls,
> and its templates are plain strings that `tsc --noEmit` cannot check; with `createElement` the component props are type-checked like the rest of the code.
> Ink is only loaded when the board starts, so the other commands do not pay for React.

### Task states

`status` derives a state per task from the window (`tmux capture-pane`, patterns per agent in the config) and the report file:

| State | Meaning |
|---|---|
| `working` | a turn is running (`working_pattern`, default `esc to interrupt`) |
| `waiting` | the agent is idle at its prompt and there is no report yet |
| `needs-trust` | the agent shows its folder-trust dialog; a human must answer it |
| `needs-input` | the agent asked **you** a question and waits (`question_pattern`; Codex: `? <question>` with options and `• Waiting for your answer.`, Claude Code: the `Enter to select · Esc to cancel` dialog) |
| `report-ready` | the report file exists and is newer than the start (the agent is idle, or the window is gone) |
| `dead` | the window is gone and there is no report |
| `orphan` | a window of the agentctl session has no state file (lost or never created) |

Precedence for a live window: `needs-trust`, then `needs-input`, then `working`, then `report-ready`, then `waiting`.
These are heuristics on screen text; if a CLI update changes its wording, adjust the patterns in the config.

### Folder trust

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

### Mirror

Off by default. Set `mirror_dir` and `status` and `pull` copy every task report (new or changed) to
`<mirror_dir>/<task>/` and write `<mirror_dir>/status.json` (the same rows as `status --json`). Point it at a synced
folder to read reports and the fleet state from another device. Nothing runs in the background: the mirror is refreshed
when you call `status` or `pull`.

### Safety rules

- `git` is only ever called with `worktree add`, `worktree remove`, and read-only queries (`rev-parse`). No merge, rebase, push, `--force` or branch deletion.
- No auto-accept mode: agentctl adds no such flag and rejects configs that try to. Your own agent settings still apply (for example a default permission mode in `~/.claude/settings.json`); agentctl does not override them.
- Files go to `state_dir` (agentctl's own state) and the cache directory (reports) only. Nothing is written to `~/.claude` or `/tmp`.
- Messages that name a tmux target quote it (`-t '=agentctl:nc-42'`): zsh expands a word starting with `=` to a program path.
- Error messages are short and say what to do next.

### Window limits and cross-review

- `limits.<agent>` caps simultaneous tmux windows per provider; the error lists the live windows. Windows are attributed to a provider through their `TASK.md`.
- `review_of: NC-6` looks up the author in `<state_dir>/nc-6/TASK.md` (or in the same file) and requires a different agent **or** a different model. `default` counts as a model name of its own.

## Example: Neon City

This is what `agentctl spec example` prints. A task on the Neon City client, run in its own worktree
`~/Projects/wt/neon-city-nc-42`, with the client's `@neon-city/*` packages linked to the backend worktree under test
(`~/Projects/wt/neon-city-backend-merge3`) and the task ID in `NEON_CITY_TASK`:

```markdown
---
task: NC-42
agent: claude
model: opus
effort: high
repos:
  - path: ~/Projects/neon-city
    worktree: ~/Projects/wt/neon-city-nc-42
    base: master
    branch: nc-42-tram-bell
links:
  # Point the client's @neon-city/* packages at the backend worktree under test.
  - from: node_modules/@neon-city/*
    to: ~/Projects/wt/neon-city-backend-merge3/packages/*
env:
  NEON_CITY_TASK: NC-42
report: ~/Projects/cache/nc-42/NC-42.md
---
Add a bell sound to the tram when it leaves a stop.

- Reuse the existing audio bus; do not add new dependencies.
- Cover the new behaviour with a test.
- When you are done, write a short report (what changed, how you checked it,
  what is left) to ~/Projects/cache/nc-42/NC-42.md.
```

A cross-review of it by a different model is one more spec (in the same file or later):

```markdown
---
task: NC-42-R
agent: codex
model: gpt-6.1-sol
review_of: NC-42
repos:
  - path: ~/Projects/neon-city
    worktree: ~/Projects/wt/neon-city-nc-42-r
    base: nc-42-tram-bell
---
Review the commits of NC-42. Do not modify the repository; report only real problems.
```

## Why not Orca / Claude Squad / Conductor?

Tools like Orca, Claude Squad and Conductor are good at *managing agent windows*: opening sessions, showing them side by side,
switching between them. If that is what you need, use them; agentctl is not trying to replace a window manager (it uses tmux for that).

agentctl manages **work orders**. The unit is a spec file that you can review, version and reuse, and it carries the
things a window manager does not know about:

- **Symlinks**: a worktree wired to another worktree's packages, replaced idempotently.
- **Env**: per-task variables, layered global → project → spec.
- **Agent flags**: model, effort, sandbox and your default flags per agent, with a guard against auto-accept.
- **A cross-review rule**: `review_of` refuses to let the same agent *and* model grade its own homework.
- **Per-provider window limits**: at most N Claude and M Codex windows at once, with a clear error that lists who holds them.
- **A paper trail**: `TASK.md` in the state dir records the spec, start time, and every follow-up prompt.

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

```sh
npm test            # node:test, no real tmux/git/agents involved
npm run typecheck   # tsc --noEmit
```

The engine lives in `src/core/` and returns data (status rows, plans, results); `src/cli.ts` and `src/render.ts` are the thin
layer on top, and so is the board: `src/core/board.ts` holds its state, key handling and actions without a terminal, `src/board/app.ts` only draws it with Ink. All side effects go through the `Runner` interface (`src/core/runner.ts`):
`RealRunner` for production, `RecordingRunner` for `--dry-run` and the tests, which feed it scripted `tmux capture-pane` screens and compare the commands it recorded.

## Limitations

- **Window limits count only windows created by agentctl.** A window is attributed to a provider through its `TASK.md`;
  windows you opened by hand are listed in limit errors but not counted.
- **Install from a clone only** (`npm link`). Node does not strip types inside `node_modules`, so a registry install would
  not run. Plan: a build step (emit plain JavaScript) at the first npm release.
- Screen patterns (ready, trust, working) are heuristics tied to the wording of the current Claude Code and Codex TUIs.
- Links replace symlinks only, never real files or directories.
- The board draws state icons with characters whose width differs between terminals (`⚙`, `⏸` are one or two cells wide); if columns look shifted, set `watch.window_icons` to plain symbols.
- `close` kills the window before it tries `git worktree remove`; a worktree with uncommitted or untracked files is refused (no `--force`), so the window is already gone when that error appears.

## Roadmap

1. **Iteration 1 (this one):** spec → worktree/links/env/window/agent/prompt; send, status, pull, close, interrupt, doctor; model equivalents with `--agent` and limit switching; task states and folder-trust detection; optional mirror.
   Follow-up: `new` waits for the folder-trust dialog (`trust_timeout`, `--no-wait-trust`).
2. **Iteration 2:** a TUI on the same core (done: [`agentctl board`](#board)), and `agentctl serve` with a read-only web UI, published through Cloudflare Tunnel and protected by Cloudflare Access.
3. **Iteration 3:** actions in the UI (send, close) and notifications; a `.agentctl-done` marker file an agent can write to say it has finished.

## License

[MIT](LICENSE)
