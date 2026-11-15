# agentctl 0.22.3

agentctl turns a Markdown work order into a Git worktree, an interactive coding agent in tmux, and an observable task with a report. It runs locally and uses the provider CLIs you install and sign in to. Claude Code, OpenAI Codex CLI, Kimi Code CLI and Z.ai GLM through a Claude Code wrapper are supported.

The owner decides what may run, answers folder trust, reviews evidence and publishes changes. A chat can read and order work through a local MCP server. The board provides the owner's terminal view; watch services the queue, delivery, events, notifications and consultations.

## Read the manual

| Page | Purpose |
|---|---|
| [Features](features.md) | All current workflows and task states |
| [From zero](tutorial.md) | Install, configure, first task, MCP, WALL and CONSULT |
| [Configuration](configuration.md) | Layers, keys, defaults and spec reference |
| [MCP tools](mcp-tools.md) | Every tool, arguments, permissions and Accepted writes |
| [Providers](providers.md) | Installation, login, model/effort, probes and caveats |
| [Token economics](token-economics.md) | Plan windows, capacity, caching and accepted-task cost |
| [Troubleshooting](troubleshooting.md) | Doctor, startup, reports, queue and recovery |
| [Agent insert](agent-insert.md) | Short Project instruction block |
| [Ordering agent guide](agent-guide.md) | Full operational contract for a dispatching chat |
| [Architecture](architecture.md) | C4 and sequence diagrams |
| [Screen gallery](screenshots.md) | Real TUI captures with synthetic demo data |

[Polski](../pl/overview.md) · [CLI command reference](../commands.md) · [0.22.3 release notes](../release-notes/0.22.3.en.md)

## Boundaries

This is orchestration, not an OS sandbox. Provider processes run with the owner's local permissions; a worktree separates checkouts, not credentials or network access. MCP has no merge, push, publish or arbitrary-shell tool. Suggested commands in reports remain data. Local stdio MCP is available through the desktop client; claude.ai in a browser and the phone cannot connect directly. The optional Claude manager uses Remote Control for phone supervision.

Percentages and model aliases come from provider observations and configuration. Unknown readings stay `n/d`. Screen parsing is heuristic; provider CLI changes can require pattern updates. 0.22.3 combines the manuals with 0.22.2 operations fixes, default-branch diagnostics and scrollable board help.
