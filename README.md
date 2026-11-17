# agentctl

Local task dispatch for Claude Code, OpenAI Codex CLI, Kimi Code CLI and Z.ai GLM. A Markdown spec becomes a Git worktree, an interactive tmux agent and a reviewable report. Watch services the queue, delivery, notifications and consultations.

[Polski](README.pl.md) · **[English manual](docs/en/overview.md)** · [From zero](docs/en/tutorial.md) · [0.22.3 release notes](docs/release-notes/0.22.3.en.md)

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
./bin/agentctl-update --ref v0.22.3 --dry-run
~~~

Agentctl runs with your permissions; worktrees are not an OS sandbox. Folder trust is never automatically accepted. Local MCP uses desktop stdio; web/phone cannot connect directly. The owner reviews evidence and decides integration/publication; report actions are proposals. [Boundaries](docs/en/overview.md#boundaries).

[Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [MIT license](LICENSE). Use the repository gate and task-owned cache.

GC checks `git status --porcelain --untracked-files=normal` in **every** task worktree, plus commits ahead of upstream (or the recorded base). Previews show dirty file and unpushed commit counts per repo, even with cached sizes. Dirty/unpushed worktrees stay unless the owner explicitly uses CLI `--force-dirty` or MCP `force_dirty: [TASK]`; apply checks again. Ignored files are excluded.

Task cache now stays when removing worktrees. Deleting old cache entries requires explicit owner confirmation: CLI `gc --include-cache --apply` or MCP `gc {include_cache: true}`. Spec `keep_cache: true`, CLI `--keep-cache TASK...`, and MCP `keep_cache: [TASK]` preserve all cache for those tasks. Report references, including `persist: [paths]`, `artifacts: [path | {path: ...}]` and `refs: [path | {path: ...}]` in agentctl-outputs, protect referenced entries and their parent directories even with include_cache. Relative paths resolve from the report directory or task worktrees. Previews paginate every cache candidate with its path and size; protection is checked again at apply.

`answer` tokens match the normalized question and option labels, independent of menu scrolling, selection marker, whitespace or unrelated screen redraws. Confirmation requires the chosen numbered option to remain visible with the same label and question; changed menus, expired/replayed tokens and changed task identity are refused.

Task class `gate` uses Claude Sonnet medium, Codex `gpt-6-luna/medium`, Kimi `k3-256k/low`, and GLM `glm-5.3-flash/medium`. The default equivalents derive from the same model matrix.

Inherited project links to closed/archived tasks are skipped, with one persisted notice per project per UTC day. Legacy defaults pointing into a repository already provided by the spec are skipped too. Explicit spec links and project `{worktree:repo}` placeholders remain intentional choices.

Every MCP write supports `{preview_token, confirm: true}` after a preview, including `away`. WALL writes also accept `{as, preview_token, confirm: true}` when `as` matches the preview; channel/kind/subject/body and other operation arguments are restored from that session. A changed author or tool, expired token or changed scope is refused; retries reuse the receipt.

Pulled report-ready tasks fold into “odebrane, do zamknięcia (N)” per cohort after active/waiting tasks. Enter expands the selected row; `B` lists the pulled tasks of that cohort and asks for confirmation before closing their windows. Reports, branches and worktrees stay. Unpulled reports form the highlighted top section across all cohorts, including tasks without a window.

`board.pulled_collapse_after: 0` sets the delay in minutes (default: collapse immediately). `board.pulled_auto_close_after: false` disables automatic closure by default. Set a non-negative number of hours to opt in: watch closes only current pulled report-ready tasks after that age since pull, records `pulled-auto-close`, and keeps worktrees. Restart watch/board after changing these settings.

`agentctl status` and MCP status group current pulled reports under “odebrane, niezamknięte”; JSON keeps the pulled marker. Use `agentctl close --cohort NAME --pulled` (preview and confirmation; `--yes` executes) or MCP `close` with `{cohort: "NAME", pulled: true}`, then confirm its preview token. Task IDs and worktree removal cannot be combined with this selection.

CLI pulled closure refuses a changed task list or a report rewritten while awaiting confirmation; run the preview again to review the current scope.

[WALL lifecycle: archive, reminders and stale](docs/en/configuration.md#wall-lifecycle-0227).
