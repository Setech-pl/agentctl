# Regression catalog

One scenario per known, fixed bug. `npm run regression` runs them all (also as part of every `npm run gate` tier) and fails on any regression.
Scenarios are deterministic (fake tmux/agent fixtures, no inference, no network). Most are the tests that were written with the fix; this catalog
references them instead of copying them. Source: `tests/regression/catalog.ts`; proof column: `tests/regression/prefix-proof.json`,
produced by `npm run regression -- --against <release>` (the current scenarios run against `src/` of the release before the fix).
Regenerate this file with `npm run regression -- --catalog`.

**Rule:** every bug fix adds its scenario and one catalog entry in the same commit (AGENTS.md).

| Bug | Symptom | Scenario | Fixed in | Pre-fix proof |
| --- | --- | --- | --- | --- |
| UX0228-CLI-SCOPE | CLI could close a newly unread report after its pulled-only preview was confirmed. | `tests/ux0228-mcp-cli.test.ts` (`^UX0228: CLI refuses`) | 0.22.6 | not proven: The --pulled CLI selector is new in this unreleased feature; the deterministic confirmation callback reproduced the race before the fix. |
| UX0228-PRIORITY | An alphabetically earlier active cohort appeared above unpulled reports in other cohorts. | `tests/ux0228-board.test.ts` (`^UX0228: unpulled reports lead`) | 0.22.6 | fails on v0.22.5 (1 failing of 1) |
| UX0228-READS | Pulled cohort previews inspected unrelated report bodies before filtering the cohort. | `tests/ux0228-mcp-cli.test.ts` (`^UX0228: pulled cohort preview`) | 0.22.6 | not proven: Introduced with the unreleased pulled selector; v0.22.5 has no pulled selector. The deterministic read-count test failed before this fix. |
| UX0228-TEXT | New pulled hints exceeded 80 columns and the new status marker interrupted legacy field order. | `tests/board.test.ts` (`a line of the list is at most 80`)<br>`tests/economy.test.ts` (`economy: concise reads`) | 0.22.6 | not proven: Introduced during this unreleased feature; v0.22.5 already passes these width/format scenarios. |
| UX0228-SCOPE | Pulled bulk close must select the queued task cohort and refuse manager-only selection. | `tests/ux0228-board.test.ts` (`^UX0228: queued selection`) | 0.22.6 | fails on v0.22.5 (1 failing of 1) |
| UX0228 | Pulled report-ready tasks obscured reports still awaiting collection and vanished automatically without closure. | `tests/ux0228-board.test.ts` | 0.22.6 | fails on v0.22.5 (5 failing of 5) |
| D6 | WALL token-only confirms carrying as hit required-field validation instead of restoring reviewed arguments. | `tests/fix0227-d6.test.ts` (`^D6:`) | 0.22.5 | fails on v0.22.4 (5 failing of 5) |
| D5 | Every spec inherited stale links to closed tasks (including missing worktrees) and repeated the same project warning. | `tests/stale-links.test.ts` (`^D5:`) | 0.22.5 | fails on v0.22.4 (3 failing of 3) |
| D3 | A valid answer token was refused after the permission menu scrolled to options 2–4. | `tests/p63-answer.test.ts` (`^D3:`) | 0.22.5 | fails on v0.22.4 (1 failing of 2) |
| D2 | GC removed the only data copies in task caches without explicit cache authorization or report-reference protection. | `tests/fix0227-gc.test.ts` (`^D2:`) | 0.22.5 | fails on v0.22.4 (3 failing of 3) |
| D1 | Cached GC previews declared dirty multi-repository tasks clean and missed unpushed commits, including linked worktrees. | `tests/fix0227-gc.test.ts` (`^D1:`) | 0.22.5 | fails on v0.22.4 (4 failing of 4) |
| G1b | Provider quota errors left GLM capacity free when usage was unavailable. | `tests/fix0226-g1b.test.ts` | 0.22.4 | fails on v0.22.3 (7 failing of 8) |
| G1a | Plan n/d left free provider slots with no timed hold override. | `tests/fix0226-g1a.test.ts` | 0.22.4 | fails on v0.22.3 (1 failing of 1) |
| H6 | Overlap warnings counted predecessor imports and ignored the integration base. | `tests/fix0226-h6.test.ts` | 0.22.4 | fails on v0.22.3 (2 failing of 2) |
| H2 | Budget fallback presented a three-hour cached status as current. | `tests/fix0226-h2.test.ts` | 0.22.4 | fails on v0.22.3 (2 failing of 2) |
| H3 | A pending queue_rm prevented replacing the same task ID. | `tests/fix0226-h3.test.ts` | 0.22.4 | fails on v0.22.3 (1 failing of 1) |
| H5 | Report summaries hid outputs findings and duplicate blocks discarded all outputs. | `tests/fix0226-h5.test.ts` | 0.22.4 | fails on v0.22.3 (3 failing of 3) |
| H1 | Deferred queue removal published a vanished-window event before cancellation. | `tests/fix0226-h1.test.ts` | 0.22.4 | fails on v0.22.3 (2 failing of 2) |
| H4 | Attempt markers before the verdict blocked dependencies. | `tests/fix0226-h4.test.ts` | 0.22.4 | fails on v0.22.3 (2 failing of 2) |
| HELP-HEIGHT | Board help overflowed terminal height and overdrew its header. | `tests/board.test.ts` (`^HELP-HEIGHT:`) | 0.22.3 | fails on v0.22.2 (1 failing of 1) |
| BASE-DEFAULT | A missing spec base did not identify the repository default branch. | `tests/worktree-start.test.ts` (`^BASE-DEFAULT:`) | 0.22.3 | fails on v0.22.2 (1 failing of 1) |
| A11 | Unknown WALL identity and own posts are not visibly labelled. | `tests/a11-wall-visibility.test.ts` | 0.22.2 | fails on v0.22.0 (1 failing of 1) |
| A10 | Collapsed Codex questions omit text from namespaced session tool calls. | `tests/p65b-peek-question.test.ts` (`^A10:`) | 0.22.2 | fails on v0.22.0 (1 failing of 1) |
| A9 | Compact output references fail YAML parsing and placeholder branches escape validation. | `tests/a9-report-formats.test.ts` | 0.22.2 | fails on v0.22.0 (2 failing of 2) |
| A8 | YAML converts unquoted git identifiers such as 2742e697 into numbers. | `tests/spec.test.ts` (`^A8:`) | 0.22.2 | fails on v0.22.0 (1 failing of 1) |
| A7 | Summary and out-of-order full report reads stay unread in events_since. | `tests/a7-report-pulled.test.ts` | 0.22.2 | fails on v0.22.0 (1 failing of 1) |
| A6 | Scrolled Codex multiline drafts lose paste ownership and cannot be submitted. | `tests/p49-codex-queue.test.ts` (`^A6:`) | 0.22.2 | fails on v0.22.0 (1 failing of 1) |
| A5 | Not every preview write accepts a token-only confirm; limits and reserve lacked preview_token. | `tests/mcp-token-confirm.test.ts` (`^A5:`) | 0.22.2 | fails on v0.22.0 (3 failing of 3) |
| A2 | WALL events disappear behind cohort filters and transport client cursors. | `tests/a2-wall-events.test.ts` | 0.22.2 | fails on v0.22.0 (2 failing of 2) |
| A1 | MCP new/queue preview waits on git and runtime reads and loses its token at the budget. | `tests/p93-mcp-accept.test.ts` (`^A1:`) | 0.22.2 | fails on v0.22.0 (2 failing of 2) |
| CONSULT-f2 | Consultation tasks inherited automatic review and failed detached-worktree admission (pre-fix unreleased 1c98117: 1 of 1 fails; absent on v0.21.0). | `tests/consult.test.ts` (`CONSULT-f2`) | 0.22.0 | cannot run on v0.21.0: the code under test did not exist there (import error) |
| CONSULT-f1 | A long task cache produced a 101-byte tmux socket even after digest shortening, so the stdio/release harness refused before startup. | `tests/harness.test.ts` (`CONSULT-f1`) | 0.22.0 | fails on v0.21.0 (1 failing of 1) |
| WALL-1-f1 | `agentctl wall post/reply/status` acted as the owner also in an agent's task shell: an agent could post as the owner, answer as a chat with --as chat:<name>, or close a decision-request (pre-fix run on the unreleased WALL-1 commit 19e8192: 4 of 5 fail). | `tests/wall2-identity.test.ts` | 0.21.0 | cannot run on v0.20.2: the code under test did not exist there (import error) |
| WALL-1-f2 | The WALL secret scan refused plain prose such as "Token: x" or "Key: the building height" (the report redaction's assignment rule); nothing was posted (pre-fix run on the unreleased WALL-1 commit 19e8192: 2 of 2 fail). | `tests/wall2-secrets.test.ts` | 0.21.0 | cannot run on v0.20.2: the code under test did not exist there (import error) |
| P16-f1 | A glm follow-up never got transcript proof (no `delivery_source: transcript`, no queue-acceptance note): the session transcript of a glm task was read with the Codex parser. The release scenario live-p15-send also failed from 0.19.4 because it read the delivery fields of the first prompt while the Codex follow-up was still queued (a scenario defect; the queued Codex path is pinned in the same file). | `tests/p16-queued-proof.test.ts` | 0.20.2 | fails on v0.20.1 (2 failing of 7) |
| P95 | The first glm task failed its start ("glm did not show its input prompt within 60s"): the wrapper's fresh Claude config shows the first-run onboarding, whose theme line "❯ ✔ Dark mode" also looked like the input box; the owner saw nothing and the window was closed. | `tests/p95-p96-glm-start.test.ts` (`^P95`) | 0.20.1 | fails on v0.20.0 (11 failing of 12) |
| P96 | A start that did not reach the agent's input closed its window and kept no screen: the owner could not see why it failed; queue_retry had no capture to look at. | `tests/p95-p96-glm-start.test.ts` (`^P96`) | 0.20.1 | fails on v0.20.0 (3 failing of 3) |
| P94 | `after` read a live author's report before its verdict line was written, announced the dependent blocked and never announced the release when the report said PASS; the owner unblocked it by hand. | `tests/p94-after-verdict.test.ts` | 0.19.6 | fails on v0.19.4 (3 failing of 4) |
| P93b | MCP unblock (and other write) confirms scanned every task under load, ran past the 8 s budget again and again and did nothing; the owner ran the CLI. | `tests/p93b-mcp-deferred.test.ts` | 0.19.6 | fails on v0.19.4 (4 failing of 4) |
| P93 | MCP queue/new confirm planned again and waited for start.lock on a loaded host, ran past the 8 s budget and registered nothing; the owner pasted `agentctl queue` in a terminal. | `tests/p93-mcp-accept.test.ts` (`P93: (queue\|new) confirm\|refuses`) | 0.19.5 | fails on v0.19.4 (4 failing of 4) |
| P92 | Kimi did not take the first prompt: "Kimi screen is not stable before Enter" (a rotating footer tip) left it in the field for the owner. | `tests/p92-kimi-start.test.ts` | 0.19.5 | fails on v0.19.4 (4 failing of 4) |
| P85 | MCP doctor probed every task report and link and walked worktrees, so it stalled on a large home. | `tests/hotfix-0194-p85.test.ts` | 0.19.4 | fails on v0.19.3 (1 failing of 1) |
| P89 | `after` released dependents on any finished report; a FAIL/BLOCKED/NO-GO or missing first-line verdict did not hold them. | `tests/hotfix-0194-p89.test.ts` | 0.19.4 | fails on v0.19.3 (6 failing of 10) |
| P89-f1 | A spec with `after_verdict` but no `after` was accepted and the override silently did nothing. | `tests/spec.test.ts` (`after_verdict`) | 0.19.4 | fails on v0.19.3 (2 failing of 2) |
| P90 | A follow-up sent to a working Codex was pasted at the first idle-looking redraw (or lost behind an existing report) instead of waiting for the confirmed turn end. | `tests/hotfix-0194-p90.test.ts` (`P90: (busy\|an idle)`) | 0.19.4 | fails on v0.19.3 (2 failing of 3) |
| P91 | A pending, withdrawn or stale follow-up (or a closed task) hid an existing report from get_report. | `tests/hotfix-0194-p91.test.ts` (`P91`) | 0.19.4 | fails on v0.19.3 (4 failing of 4) |
| P91-f1 | Closing a task silently discarded queued and unsent follow-ups without a journal entry. | `tests/hotfix-0194-p91.test.ts` (`close journals`) | 0.19.4 | fails on v0.19.3 (1 failing of 2) |
| P83-write | MCP write previews (close/cancel/mark/gc/queue) ran worker measurements, du and git status and took seconds on large homes. | `tests/write-contracts.test.ts` | 0.19.3 | fails on v0.19.2 (4 failing of 4) |
| P83-read | status, queue list and MCP reads walked every worktree again (read-path regression on large homes). | `tests/read-contracts.test.ts` | 0.19.2 | fails on v0.19.1 (4 failing of 5) |
| P84 | MCP set_limits rejected integer strings such as "3" for a provider (P84/P79). | `tests/mcp-limit-strings.test.ts` | 0.19.2 | fails on v0.19.1 (1 failing of 1) |
| P77 | Several two-phase MCP tools refused a confirm that carried only the preview_token. | `tests/mcp-token-confirm.test.ts` | 0.19.2 | fails on v0.19.1 (2 failing of 2) |
| L1 | A third gate entering while a live lock was displaced during stale-lock reclamation could own the gate lock too. | `tests/gate.test.ts` (`^L1`) | 0.19.1 | cannot run on v0.19.0: the code under test did not exist there (import error) |
| F1 | Automatic .cache cleanup ran during a live turn or in a worktree shared with another open task. | `tests/p73-cache-clean.test.ts` (`^F1`) | 0.19.1 | cannot run on v0.19.0: the code under test did not exist there (import error) |
| P65-b | peek of a Codex task with a collapsed question did not name the question text. | `tests/p65b-peek-question.test.ts` | 0.19.1 | fails on v0.19.0 (2 failing of 3) |
| P70 | A declared outputs.verdict overrode the first-line verdict of a review report (NO-GO on line 1 showed as PASS). | `tests/p70-review-verdict.test.ts` | 0.19.1 | fails on v0.19.0 (8 failing of 10) |
| P71 | Attention summaries repeated outputs of closed/pulled tasks and the unrated count on every call. | `tests/chat-events.test.ts` (`P71`) | 0.19.1 | fails on v0.19.0 (2 failing of 2) |
| P72 | Backend links ignored spec repository worktrees and base-stale targets raised no warning. | `tests/stale-links.test.ts` (`P72`) | 0.19.1 | fails on v0.19.0 (1 failing of 1) |
| P73-a | Task worktree .cache was left behind after the report was settled (and removal could escape through symlinks). | `tests/p73-cache-clean.test.ts` (`^P73-a`) | 0.19.1 | cannot run on v0.19.0: the code under test did not exist there (import error) |
| P42 | A task that already had a window showed twice on the board (queue row "… starting" plus its own row). | `tests/p42-board-window.test.ts` | 0.19.0 | fails on v0.18.2 (3 failing of 4) |
| P51 | Limit notifications and events omitted unchanged optional providers. | `tests/p51-limits.test.ts` | 0.19.0 | fails on v0.18.2 (1 failing of 1) |
| P52 | Repeated report edits published the report/results notification several times per attempt. | `tests/p52-report-events.test.ts` | 0.19.0 | fails on v0.18.2 (2 failing of 2) |
| P62 | An MCP call could outlive its budget; retried confirms duplicated orders and fresh registrations vanished from partial responses. | `tests/p62-budget.test.ts` | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| P63 | Answering an agent menu with `send "1"` queued a message instead of choosing the option. | `tests/p63-answer.test.ts` (`P63`) | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| B1-answer | Answer tokens could be replayed, outlive their preview or apply to a changed frame; an old Kimi menu above a fresh composer was still answerable. | `tests/p63-answer.test.ts` (`^integration`) | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| P64 | A message queued inside a working Codex (↳ echo) raised a false needs-attention "Prompt delivery not confirmed". | `tests/p64-codex-queued.test.ts` | 0.19.0 | fails on v0.18.2 (2 failing of 3) |
| P65 | A collapsed async Codex question while the agent works was reported as needs-input although the agent kept going. | `tests/p65-collapsed-question.test.ts` | 0.19.0 | fails on v0.18.2 (2 failing of 6) |
| P67 | Credential masking replaced short substrings of ordinary words, field names and task IDs. | `tests/p67-redaction.test.ts` (`^P67`) | 0.19.0 | fails on v0.18.2 (2 failing of 2) |
| R1-redact | camelCase credentials and passwd values were not masked in fields, text and URL queries. | `tests/p67-redaction.test.ts` (`^R1`) | 0.19.0 | fails on v0.18.2 (1 failing of 1) |
| P68 | A command run from a directory removed by gc crashed with an ENOENT uv_cwd stack trace. | `tests/p68-cwd.test.ts` | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| P69 | After gc --apply the board and status kept the pre-gc disk reading for minutes. | `tests/p69-gc-disk.test.ts` | 0.19.0 | fails on v0.18.2 (2 failing of 2) |
| B2-clean | gate clean could follow dangling or nested symlinks to outside paths and stop a foreign tmux server. | `tests/gate-clean.test.ts` (`integration B2`) | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| X1 | A preempted gate-lock reclaimer could unlink the live lock a successor had installed. | `tests/gate.test.ts` (`^X1`) | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| X2 | A SIGKILL between creating and writing the gate-lock sidecar left a lock that recovery waited on forever. | `tests/gate.test.ts` (`^X2`) | 0.19.0 | cannot run on v0.18.2: the code under test did not exist there (import error) |
| X3 | An interrupted FIFO→active transfer left one message in both stores; withdraw refused it as ambiguous and recovery could redeliver it. | `tests/p48-withdraw.test.ts` (`^X3`) | 0.19.0 | fails on v0.18.2 (2 failing of 2) |
| X4 | MCP set_limits refused "off" for the optional provider (Kimi) in its registered schema. | `tests/kimi.test.ts` (`^X4`) | 0.19.0 | fails on v0.18.2 (1 failing of 1) |
| P49 | A follow-up to a working Codex used the wrong queue key, and wrapped pastes were not recognised as delivered. | `tests/p49-codex-queue.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P50 | Requeueing a removed task ID reused the old attempt and cancelled its new dependents. | `tests/queue.test.ts` (`^P50`) | 0.18.2 | pre-fix proof not run (time budget) |
| R2-gate | The gate lock of a SIGKILLed gate (dead owner PID) was waited on forever. | `tests/gate.test.ts` (`SIGKILLed`) | 0.18.2 | pre-fix proof not run (time budget) |
| FIX1-update | doctor judged the Codex update check from the first -c flag instead of the last one that wins. | `tests/p33-codex-update.test.ts` (`doctor`) | 0.18.2 | pre-fix proof not run (time budget) |
| FIX1-tmux-loss | Closing a never-ready start window on purpose raised a tmux-loss event. | `tests/queue.test.ts` (`intentional close of a never-ready`) | 0.18.2 | pre-fix proof not run (time budget) |
| FIX1-kimi-trust | The Kimi trust dialog stayed needs-trust although a ready prompt below it proved trust was answered. | `tests/kimi.test.ts` (`^P48`) | 0.18.2 | pre-fix proof not run (time budget) |
| FIX1-gc-events | Oversized legacy gc_preview events filled whole event pages. | `tests/chat-events.test.ts` (`summarized on read\|gc_preview value`) | 0.18.2 | pre-fix proof not run (time budget) |
| INT4-trust | A trust-wait timeout left a failed queue entry for a live pending task. | `tests/queue.test.ts` (`^INT4`) | 0.18.2 | pre-fix proof not run (time budget) |
| SOAK | Held action keys queued stale commands on the board and timers/caches grew during long sessions. | `tests/board-soak.test.ts` (`held action keys\|eight-hour\|progress cache`) | 0.18.2 | pre-fix proof not run (time budget) |
| P43 | Tasks lost with the tmux server vanished from status instead of staying visible with recovery guidance. | `tests/tmux-loss.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32 | The board tick re-scanned every task record and report, archived included, several times per 2 s tick. | `tests/board-p32-counts.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F1 | A cached report digest was trusted without re-checking the owner, allowed roots and symlinked ancestors. | `tests/board-p32-f1.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F2 | Atomic replacement or equal-size rewrite of TASK.md or a report went unnoticed by the caches. | `tests/board-p32-f2.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F3 | An archive duplicate won over the current task repositories on the board. | `tests/board-p32-f3.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F4 | Live closed/cancelled rows lost their tokens in default board mode. | `tests/board-p32-f4.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F5 | An immediate watch refresh left a superseded trailing timer that fired a duplicate tick. | `tests/board-p32-f5.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F6 | Expanding hidden/closed sections did not request deep data while an active row stayed selected. | `tests/board-p32-f6.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F7 | Board refresh sources kept several deadlines, re-armed after failures or after exit. | `tests/board-p32-f7.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P32-F8 | Arrow keys on populated rows stalled while records were scanned or status collected. | `tests/board-p32-f8.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P23 | Output repository names given as worktree directory names or paths were not normalised to the repository name. | `tests/p23.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P18 | Recursive or self links were accepted in spec previews. | `tests/p18.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P34 | MCP `new` confirm could hold the server for minutes for a checkout, setup or input prompt instead of registering the start for the watcher. | `tests/mcp.test.ts` (`confirm never starts in the server`)<br>`tests/p19-setup.test.ts` (`also handed to the watcher`) | 0.18.2 | pre-fix proof not run (time budget) |
| P33 | The Codex "Update available" modal blocked a start for the full 60 s ready timeout. | `tests/p33-codex-update.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P35 | `prompt_delivery: sent` was set without a real delivery (a human answering a dialog flipped a failed start to sent). | `tests/p35-delivery.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P36 | `queue rm` left the live window of a cancelled failed start, so the cancelled state read as waiting. | `tests/queue.test.ts` (`^P36`) | 0.18.2 | pre-fix proof not run (time budget) |
| P37 | `events --since HH:MM` for a time later than now returned an empty "future" window instead of yesterday. | `tests/chat-events.test.ts` (`^P37`)<br>`tests/fix5.test.ts` (`P37`) | 0.18.2 | pre-fix proof not run (time budget) |
| P38 | A closed cohort journalled its whole GC plan, which flooded events_since with JSON fragments. | `tests/cohort.test.ts` (`^P38`) | 0.18.2 | pre-fix proof not run (time budget) |
| P30 | A rejected config reload was forgotten between reads, hiding the rejection from doctor and status. | `tests/config-reload.test.ts` (`rejection receipt`) | 0.18.2 | pre-fix proof not run (time budget) |
| P27 | Long PATH or Codex notify arguments overflowed the tmux command line when launching an agent. | `tests/launch-script.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P28 | Kimi status stayed on a stale error banner after a successful re-login. | `tests/c2-kimi.test.ts`<br>`tests/kimi.test.ts` (`P28`) | 0.18.2 | pre-fix proof not run (time budget) |
| P19 | The MCP server was held by a task start and by synchronous worktree-size walks over node_modules. | `tests/p19-setup.test.ts` (`^P19`)<br>`tests/p19-reads.test.ts` (`RealRunner: a child process\|the size walks`) | 0.18.2 | pre-fix proof not run (time budget) |
| P19-FIX2 | Disk measurements were duplicated, never invalidated, and batched author/reviewer starts lost their order and scope. | `tests/p19-fix2-disk.test.ts` (`R2: cold inventory\|R3: path TTLs\|R3: removed and replaced`)<br>`tests/p19-fix2-measurement.test.ts` (`disk.workers=1\|a crashed foreground\|shutdown cancels\|MCP stdin end\|GC rechecks`)<br>`tests/p19-fix2-no-agent.test.ts`<br>`tests/p19-fix2-setup.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P15 | `send` to a working agent was silent and could press Enter into the wrong field or mark an undelivered message as delivered. | `tests/p15-fix3-contract.test.ts`<br>`tests/p15-fix3.test.ts`<br>`tests/p15-fix4.test.ts`<br>`tests/p15-fix5.test.ts` | 0.18.2 | pre-fix proof not run (time budget) |
| P15b | A collapsed Claude paste arrived wrapped in <pasted_content> and never matched the pending prompt, ending in needs-attention. | `tests/p15-send.test.ts` (`P15b`) | 0.18.2 | pre-fix proof not run (time budget) |
| P16 | Codex follow-ups to a working agent were not recognised as queued/steered, so delivery stayed unconfirmed. | `tests/p15-send.test.ts` (`P16`) | 0.18.2 | pre-fix proof not run (time budget) |

## Not catalogued

CHANGELOG identifiers that are features, improvements or studies rather than fixed bugs:

- FIX0227-W4-harness: harness assertion aligned with the intentional A3 snapshot contract; production unchanged, covered by W4 in a3-snapshot.test.ts
- P10: feature: optional tmux.socket and attach hints
- P44: feature: dedicated dev tmux server documentation and doctor checks
- P17: feature: stale project link warnings in previews
- P22: feature: report_from hints
- P24: feature: disk share warnings
- P29: guard: live harness refuses missing cache roots (process rule, covered by harness tests)
- P39: convenience: token-only confirm for new/queue (the defect for every tool is P77)
- P45: improvement: concise MCP report reads
- P47: improvement: MCP footers only on demand
- P54: feature: npm run gate -- clean
- P55: feasibility study; no behaviour change claimed for Kimi trust
- P59: no mapping in the supplied branches/reports; no behaviour claimed
- P60: feature: spec class and model matrix
- P61: feature: model matrix (data/model-matrix.yaml) and generated tables
- P66: feature: review_of list
- P79: covered by P84 (one test file)
- P73: covered by P73-a and F1
