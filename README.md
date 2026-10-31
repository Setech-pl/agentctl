# agentctl

A small dispatcher for CLI coding agents ([Claude Code](https://docs.claude.com/en/docs/claude-code) and [Codex](https://github.com/openai/codex)).
You write a **spec** (a Markdown file: YAML header + prompt). `agentctl new` turns it into a git worktree, symlinks,
environment variables, a tmux window with the agent already running, and your prompt pasted in.

```
spec.md ──► git worktree ──► symlinks ──► TASK.md in the cache ──► tmux window ──► agent ──► prompt pasted
```

It is deliberately small: Node core plus two dependencies (`commander`, `yaml`), no build step, no daemon.
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
agentctl pull NC-42                  # report to the clipboard
agentctl close NC-42 --rm-worktree   # window and worktree gone, the branch stays
```

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
| `task` | yes | Task ID, UPPERCASE letters/digits/`-`/`_`, starting with a letter (`NC-42`). The tmux window is the lowercase ID (`nc-42`); the cache folder is `<cache>/nc-42/`. |
| `agent` | yes* | `claude` or `codex`. (*or `defaults.agent` in a config) |
| `model` | no | Model name passed to the agent (`--model` / `-m`). Omitted or `default`: the agent's own default, no flag. |
| `effort` | no | `low`, `medium` or `high` (default `high`). See [Effort](#effort). |
| `repos[]` | yes | At least one `{path, worktree, base, branch}`. `path` is the existing checkout. `worktree` is where the new worktree goes (default: `<worktree_root>/<repo-name>-<task>`). `base` is the start point. `branch`, if given, is created (or reused if it exists); without it the worktree is detached. The agent starts in the **first** worktree. |
| `links[]` | no | `{from, to}` symlinks created in the first worktree, see [Links](#links). |
| `env` | no | Environment variables set in the tmux window (so the agent and everything it runs inherit them). |
| `review_of` | no | Task ID of the work being reviewed. The reviewer must use a different agent **or** a different model than the author, otherwise `new` refuses. |
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

### Links

Links are the glue that lets a worktree use *another* worktree's code (for example a client against a backend under test).

- `from` is relative to the first worktree, `to` is what it should point at.
- `to` without `*`: every match of the glob `from` becomes a symlink to `to`. A `from` without glob characters is a single link.
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
cache: ~/Projects/cache        # task folders live here (default)
session: agentctl              # tmux session name (default)
limits:                        # max simultaneous windows per provider
  claude: 3
  codex: 3
defaults: {effort: high}       # agent, model, effort
agents:
  claude:
    flags: []                  # extra flags appended to the claude command line
    ready_pattern: '\? for shortcuts'   # regex on the tmux screen: "the agent is ready for input"
    ready_timeout: 60                   # seconds
  codex:
    flags: []
    ready_pattern: 'context left|\? for shortcuts'
    ready_timeout: 60
    # effort_args: ['-c', 'model_reasoning_effort={effort}']   # override if your version differs
```

```yaml
# .agentctl.yaml in the project repo
worktree_root: ~/Projects/wt           # worktrees default to <worktree_root>/<repo>-<task>
env:
  NEON_CITY_TASK: "{TASK}"
report: "{cache}/{task}/{TASK}.md"
links: []
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

The Codex override is accepted by the CLI, but I could not confirm end to end that the model really runs with that effort
without launching an agent, which this project's first iteration deliberately never does in its tests.
Check it once with a real task (`/status` inside Codex). If a future version changes this, set `agents.<name>.effort_args`
(`[]` to pass nothing). `agentctl doctor` shows which mechanism it detects.

## Commands

| Command | What it does |
|---|---|
| `agentctl new [file\|-] [--dry-run] [--reuse]` | For each spec: `git worktree add` (error if the worktree exists, unless `--reuse`), symlinks, `<cache>/<task>/TASK.md`, a tmux window named after the task in session `agentctl` (created if missing), starts the agent in the first worktree with the env, waits for the agent's prompt (polling `tmux capture-pane`), pastes the prompt as one bracketed paste (`tmux load-buffer -` + `paste-buffer -p`), then sends Enter separately. Everything is validated before anything starts. |
| `agentctl send [file\|-] [--dry-run]` | Paste a follow-up prompt into the existing window (`task` from the header; the rest of the header is ignored). Errors if the window does not exist. The prompt is appended to `TASK.md` with a timestamp. |
| `agentctl status [--json]` | Table: task, agent/model/effort, window alive?, start, duration, report present?, last non-empty line of the window. |
| `agentctl pull <task>` | Copies the report to the clipboard (`pbcopy` on macOS, `wl-copy` or `xclip` on Linux) and prints its path. No report yet: prints the last 40 lines of the window. |
| `agentctl close <task> [--rm-worktree] [--dry-run]` | `tmux kill-window`. With `--rm-worktree` also `git worktree remove` (no `--force`; branches are never deleted; a worktree with `main`/`master` checked out is refused). |
| `agentctl doctor` | Versions of tmux, node, git, claude, codex, gh; effort mechanism detected for each agent; cache dir; configs; tmux session. |
| `agentctl spec example` | Prints the example spec below. |

`--dry-run` swaps the execution layer for a recorder: no command is run and no file is written, and it prints what would happen.
Lines starting with `#` are comments, `write`/`append` stand for file writes:

```
$ agentctl new --dry-run nc-42.md
git -C ~/Projects/neon-city worktree add -b nc-42-tram-bell ~/Projects/wt/neon-city-nc-42 master
ln -sfn ~/Projects/wt/neon-city-backend-merge3/packages/protocol ~/Projects/wt/neon-city-nc-42/node_modules/@neon-city/protocol
mkdir -p ~/Projects/cache/nc-42
write ~/Projects/cache/nc-42/TASK.md (805 bytes)
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

### Safety rules

- `git` is only ever called with `worktree add`, `worktree remove`, and read-only queries (`rev-parse`). No merge, rebase, push, `--force` or branch deletion.
- No auto-accept mode, and configs that try to enable one are rejected.
- Working files go to the cache directory only (`TASK.md`, reports). Nothing is written to `~/.claude` or `/tmp`.
- Error messages are short and say what to do next.

### Window limits and cross-review

- `limits.<agent>` caps simultaneous tmux windows per provider; the error lists the live windows. Windows are attributed to a provider through their `TASK.md`.
- `review_of: NC-6` looks up the author in `<cache>/nc-6/TASK.md` (or in the same file) and requires a different agent **or** a different model. `default` counts as a model name of its own.

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
- **A paper trail**: `TASK.md` in the cache records the spec, start time, and every follow-up prompt.

## Development

```sh
npm test            # node:test, no real tmux/git/agents involved
```

All side effects go through the `Runner` interface (`src/runner.ts`): `RealRunner` for production, `RecordingRunner` for
`--dry-run` and the tests, which feed it scripted `tmux capture-pane` screens and compare the commands it recorded.

## Roadmap

1. **Iteration 1 (this one):** spec → worktree/links/env/window/agent/prompt; send, status, pull, close, doctor.
2. **Iteration 2:** `agentctl serve` with a read-only web UI, published through Cloudflare Tunnel and protected by Cloudflare Access.
3. **Iteration 3:** actions in the UI (send, close) and notifications; a `.agentctl-done` marker file an agent can write to say it has finished.

## License

[MIT](LICENSE)
