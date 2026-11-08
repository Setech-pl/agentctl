# Dispatcher guide

You are the ordering agent. Read this guide and `capacity` before allocating work in any project. agentctl reports facts and carries out explicit orders; you choose the provider, model and effort within the user's authorization.

## Start a session

Clipboard mode: run `agentctl guide --project /path/to/repo --clip`, then `agentctl capacity --clip` and paste both into the ordering chat. Create a spec in the chat, copy it, run `agentctl new --clip` (or `agentctl queue --clip`), and approve the displayed order. `--json` exposes machine data for capacity, new and queue. `new --clip` reads the spec rather than copying its response.

MCP mode: call `guide` with `{ "project": "/path/to/repo", "lang": "en" }`, then `capacity` with `{}`. Both are read tools and require no `mcp.allow` entry. Write tools require their name in `mcp.allow`; `new` and `queue` first preview the order and execute with `confirm: true`. Respect the user's established authorization; show a concrete spec before asking for missing approval. Never work around a refused tool.

## Decide what to allocate

Compare the plan windows actually reported (5 h, week or month): remaining percent, reading age, stale flag, consumption percent per hour, projected exhaustion and time to reset. A stale reading or `null` means n/d, not zero or free capacity. Percent includes use outside agentctl. Estimates are explicitly under `estimate` with a basis and confidence; they are not provider quotas or promises. A projection does not predict how the provider will change its limits.

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
- `agent`, `model`, `effort`: explicit requested order. Choose an active provider: `claude`, `codex`, or `kimi` (when enabled); supported effort values are low, medium, high, xhigh, max, subject to provider validation. See capacity's equivalents. `pin: true` prevents provider translation and move.
- `repos`: list of repositories. Each `path` is the source repo; `worktree` is its isolated checkout; optional `base` is the start ref; optional `branch` creates a branch (without a branch, a detached checkout is possible). Follow project rules on branch and worktree ownership.
- `report`: list of paths/globs; first is canonical, the rest are detection alternatives relative to the worktree or absolute. The report's first line must be `Werdykt: PASS`, `Werdykt: PARTIAL` or `Werdykt: FAIL`, then findings, commits, validation and limitations. A verdict is not a user-assigned stats result: `mark` records that judgment.
- `review_of`: task being reviewed; use another model/provider. `after`: list of tasks whose reports must exist before start. These dependencies belong in the queue.
- `priority`: normal or high, used in queue ordering. `touches`: anticipated file globs for collision warnings, not file locks.
- `remote_control`: enable Claude Remote Control for this task when supported and authorized; it does not grant permission to bypass prompts.
- Optional inherited fields: `links` (`from`/`to` symlinks), `env`, `worktree_root`, `defaults` and `setup` commands. Keep setup in trusted project configuration; MCP rejects setup supplied in a spec. `guide:` in `.agentctl.yaml` names a project overlay relative to the repo or starting with `~`; a missing overlay warns and does not stop the order.

## Run and follow work

Use `new` for immediate work, `queue` for work waiting on slots or reports. Group related orders with `cohort`; inspect `cohort list/show`, queue position and start conditions. `queue pause/resume/up/retry/rm` manage waiting work. A cancelled dependency makes its descendants `blocked`: explicitly `unblock` (optionally `--drop-after TASK`) or cancel them after deciding what the missing result means. MCP `resume` restores resumable tasks; `unblock` removes a queued dependency and `queue_retry` retries a failed start.

At the start of each chat reply about work call `events_since` (without a separate `status`). Call `pull_ready` to take newly completed reports, `get_report` with `section` for a selected section, and `peek` for a question or progress. Do not claim success from a ready flag alone. Read the verdict and evidence; use `mark` for an authorized evaluation. Answer permission and trust prompts through the supported terminal/Remote Control flow; never auto-accept them.

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

Since 0.17.1 MCP covers queue retry/control, cohorts, `gc` and diagnostics. Check `capacity.disk` before dispatching work. For a failed queue entry, read the reason and propose a repair or `queue_retry`. At disk-warn propose `gc_preview`; at disk-critical seek approval for `gc`, or use it within the user’s authorization. Starts and removals require preview and confirmation; `mcp.allow` alone does not replace confirmation. See [MCP](mcp.md).

Use `pull_ready` summary mode for reports; request only the needed `get_report` section. Allocate from provider percentages, reset times and stats. Token estimates are informational. `self_verdict` is the agent assessment; `mark` is the human evaluation.

0.17.2 review correction / poprawka po przeglądzie: summary_delivered ≠ pulled ≠ mark. Use full report pages or explicit ack; reports require current attempt plus report-end or settled ended turn. Stable client event cursors and bounded pages are described in [mcp.md](mcp.md); report.settle_s and overload.give_up_after in [configuration.md](configuration.md).

Leave events_since.client unset for independent concurrent sessions. A new session inherits the saved client high-water mark; set client only when sharing consumption is intentional.

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

Automatic review adds `TASK-REV` after the author report, on the author branch and in the same cohort. It prefers another available provider, using `review.*` or `equivalents`; otherwise it needs another configured model. No valid pairing leaves a visible pending review error. The reviewer gets its own detached worktree (`<worktree_root>/<repo>-<task>-rev`, one per repository of the author, pinned to the author's commit) and writes its own report at `cache/<task-rev>/<TASK-REV>.md`; it never shares the author's checkout or branch. It starts only after the author's turn is over (report-end, report settle time, no follow-up queued or unconfirmed, no draft, no git running in the author's checkout); until then the queue shows `czeka na autora …`. If the author commits again before the review starts, the review is re-pinned to the new SHA (delta and heads updated, journal `review-repinned`). `review.rerun: true` schedules `REV2` for a new report, with the previous review's scheduled SHA as the delta base. The first base is the author's recorded base. See the review template in `docs/examples/` and the configuration reference for overrides. A review's verdict is the first line of its report (`Werdykt: GO|GO-WITH-CHANGES|NO-GO`; PASS / PASS with findings / FAIL accepted), shown by events, status, get_report and pull_ready; when it disagrees with the declared `outputs.verdict` (GO = PASS, GO-WITH-CHANGES = PARTIAL, NO-GO = FAIL), a needs-attention event names both: "inconsistent verdict: first line X, outputs Y".

`base: "@TASK"` resolves at start to that task's output commit, otherwise its branch HEAD; specify `:repo-name` for multiple repositories. The resolved commit is shown in the new preview and stored in TASK.md. Missing or ambiguous sources block start. A verdict condition blocks on another verdict or `brak werdyktu`; ordinary `after: TASK` still waits only for a complete report.

`send` pastes a follow-up immediately while Claude/Codex work. Delivery is confirmed from submission, a new working state, transcript/queued-message echo or a new complete report. `idle_prompt` and a late Stop alone do not confirm it; a stuck composer becomes `needs-attention` after `delivery_confirm_s`. An idle-only adapter (`accepts_busy_prompt: false`), or an unconfirmed previous message, keeps later messages in a durable FIFO. Status/peek show the queue; the response says pasted, queued position, or unconfirmed. The watcher drains it in order.

The answer of `send` and `delivery_result` (TASK.md, `status --json`, MCP `status`) say what happened, in three states: delivered (`delivered`, with its source), `w kolejce agenta – niepotwierdzone` (queued-in-agent: the screen shows the message in the agent’s queue, nothing has confirmed it) or `nie dostarczono – tekst w polu wpisywania` (not-delivered-in-field: the paste stands in the input field). **Delivered is said only on an exact source**, compared literally (line ends are the one normalisation; no run of white space is squeezed): the UserPromptSubmit hook (its prompt for a collapsed paste is wrapped in `<pasted_content id=…>`; the wrapper is taken off the hook’s text only, by pairs of ids, and nested, mismatching or stray tags are ambiguous = no proof; the pending prompt is compared as written), the notify payload of Codex, or the session transcript of the task itself (Claude Code: the `queue-operation`/`enqueue` line, written the moment a message is submitted while a turn runs, or the `user` line; Codex: the `response_item` / `item_completed` line, or `user_message` in older versions) holding a message written after the delivery began that is exactly the pending one (for a collapsed paste the full text, not the label). Only the transcript files of the task’s own sessions are read: the ids its hooks recorded, else the single new transcript of its worktree. What the agents themselves do to a message is not part of it: the white space at its end is dropped, the newlines around a collapsed paste are the wrapper’s padding, Claude Code stores a tab as four spaces. The screen confirms nothing for a working agent: an echo of Codex or the queue sign of Claude Code (the dim “Press up to edit queued messages”, the queued message with “ctrl+x ctrl+s to send now”) only classifies the state as `w kolejce agenta – niepotwierdzone` (the sign only when it was not on the screen just before our own Enter and appeared after it with our paste gone from the field); the pending prompt stays, and the delivery goes on to wait for the hook or the transcript. For an idle agent that was pasted into, the older signs of the first prompt of every task remain (the turn started, the canonical report changed, the message echoed whole above an empty composer). **agentctl presses Enter only in the call that pastes**: up to three times, and before each one it captures the screen and compares the whole area of the input field, byte for byte (empty lines inside included), with the image taken right after the paste, which must itself be our paste (one placeholder, or the lines of the text); the same capture must show no dialog. A difference, a changed first image or an open dialog means no Enter and `nie dostarczono – tekst w polu wpisywania` (needs-attention at the next watch tick, with the two ways out). `watch` never presses Enter. `agentctl send --enter-only TASK` shows the exact text of the field, the screen state and a token for those bytes; `agentctl send --enter-only TASK --confirm TOKEN` captures again and presses Enter only if the area is still byte for byte the previewed text and the image recorded after our paste (so agentctl pasted it for this delivery) and the screen shows no dialog; anything else is refused with the reason. MCP: `send` with `enter_only: true` and no text needs its own permission `send_enter` in `mcp.allow` (`send` alone does not allow it); without `confirm: true` it only previews (text, state, `token`), with `confirm: true` and that `token` it presses; a refusal and a failed key (tmux `send-keys` error) are `isError` answers with the reason, the failed key is audited `failed` and never announced as sent, a pressed Enter is audited as executed (`enter-sent`, with the delivery) and announced, and the answer keeps “Enter sent” apart from “delivery confirmed”. With an open Codex question nothing is pasted: the answer names the question (“Codex ma otwarte pytanie „…” (zwinięte, N)”) and the message stays in the FIFO. The journal (`events_since`, kind WIADOMOŚĆ) records every change of the result of a follow-up with its delivery id: queued, not delivered, delivered (the first prompt of a task: only the first two).

A provider limit emits one notice per episode with the known reset (otherwise `n/d`). Fresh remaining capacity above `limited.resume_above_percent` (5 by default), or an elapsed known reset, permits `limited.message` (`kontynuuj`) to the idle empty window. The overload guards check again before paste and Enter; attempts and limits survive restarts. `limited.auto_resume: false` disables sending. Provider and model stay the same.

`agentctl mark --cohort NC ok --note "reviewed"` previews its exact range; `--yes` confirms. MCP accepts `task`, `tasks` or `cohort`; more than one task requires preview/confirm. With a cohort filter, board `o/p/f` previews its IDs before marking. Agentctl records the user's result. Closing every cohort task emits `gc_suggest` with that cohort's protected cleanup preview; it never deletes automatically.

MCP previews have independent `preview_token` values, expire after ten minutes and refuse a changed range. Pass the token and identical arguments with `confirm: true` — or the token alone, which executes the stored arguments (for `new`/`queue` the spec need not be resent); omitting a token uses the latest matching preview for compatibility. `gc_preview` with a cohort gives only the count of foreign worktrees; confirmed `gc` returns its results without repeating the plan. `notify.mcp_writes` defaults to `summary`, at most once per 60 seconds; `all` and `off` are explicit alternatives. Audit remains complete. F12 returns to the board of the current configured session, including a parallel dev session. Duration includes checkout/setup before the agent starts; stale plan notices are once per reading.

## Active providers and Kimi

Choose among the active `providers` in config: Claude and Codex are required; Kimi is optional. Use equivalents by model class as dispatch mappings, then check current capacity and slots. With three providers, move requires an explicit `--agent`; auto review follows `review.prefer` or provider order and skips the author, unavailable CLIs and unmapped targets.

Kimi equivalents: light → `k3-256k/low`, medium → `k3/high`, strong → `k3/max`. Use `k3.1-pro` only when explicitly requested; it consumes about 10× the plan limit.

Kimi Code 2.5.0 has no CLI sandbox. Start accepts `manual` (Always Ask) or `yolo` (Ask When Needed) only with `permission.dangerous_command_guard=true`; `auto` (Never Ask) and a disabled guard in config/env are refused. Real 2.5.0 still asks for exact Bash allow rules in manual mode; yolo uses those rules. Doctor shows mode, guard and rules without editing config. Write may proceed without a dialog. Trust/login/update decisions belong to the human. Efforts are low/high/max only when the configured model's `support_efforts` permits them; without catalog evidence no effort env is forced. Display names and unversioned aliases are dynamic. Manager and Remote Control remain Claude-only.

Kimi plan capacity is n/d unless `capacity.kimi_usage_probe` is enabled; the neutral session needs manual trust. The rate-limited `/usage` probe reads only the TUI, never credentials/OAuth or an API, and never uses a task window. Observe 5h/Weekly/Monthly only when present. Prompts, files read, command results and diffs go to Moonshot AI; telemetry defaults off, which does not stop task data transmission. A project guide can explicitly prohibit Kimi for that repository.

```yaml
---
task: EXAMPLE-KIMI
agent: kimi
model: k3
effort: high
repos: [{path: /path/to/repo, worktree: /path/to/worktree, branch: task/example}]
---
State the acceptance criteria, constraints and report requirements here.
```

Kimi screen auth/limit/overload/background patterns, busy queue footer, other wire interactions are hypotheses backed by synthetic fixtures; do not describe them as verified real 2.5.0 behavior.

Kimi 2.5.0 effective model/effort comes from passive `llm.request.modelAlias/thinkingEffort`, recorded beside requested settings in TASK.md and status JSON. The footer can retain `high` while the effective wire effort is `low`; a wire mismatch warns. Sessions bind via `sessions/<workspace>/<session>/state.json` (session index fallback); `usage.record` supplies input/output/cache tokens and numeric `time`.
