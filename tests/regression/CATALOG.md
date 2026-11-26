# Regression catalog

One scenario per known, fixed bug. `npm run regression` runs them all (also as part of every `npm run gate` tier) and fails on any regression.
Scenarios are deterministic (fake tmux/agent fixtures, no inference, no network). Most are the tests that were written with the fix; this catalog
references them instead of copying them. Source: `tests/regression/catalog.ts`; proof column: `tests/regression/prefix-proof.json`,
produced by `npm run regression -- --against <release>` (the current scenarios run against `src/` of the release before the fix).
Regenerate this file with `npm run regression -- --catalog`.

**Rule:** every bug fix adds its scenario and one catalog entry in the same commit (AGENTS.md).

| Bug | Symptom | Scenario | Fixed in | Pre-fix proof |
| --- | --- | --- | --- | --- |
| REVIEW0263-F2 | The admission deadline interrupted integration GC and could interrupt a prompt between paste and Enter. | `tests/review0263.test.ts` (`^REVIEW0263-F2:`)<br>`tests/disk0248.test.ts` (`^FLOW-GC: watch proposes`) | 0.27.2 | fails on 795247ab32fc91b345ada1f9ce1ede77cdfcfb72 (2 failing of 2) |
| REVIEW0263-F4 | The new start lock wrote an owner format an older worker could never reclaim. | `tests/queue.test.ts` (`^HOTFIX0263-LOCK:`) | 0.27.2 | fails on 795247ab32fc91b345ada1f9ce1ede77cdfcfb72 (1 failing of 1) |
| REVIEW0263-F1 | Accepted start validation ran lengthy repository and tmux probes while holding the admission lock. | `tests/review0263.test.ts` (`^REVIEW0263-F1:`) | 0.27.2 | fails on 795247ab32fc91b345ada1f9ce1ede77cdfcfb72 (1 failing of 1) |
| REL0272-TICK-ROWS | A status collection timeout replaced the last complete MCP snapshot with a rowless snapshot dated as fresh. | `tests/watch-snapshot.test.ts` (`^REL0272-TICK-ROWS:`) | 0.27.2 | fails on 795247ab32fc91b345ada1f9ce1ede77cdfcfb72 (1 failing of 1) |
| REL0272-P19-RETRY | Retrying setup over kept worktrees ran a separate unbounded series of cwd probes for each checkout. | `tests/worktree-start.test.ts` (`^REL0272-P19-RETRY:`) | 0.27.2 | fails on 795247ab32fc91b345ada1f9ce1ede77cdfcfb72 (1 failing of 1) |
| REL0272-GIT-REFUSAL | Local GC could override Git’s untracked-file protection after the hotfix merge. | `tests/fix0227-gc.test.ts` (`^D1: cached MCP preview checks every repo`) | 0.27.2 | fails on 5274994a68ce2d2fdaf2cc310ad602c00a6b0e94 (1 failing of 1) |
| REL0272-PRESSURE-POLICY | The macOS CPU fixture concentrated its competing application workload in the gate’s background scheduling group. | `tests/gate.test.ts` (`^REL0272-PRESSURE-POLICY:`) | 0.27.2 | fails on 6631d091d0b6f64af65184dbb37f68684d9faa43 (1 failing of 1) |
| REL0272-DELIVERY-SCAN | Watch acquired the shared start lock once per active task even when there were no messages to send. | `tests/review0256.test.ts` (`^REL0272-DELIVERY-SCAN:`) | 0.27.2 | fails on e3a6373f67cc15323ad95af1e91bacb8c0d83760 (1 failing of 1) |
| REL0272-SMOKE-EVIDENCE | A package install failure aborted the release gate before its production-scale check. | `tests/gate.test.ts` (`^REL0272-SMOKE-EVIDENCE:`) | 0.27.2 | fails on f702dcca477f2d708a55a3cf9ed540cae21001ed (1 failing of 1) |
| REVIEW0256-RESUME | A hung launch-health retry could keep the watch tick and start reservation open. | `tests/review0256.test.ts` (`^REVIEW0256-RESUME:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-LOAD | An alert threshold blocked all queue admission without an opt-in. | `tests/review0256.test.ts` (`^REVIEW0256-LOAD:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-INDEX | Launch health repeatedly parsed unchanged task headers and the full journal. | `tests/review0256.test.ts` (`^REVIEW0256-INDEX:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-LEGACY | A legacy interrupted launch could replay its prompt automatically after upgrading. | `tests/review0256.test.ts` (`^REVIEW0256-LEGACY:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-DOWNGRADE | Rollback to 0.26 could fail to parse config or retain timed reservations indefinitely. | `tests/review0256.test.ts` (`^REVIEW0256-DOWNGRADE:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-MCP | A pre-0.27 MCP server could write limits directly and bypass owner approval. | `tests/review0256.test.ts` (`^REVIEW0256-MCP:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| REVIEW0256-EVENTS | Every chat-scoped events read rescanned task headers synchronously. | `tests/review0256.test.ts` (`^REVIEW0256-EVENTS:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| FIX-5246F46 | Interrupted pre-checkouts appeared in task status before a worktree existed. | `tests/review0256.test.ts` (`^FIX-5246F46:`) | 0.27.1 | fails on 7c331003fd87f50f6bd69c689a2b23e885af2d3d (1 failing of 1) |
| FIX-331D4A3 | A tmux server restart could turn a resume into an original prompt replay. | `tests/tmux-loss.test.ts` (`^lost server/session stays visible`) | 0.27.1 | fails on bf115b61891277afd3c99824fb596367b723f434 (1 failing of 1) |
| W110-MCP-AGE | Queue and limits discarded a healthy snapshot just after a nominal tick was missed. | `tests/watch-snapshot.test.ts` (`^W110-MCP-AGE:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| UPGRADE0272 | A clone upgrade could leave a failing candidate installed instead of restoring the previous stable copy. | `tests/update.test.ts` (`^a failed post-upgrade check`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W102-VOLUME | State and external worktree disks shared the same start floor. | `tests/disk0248.test.ts` (`^W102-VOLUME:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-A | Watch stages could starve indefinitely after timing out. | `tests/field0272.test.ts` (`^W110-A:`) | 0.27.2 | fails on v0.27.1 (2 failing of 2) |
| W110-B | A finished task with a complete report could remain working. | `tests/field0272.test.ts` (`^W110-B:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-C | A transient tmux inventory gap could report a live window lost. | `tests/field0272.test.ts` (`^W110-C:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-D | A failed Codex version check failed the order without retry or CLI output. | `tests/field0272.test.ts` (`^W110-D:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-E | A terminal dependency without a verdict could block silently forever. | `tests/field0272.test.ts` (`^W110-E:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-F | Trailing findings and ambiguous first-line verdicts were mishandled. | `tests/field0272.test.ts` (`^W110-F:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-G | Deferred checks and namespaced output extensions were rejected. | `tests/field0272.test.ts` (`^W110-G:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-H | An owner could not remove a chat provider quota. | `tests/field0272.test.ts` (`^W110-H:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| W110-I | Plan readings did not use a two-window age bound or show n/d when expired. | `tests/field0272.test.ts` (`^W110-I:`) | 0.27.2 | fails on v0.27.1 (1 failing of 1) |
| FIELD0256-LAUNCH | A window could exit at launch without evidence, a retry, or a usable recovery and dependency state. | `tests/queue.test.ts` (`^FIELD0256-LAUNCH:`)<br>`tests/field0253-gc.test.ts` (`^FIELD0256-DEAD-GC:`) | 0.27.1 | fails on v0.27.0 (2 failing of 2) |
| FIELD0256-HOLD | Registered orders stayed idle without a hold event or a visible owner reservation reason. | `tests/queue.test.ts` (`^FIELD0256-HOLD:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| FIELD0256-CHAT-USAGE | Named chats lacked a common footer showing their effective quotas and global headroom. | `tests/owner-limits.test.ts` (`^FIELD0256-CHAT-USAGE:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| FIELD0256-COUNTS | Capacity and events disagreed on ready reports and stale status listed pulled or closed tasks as active. | `tests/capacity.test.ts` (`^FIELD0256-COUNTS:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| FIELD0256-EVENTS | A chat saw unrelated task events and truncated raw JSON GC results. | `tests/a2-wall-events.test.ts` (`^FIELD0256-EVENTS:`)<br>`tests/field0253-gc.test.ts` (`^FIELD0256-GC-EVENT:`) | 0.27.1 | fails on v0.27.0 (2 failing of 2) |
| FIELD0256-STALE | Expired provider readings still appeared as current percentages. | `tests/capacity.test.ts` (`^FIELD0256-STALE:`) | 0.27.1 | fails on v0.27.0 (2 failing of 2) |
| FIELD0256-GC-KEEP | GC ignored comma-delimited task IDs in --keep and --force-dirty. | `tests/field0253-gc.test.ts` (`^FIELD0256-GC-KEEP:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| FIELD0256-EXACT | An exact task ID outside a command’s eligible set could select a review by prefix. | `tests/queue-mcp.test.ts` (`^FIELD0256-EXACT:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| FIELD0256-SPEC | task_spec missed queued-only work and could show the review spec for the exact author ID. | `tests/queue-mcp.test.ts` (`^FIELD0256-SPEC:`) | 0.27.1 | fails on v0.27.0 (1 failing of 1) |
| LIMITS0255-OWNER | A chat confirmation could change shared limits without an owner decision in the CLI or board. | `tests/owner-limits.test.ts` (`^LIMITS0255-OWNER:`) | 0.27.0 | fails on v0.26.0 (1 failing of 1) |
| LIMITS0255-SHARES | Per-chat absolute ceilings stayed fixed after global changes and needed manual recalculation. | `tests/owner-limits.test.ts` (`^LIMITS0255-SHARES:`) | 0.27.0 | fails on v0.26.0 (1 failing of 1) |
| LIMITS0255-SCHEDULE | The dispatcher could not switch between limit profiles at local times across midnight and DST. | `tests/owner-limits.test.ts` (`^LIMITS0255-SCHEDULE:`) | 0.27.0 | fails on v0.26.0 (1 failing of 1) |
| HOTFIX0263-START | Hung checkout or setup retained a setup slot and delayed unrelated queued tasks. | `tests/queue.test.ts` (`^HOTFIX0263-START:`) | 0.26.1 | fails on v0.26.0 (2 failing of 2) |
| HOTFIX0263-LOCK | An old admission lock with no live owner kept starts from proceeding. | `tests/queue.test.ts` (`^HOTFIX0263-LOCK:`) | 0.26.1 | fails on v0.26.0 (1 failing of 1) |
| HOTFIX0263-WATCH | A stalled watch stayed down or left interrupted starts in the failed queue. | `tests/disk0248.test.ts` (`^HOTFIX0263-WATCH:`) | 0.26.1 | fails on v0.26.0 (1 failing of 1) |
| HOTFIX0263-DISK | GC reported logical file size instead of the bytes reclaimed on disk. | `tests/gc.test.ts` (`^HOTFIX0263-DISK:`) | 0.26.1 | fails on v0.26.0 (1 failing of 1) |
| HOTFIX0263-TRASH | Stale dependency clones moved to Trash and continued using disk space. | `tests/disk0248.test.ts` (`^HOTFIX0263-TRASH:`) | 0.26.1 | fails on v0.26.0 (1 failing of 1) |
| FLOW-GC | Integration left closed worktrees for chats to find and scope manually before GC. | `tests/disk0248.test.ts` (`^FLOW-GC:`) | 0.26.0 | fails on v0.25.3 (2 failing of 2) |
| FLOW-FRESHNESS | Reviews could start against outdated integration bases without a warning or candidate. | `tests/disk0248.test.ts` (`^FLOW-FRESHNESS:`) | 0.26.0 | fails on v0.25.3 (2 failing of 2) |
| FLOW-READONLY | A review could not use the stopped author checkout with isolated evidence and Git hooks. | `tests/disk0248.test.ts` (`^FLOW-READONLY:`)<br>`tests/audit-0174.test.ts` (`^W4 a stale resume plan`) | 0.26.0 | fails on v0.25.3 (1 failing of 2) |
| FLOW-SETUP | A review had to reinstall dependencies even when its task already had a compatible installation. | `tests/disk0248.test.ts` (`^FLOW-SETUP:`) | 0.26.0 | fails on v0.25.3 (1 failing of 1) |
| FLOW-CLOSE | Closing a task whose tmux window had disappeared gave an ambiguous or misleading result. | `tests/mcp.test.ts` (`^FLOW-CLOSE:`) | 0.26.0 | fails on v0.25.3 (1 failing of 1) |
| FIELD0253-BACKGROUND | An idle Codex composer with background terminals held queued follow-ups indefinitely. | `tests/field0253-codex-background.test.ts` (`^FIELD0253-BACKGROUND:`) | 0.25.3 | fails on v0.25.2 (2 failing of 2) |
| FIELD0253-ADMISSION | Queue validation and admission stopped when the full status sweep exceeded the watchdog deadline. | `tests/field0253-watch-queue.test.ts` (`^FIELD0253-ADMISSION:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-ATTENTION | Long-wait WALL decision requests stayed open after the task left the waiting state. | `tests/field0253-attention.test.ts` (`^FIELD0253-ATTENTION:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-LIMITS | Limits and quota WALL messages omitted their source and could miss intermediate revisions. | `tests/field0253-limits.test.ts` (`^FIELD0253-LIMITS:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-DISK | A stale worktree-size sample made the board show disk warn despite healthy free space. | `tests/field0253-disk.test.ts` (`^FIELD0253-DISK:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-CLI | The CLI could only force removal of dirty worktrees for the whole GC selection. | `tests/field0253-cli.test.ts` (`^FIELD0253-CLI:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-GC | A large MCP GC plan could exhaust the deadline before returning its confirmation token. | `tests/field0253-gc.test.ts` (`^FIELD0253-GC:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-BUDGET | The MCP deadline was recorded as a task state write failure. | `tests/field0253-budget.test.ts` (`^FIELD0253-BUDGET:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| FIELD0253-ENOSPC | A transient ENOSPC left TASK.md in needs-attention after space returned. | `tests/field0253-enospc.test.ts` (`^FIELD0253-ENOSPC:`) | 0.25.3 | fails on v0.25.2 (1 failing of 1) |
| ROWSEL0252 | Selected board rows retained mixed colors and had no background across the list pane. | `tests/board-render.test.ts` (`ROWSEL0252:`) | 0.25.2 | fails on v0.25.1 (1 failing of 1) |
| NOTIFY0251-WINDOW | Watch repeated the same plan alert after reset estimates changed or the plan briefly disappeared. | `tests/usage-limits.test.ts` (`^NOTIFY0251-WINDOW:`) | 0.25.1 | fails on v0.25.0 (1 failing of 1) |
| NOTIFY0251-RACE | Overlapping watch reads sent the same plan alert to desktop and phone before the ledger was written. | `tests/usage-limits.test.ts` (`^NOTIFY0251-RACE:`) | 0.25.1 | fails on v0.25.0 (1 failing of 1) |
| NOTIFY0251-LIMIT | Provider-limit hooks could send owner alerts and run retries outside watch. | `tests/alerts.test.ts` (`^NOTIFY0251-LIMIT:`) | 0.25.1 | fails on v0.25.0 (1 failing of 1) |
| NOTIFY0251-DURABLE | Interrupted trust, disk and load announcements could repeat after watch restarted. | `tests/disk.test.ts` (`^NOTIFY0251-DURABLE:`)<br>`tests/machine.test.ts` (`NOTIFY0251-DURABLE`)<br>`tests/trust-notify.test.ts` (`^NOTIFY0251-DURABLE:`) | 0.25.1 | fails on v0.25.0 (3 failing of 3) |
| NOTIFY0251-SOCKET | A 67-byte task cache caused isolated tmux to refuse the gate socket path. | `tests/harness.test.ts` (`^NOTIFY0251-SOCKET:`) | 0.25.1 | fails on v0.25.0 (1 failing of 1) |
| QUOTA0250-CONTENTION | A single chat could take the next shared provider slots before another chat had a chance to reach its floor. | `tests/chat-quotas.test.ts` (`^QUOTA0250-CONTENTION:`) | 0.25.0 | fails on v0.24.0 (1 failing of 1) |
| QUOTA0250-CEILINGS | The queue had no chat ceiling across hosts or utilization tie-break and could not explain a wait for chat capacity. | `tests/chat-quotas.test.ts` (`^QUOTA0250-CEILINGS:`) | 0.25.0 | fails on v0.24.0 (1 failing of 1) |
| QUOTA0250-IDENTITY | Agent orders on the shared instance lost the ordering chat when confirmed and picked up by watch. | `tests/chat-quotas.test.ts` (`^QUOTA0250-IDENTITY:`) | 0.25.0 | fails on v0.24.0 (1 failing of 1) |
| QUOTA0250-MANAGEMENT | Any caller with set_limits permission could change shared limits and the WALL did not show those changes. | `tests/chat-quotas.test.ts` (`^QUOTA0250-MANAGEMENT:`) | 0.25.0 | fails on v0.24.0 (1 failing of 1) |
| QUOTA0250-GLM | Removing the GLM global cap silently restored its built-in limit of two. | `tests/chat-quotas.test.ts` (`^QUOTA0250-GLM:`) | 0.25.0 | fails on v0.24.0 (1 failing of 1) |
| DISK0248-NM | Parallel worktrees with the same npm lockfile each ran an independent install and consumed a full dependency tree. | `tests/disk0248.test.ts` (`^DISK0248-NM:`) | 0.24.0 | fails on v0.23.3 (1 failing of 1) |
| DISK0248-CLOSE | Closing finished worktrees left their ignored build and browser files in place. | `tests/disk0248.test.ts` (`^DISK0248-CLOSE:`) | 0.24.0 | fails on v0.23.3 (1 failing of 1) |
| DISK0248-VOLUME | The queue started worktrees on a mount directory that had fallen back to the internal disk. | `tests/disk0248.test.ts` (`^DISK0248-VOLUME:`) | 0.24.0 | fails on v0.23.3 (1 failing of 1) |
| DISK0248-LOCK | A checkout interrupted by a disappearing disk could leave Git initializing and index locks behind. | `tests/disk0248.test.ts` (`^DISK0248-LOCK:`) | 0.24.0 | fails on v0.23.3 (1 failing of 1) |
| SNAP0247 | A blocked watch step stopped snapshot publication, and stale MCP status dropped disk and capacity. | `tests/watch-snapshot.test.ts` (`^SNAP0247:`)<br>`tests/board-render.test.ts` (`SNAP0247:`) | 0.23.3 | fails on v0.23.2 (4 failing of 4) |
| WALL-34-READY | Kimi startup accepted a transient composer on the welcome screen before it had settled. | `tests/host-tasks.test.ts` (`^WALL-34-READY:`) | 0.23.2 | fails on v0.23.1 (2 failing of 2) |
| WALL-34-FIFO | An unconfirmed Kimi start in needs-attention kept later sends queued behind it. | `tests/host-tasks.test.ts` (`^WALL-34-FIFO:`) | 0.23.2 | fails on v0.23.1 (2 failing of 2) |
| WALL-23 | An unconfirmed MCP follow-up was accepted and delivered to a working agent. | `tests/mcp-write-contract.test.ts` (`^WALL-23:`)<br>`tests/host-tasks.test.ts` (`^WALL-23:`) | 0.23.2 | fails on v0.23.1 (3 failing of 3) |
| MCP-WRITE-PREVIEW | Single-task mark and an uncached GC write preview could register requests without confirmation. | `tests/mcp-write-contract.test.ts` (`^MCP-WRITE-PREVIEW:`) | 0.23.2 | fails on v0.23.1 (1 failing of 1) |
| REL0244-CASE-ISOLATION | An independent live case inherited provider admission or usage state from the preceding case. | `tests/harness.test.ts` (`^REL0244-CASE-ISOLATION:`) | 0.23.1 | fails on v0.23.0 (1 failing of 1) |
| REL0244-LIVE-EVIDENCE | The release gate stopped recording live evidence after the first failed regression or live check. | `tests/gate.test.ts` (`^REL0244-LIVE-EVIDENCE:`) | 0.23.1 | fails on v0.23.0 (1 failing of 1) |
| REL0244-REMOTE-FIXTURE | The fake remote admission probe used the gate machine’s free disk space and blocked unrelated regressions. | `tests/host-tasks.test.ts` (`^REL0244-REMOTE-FIXTURE:`) | 0.23.1 | not proven: Fixture bug introduced by the unreleased 0.23.1 admission merge. The gate on 571a4ca reproduced it. |
| REL0244-KIMI-HOLD | The release gate refused the Kimi trust task at admission because a previous case left a quota hold. | `tests/live-kimi.test.ts` (`^REL0244-KIMI-HOLD:`) | 0.23.1 | fails on v0.23.0 (1 failing of 1) |
| REL0244-DEV-REF | The dev updater draft preferred a stale local branch in a separate dev clone. | `tests/dev-update.test.ts` (`^dev updater resolves a branch`) | 0.23.1 | not proven: The dev updater first ships in 0.23.1; the scenario fails on the owner-approved draft. |
| REL0244-DEV-ROLLBACK | Rebuilding the same commit overwrote the dev updater draft’s rollback target. | `tests/dev-update.test.ts` (`^dev updater rebuilds a tagged worktree`) | 0.23.1 | not proven: The dev updater first ships in 0.23.1; the scenario fails on the owner-approved draft. |
| REL0244-DEV-PATH | The dev updater draft could not read the package version from a path containing an apostrophe. | `tests/dev-update.test.ts` (`^dev updater reads the package version`) | 0.23.1 | not proven: The dev updater first ships in 0.23.1; the scenario fails on the owner-approved draft. |
| REL0243-PREVIEW | MCP remote queue preview used dispatcher disk instead of host work_dir. | `tests/host-tasks.test.ts` (`^REL0243-PREVIEW:`) | 0.23.1 | not proven: Introduced by integrating 0.22.8 disk previews with remote hosts; absent from either previous release. |
| REL0243-LINKS | Remote project defaults ignored links: [] and accepted closed-task backends. | `tests/host-tasks.test.ts` (`^REL0243-LINKS:`) | 0.23.1 | fails on v0.23.0 (1 failing of 1) |
| REL0243-GC | Remote GC bypassed cache opt-in, pins and unpushed-commit protection. | `tests/host-gc.test.ts` (`^REL0243-GC:`) | 0.23.1 | fails on v0.23.0 (2 failing of 2) |
| REL0243-DISK | Remote setup did not enforce free disk in its host work_dir. | `tests/host-tasks.test.ts` (`^REL0243-DISK:`) | 0.23.1 | fails on v0.23.0 (1 failing of 1) |
| HOST-RESUME-HOLD | An explicit owner resume was silently skipped during a queued provider hold (introduced in unreleased HOST-0C). | `tests/resume.test.ts` (`^HOST-RESUME-HOLD:`)<br>`tests/host-tasks.test.ts` (`^HOST-RESUME-HOLD:`) | 0.23.0 | not proven: Introduced in unreleased 3f0078c; v0.22.4 local resume was unaffected. Both scenarios fail on 6c574f7 (measured in HOST0C-prefix-resume.log). |
| HOST-SSH-COLD | The first host health probe failed because its ControlMaster socket directory did not exist. | `tests/host-ssh-exit.test.ts` (`^HOST-SSH-COLD:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-DISK-PROBE | Host disk health used wrong df fields and did not expand remote HOME or honor host PATH. | `tests/host-health-home.test.ts` (`^HOST-DISK-PROBE:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-HOLD-OFFLINE | Persisted quota evidence could replace host-unreachable with limited after SSH loss. | `tests/host-tasks.test.ts` (`^HOST-HOLD-OFFLINE:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-GC-TARGET | An endpoint change could retarget a reviewed remote GC plan to a different SSH host. | `tests/host-gc.test.ts` (`^HOST-GC-TARGET:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-REDISCOVER | A renamed remote task window could be lost after watch restart when its tmux ID changed. | `tests/host-rediscover.test.ts` (`^HOST-REDISCOVER:`) | 0.23.0 | fails on v0.22.4 (1 failing of 1) |
| HOST-TMUX-WRAP | Wrapping saved tmux capture/paste/window methods recursed through the remote router (unreleased 87662ec; router absent from v0.22.3). | `tests/host-boundaries.test.ts` (`^HOST-TMUX-WRAP:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-MIRROR-ENV | Remote report mirror commands included unrelated launch environment values in SSH argv (unreleased b9384f2; mirror absent from v0.22.3). | `tests/host-boundaries.test.ts` (`^HOST-MIRROR-ENV:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-LOCAL-IO | The remote host router scanned every local task header before board/status previews (unreleased b9384f2; host runtime absent from v0.22.3). | `tests/host-boundaries.test.ts` (`^HOST-LOCAL-IO:`) | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| HOST-SSH-EXIT | A reachable host command exiting nonzero was misclassified as unreachable (unreleased HOST-0A 7fa25d6: 1/1 fails; absent from v0.22.3). | `tests/host-ssh-exit.test.ts` | 0.23.0 | cannot run on v0.22.4: the code under test did not exist there (import error) |
| FIELD0230-SOCKET | A 66-byte task cache made isolated tmux socket paths exceed the harness limit. | `tests/harness.test.ts` (`^FIELD0230-SOCKET:`) | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-PIN | A pin added during a GC safety query could miss the final deletion boundary. | `tests/field0230-gc.test.ts` (`^F2:`) | 0.22.8 | not proven: Pin/unpin GC protection is introduced in this release; no previous release exposes this race. |
| FIELD0230-F12 | Integrate base and advisory external repository references invalidated outputs. | `tests/field0230-outputs.test.ts` | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-F11 | Closed-task project links were silently dropped with a warning instead of blocking unsafe defaults. | `tests/field0230-links.test.ts` | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-F10 | Kimi effort medium was rejected instead of mapped to high with a warning. | `tests/field0230-effort.test.ts` | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-F9 | Tool identity and local preview expiration were inconsistent across reads/writes. | `tests/field0230-reads.test.ts` (`^F9:`) | 0.22.8 | fails on v0.22.7 (1 failing of 2) |
| FIELD0230-F7 | GLM starts ignored the provider peak admission schedule. | `tests/field0230-peak.test.ts` (`^F7: default`) | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-F6 | Shared provider holds omitted global scope and the detecting task. | `tests/field0230-providers.test.ts` (`^F6:`) | 0.22.8 | fails on v0.22.7 (2 failing of 2) |
| FIELD0230-F5 | Quota panes lost their usage hint/reset and disappeared from attention summaries. | `tests/field0230-providers.test.ts` (`^F5:`) | 0.22.8 | fails on v0.22.7 (2 failing of 2) |
| FIELD0230-F4 | Status/capacity reused stale filesystem free-space samples. | `tests/field0230-disk.test.ts` (`^F4:`) | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| FIELD0230-F3 | The queue admitted worktree setups below the free-disk start floor. | `tests/field0230-disk.test.ts` (`^F3:`) | 0.22.8 | fails on v0.22.7 (4 failing of 4) |
| FIELD0230-F1 | GC preview listed skipped dirty worktrees under cleanup candidates. | `tests/field0230-gc.test.ts` (`^F1:`) | 0.22.8 | fails on v0.22.7 (1 failing of 1) |
| WALL0229-HISTORY | Archive retry deduplication collapsed legitimate close/reopen/close records sharing a timestamp. | `tests/wall-lifecycle.test.ts` (`^WALL0229-HISTORY:`) | 0.22.7 | not proven: Unreleased lifecycle API is absent on v0.22.6 (import error); this scenario fails on pre-fix 83e0350 (1 failing test), measured separately from the release proof. |
| WALL0229-INBOX | Adding WALL age interrupted the stable ID/subject prefix in the budget fallback inbox. | `tests/a2-wall-events.test.ts` (`^A2: known chat receives`) | 0.22.7 | not proven: Introduced during unreleased lifecycle work; v0.22.6 passes. Existing A2 scenario fails on dd6d977 before correction (1 failing test), measured separately from the release proof. |
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

- QUOTA0250: feature: central quotas for chats sharing one instance; admission, owner and edit contracts are tracked above
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
