# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/) while it is below 1.0 (minor versions may change behaviour).

## [Unreleased]

- Show machine load/free memory in capacity and status detail; record configurable load threshold crossings.

- P32 F8: regression coverage sends real Ink/stdin arrow keys on populated rows independently during record scanning and status collection, and checks selection/preview effects without latency thresholds.

- P32 F7: all board refresh sources cancel the old deadline and re-arm only after the shared load completes, including failures; exit cancels pending refreshes.

- P23: accept task worktree directory names as output repository aliases and normalize accepted refs to repository names.

- P22: suggest explicit report_from for plausible nearby reports in status, board and events; never adopt automatically.

- P18: reject recursive/self links during preview and warn about missing absolute link sources.

- P32 validation: default gates assert warm-tick file counts; the host-sensitive 100 ms assertion uses the existing AGENTCTL_P32_PERF opt-in.

- P32 F9: remove the production per-scan parse counter; tests count fixture file operations only.

- P32 F6: expanding hidden/closed sections always requests a deep refresh, including when an active row remains selected or a shallow refresh is in flight.

- P32 F5: an immediate watch refresh cancels a superseded trailing timer, preventing duplicate ticks under event-loop delay.

- P32 F4: token collection uses the effective row and its shallow predicate, retaining tokens for live closed/cancelled tasks and current rows with archive duplicates.

- P32 F3: current task repositories and worktrees take precedence over archive duplicates on the board.

- P32 F2: TASK.md and report caches detect atomic replacement and equal-size rewrites with dev/inode and nanosecond mtime/ctime; coarse change times force a reread.

- P32 F1: cached report digests revalidate the current owner, allowed roots and symlink components on every inspection.

- P32: the board tick no longer scales with the archive. Task records are scanned once per tick and re-parsed only when a TASK.md changes (previously 5-6 full scans of every record, archived included, per 2 s tick); report bodies are hashed and scanned once per version (cached by dev/ino/mtime/size); closed/cancelled/archived rows skip the prompt queue, outputs and token collection unless their section is expanded; one UsageReader per board process replaces the per-tick ~1 MB usage-cache parse; the disk report is collected on its own 5 min cadence with a bounded budget; the refresh runs every 2 s only while a task is alive (5 s when everything is done, armed after the previous tick, never stacked) and fs.watch event ticks are debounced to one per 500 ms; the per-record loop yields every 25 records so keys interleave with a tick.
- Development gates: `npm run gate -- quick|full|release` centralizes affected tests, sequential shared Node runtimes, package/doctor/live checks, low-priority execution, a cross-task lock and JSON evidence; standing agent rules are in AGENTS.md.

- Claude `/usage` probe is opt-in (`capacity.claude_usage_probe: true`); it reads plan windows in an isolated neutral session and never starts automatically by default.
- `dataset export` streams a read-only benchmark dataset as JSONL or CSV, with attempt identities, provenance and explicit redacted prompt/report content opt-ins.
- P29: live harnesses and package smoke checks require an explicit absolute `AGENTCTL_LIVE_CACHE` task root; missing roots, shared historical sandboxes and escaping paths are refused before writes.
- P30: preserve rejected config reload state across reads and clear the receipt only after a corrected configuration is accepted; live retry checks synchronize on the persisted rejection/recovery state.

- P27: launch providers through private task-local scripts, keeping tmux commands short even with long PATH and Codex notify arguments. Codex forwards the original notify through a private JSON file (`event --forward-file`); start, resume, move and queued starts share the launch path.
- Review fixes M1–M3: require the complete owned Kimi composer before Enter and support token-confirmed recovery; follow-ups require current hook/wire or exact transcript injection evidence; redact setup diagnostics, persisted events and MCP output.
- P28: recover Kimi status after successful re-login despite stale error banners. Fall back to the startup CLI version when wire records omit it. Default economical equivalents are k3-256k/low, k3/high and k3/max; pro remains explicit-only. GC completion reports successful current removals and bytes separately from failures and skipped entries.

- P15/P15b/P16, `send` to a working agent (recorded on Claude Code 2.1.311 and codex-cli 0.166.0; reworked after cross reviews, P15-FIX2–FIX4): the result is never silent: `send`, `status` (`delivery_result`, `--json`, MCP) and the journal (`WIADOMOŚĆ`, every change of the result of a follow-up with its delivery id) say delivered (with its source), `w kolejce agenta – niepotwierdzone`, `w kolejce agenta – potwierdzone` or `nie dostarczono – tekst w polu wpisywania`.
  - **Delivered only from an exact source** (P15-FIX3): the UserPromptSubmit hook (a collapsed paste arrives wrapped in `<pasted_content id="…">`: the wrapper comes off the hook’s text only, by pairs of ids; nested, mismatching or stray tags prove nothing), the notify payload of Codex, or the session transcript of the task itself (Claude Code `user`; queued injection must correlate to a unique unconsumed enqueue after delivery started; Codex `response_item`/`item_completed`/`user_message`), holding a message written after the delivery began that is literally the pending one. Line ends are the only normalisation; no white space is squeezed (the agents’ own edits are accounted for: trailing white space dropped, Claude Code stores a tab as four spaces, the wrapper’s padding). FIX4 pins one session and file identity to the current attempt, selected by its own hook/statusLine/notify; no worktree/cwd fallback or replacement after loss/rotation. Enqueue alone confirms the queue, retains pending through the end of the turn and timeout, and never means delivered.
  - **FIX4 composer boundaries**: Claude upper/lower borders or the recorded Codex model/hints footer delimit the whole field. Footer-like text inside is content, including `? for shortcuts` and `esc to interrupt`. Unknown/truncated structure refuses Enter; preview and confirmation use that same complete area.
  - **The screen confirms nothing for a working agent** (P15-FIX3): the queue sign of Claude Code (dim “Press up to edit queued messages”, “ctrl+x ctrl+s to send now”; only when it was not on the screen before our own Enter) and the echo of Codex’s steered message (the whole message, read back exactly) only classify `w kolejce agenta – niepotwierdzone`; the pending prompt stays and the delivery waits for the hook or the transcript. (Before: the echo compared with white space squeezed, so `"AB CD"` was acknowledged by `"ABCD"`.)
  - **agentctl presses Enter only in the call that pastes** (P15-FIX3): up to three times, each after a capture whose whole input-field area (empty lines inside included) is byte for byte the image taken after the paste, which must itself be our paste, and with no dialog on that capture. `watch` no longer presses Enter every 8 s (removed: the signature was space-insensitive, stopped at the first empty line and the dialog was not looked at in the last capture). A difference or an open dialog: no Enter, `nie dostarczono – tekst w polu wpisywania`, needs-attention at the next tick.
  - `agentctl send --enter-only TASK` and MCP `send` with `enter_only: true` (permission `send_enter`) show the exact text of the field, the screen state and a token for those bytes (`--confirm TOKEN` / `confirm: true` + `token`); the confirm captures again and presses Enter only if the field is byte for byte the previewed text and the image recorded after our paste, and no dialog is open. A refusal and a failed key (tmux `send-keys` error) are errors with the reason; a failed key is audited `failed` and never announced as sent.
  - CRLF in a prompt is pasted as LF (tmux turns each CR into an Enter).
  - The hook gets a collapsed paste wrapped in `<pasted_content id="…">`, which never matched the pending prompt, so a message that had arrived stayed `confirming` until `needs-attention` (P15b).
  - Claude Code’s spinner frame `✳` is a working frame, but only as a spinner line right above the input box (not in the transcript, not in a quoted report): without the footer `esc to interrupt` it read as idle in the middle of a turn. A screen that looked idle for a moment before the paste no longer leaves the paste in the field without Enter (P15).
  - With an open Codex question nothing is pasted; `send` names the question and keeps the message in the FIFO.
- P19-FIX2: share one bounded measurement scheduler across disk/capacity/previews/GC (disk.workers, default 2), deduplicate paths across inventory changes, keep independent path timestamps and invalidate replaced/removed roots. Background workers no longer keep an idle parent alive and are cancelled on MCP shutdown; foreground CLI measurements remain referenced, crashes have a bounded foreground fallback and timed-out workers release their slot. GC rechecks cached ages before deletion.

- P19-FIX2: keep the author relationship of registered MCP batches: reviewers wait for the author record, validate its effective order, and fail retryably when the author start fails; no-agent batches retain their admitted author order and durable preparation completion without creating task records. Refuse mixed new batches instead of silently omitting fresh tasks; emit setup start/result events per repository command, with exit codes on results.

- P19: the MCP server is no longer held by a task start. Cause: the disk facts (`status`, `capacity`, the previews of `new` and `queue`) added up the size of every worktree, `node_modules` included, with a synchronous walk, cached under a key made of the list of worktrees - each new task or worktree started a walk of all of them on the event loop of the server, so `status` from any chat waited for it (a dev server with a few small worktrees did not notice); queries to tmux and git were synchronous child processes as well. Now the walks are asynchronous and bounded, `collectDisk` answers within about a second with the last reading (`measuring`) while one shared background measurement runs, a worktree measured recently keeps its size when another appears, `RealRunner` runs every command except an interactive one without blocking the loop, and `git worktree remove` of `close`/`gc` has the `git.timeout_s` allowance.
- P19: MCP `new` with `confirm: true` for a repository with setup (`.agentctl.yaml`) registers the start and returns at once (the `MCP new` journal line is written then); the watcher does the checkout, the setup and the window by the queue path, so the setup survives a restart of the MCP server or of the app. `status` and `queue_list` show `uruchamiane – setup w toku (repo 1/2 …)`; `events_since` has `SETUP` and `BŁĄD SETUPU` (repository, command, exit code, log path) next to `START`; a failed setup leaves the task failed with its reason and its worktrees, `queue_retry` starts it again. A repeated `new` for a task being started returns its state and starts nothing twice. Without a running watcher the confirm is refused before anything is created (the preview warns); `agentctl new` in a terminal is unchanged. Contract change: such a `new` no longer answers "Started: …" but "Registered: …" (see docs/mcp.md, "A start with setup").

## [0.18.0] - 2026-11-05

### Added
- Provider registry and adapters for Claude Code, Codex and opt-in Kimi Code CLI 2.5.0. Default active providers remain Claude and Codex; both stay required.
- Kimi interactive launch/resume, dynamic TOML model/effort catalog and read-only permission diagnostics, screen fixtures, passive protocol-1.5 wire and usage.record token accounting. Unknown protocols use screen fallback; unverified session paths/interactions and missing screen states remain documented hypotheses.
- Optional rate-limited Kimi `/usage` probe in a neutral manually trusted session; no task-window probe, credentials, OAuth or provider API calls. Three-provider capacity, limits, reservations, usage, board, alerts, queue holds and MCP schemas.
- `review.prefer` for active installed mappable reviewers; explicit move target with slot/percentage information when three providers are active.

### Safety and compatibility
- Safety rules apply per target provider, including after move/translation. Claude/Codex retain 0.17.4 results. Kimi rejects auto-accept/non-interactive prompt flags, trust bypass env and unsafe permission modes, disables updates per process and defaults telemetry off.
- Manager and Remote Control remain Claude-only. Kimi config is never written, and trust/login/update dialogs are never answered. Kimi task data still goes to Moonshot AI; Kimi permissions provide no sandbox.

## [0.17.4] - 2026-11-04

- P12: the board's `k` choice lists the `board.cohorts_recent` (10) most recently active cohorts plus those with work, folds older quiet ones into `starsze…` and scrolls with ↑↓/PgUp/PgDn; `agentctl cohort archive <name>… | --older-than <age>` (preview, `--yes`) and MCP `cohort_archive` (preview + confirm, add it to `mcp.allow`) hide finished cohorts from the choice and the default `cohort list` (`--all`); tasks, reports and history stay, a new task in the cohort brings it back.
- P14: setup runs per repository of a multi-repo spec (`repos[].setup` or the repository's own `.agentctl.yaml`), each in its own worktree; the preview lists it per repository; the chat still cannot send `setup`.
- Fix 1 after UAT: B1 automatic reviews run in their own detached worktree (never the author's checkout), with their own report path, and start only when the author's turn is over (queue shows "czeka na autora"); a newer author commit re-pins the pending review, an entry queued by the earlier build is converted, and a residual "unsafe start residue" on a review retries. B2 `agentctl-outputs` is validated per section and entry (`outputs_partial`; one bad entry no longer voids the block) and `checks` accept text, one-key maps and `{name, result, note?}`, normalized. P13 queue previews keep an argument-only identity (regression tests). U-a/b clearer link-target warnings with resolved paths; U-c no "missing block" warning for tasks from before the outputs protocol; U-d no `gc_suggest` wave for cohorts closed before the upgrade; U-e no false "window reset" from a jittering boundary; U-f `send` says "wklejono" once.

- Kimi audit K1/S3/N3: atomic state snapshots (same-directory temporary file, fsync, rename), a shared per-task lock for all TASK.md writes/appends and prompt delivery, grouped report metadata updates, preserved old state on ENOSPC/interruption and durable needs-attention diagnostics with emergency disk space.
- Kimi audit K2/W2: restrict MCP report sources/spec paths to task worktrees and cache; reject symlinks and boundary escapes. CLI warns for outside spec paths and permits an explicit outside regular report source only with --force. Report reads validate paths and opened inode before/after reading, including pull_ready and mirrors.
- Kimi audit W4: one global start admission lock with durable slot reservations for new, queued/retried starts, resume and move. Shared admission with report-ready follow-ups; preserve repository checkout concurrency and recover dead reservation owners. Independent watchers claim queue entries once.

- Production P1: confirm idle after `watch.idle_confirm_ticks` consecutive reads (default 2). Recognize running tools and Claude spinner variants; Stop cannot announce waiting while work is visible.
- Production P2/P3: preview all missing link targets, reject confirmation before writes, check project links in doctor, and protect GC worktrees referenced by known project/active-task links (`--force-links` is CLI-only). Preview tokens hash canonical arguments, survive reads and unrelated starts, and expose `preview.ttl_s` (600 s), expiry and precise rejection causes. Destructive target expansion still refuses.
- Production P5: one report readiness rule across doctor, status, list/get_report and pull_ready, including missing canonical files with historical copy metadata.
- Production P8/P9: `gc --preview`/`--dry-run` alias the default preview; `--apply` executes. Aggregate-first GC summaries include bytes/counts by category, reason and cohort, newer skips grouped by task, with opt-in paginated details (`--verbose` / `detail: true`).
- Production P10/P11: idle report-ready windows release provider slots by default (`limits.count_report_ready: false`); capacity/limits separate working and awaiting collection. Follow-ups count again and refuse with a warning at a full limit. Stale readings explain elapsed hours and local read time.

- Board: the header names the version (`agentctl 0.17.2 board · …`, the one `agentctl version` prints) and the board titles its terminal window `agentctl <version> · board` (OSC 2; the previous title is restored on exit where the terminal supports the xterm title stack). In tmux the outer terminal's title is set through the session options `set-titles` and `set-titles-string` of the agentctl session only. `board.window_title: false` turns all of it off.
- Docs: the README leads with the dispatcher workflow, a board screenshot generated from a demo session (`npm run docs:screenshot`), the key benefits and the automatic flow with real `events_since` / `pull_ready` output from that demo.

- NC workflow: version 1 report outputs with git validation, verdict-gated dependencies, automatic cross-provider reviews and repeat delta reviews, task-referenced base commits, cohort output aggregation and once-per-report decision/action events. Invalid/missing outputs warn without changing report readiness.
- Recover limited windows on the same model/provider using persisted overload guards and retry bounds; one provider notice per episode. Closed cohorts emit protected gc_suggest plans, without deleting anything. Batch human marks share exact previews across CLI, board and MCP.
- Independent MCP preview tokens, concrete scopes and preflight failures; scoped GC hides foreign paths and confirmed GC returns results only. Include checkout/setup in task duration; stale plan notices stay once per reading. Consistent MCP report values; grouped MCP write notices by default; F12 works across concurrent sessions.
- REV3 F1/F2: follow-ups paste during work for Claude/Codex, idle-only adapters retain durable FIFO messages visible in status/peek, and idle/late Stop alone cannot acknowledge a stuck draft. Submission/echo/working evidence resolves delivery; timeouts become needs-attention.

## [0.17.3] - 2026-11-04

- FIX2 P: recognize Claude Code 2.1.x spinner progress and submitted transcript echoes. Confirm delivery from current-generation Claude UserPromptSubmit/Stop/Notification or Codex notify before screen heuristics. New/queue/send return success with an uncertainty warning; watch resolves within delivery_confirm_s (60 s) and notifies once on timeout. Later work, turn completion or a completed canonical report clears needs-attention and unblocks report consumers. Adapter delivery/working patterns are configurable.
- Post-live fixes A–O: acknowledge initial prompt delivery for Codex and Claude, retry a swallowed Enter at most twice without repasting, and defer uncertain delivery to watch before needs-attention. Trust-delayed prompts are sent once by new/watch with a durable task marker.
- Every dispatched/resumed report protocol names the absolute canonical report path and filename. Explicit report_from confirms provenance without a review warning; overwrites require force.
- Small pull_ready summaries are truthful about truncation, extract backticked SHAs and avoid duplicated headings. Full reports paginate through response_page and are marked pulled only after contiguous complete delivery.
- Dev MCP identity no longer asks users to restart Claude because stable has another version; doctor reports dev PATH differences as information. Ignore plain shell windows when detecting orphans, and avoid stale-plan events before the first reading.
- Cohort close previews use the execution plan; report_from previews show source/overwrite facts; archive honors an explicit cohort. Bootstrap cohort grace from the latest stored task change.
- Behavior change: report candidates are journal/status/board flags without local or ntfy notifications, keeping a candidate from competing with an agent question. 0173-11 is a determinism fix to a test, not a regression that fails reliably on 0.17.2. Remove dead syncReport pane/message options.

- Bound all MCP responses to 8 KiB by default with session-local response fragments; write previews show affected tasks only, global queue operations show counts and five queued tasks.
- Report discovery accepts only current-attempt configured alternatives bearing the task ID; copying always requires explicit report_from/--from. Candidate flags preserve task states and questions. Status/doctor flag historical report_source copies for review.
- Delay cohort completion until 300 seconds after its last membership/state change (cohort.done_grace_s).
- Correct paused queue previews and absolute get_report byte offsets, including EOF and sections.
- Summarize disk inventory by total, count and five largest worktrees; detailed paths require pagination.
- Resolve project guide/doctor context explicitly over MCP; diagnose missing overlays. Keep new/queue project configuration independent of server cwd.
- Use stable Node paths in task hooks, notify and usage tap; doctor warns about active legacy task paths.
- Restart watch and board by tmux role after updates; make the immediate terminal-size regression independent of wall time.

## [0.17.2] - 2026-11-03

- Board: compact provider/model/version/effort labels (e.g. cx S 6.1 XH), observed/configured alias version fallbacks, full names in preview/help, wider lists at 140+ columns, and board.list_width / board.model_versions configuration. Queue rows share the same formatter; selection/state colors and NO_COLOR stay unchanged.

- Second review: overload budgets survive brief work/waiting and reset only after 600 s continuous work (overload.reset_after_s) or completion; deadlines stay anchored and attention is announced once. Claude detection requires a prefixed error directly under its CLI block.
- Independent event cursors for concurrent same-name MCP sessions, with a persisted client high-water mark for successors; explicit client opts into sharing. Preserve ordinary nonsecret env facts during redaction. Fix peek losing collapsed questions behind wrapped numeric attempt IDs in scrollback. TUI fixture whitespace has an explicit scoped Git attribute.

Economy and reliability.

- Cross-review safety fixes: adapter-specific final error banners, guarded retries before Enter, recovery-reset persistent episodes and give_up_after; complete attempt-bound reports require report-end or an ended/settled write. Timed-out checkout reuse now checks git status, locks, HEAD/branch and running work.
- MCP behavior correction: summary receipt no longer marks full reports pulled. Explicit ack, complete full-mode delivery or contiguous get_report EOF is separate from user mark. Stable client cursors, bounded event fragments/pages, stable report selections, fence-aware report pages and secret redaction in queue_show.


- Behavior change: MCP events_since, status, queue_list, cohort_show, limits and capacity default to concise text only; `format: json` / `detail: true` returns full data. pull_ready defaults to bounded summaries, with explicit full mode and pagination. get_report supports Markdown sections and line pagination.
- Per-client MCP cursors with conservative legacy replay; manager begins with events_since, reads report summaries and uses provider percentages/reset/stats for allocation.
- Strict report alternatives and visible report-candidate state; canonical report wins, explicit report_from confirms. Candidates never release dependencies or complete cohorts.
- Separate overloaded state, persisted bounded idle-only retries; bounded transient queue-start retries and queue show diagnostics. Background monitor/shell wording and unsent drafts are recognized.
- Task-local worktree placeholders with explicit fallback in links/env. History requested/resolved/observed and CLI version, self_verdict separate from mark; reasoning output tokens remain a subset of output.
- EN/PL documentation and isolated regression/live/package validation.

## [0.17.1] - 2026-11-03

- Add MCP parity for queue retry/up/pause/resume, unblock, cohort membership/notes, hide/unhide/archive/adopt/report-from, reservation release, manager control, notification tests and GC; add doctor, config, equivalents, manager/away status and local inspection tools.
- Generate CLI → MCP inventory (including options and explicit terminal/installation/internal-hook exceptions) with a guard test. Descriptions name the CLI equivalent.
- Keep existing mcp.allow permissions unchanged. New explicit groups are queue:*, cohort and manager:*. close, interrupt and queue_rm now require two steps. Enforce session-bound previews for starts/removals, reject changed scopes, audit and journal writes and announce them on the desktop.
- Expose device-deduplicated disk facts through capacity/status/doctor/board, five-minute size caching, configurable 50/20 GiB thresholds, transition events/notifications and critical-space start warnings. Unknown values stay n/d.
- Run checkout and setup asynchronously across repositories; timeouts terminate their own child process groups.
- Use git.timeout_s (default 600 s) for worktree checkout and setup. Serialize worktree creation by Git common directory, recover dead lock owners, preserve uncertain partial checkouts with actionable residue details, and validate residue before queue retry.
- MCP status JSON now has {disk, tasks}; gc_preview remains read-only, while the separately permitted gc applies the protected CLI plan (branches opt-in, never force).

### Documentation
- Repair flow diagrams, validate Mermaid in CI and reorganize both READMEs.
- Lead both READMEs with the parallel Claude Code and Codex workflow and its benefits.
- Highlight the selected board row in bold blue, with a configurable color and `NO_COLOR` support.

Versions 0.1.0 to 0.7.0 correspond to pull requests #1 to #7; their dates are the merge dates. The version numbers were assigned afterwards, when this changelog was written.

## [0.17.0] - 2026-11-03

### Added
- Capacity across CLI (--clip/--json), MCP and board C: source age, plan windows/reset, bounded sample history, pace/projection, explicitly labeled token estimates, slots, queue, equivalents and seven-day model/effort stats.
- Capacity snapshots in new/queue; configurable thresholds, stale events with active tasks and reset events in events_since.
- Project-independent dispatcher manuals EN/PL shared by guide CLI/MCP and manager, project guide overlays, missing-overlay doctor warnings and packaged guide smoke coverage.
- CLI version alias and service restarts by stable tmux role.

### Fixed
- Serialize event/watch notification ownership and ntfy retry queue mutations across processes.
- Prefer stable Homebrew Node paths in MCP entries; doctor gives complete repair commands.
- MCP install dry-run reads current registration and reports no write accurately.
- Watch panes survive early exit and doctor reports missing/dead watcher; up --no-attach is documented.
- Clone updater keeps detached checkout and finds renamed watcher by role, with worktree regression coverage.

### Before release
- Configure npm trusted publisher for Setech-pl/agentctl, workflow publish.yml; explicitly allow direct npm publish. First successful OIDC publish must occur within two days of configuration.
- If the package does not yet exist, manually bootstrap 0.16.0 or 0.17.0 with 2FA outside this task, then configure OIDC. A manually published 0.17.0 is skipped by publish.yml; validate OIDC with the next unpublished version. See the release report for the full procedure.

## [0.16.0] - 2026-11-02

### Added
- Public npm distribution as `@setech-pl/agentctl`, with package metadata, a file whitelist and build/test/typecheck lifecycle gates.
- GitHub CI on Node 22.14 and latest Node; release publishing through npm OIDC with provenance, skipping versions already in the registry.
- npm installation, platform support and first-publication instructions, including the command-name conflict with `@orgloop/agentctl`.
- Doctor reports the installation source and warns when another `agentctl` shadows this package in PATH.
- Tarball runtime smoke checks through the isolated live harness; task-specific live and unit cache overrides.

### Changed
- `agentctl-update` updates npm global installations through npm and rejects clone-only options in that mode.
- MCP registration uses the installed npm executable for npm installations.
- Minimum Node is 22.14.0.

### Fixed
- Avoid updater SIGPIPE under `pipefail` when checking for the watch window.

## [0.15.0] - 2026-11-02

- Explain collapsed Codex questions with their count and the shortcut captured from the screen; retain needs-input while work continues. Peek and board preview preserve the explanation; local notifications include question text.
- Keep question content local by default: `notify.ntfy.include_question: false` sends only opening instructions and manager/Remote Control hints to ntfy. Explicit `true` enables clipped question text. Live config reload also redacts queued question retries; local notifications, board, peek and status/MCP retain their content.
- Compile a distributable JavaScript package into dist; update runtime self commands, package version lookup, MCP process detection and the updater build step.
- Keep phone and manager live suites separate; add collapsed-question live checks through the isolated harness.

## [Unreleased]

- Show machine load/free memory in capacity and status detail; record configurable load threshold crossings.

- Claude `/usage` probe is opt-in (`capacity.claude_usage_probe: true`); it reads plan windows in an isolated neutral session and never starts automatically by default.
- `dataset export` streams a read-only benchmark dataset as JSONL or CSV, with attempt identities, provenance and explicit redacted prompt/report content opt-ins.
- P29: live harnesses and package smoke checks require an explicit absolute `AGENTCTL_LIVE_CACHE` task root; missing roots, shared historical sandboxes and escaping paths are refused before writes.
- P30: preserve rejected config reload state across reads and clear the receipt only after a corrected configuration is accepted; live retry checks synchronize on the persisted rejection/recovery state.

Nothing yet.

## [0.14.0] - 2026-11-02

Pull request: remote control from your phone (`agentctl manager`). The date is the day it was prepared; set it to the merge date.

### Added
- **`agentctl manager [--name] [--project] [--model sonnet] [--effort medium] [--url] [--dry-run]`** and **`agentctl manager stop`**: a Claude Code session in the window `manager` of the agentctl session, started as `claude --model … --effort … --mcp-config <file> --remote-control <name> --settings <file> --append-system-prompt-file <file>` (an interactive session, not the server mode `claude remote-control`, which refuses `--settings` and cannot carry the role), so the Claude app on a phone (Code) can continue it. The three files are written at every start into `<config dir>/manager/`: `role.md` (a dispatcher: `events_since` and `status` first, changes only with your clear yes, summaries of at most 6 lines, no merge, push or tag; the text of `manager.guide` is added), `settings.json` (the read tools of the MCP server need no tap; the write tools make Claude Code ask) and `mcp.json` (the agentctl MCP server under the name `agentctl`). The project is not changed. Never a second copy. The folder trust and the one-time "Enable Remote Control" are left to you: the command says which window to go to. `--url` prints the session address and the QR code when the window shows them (it types nothing).
- **`manager.*`** in the config: `project`, `name` (default `agentctl manager`), `model` (`sonnet`), `effort` (`medium`), `guide` (a local copy of the spec-writing rules, optional; a missing file is a warning), `autostart`. `agentctl up` starts the manager too when `autostart` is true, without waiting, and a manager that cannot start is one line, not the end of `up`.
- **The manager is not a task**: it is no orphan in `status`, not a target of `close`, `cancel`, `send` or `gc`, and no place against a provider limit (`limits.count_external` does not count it either). `MANAGER`, `WATCH` and `BOARD` are refused as task IDs (those windows are agentctl's own; a task of that name would have been invisible in `status`).
- **Board**: the manager in its own line under the header (🧭 name: *połączony*, *czeka na połączenie*, *czeka na potwierdzenie w oknie*, *połączenie nie działa*, *uruchamia się*, or dimmed *nie działa* when `manager.*` is set but no window exists). The arrow up from the first task selects it, **Enter** goes to its window (outside tmux the message gives the `tmux attach` command), the preview shows its screen; a refresh never selects it by itself.
- **`remote_control: true`** in a spec, and **`defaults.remote_control`**: a Claude agent starts with `--remote-control <TASK>` after `agents.claude.flags` and before the event wiring, so `--settings`, `--model` and `--effort` go along. The task shows up in the Claude app under its ID. Kept in `TASK.md` (`remote_control: true`) and used again by `resume`. A Codex task with `remote_control: true` is an error, `defaults.remote_control` leaves Codex tasks alone, a switch to Codex drops it, and `--remote-control`, `--rc` or `remote-control` in `agents.claude.flags` is refused. The "Enable Remote Control" dialog is waited for like the folder trust.
- **Phone**: with the manager window up, `needs-input`, `report-ready` and `cohort-done` end with "Otwórz sesję „agentctl manager” w aplikacji Claude."; a `needs-input` of a task with Remote Control ends with "Odpowiesz w aplikacji Claude: <TASK>". No link, no path.
- **`doctor`**: `claude remote control` (the flags `--remote-control` and `--append-system-prompt-file` in the help; a warning for `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex/Foundry and the two switches that turn feature flags off, the values never printed), `manager` (running and connected, waiting for you, a missing project or guide, `autostart` while it is not running) and `manager mcp` (the `node` and the script of `mcp.json` still exist).
- Live scenarios `scripts/live-manager.ts` through the harness (the fake `claude` lists the Remote Control flags and shows `/rc active` when started with `--remote-control`): 29 checks.
- Documentation: Remote control from your phone in both READMEs, `docs/details.md` and `docs/details.pl.md` (the modes and flags found in the research, the states, what was and was not checked), `docs/configuration.md` (`manager.*`, `remote_control`, `defaults.remote_control`), `docs/mcp.md`; the sequence and architecture diagrams show the phone and the manager.

### Changed
- `buildAgentArgv` and `buildResumeArgv` take the task ID and `remoteControl`; `Context`, the board state (`manager`) and the status code that skips non-task windows know the window `manager`.
- `docs/details.md` and `docs/details.pl.md` have one more section each, kept in step by the test.

### Limitations
- Not tried against a real Claude Code (it would use the plan and register sessions on the account): that `--remote-control` is accepted together with `--settings`, `--mcp-config` and `--append-system-prompt-file`; the exact screen texts (`/rc active`, the failure notices, the "Enable Remote Control" dialog, which agentctl reads from the documentation); how the permission prompts of the MCP tools look on the phone; how the connection behaves after a sleep of the Mac. The Mac must be on and awake, the `claude` process must keep running, and a claude.ai login (Pro, Max, Team, Enterprise) is needed, not an API key.

## [0.13.0] - 2026-11-02

Pull request: phone notifications through ntfy and away mode, `docs/details.pl.md`. The date is the day it was prepared; set it to the merge date.

### Added
- **Phone notifications.** `notify.ntfy` (`server` default `https://ntfy.sh`, `topic`, `token` as a Bearer header, `events` default all ten: `needs-input`, `needs-trust`, `limited`, `blocked`, `report-ready`, `cohort-done`, `queue-failed`, `orphan`, `dead`, `usage-critical`; `priority` per event, `high` for `needs-input`, `limited` and `usage-critical`; `include_verdict` default true; `click_url`; `always`). The request is `POST <server>/<topic>` with `Title`, `Priority`, `Tags`, `Click` and `Authorization`; a title with non-ASCII characters is sent as RFC 2047. The message holds only the task ID, the name of a cohort and the first line of the verdict, with path-like words cut; never a report, a question, a path or a file name. It is sent from the journal write, so the phone gets exactly what the Mac announced (the de-duplication of the Mac applies); the journal entry gets `phone: sent|queued` and `events` marks it with 📱. A failed request is queued in `phone-queue.json` and retried by the watcher three times (30 s, 2 min, 10 min), then dropped with a line in `phone.log`; the watch log warns once an hour; a network error never stops the watcher. `orphan` is a journal kind now, and a `usage` entry carries `level`.
- **Away.** `agentctl away [status|on|off]` (state in `<config dir>/away.json`, `--json` for status); the phone is quiet while away is off unless `notify.ntfy.always: true`; the Mac is not affected. `away.auto_idle: <minutes>` (macOS, `ioreg` `HIDIdleTime`) turns it on when the Mac is idle and off at the first activity; a hand-made `off` is not undone while the Mac stays idle. Off by default.
- **`agentctl ntfy-setup [--server URL] [--regenerate] [--show-qr] [--dry-run]`**: a random topic (`agentctl-` and 24 hex digits) written to `config.yaml` with comments and key order kept (the YAML edit is shared with `limits set` now: `config-edit.ts`), steps for iOS and Android and for a server of your own, the warning that on the public ntfy.sh the topic is the only protection. `--show-qr` uses `qrencode` when installed; no dependency was added. `doctor` warns about a weak topic and a private server without a token, and shows away.
- **`agentctl notify-test [--local|--phone|--all]`**: the channel, the result and the time of each; the phone test ignores away and never prints the whole topic.
- Board: `📱 away` / `📱 always` / dimmed `📱 off` in the header and key **`w`** (after y/N). tmux status line: `📱` in front while away is on. MCP: `status` and `events_since` carry the away state; write tool **`away`** (`on`) behind `mcp.allow`, no confirm step, audited and announced.
- **Report detection.** A report the agent wrote elsewhere than the spec says (`docs/reports/<…>.md` in the worktree, another folder under the cache) is found after every end of a turn (Claude `Stop` with `last_assistant_message`, Codex `notify`) and at every `watch` tick for a `waiting` task: `.md` paths in the last message and in the last 400 lines of the window (`capture-pane -J`; absolute, `~/…`, relative to the worktree, after `pbcopy < `), an existing file written after the start, preferring the task ID or `report`/`raport` in the name, then the one mentioned last. `report:` may be a list of paths and globs (`{task}`/`{TASK}`; the first is the canonical path). A report found elsewhere is copied to the canonical path (never over a file the agent wrote; a copy made earlier is refreshed when the source is newer); `TASK.md` keeps `report_source`, the journal says "raport wykryty w <path>" (new kind `report-detected`), the state turns `report-ready` with the verdict notification. `agentctl report <TASK> [--from <path>] [--force]` shows or sets the source; `status`, the board and the MCP `task_spec` and `list_reports` show it; `pull <TASK>` searches when the report is missing.
- **`docs/details.pl.md`**: the full Polish equivalent of `docs/details.md`; `README.pl.md` links to it. The link test covers both and a test keeps their headings, tables and code blocks in step.
- Live scenarios `scripts/live-phone.ts` through the harness: a mock ntfy server on localhost (one request, headers, no report text, no duplicate from the watcher, none with away off, queue and retry after a dead server) and one request to the public ntfy.sh on a random temporary topic (HTTP 200).
- Documentation: Phone notifications in both READMEs and both details files, `docs/configuration.md` (`notify.ntfy.*`, `away.*`), `docs/mcp.md`; the sequence and architecture diagrams show the phone.

### Changed
- The board key line is `m M move i int c/r pull x close X cancel k cohort h hide l log L G R w u/d/p ?` (it must fit 80 columns).
- `Context` has a `fetch` for the phone (tests give a mock).

### Limitations
- On the public ntfy.sh the name of the topic is the only protection. The `ntfy://` link of `--show-qr` was not tried on a phone. `away.auto_idle` needs macOS (`ioreg`). Texts on the phone are in Polish, like those of the Mac.

## [0.12.0] - 2026-11-02

Pull request: live limits, events for the chat, gc, resume, `agentctl up`, a safe harness for live tests. The date is the day it was prepared; set it to the merge date.

### Added
- **Limits.** `agentctl limits` (limit, used and free per provider; the windows of agentctl, the reserved places and the external sessions; the queue), `limits set claude=3 codex=5 [-y]` (edits `config.yaml` with the YAML document API: comments and the order of the keys stay; `config.yaml.bak`; the result is loaded to check it; `codex=off` removes a limit), `limits reserve claude=1 [--note]` / `limits release` (places for agents started by hand, `<config dir>/reservations.json`), and `limits.count_external: true` (claude/codex terminal sessions outside the agentctl session, found with `ps`, `tmux list-panes` and `lsof`; MCP servers, headless runs, `usage-tap` and agentctl itself are not counted). Reserved and external places count in `new`, `queue`, `queue list`, `resume` and the board.
- **Config reload.** `watch` and the MCP server read `config.yaml` again when its text changes (`fs.watch` and a check at every tick), for every key. A raised limit starts waiting queue tasks at the next tick. A file that does not load changes nothing: the previous settings stay, the watch log warns once, `config-state.json` records it, and `doctor` (warning `config reload`), the MCP `status` / `version` and the CLI error say so. A `notify` change rebuilds the notifier.
- **Events for the chat.** `<config dir>/journal.jsonl` (reports ready with the verdict, starts from the queue, failed starts, questions, folder trust, blocked, cancelled and limited tasks, vanished windows, finished cohorts, plan thresholds, changed limits), `agentctl events [--since last|30m|2h|HH:MM|ISO] [--cohort X] [--keep] [--json] [--clip]` and the MCP read tool **`events_since`** (`since`, `cohort`, `peek`): the events after a time or after the previous call of the client (a marker per client, `cli` and `mcp`; the first call looks back 24 hours) and a line with the state now (active, queued, reports to pull, tasks that wait for you). The tool description tells a chat to call it at the start of every answer about the agents' work.
- **gc.** `agentctl gc [--apply] [--older-than 7d] [--branches] [--cohort X] [-y] [--json]`: a dry run with sizes; worktrees of closed, cancelled and archived tasks without uncommitted changes (`git worktree remove`, never forced), files next to the reports older than the age (the `*.md` stay), the state of closed tasks moved to the archive, and with `--branches` merged branches (`git branch -d`, never `-D`, never `main`/`master`, the current or a remote branch). Uncommitted work, worktrees of others, unmerged branches and too new files are listed as skipped with the reason; a cache folder that belongs to no agentctl task is not touched; history and reports stay. `--apply` lists, asks y/N and reports what was freed. Board key **`G`** (preview), MCP read tool **`gc_preview`** (`older_than`, `merged`, `cohort`). `Runner` gets `remove`.
- **Resume.** `agentctl resume [TASK…] [--all] [-y] [--dry-run]`: for active tasks that have a worktree and no window (after a restart), the window comes back and the agent starts in resume mode with the same model, effort, flags, hooks and usage tap, without the prompt: Claude `--resume <session>` (recorded by the hooks / usage tap) or `--continue`, Codex `resume <session>` or `resume --last` (flags after `resume`, checked against `codex resume --help` of 0.166.0). Tasks with a report are skipped unless `--all`; provider limits are respected. `watch` sends one notification at its start, "N zadań do wznowienia". Board: section **"Do wznowienia"** and key **`R`** (after y/N). MCP write tool **`resume`** (`tasks`, `all`, `confirm`).
- **`agentctl up`.** The start of the day: `watch --tmux` and `board --tmux` (each only when its window is missing), the resume hint, then attach / switch-client to the board; without a terminal (or with `--no-attach`) it prints the command.
- MCP: read tools `events_since`, `limits`, `gc_preview`; write tools `set_limits`, `reserve` and `resume`, behind `mcp.allow`, with a summary first and `confirm: true`, audited and announced.
- **Live-test harness** `scripts/live-harness.ts`: an isolated tmux server (`TMUX` unset, own `TMUX_TMPDIR`, `tmux.conf` with `default-command` and an explicit PATH), own `AGENTCTL_HOME`, `CODEX_HOME` (no `notify` chain), `CLAUDE_CONFIG_DIR` and `HOME`, a PATH of fake `claude`, `codex`, `pbcopy`, `pbpaste`, `terminal-notifier`, `osascript` and no directory with a real `claude` or `codex`; it refuses to start when `command -v` or the tmux socket point at the real thing. `scripts/live-scenarios.ts` runs the live checks of this release through it. Documented in CONTRIBUTING.md; the refusals are tested.
- Documentation: the Limits, Events for the chat, Cleaning up and Resuming sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the architecture and flow diagrams show the reload, the journal, `ps`, resume and gc.

### Changed
- The board key **`G`** (open all cohort groups) is now **`E`**; **`G`** is the clean-up preview. The key line is `m msg M move i int c/r pull x close X cancel k cohort h hide l log L G R u/d/p ?`.
- The only branch deletion agentctl does is `gc --branches` with `git branch -d`.
- `Context.config` can be replaced while a process runs (`Context.setConfig`).
- Board tests of the log and result keys are in one place (the copy in `history.test.ts` is merged into `usage-board.test.ts`).

### Limitations
- Events are recorded while `agentctl watch` runs (and by the commands that write them themselves). External sessions are found by process name: a renamed wrapper is not seen. `resume` starts the agent but does not check that it came up; a folder-trust dialog, if one shows, is for a human.

## [0.11.0] - 2026-11-02

Pull request: token usage, plan limits, task history and stats. The date is the day it was prepared; set it to the merge date.

### Added
- **Usage.** `agentctl usage [--cohort X] [--since 7d] [--json] [--clip]`: per provider the 5 hour and weekly window (percentage used and reset time, or n/d) and the tokens today and in the period; the active tasks with their tokens; the cohorts; the models. Tokens are read from the agents' own logs, incrementally (a cache of file offsets in `<config dir>/usage-cache.json`): Claude Code transcripts (`~/.claude/projects/…`, subagents included) and Codex session logs (`~/.codex/sessions/…`). A session belongs to the task whose worktree it ran in, between the task's start and its end (also across `move`); the sessions named by the agent's events (`<state_dir>/<task>/sessions.json`) count too. The number shown is input + output + cache writes; cache reads are kept apart.
- **Plan limits.** Codex: from the `rate_limits` of the newest session log. Claude Code: only a statusLine command gets them, so `new` sets the `statusLine` of a Claude window to the new command **`agentctl usage-tap`**, which stores the windows, remembers the session and runs your own statusLine afterwards with the same input (your status line does not change; a statusLine that is not a `command` is left alone). What is not known is **n/d** (no reading yet, no subscription, a window reset since the reading, no log): nothing is guessed.
- `status`: a `TOKENS` column (`1.2M`) when a session log is found (n/d for a task without one), `tokens` in `--json`, a column in `--clip`.
- Board: a usage panel under the title (bar, percentage and reset per provider; green, yellow, red by the thresholds), a `TOKENS` column, **`l`** the log, **`o`** / **`p`** / **`f`** mark the selected finished task. The tmux status line adds `C 62% · X 18%` (`usage.status_line`).
- **Warnings.** `watch` notifies once when a plan window crosses `usage.warn` (80) and once when it crosses `usage.critical` (95), per provider and window period (`<config dir>/usage-alerts.json`). The summary of `new --clip` and `queue` shows the plan of the task's provider and the hint "claude blisko limitu (83%), codex ma zapas (15%): --agent codex" (nothing is switched; a pinned task stays). **`usage.queue_hold`** (off by default) keeps the queue from starting tasks of a provider above that percentage; `queue list`, `status` and the board say why.
- **History.** `<config dir>/history.jsonl` gets a record when a report is ready, and when a task is closed, cancelled, moved or marked: task, cohort, project, requested and effective agent/model/effort, start, report, close or cancel with the reason, duration, tokens (null when unknown), commits and files, the first line of the verdict, the move, the result. **`agentctl mark <TASK> ok|partial|fail [--note]`**, **`agentctl log [--since] [--cohort] [--json] [--clip]`**, **`agentctl stats [--since 30d] [--cohort] [--json] [--clip]`** (per agent/model/effort: tasks, median time and tokens, shares of ok/partial/fail among the marked, unmarked, cancelled, moved after a limit).
- MCP: read tools **`usage`**, **`log`**, **`stats`** (`cohort`, `since`), write tool **`mark`** behind `mcp.allow` (audited, no confirm step), a one-line plan summary in `status`.
- Config: the `usage` section (`warn`, `critical`, `queue_hold`, `status_line`, `claude_tap`, `claude_dir`, `codex_dir`).
- Documentation: the Usage and limits and History and stats sections of both READMEs and `docs/details.md` (formats that were checked, what is n/d), `docs/configuration.md`, `docs/mcp.md`; the architecture diagram shows the readers of the agents' logs and the usage tap.

### Changed
- The board key line is `m msg M move i int c/r pull x close X cancel k cohort h hide l log o/f u/d/p ?` (the arrows and Enter are in the help). The board list has a `TOKENS` column from 69 columns on.
- Tests read the agents' logs from the scratch directory (`usage.claude_dir`, `usage.codex_dir`), never from the real `~/.claude` and `~/.codex`.

### Limitations
- Tokens are those of the sessions agentctl can bind to a task; sessions you start by hand and Claude's limits outside task windows are not seen. A Codex session resumed or forked from another counts the inherited history again. The formats are the agents' own and undocumented: a change in them shows as n/d.

## [0.10.0] - 2026-11-02

Pull request: task cancellation and cohorts. The date is the day it was prepared; set it to the merge date.

### Added
- **Cancelling.** `agentctl cancel <TASK…> [--reason "…"] [--rm-worktree] [-y] [--dry-run]`: shows the list and asks y/N. A task at work gets the agent's interrupt key, then `cancel.grace` seconds (default 5, one wait per command), then its window is closed; a finished task without a window is only marked; a task in the queue is taken out of it (`queue rm` is its alias, without a reason). The task is **`cancelled`** (new state ✕, not `closed`): `cancelled`, `cancelled_at`, `cancel_reason` and `cancel_source` (`cli`, `board`, `mcp`) in `TASK.md`. The worktree and the branch stay; `--rm-worktree` runs `git worktree remove` (never `--force`, never a branch). A task from `move` is cancelled together with its other half, after one question.
- A cancelled task leaves `status` and the board (`status --all` and the board key `a`: section **Cancelled**; `cancelled`, `cancelledAt`, `cancelReason` in `status --json`), does not count against the window limits, is not taken by `pull --ready`, gives no "window vanished" notification and no collision. Its report, if one was written, stays (`pull <TASK>`).
- **Blocked tasks.** A queued task whose `after` names a cancelled task is blocked (⛓): `status`, `queue list` (`blocked` in `--json`) and the board show `⛓ zablokowane – NC-42 anulowane`; it never starts (a task that waits for a blocked one is blocked too). `watch` sends one notification per cancelled author, "NC-43 zablokowane – NC-42 anulowane". `queue` and `new` refuse an `after` that names a cancelled task. **`agentctl unblock <TASK> [--drop-after <TASK>]`** removes the dependency; `agentctl cancel` is the other way out.
- **Cohorts.** Spec field `cohort: <name>` and `--cohort <name>` on `new` and `queue` (the flag wins). No name, no cohort: there is no default and none is made up. Names: letters, digits, `-`, `_`, `.`, compared without regard to case, shown as first written; the first task makes the cohort (`<config dir>/cohorts/<name>.json`: created, optional note). `cohort` of a task is in its `TASK.md` and queue entry.
- `agentctl cohort list [--json]` (tasks per cohort: active, queued, reports, closed, cancelled; since when), `cohort show <name> [--json]`, `cohort add <name> <TASK…>`, `cohort remove <TASK…>`, `cohort note <name> "…"`.
- `--cohort <name>` filter on `status` (with `--json` and `--clip`), `pull --ready`, `close`, `cancel` and `queue list`; `close --cohort` and `cancel --cohort` list the tasks and ask y/N. `status` has a `COHORT` column once any task has a cohort.
- `watch`: "kohorta <nazwa>: wszystkie raporty gotowe (N)" when every task of a cohort that was not cancelled (queued ones included) has a report; once per cohort, again only when a task joins.
- Board: **`X`** cancels (optional reason, then y/N; also on queued tasks and in the menu of a finished task), grouping by cohort with foldable headers that carry the counts of states (`g` folds, `G` opens all, "bez kohorty" last), **`k`** picks the cohort to show, **Cancelled (N)** section under `a`, ⛓ in the Queue section.
- MCP: write tool **`cancel`** (`task` or `cohort`, `reason`, `remove_worktree` behind `mcp.allow_rm_worktree`, `confirm: true` after a description; audited and announced with the reason), read tools `cohort_list`, `cohort_show` and `version`, `cohort` argument of `status` and `pull_ready`; `cohort`, `cancelled`, `cancelReason` in the status rows. `mcp.allow` accepts `cancel`.
- Config: `cancel.grace`; `cancelled` among the keys of `watch.window_icons` (default ✕).
- Documentation: the Cancelling tasks and Cohorts sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the flow, architecture and state diagrams show cancelling, blocked tasks and cohorts.
- `agentctl mcp check` and the MCP `version` tool: see Fixed.

### Changed
- On the board **`k` no longer moves the selection up**: it is the cohort filter. The arrow moves up, `j` still moves down. The key line is `↑↓ ⏎ m msg M move i int c/r pull x close X cancel k cohort h hide z/a u/d/p ?`.
- `queue rm` makes the task `cancelled` (it used to leave nothing behind) and says which waiting tasks became blocked.

### Fixed
- **One unknown name in `mcp.allow` switched the whole MCP server off** (for example `queue` read by an older server): nothing worked, not even `status`. Unknown names, unknown keys and wrong types in the `mcp` section are now warnings: the entry is ignored, the rest works, and `status`, `version` and `agentctl doctor` show the warning. Only a config that cannot be read at all stops the server.
- **The Claude app kept the old MCP server process after `agentctl-update`.** The server now tells its version and script (MCP `version` and a line in `status`, with a hint when the stable copy on disk is newer). `agentctl doctor` and, at its end, `agentctl-update` run `agentctl mcp check`: it finds `agentctl … mcp` processes that started before the stable copy was last updated and warns "serwer MCP w aplikacji działa na starej wersji – zamknij aplikację Claude (⌘Q) i otwórz ponownie". Nothing is stopped for you; `docs/mcp.md` describes the update as quitting the app.

### Known limits
- `cancel` does not undo what the agent did; an unclean worktree is refused by `--rm-worktree`, as by `close`.
- The staleness check compares process start times with the update time of the stable copy (`package.json`, `node_modules`); a server of another checkout is not judged.
- Cohort and cancellation data are kept per task for a later usage and stats milestone; nothing counts them yet.

## [0.9.0] - 2026-11-02

Pull request: queue, dependencies, collision warnings. The date is the day it was prepared; set it to the merge date.

### Added
- **Queue.** `agentctl queue [file|-|--clip] [-y] [--agent]`: the same checks as `new` (review_of, pin, `--agent` mapping, Codex efforts, duplicates, repositories) except the provider limit, a summary, y/N, then one JSON entry per task in `<config dir>/queue/`. `queue list [--json]`, `queue rm`, `queue up`, `queue pause`, `queue resume`, `queue retry`.
- `agentctl watch` starts the next queued task (high priority first, then first come, first served) when its provider has a free window, by the path of `new`, in the background: a start that waits for the folder-trust dialog (`needs-trust` is notified) does not stop the rest of the queue. Notification "Uruchomiono TASK z kolejki". The queue never switches provider by itself.
- A start that fails puts the task at the end of the line as `failed`, with a log (`queue/<n>-<TASK>.log`) and a notification; it is not retried in a loop.
- `new` with a full provider limit asks "add to the queue? [y/N]" (without a terminal the error names `agentctl queue`).
- **Dependencies.** Spec field `after: <TASK or list>`: a queued task starts when each named task has a report (`report-ready`, or closed with a report). `status`, `queue list` and the board say "czeka na TASK". An unknown task, a self reference and a circle are errors at adding; `new` refuses a task whose `after` is not met. A review (`review_of`) without `after` gets a hint in the summary.
- **Collisions.** `watch` compares, every `collisions.interval` (300 s), the files changed by each active task (commits over the base plus uncommitted) per source repository: `COLLIDE` column in `status` (`⚠ LANDING-QS-1: 2`, also `collide` in `--json`), `⚠` on the board, one notification per new pair (remembered in `collisions.json`). `agentctl overlap [TASK] [--json]` lists the shared files.
- Spec fields `priority: high|normal` and `touches: [globs]`; `queue` and `new` warn (and ask y/N) when an active task already changes files matching `touches`.
- Board: **Queue (N)** section under the active tasks (`u` front, `d` remove after a question, `p` pause or resume), the preview of a queued task, `⚠` marker and the colliding tasks in the preview title. The tmux status line counts the queue (`2⚙ 1⏳ 3⧗`).
- MCP: read tools `queue_list` and `overlap`; write tools `queue` (summary first, `confirm: true` to queue; `setup` refused) and `queue_rm`, both behind `mcp.allow`, audited and announced; `status` carries short `Queue` and `Collisions` lines and `collidesWith` per task.
- Config: `queue.enabled`, `queue.parallel_starts`, `collisions.enabled`, `collisions.interval`, `collisions.notify`, `collisions.ignore`. Documentation: the Queue, Dependencies and Collisions sections of both READMEs, `docs/details.md`, `docs/configuration.md`, `docs/mcp.md`; the flow, architecture and state diagrams show the queue.

### Changed
- The board key line is shorter (`c/r pull`, `u/d/p`) to stay within 80 columns.
- `mcp.allow` accepts `queue` and `queue_rm`.

### Known limits
- The queue moves only while `agentctl watch` runs; `watch` reads the config when it starts.
- Collisions compare file names, not hunks.

## [0.8.0] - 2026-11-02

Documentation and help. The date is the day it was prepared; set it to the merge date.

### Added
- `README.md` rewritten as a project home page, with a Polish counterpart `README.pl.md`: problem, key features, quick start, daily loop, spec format, configuration, board, notifications, model equivalents, MCP, comparison with other tools, safety model, limitations and roadmap.
- Mermaid diagrams (end-to-end sequence, architecture, task states) in both READMEs and in `docs/diagrams.md`.
- `docs/commands.md`: every command, subcommand and option, generated from the command definitions by `npm run docs` (`scripts/gen-docs.ts`). A test fails when the file is out of date.
- `docs/configuration.md`: every key of the global config, the project config and the spec, with type, default and meaning. A test fails when a key in the code is not described, and when a built-in screen pattern differs from the one shown.
- `docs/mcp.md`: the MCP tools, the allow-list, `confirm`, the audit log, install, what has been checked and the limits.
- `docs/details.md`: the long-form sections of the old README (events, notifications, limits and move, window icons, navigation, board, folder trust, stable install and others).
- `agentctl <command> --help` ends with examples for every command; the same examples appear in `docs/commands.md`.
- `CONTRIBUTING.md`, with the rule that closes every milestone.
- Test that relative links and anchors in the documents resolve, and that the README and its Polish counterpart link to each other.
- `package.json`: `description`, `keywords`, `homepage`, `bugs`; `docs` and the Polish README in `files`.

### Changed
- MCP: `status`, `task_spec` and `list_reports` return local times (`startedLocal`, `pulledLocal`, `modifiedLocal`) next to the UTC values, as `status --json` does. A chat had shown the UTC time as the start time.
- `agentctl new --help` mentions the setup commands.
- The lists of accepted config and spec keys are exported constants (used by the tests that check the documentation); behaviour is unchanged.

## [0.7.0] - 2026-11-01

Pull request #7: daily-use reliability, finished tasks in the board, local MCP server.

### Added
- `agentctl mcp`: a local MCP server on stdio (official SDK) for the Claude app, Claude Code and VS Code. Read tools `status`, `peek`, `list_reports`, `get_report`, `pull_ready`, `task_spec`; write tools `send`, `new`, `interrupt`, `close`, `move`, off unless listed in `mcp.allow`, audited in `mcp-audit.log`. `agentctl mcp install` and `uninstall` register it in the desktop app (diff, y/N, dated backup, other servers kept) and in Claude Code; `doctor` checks the registration.
- `agentctl hide` and `unhide`; `board.auto_hide_pulled_dead`.
- `agentctl close` marks the task closed (`closed`, `closed_at`): it leaves `status`, the board, `pull --ready`, `watch` and the window limits. `status --all` lists closed and archived tasks. `agentctl archive [--older-than]` moves the state of closed tasks to the archive folder.
- Board: tasks without a window sit in their own **Finished** section; Enter on one opens a menu; closed tasks have their own section (key `a`).
- State `background`: the agent idle at its prompt while its own shells and monitors run. Its end of turn is not announced and `watch` does not call it waiting.
- `notify.backend` (`auto`, `terminal-notifier`, `osascript`): when terminal-notifier cannot show notifications, the same notification goes out through `osascript`, and terminal-notifier is left alone for an hour. `agentctl notify-test` says which channel carried a test message.
- Navigation: `mouse on` in the agentctl tmux session (`board.mouse`) and a key back to the board from any window (`board.return_key`, default F12).

### Changed
- `board --tmux` and `watch --tmux` start their command as the process of the window, with `remain-on-exit failed`, so a failed start stays on the screen; the board waits for a terminal size, draws even with `CI` set, and logs to `board.log`.
- `mcp install --dry-run` says that nothing was written and names the backup a real run would make.
- The Finished and Closed titles of the board use `+` and `-`, so they are not taken for the selection marker.

### Fixed
- No state folder is created for an orphan window just because it was announced.

## [0.6.0] - 2026-11-01

Pull request #6: event notifications, click-to-window, verdict, limits.

### Added
- Events from the agents themselves: Claude Code hooks (`Notification`, `Stop`, `StopFailure`) through `--settings`, Codex through `-c notify=…` (the user's own `notify` command is forwarded). `agentctl event` records them, updates the task state at once and notifies. `notify.events` and `notify.turn_end` switch them off.
- States `limited` (usage limit used up; `agents.<agent>.limit_patterns`) and `superseded`.
- `agentctl move`: hands a task that hit its limit to the other provider in the same worktree.
- Notifications through `terminal-notifier` with click-to-window (`agentctl attach --switch-client`); the "report ready" text quotes the verdict line of the report (`notify.verdict_pattern`); one transition is announced once, whichever of the event and the watcher sees it first.

### Fixed
- Fixes from the live runs, with tests for events, deduplication, click, verdict, limits and move.
- `doctor` warns when terminal-notifier cannot show notifications yet.

## [0.5.0] - 2026-11-01

Pull request #5: board TUI, attach and peek, window icons, progress.

### Added
- `agentctl board`: a full-screen overview of the tasks (Ink) with a live preview of the selected window and keys to message, interrupt, move, pull and close.
- `agentctl attach` and `agentctl peek`; task names are case-insensitive and a unique prefix is enough.
- `PROGRESS` in `status`: commits over the base and changed files per worktree.
- State icons in front of the tmux window names while `watch` runs (`watch.window_icons`); operations find windows by task name or by tmux window ID.
- `agentctl status --tmux-line` and a task count in the status bar of the agentctl session (`watch --tmux`, `watch.status_line`).

### Fixed
- The status bar needed the pane target `=session:`, and its result must be checked.

## [0.4.0] - 2026-11-01

Pull request #4: pilot fixes.

### Added
- `state_dir`: agentctl's own state (`TASK.md`, `setup.log`, markers) moved out of the folder the agents write to, with an automatic migration; a Codex agent had deleted its `TASK.md` while tidying up.
- States `orphan` (a window without a state file) and `needs-input` (the agent asks a question); `agentctl adopt` restores a lost state file.
- `status` shows the start time in local time; `status --json` keeps the UTC `started` and adds `startedLocal`; the last line skips the agent's footer (`footer_patterns`).
- `bin/agentctl-update`: a stable copy of agentctl as a detached worktree (`npm ci`, `npm link`, `doctor`, restart of the watch window).
- `npm run typecheck`.

### Fixed
- tmux targets that start with `=` are quoted (zsh expands `=word` to a program path).

## [0.3.0] - 2026-11-01

Pull request #3: automation.

### Added
- `agentctl new --clip`, `send --clip` (spec or prompt from the clipboard, a summary and a y/N question; `-y` skips it) and `status --clip`.
- `agentctl pull --ready` (all new reports in one text, marked as pulled, `--all` for the others) and `close` for several tasks at once.
- `agentctl watch`: desktop notifications on state transitions (report ready, question, folder trust, waiting too long, died), a log, and `--tmux` to run it in its own window.

## [0.2.0] - 2026-10-31

Pull request #2: trust wait, setup step and literal links.

### Added
- `new` waits for you to answer the folder-trust dialog of a fresh worktree (`trust_timeout`, `--no-wait-trust`) instead of stopping at it. agentctl still never answers it.
- `setup`: shell commands run in the first worktree before the links, with output in `setup.log`.
- Links without a glob are literal paths and create their parent directories.
- `agentctl new --no-agent`: only worktree, setup and links.

## [0.1.0] - 2026-10-31

Pull request #1: iteration 1, core and CLI.

### Added
- Spec files (YAML header and prompt) and layered configuration (global, project, spec) with validation that reports all mistakes at once.
- `agentctl new` (git worktree, symlinks, environment, tmux window, agent, prompt), `send`, `status`, `pull`, `close`, `interrupt`, `doctor`, `spec example`, `--dry-run` through a recording runner.
- Support for Claude Code and Codex, with effort flags and a guard against auto-accept flags.
- Claude and Codex equivalents table, `new --agent`, switching when a provider's window limit is full, `pin`.
- Task states (`working`, `waiting`, `needs-trust`, `report-ready`, `dead`) and folder-trust detection.
- Per-provider window limits, the `review_of` cross-review rule, an optional mirror of the reports.

[Unreleased]: https://github.com/Setech-pl/agentctl/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/Setech-pl/agentctl/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/Setech-pl/agentctl/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/Setech-pl/agentctl/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Setech-pl/agentctl/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Setech-pl/agentctl/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Setech-pl/agentctl/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Setech-pl/agentctl/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Setech-pl/agentctl/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Setech-pl/agentctl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Setech-pl/agentctl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Setech-pl/agentctl/releases/tag/v0.1.0
