# Features

## Work orders and lifecycle

A spec contains YAML between `---` delimiters and the prompt below it. A file can contain several orders. `new` previews/starts immediate work; `queue` registers work for watch to admit. Repositories can have independent worktrees, bases, branches and setup; links and environment come from configuration layers. Placeholders `{task}`, `{TASK}` and `{cache}` resolve task paths. `class` maps provider/model/effort through [the matrix](../../data/model-matrix.yaml); explicit model/effort wins with a warning. `pin` prevents provider translation and move. `touches` warns about overlapping changes; it does not lock files.

`after` waits for complete predecessor reports and accepted first-line verdicts: PASS, PASS with findings, PARTIAL or GO by default. `after_verdict` overrides the accepted set, including explicit FAIL/BLOCKED when intended; it requires `after`. Unknown dependencies and cycles fail validation. A missing verdict waits while its author is live or the report is still settling; explicit rejection blocks. A corrected accepted report automatically releases verdict-blocked dependents at the next watch tick (P94). `unblock` / `queue up` provide explicit manual release; understand the missing result first.

Queue order is high priority before normal, FIFO within each class. `weight: heavy` shares `limits.heavy` across providers; immediate `new` is outside that admission rule. Provider slots, reservations, optional external sessions, pause, dependencies, plan hold and disk guards can delay a start. `queue show/list/up/rm/retry/pause/resume` explain and manage it. Failed starts retain their diagnostic window by default and save `start-failure-screen.txt`; retry closes the leftover window first.

| Task state | Meaning |
|---|---|
| `host-unreachable` | SSH cannot reach the task host; keep its window and slot, retry with backoff |
| `needs-attention` | Delivery, lost-window or state-write problem needs inspection |
| `overloaded` | Recognized provider capacity/overload episode |
| `working` | Provider turn is running |
| `background` | Provider's own background work continues |
| `waiting` | Idle prompt, no complete report |
| `needs-input` | Question, approval or first-run dialog waits for the owner |
| `needs-trust` | Folder trust requires a human in the window |
| `limited` | Provider reports exhausted usage/credits |
| `report-ready` | Eligible current-attempt report complete, agent idle or gone |
| `superseded` | Original task after an explicit provider move |
| `dead` | Window gone, no eligible report |
| `closed` | Owner closed it; visible with all/hidden views |
| `cancelled` | Work abandoned; worktree and branch retained |
| `orphan` | tmux task window without task metadata |

`interrupt` ends a turn but keeps its window. `send` adds a follow-up; busy Codex messages wait durably until confirmed turn end and have IDs for `withdraw`. Paste acknowledgement is checked; an unsent draft is not success. `answer` safely selects a supported question; numbered needs-input/needs-trust menus require an explicit exact-menu confirmation. Startup/watch never automatically accept folder trust. `resume` continues a known session without pasting the initial prompt again. `move` maps to another active provider in the same worktree; pinned/already-moved tasks are refused. `adopt` restores missing metadata from explicit facts. Closing, cancelling, hiding, archiving and deleting a worktree are distinct operations.

## Watch, board and notifications

`watch` polls tasks, handles provider hooks/passive transcripts, confirms prompt delivery, reloads valid config, starts eligible work, records events and advances CONSULT. Restarting watch reconciles durable state; live task windows survive. `up` can arrange watch, board and optionally manager; service windows have stable tmux roles. Desktop notifications cover configured events, questions, trust, reports, limits and write outcomes. Optional ntfy sends configured events to a phone in away mode (`away` / `ntfy-setup`); a Claude manager with Remote Control is another phone path. Neither makes local MCP a public server.

The Ink board has a task list and selected-task peek, cohort grouping/folding, queue, finished/closed/cancelled sections, messages and confirmations, log, limits, capacity, GC preview and WALL. `Enter` opens a task window; `F12` returns when configured. `?` shows the full keys, `k` filters cohort, `g/E` fold/open groups, `z/a` show finished/all, `L/C/G/l/W` open limits/capacity/GC/log/WALL. `m` composes a follow-up, `x/X` close/cancel after confirmation, `u/d/p` reorder/remove/pause queue. `o/p/f` mark finished work ok/partial/fail. At ≥110 columns the selected preview appears. [Every view is illustrated](screenshots.md).

## Reports, events and review

Reports use a canonical allowed path, current attempt marker and `<!-- agentctl:report-end -->`, or settle after a confirmed ended turn. A partial/old-attempt report is not ready. Alternate paths are candidates; `report --from` explicitly copies a permitted regular file. The first line is `Verdict: …` or `Werdykt: …`. An `agentctl-outputs` YAML block version 1 carries verdict, commits, proposed integration refs, decisions, actions, checks, optional preview and notes. Git refs are checked locally; invalid entries warn and valid sections survive. Proposed actions never execute automatically. `wall_posts` is a separately validated extension described below.

`pull` copies reports; MCP `pull_ready` defaults to summary. Summary delivery, full collection and human `mark` are different facts. `get_report` summary/first full page marks pulled by default; `mark_pulled: false` opts out and `true` explicitly acknowledges. Other full pages can cover the report in any order; sections do not mark by default. `review_of` links a review; configured `review: auto` queues a different eligible provider after the author, pinned to its recorded commits, with rerun policy. Review GO / GO-WITH-CHANGES / NO-GO maps to PASS / PARTIAL / FAIL. `cohort show` aggregates outputs and flags conflicting refs.

`events_since` is a delta read scoped by configured `as` (explicit `client` overrides; otherwise transport client), not a push subscription. Start every work-related chat reply with it; use `as: "chat:<name>"` for WALL visibility. First read looks back 24 hours; `peek: true` does not advance the cursor. Journal events include report verdicts, questions, trust, queue/setup/failure, blocks, limits, outputs and CONSULT milestones. Watch must run for continuous observation. [MCP transport and Accepted](mcp-tools.md) explain safe retries and response pages.

## WALL and CONSULT

WALL is append-only channel communication. Defaults include `agentctl`, `nc`, `hems`, `shared:sim`, `shared:weather` and `shared:maps`. Messages have kind info/question/decision-request/contract-change/answer, refs, reply threads and open/answered/accepted/rejected/superseded status. Author/channel permissions and subscriptions bound access; declared identities are not authentication. Owner CLI sees all channels. Board `W` reads channels, messages and threads; `s/t` filter status/kind and `r/R` mark read. It does not edit message status: use CLI/MCP for that.

`wall: [nc, "shared:*"]` in a task spec injects bounded open-message context as read-only data. A task's report can add `wall_posts: [{channel, kind, subject, body, refs}]` inside outputs: watch/report processing publishes each permitted post once per attempt as `task:<ID>`. A refused post becomes a finding, not a rejected report. Bodies are ≤8 KB; refs name allowed paths/commits/tasks/messages and attach no files. Secret scanning rejects detected credentials. Decisions and contract changes need owner choice; a chat uses `owner_confirmed: true` only after that choice.

CONSULT orchestrates 2–26 panel members from at least two active providers, 1–3 rounds (default 2), then one synthesis task: members × rounds + 1 tasks. It is for expensive decisions, with a preview of count and usage. Detached `read_only` snapshots skip setup/links and have a commit guard and HEAD baseline; this is cooperative, not OS isolation. First round is independent; later rounds see anonymous stable labels and their own answer marked “yours”. Provider/self-identification stripping is best effort. Complete answers require Recommendation, Reasoning, Risks, Confidence 1–5, Unknowns, and later Changed. Synthesis weighs reasons rather than votes, with GO/NO-GO/SPLIT; only after it completes does the owner report reveal identities. `post_to` optionally publishes once to WALL. Invalid answers wait for repair; cancellation blocks. Restart repairs partial registration.

## Economics, maintenance and regression

`limits` controls concurrent windows; `capacity` combines observed plan windows, slots, queue, disk/load and labeled estimates. `usage` reads tokens and plan observations, including separate GLM bookkeeping. MCP `set_limits` requests a `queue_hold` change, and the owner can apply it from the board or CLI. [Economics](token-economics.md) explains unknowns and benchmark cost.

`log` and `stats` summarize attempts and human marks; `dataset export` exports local benchmark JSONL/CSV with provenance and explicit content opt-in. `gc` previews protected cleanup before apply; dirty/live/unmerged work is protected, branch deletion uses `git branch -d`. `history` is the underlying persisted attempt record, exposed through log/stats/export rather than a CLI command named history. `archive` moves closed task state; `mirror_dir` copies reports/status for another local reader. `doctor` diagnoses wiring, safety, providers, stale MCP, disk and config; `--timings` adds read-budget diagnostics.

[Regression catalog](../../tests/regression/CATALOG.md) records deterministic bug scenarios, fixed versions and measured pre-fix proof or explicit noProof. `npm run regression` runs the catalog, and every `npm run gate -- quick|full|release` includes it. Docs/tests and package release checks run through the gate; there is no runtime automatic merging or release publication.

## Worktree references and operational details

Links can refer to a repository in the same spec with {worktree:repo}, optionally {worktree:repo|fallback}; cross-task {task:TASK-ID,repo:repo}/sub/path uses recorded worktrees. Missing/ambiguous refs fail preview; stale inherited links warn and are never silently retargeted. Base task:<ID> resolves the author's recorded commit, not a moving branch at order time. new --reuse explicitly reuses a checked worktree; it does not recover an unknown provider conversation.

Automatic reviews use their own detached checkout and canonical report, with a recorded delta/base. They wait for the author's ended turn, settled sentinel report, no draft/pending delivery and no Git activity; a new commit before admission repins the review. Same-provider review needs a different model. Human mark can target task/cohort as the CLI reference specifies. Multi-task selectors and destructive operations preview the actual affected set.

Read-only CONSULT context accepts configured task/WALL/file/commit references under its validated roots, freezes repository commits/context, and does not attach arbitrary paths from another chat. Reports can trigger protected per-worktree .cache cleanup only after a settled sentinel and ended turn, with no shared checkout or escaping symlink; node_modules is retained. Use report.clean_worktree_cache to disable this policy.

Manager and phone options are local setup choices: ntfy-setup creates the subscription secret; notify-test --phone explicitly tests delivery, while away controls routine forwarding. Internal event and usage-tap are provider callbacks, not chat shell access. For exact selectors, flags and terminal-only operations use the [generated CLI reference](../commands.md); the [source map](../reference/source-map.md) identifies implementations and deterministic coverage.

## Operations in 0.22.2–0.22.3

MCP new/queue previews defer base, worktree overlap and disk checks to watch; acceptance can therefore be followed by a failure event. A missing base now reports, for example, `base main not found – default branch is master`. The default comes from local origin/HEAD or a main/master HEAD; missing metadata is reported as unknown. Correct the spec and retry; no automatic substitution occurs.

Send verification retains ownership of scrolled multiline Codex input and requires delivery evidence, including transcript acknowledgement; a paste alone is not delivery. Collapsed Codex questions keep their text. Watch restarts emit `WATCH WZNOWIONY`. Board help scrolls with ↑↓/PgUp/PgDn and fits terminal height.

YAML base and output SHA identifiers are strings (quote SHAs, including numeric/exponent-looking values). Both `Verdict:` and `Werdykt:` first lines are accepted; the first-line verdict takes precedence. Under commits/integrate, compact output mappings accept `- repo: example, branch: dev, sha: "2742e697"` as well as object entries. Use existing branches and SHAs, never placeholders; checks accept mappings with name/result, one-key mappings or text. Structured name/result entries remain clearest.

WALL confirms append synchronously, without a watch round-trip. Events use the configured `as` cursor, show the bounded `WALL do Ciebie (open)` section and label actual own posts `(yours)`; unknown chats get a warning. See [MCP semantics](mcp-tools.md) for snapshot ages and report acknowledgement.

Timed provider holds, status age/fallback, queue replacement and integration warnings: see [0.22.4 configuration](configuration.md#hotfix-0224-provider-holds-snapshots-and-integrations).
