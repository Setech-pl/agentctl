# agentctl

Local task dispatch for Claude Code, OpenAI Codex CLI, Kimi Code CLI and Z.ai GLM. A Markdown spec becomes a Git worktree, an interactive tmux agent and a reviewable report. Watch services the queue, delivery, notifications and consultations.

[Polski](README.pl.md) · **[English manual](docs/en/overview.md)** · [From zero](docs/en/tutorial.md) · [0.23.1 release notes](docs/release-notes/0.23.1.en.md)

![Real board, synthetic tasks, no inference](docs/img/board-main.png)

Dependencies/verdict gates, provider slots/plan holds, safe follow-ups, reports, cohorts, WALL and CONSULT: [all features](docs/en/features.md). [Every TUI view](docs/en/screenshots.md) includes help, capacity, WALL filters and threads.

| Start here | Reference |
|---|---|
| [Install and first task](docs/en/tutorial.md) | [Configuration/specs](docs/en/configuration.md) |
| [Providers/login](docs/en/providers.md) | [All MCP tools and Accepted](docs/en/mcp-tools.md) |
| [Token economics](docs/en/token-economics.md) | [Troubleshooting/doctor](docs/en/troubleshooting.md) |
| [Project instruction insert](docs/en/agent-insert.md) | [Ordering agent guide](docs/en/agent-guide.md) |
| [CLI commands](docs/commands.md) | [Regression catalog](tests/regression/CATALOG.md) |

## Architecture

![C4 System Context](docs/diagrams/context.svg)

[Containers and sequence diagrams](docs/en/architecture.md) show Accepted, trust, reports/recovery, WALL and CONSULT; local PlantUML/C4 sources plus SVG/PNG renders.

## Install

Node ≥22.14.0, Git, tmux and separately installed/logged-in provider CLIs are required. Kimi's current npm CLI needs Node ≥22.19.0. The tutorial covers the stable installation and first config.

~~~sh
git clone https://github.com/Setech-pl/agentctl.git
cd agentctl
npm ci
npm run build
./bin/agentctl-update --ref v0.23.1 --dry-run
~~~

[Release safety, shadow canary and upgrade rollback](docs/en/release-safety.md) · [0.27.3 release notes](docs/release-notes/0.27.3.en.md) · [0.27.2](docs/release-notes/0.27.2.en.md).

For dev, `./bin/agentctl-dev-update v0.23.1` rebuilds `~/Projects/agentctl-wt/devtest` using `~/.agentctl-dev`. It accepts a tag, branch or SHA, `--status`, `--rollback`, `--no-restart` and `--skip-ci`.

Agentctl runs with your permissions; worktrees are not an OS sandbox. Folder trust is never automatically accepted. Local MCP uses desktop stdio; web/phone cannot connect directly. The owner reviews evidence and decides integration/publication; report actions are proposals. [Boundaries](docs/en/overview.md#boundaries).

## Hosts

Use `host: pc` to run a task on a configured SSH host: remote worktree/setup/agent, ordinary task operations and a local report mirror. [Remote task setup and PC example](docs/en/hosts.md). Account/host limits, provider holds, safe remote GC, per-host board tasks and restart/adopt/resume are included in 0.23.1; queued tasks can change location with `move --host pc|local`. [Release notes](docs/release-notes/0.23.1.en.md).

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE). Use the repository gate and task-owned cache.

GC checks every repository for dirty files and unpushed commits; cache stays by default. Owner-confirmed `include_cache` still respects pin/keep/keep_cache and report artifacts; remote GC never forces deletion. [GC safety and configuration](docs/en/configuration.md).

`answer` tokens match the normalized question and option labels, independent of menu scrolling, selection marker, whitespace or unrelated screen redraws. Confirmation requires the chosen numbered option to remain visible with the same label and question; changed menus, expired/replayed tokens and changed task identity are refused.

Task class `gate` uses Claude Sonnet medium, Codex `gpt-6-luna/medium`, Kimi `k3-256k/low`, and GLM `glm-5.3-flash/medium`. The default equivalents derive from the same model matrix.

Inherited project links to closed/archived tasks are errors: use the spec's own backend worktree or links: []. Legacy defaults pointing into a repository already provided by the spec are skipped too. Explicit spec links and project `{worktree:repo}` placeholders remain intentional choices.

Every MCP write supports `{preview_token, confirm: true}` after a preview, including `away`. WALL writes also accept `{as, preview_token, confirm: true}` when `as` matches the preview; channel/kind/subject/body and other operation arguments are restored from that session. A changed author or tool, expired token or changed scope is refused; retries reuse the receipt.

Pulled report-ready tasks fold into “odebrane, do zamknięcia (N)” per cohort after active/waiting tasks. Enter expands the selected row; `B` lists the pulled tasks of that cohort and asks for confirmation before closing their windows. Reports, branches and worktrees stay. Unpulled reports form the highlighted top section across all cohorts, including tasks without a window.

`board.pulled_collapse_after: 0` sets the delay in minutes (default: collapse immediately). `board.pulled_auto_close_after: false` disables automatic closure by default. Set a non-negative number of hours to opt in: watch closes only current pulled report-ready tasks after that age since pull, records `pulled-auto-close`, and keeps worktrees. Restart watch/board after changing these settings.

`agentctl status` and MCP status group current pulled reports under “odebrane, niezamknięte”; JSON keeps the pulled marker. Use `agentctl close --cohort NAME --pulled` (preview and confirmation; `--yes` executes) or MCP `close` with `{cohort: "NAME", pulled: true}`, then confirm its preview token. Task IDs and worktree removal cannot be combined with this selection.

CLI pulled closure refuses a changed task list or a report rewritten while awaiting confirmation; run the preview again to review the current scope.

[WALL lifecycle: archive, reminders and stale](docs/en/configuration.md#wall-lifecycle-0227).
