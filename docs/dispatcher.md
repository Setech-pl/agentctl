# Dispatcher guide

You are the ordering agent. Read this guide and `capacity` before allocating work in any project. agentctl reports facts and carries out explicit orders; you choose the provider, model and effort within the user's authorization.

## Start a session

Clipboard mode: run `agentctl guide --project /path/to/repo --clip`, then `agentctl capacity --clip` and paste both into the ordering chat. Create a spec in the chat, copy it, run `agentctl new --clip` (or `agentctl queue --clip`), and approve the displayed order. `--json` exposes machine data for capacity, new and queue. `new --clip` reads the spec rather than copying its response.

MCP mode: call `guide` with `{ "project": "/path/to/repo", "lang": "en" }`, then `capacity` with `{}`. Both are read tools and require no `mcp.allow` entry. Write tools require their name in `mcp.allow`; `new` and `queue` first preview the order and execute with `confirm: true`. Respect the user's established authorization; show a concrete spec before asking for missing approval. Never work around a refused tool.

## Decide what to allocate

Compare both plan windows (5 h and week): remaining percent, reading age, stale flag, consumption percent per hour, projected exhaustion and time to reset. A stale reading or `null` means n/d, not zero or free capacity. Percent includes use outside agentctl. Estimates are explicitly under `estimate` with a basis and confidence; they are not provider quotas or promises. A projection does not predict how the provider will change its limits.

Check free slots, reservations, limits and the next queued task. No configured slot limit means unbounded, not a measured number of free slots. Check seven-day model × effort stats: count, marked ok/partial/fail, unmarked count, median duration and tokens. Small samples and different task sizes limit comparisons. The equivalents table is a configured correspondence, not a provider entitlement check.

Choose enough reasoning for the scope and risk; do not default to the highest model or effort. Simple bounded edits can use a smaller model and lower effort; difficult design, uncertain debugging and high-impact review can justify more. Explain the choice from task needs and current capacity. Plan cross-review with a different model or provider, using `review_of` and `after`; check `capacity` again before starting it. agentctl never selects a provider or moves work because a threshold was crossed.

## Write a spec

A spec is YAML front matter between two `---` lines, followed by the prompt. Several specs can be in one file. State acceptance criteria, constraints, validation and required report evidence in the prompt.

```yaml
---
task: APP-101
cohort: release-1
agent: claude
model: sonnet
effort: medium
repos:
  - path: /path/to/repo
    worktree: /path/to/worktrees/app-101
    base: main
    branch: app-101
report:
  - /path/to/reports/APP-101.md
  - docs/reports/APP-101.md
pin: false
priority: normal
touches: [src/api/**, tests/api/**]
remote_control: false
---
Implement the bounded API change. Test the acceptance criteria. Write the report.
```

- `task`: unique task ID. `cohort`: optional group for status, reports and completion.
- `agent`, `model`, `effort`: explicit requested order. Providers are `claude` and `codex`; supported effort values are low, medium, high, xhigh, max, subject to provider validation. See capacity's equivalents. `pin: true` prevents provider translation and move.
- `repos`: list of repositories. Each `path` is the source repo; `worktree` is its isolated checkout; optional `base` is the start ref; optional `branch` creates a branch (without a branch, a detached checkout is possible). Follow project rules on branch and worktree ownership.
- `report`: list of paths/globs; first is canonical, the rest are detection alternatives relative to the worktree or absolute. The report's first line must be `Werdykt: PASS`, `Werdykt: PARTIAL` or `Werdykt: FAIL`, then findings, commits, validation and limitations. A verdict is not a user-assigned stats result: `mark` records that judgment.
- `review_of`: task being reviewed; use another model/provider. `after`: list of tasks whose reports must exist before start. These dependencies belong in the queue.
- `priority`: normal or high, used in queue ordering. `touches`: anticipated file globs for collision warnings, not file locks.
- `remote_control`: enable Claude Remote Control for this task when supported and authorized; it does not grant permission to bypass prompts.
- Optional inherited fields: `links` (`from`/`to` symlinks), `env`, `worktree_root`, `defaults` and `setup` commands. Keep setup in trusted project configuration; MCP rejects setup supplied in a spec. `guide:` in `.agentctl.yaml` names a project overlay relative to the repo or starting with `~`; a missing overlay warns and does not stop the order.

## Run and follow work

Use `new` for immediate work, `queue` for work waiting on slots or reports. Group related orders with `cohort`; inspect `cohort list/show`, queue position and start conditions. `queue pause/resume/up/retry/rm` manage waiting work. A cancelled dependency makes its descendants `blocked`: explicitly `unblock` (optionally `--drop-after TASK`) or cancel them after deciding what the missing result means. MCP `resume` can resume resumable tasks or unblock a queued task; read its input schema.

At the start of each chat reply about work call `events_since`, then `status`. Call `pull_ready` to take newly completed reports, `get_report` for one full report, and `peek` for a question or progress. Do not claim success from a ready flag alone. Read the verdict and evidence; use `mark` for an authorized evaluation. Answer permission and trust prompts through the supported terminal/Remote Control flow; never auto-accept them.

Example MCP sequence (tool names may have an installation prefix):

```text
guide({project: "/path/to/repo", lang: "en"})
capacity({})
new({spec: "---\ntask: APP-101\nagent: claude\nmodel: sonnet\neffort: medium\nrepos:\n  - path: /path/to/repo\n    worktree: /path/to/worktrees/app-101\nreport: [/path/to/reports/APP-101.md]\n---\nImplement and validate the change."})
new({spec: "<the same spec>", confirm: true})
events_since({since: "last"})
status({})
pull_ready({})
get_report({task: "APP-101"})
queue({spec: "---\ntask: APP-102\nagent: codex\nmodel: gpt-6.1-sol\neffort: medium\nreview_of: APP-101\nafter: [APP-101]\nrepos:\n  - path: /path/to/repo\n    worktree: /path/to/worktrees/app-102\n---\nReview the report and implementation independently."})
queue({spec: "<the same review spec>", confirm: true})
```

On `limited`, inspect capacity and the task's state. Waiting for reset, changing the order, cancelling or explicitly calling `move` are decisions for the ordering agent and user; `pin` forbids move. Moving continues in the existing worktree and preserves the original report. After pulling and reviewing, `close` ends the window; removing worktrees requires separate authorization and configuration. `cancel` stops unnecessary work and retains its report/worktree by default.

## Boundaries

agentctl does not merge, push, publish, open PRs, choose a provider, judge report correctness or automatically transfer tasks. It does not turn n/d into a number. It records events only while an observing command/watch runs; events_since is not a background subscription. Keep watch running (`agentctl up --no-attach`) for queue service and notifications. UI labels may change: watch and board windows carry stable tmux `@agentctl-role` options; restart with `agentctl watch --tmux --restart` or `agentctl board --tmux --restart`, without relying on window names.
