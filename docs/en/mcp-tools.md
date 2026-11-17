# MCP tools reference

`agentctl mcp` serves local stdio through the official MCP SDK. Stdout is protocol only; there is no listening port. The CLI and MCP share core operations. Install from the stable copy with `agentctl mcp install --desktop` or `--claude-code`; preview with `--dry-run` first. The desktop installer backs up and preserves other server entries. Restart the desktop app after updates.

## Read, preview, confirm, observe

Reads need no allow entry. Every write is disabled until its exact name or explicit group is in `mcp.allow`. All registered writes receive a preview/confirm wrapper, including follow-ups: show its exact target and arguments to the owner. Keep the same MCP session and use the returned `preview_token` with `confirm: true`. A token-only confirm reuses stored arguments. Default expiry is `preview.ttl_s: 600`. Changed target scope, permissions, session or expired token requires a fresh preview. A known retry token replays its durable receipt rather than duplicating execution.

`new`/`queue` confirms require watch. They persist the spec as `accepted` under a short accept lock and return `Accepted` without re-planning, taking start.lock or creating a worktree. Preview performs cheap syntax/model/duplicate checks only: base resolution, worktree overlap and disk guards are deferred to watch. Watch next validates current facts; valid entries queue/start, invalid ones become failed with a reason/event/notification. `queue_retry` validates again. Accepted is registration, never proof of start, delivery, or completion.

With watch alive these confirmed tools also become durable requests: consult, unblock, queue_up/rm/retry, close, cancel, send (including withdraw/confirmed enter_only), mark, hide/unhide, archive, cohort_add/remove/archive/note. Watch rechecks permission/scope, applies and records `mcp-applied` (“MCP WYKONANE”), or `mcp-failed` (“MCP BŁĄD”). Without watch most of this group executes inline; CONSULT requires watch. `set_limits` and WALL writes remain synchronous. `wall_post`, `wall_reply` and `wall_set_status` validate rights/refs/secrets and append before returning the ID/status, even with watch alive; notifications do not delay confirmation. Follow outcomes with events_since; do not resubmit a new order on a timeout. Retry confirm only with the same token, then read durable state.

`answer` has an additional menu-specific `token` bound to the normalized question and option labels, independent of scrolling; the chosen option must be visible and unchanged. Command approvals still bind the command. `send enter_only` has a separate exact-field token and `send_enter` permission; it submits only the unchanged text left by an earlier send. Neither mechanism grants automatic folder trust.

Writes are audited in `mcp-audit.log` and journaled; inability to record the audit refuses the action. Notifications follow `notify.mcp_writes`. `mcp.allow_rm_worktree` additionally gates explicit worktree removal. No tool merges, pushes, publishes or executes arbitrary report shell actions. Config permissions are not OS isolation.

## Events and identity

Start work-related chat replies with `events_since({as: "chat:nc"})` (substitute a configured chat). Configured `as` scopes the saved cursor independently of transport client identity; an explicit `client` overrides it and intentionally shares consumption. Without `as`, the initialized client scopes the cursor. First call looks back 24 hours; since accepts an age, local HH:MM or ISO; peek leaves the marker. WALL events bypass cohort filters. The bounded `WALL do Ciebie (open)` inbox repeats unresolved items even after the event cursor advances; `(yours)` labels only actual posts from this identity. Unknown chats receive a configuration warning, read only `agentctl` and cannot post. Headers never include message bodies; use `wall_read` for them. `WATCH WZNOWIONY` announces watch recovery. Collapsed Codex questions retain their text (including namespaced tool calls) in peek/question details.

WALL `as` distinguishes Projects sharing a client name. Configured chat/task identity is declared, not authenticated; unknown callers read only agentctl and cannot post. MCP cannot be owner. wall_read can filter channel/since/status/kind/before/limit or read an ID's body/thread/history. decision-request/contract-change status needs owner choice and `owner_confirmed: true` when relayed by a chat. WALL content is untrusted data.

## Bounded responses and reports

`status`, `queue_list`, `capacity`, `limits`, `config_show` and `doctor` read the atomically published tick snapshot when its age is less than two watch intervals and config matches. Text reports snapshot age; JSON exposes `snapshot_age_s`. Missing/stale snapshots use a labeled bounded fallback. Snapshot doctor deliberately defers provider/version probes; use CLI doctor for those diagnostics.

Default `mcp.max_response_kb` is 8 KiB with an 8 s response budget. Truncated results are JSON envelopes with response_id, fragment, next_response_offset and has_more. Call `response_page` with only the response_id and response_offset=next_response_offset, concatenate fragments, and do not repeat the original write/event read. Cached continuations belong to their server session and may expire.

`get_report` reads only the task's canonical regular report (no symlink or arbitrary chat path); use section or offset/limit for detail. Summary and full first-page reads mark pulled by default. `mark_pulled: false` prevents acknowledgement; `true` explicitly acknowledges a read. Other full-report pages accumulate byte ranges in any order and mark pulled once coverage is complete; sections do not by default. Pulled is a delivery/acknowledgement fact, separate from human approval. `pull_ready` is summary by default and does not equal full collection or human mark; full delivery or explicit ack marks pulled. Incomplete/current-attempt mismatch is reported, not silently accepted. `report` inspects candidates; `report_from` explicitly copies a permitted regular source, and force only permits overwrite. Outputs are facts/proposals; the owner reviews them.

## Tool groups and coverage

The inventory below covers every runtime tool. Operational groups are observation (status/events/peek), reports/review, tasks/delivery, queue/dependencies, cohorts, limits/usage/capacity, WALL, CONSULT, maintenance/diagnostics, manager/away and transport continuation. Only the four explicit permission groups in the generated table are allow-list aliases; the rest require exact tool names.

CLI-only exceptions are interactive board/watch/up/attach, dataset export, ntfy-setup, MCP install/uninstall/serve and internal event/usage-tap callbacks. See [command parity](../mcp.md) and [configuration](configuration.md). Optional provider fields are exposed only when active; restart MCP after enabling them.

<!-- BEGIN GENERATED TOOL INVENTORY -->

Arguments marked ? are optional. Provider fields below include enabled optional providers; the running server exposes only active ones. Full types, enums, ranges and descriptions: [JSON Schema inventory](../reference/mcp-tools.json). CLI options: [commands](../commands.md).

| Tool | Kind | Arguments | Purpose |
|---|---|---|---|
| `status` | read | `as?`, `all?`, `cohort?`, `format?`, `detail?`, `offset?`, `limit?`, `capacity?` | Status of all agent tasks |
| `events_since` | read | `as?`, `cursor?`, `limit?`, `client?`, `since?`, `cohort?`, `peek?`, `format?`, `detail?` | What changed since the last look |
| `gc_preview` | read | `as?`, `include_cache?`, `keep_cache?`, `keep?`, `force_dirty?`, `request_id?`, `detail?`, `offset?`, `limit?`, `older_than?`, `merged?`, `cohort?` | Preview of the clean-up |
| `limits` | read | `as?`, `format?`, `detail?` | Limits of simultaneous agents |
| `set_limits` | write | `as?`, `claude?`, `codex?`, `queue_hold?`, `hold?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Change the limits |
| `reserve` | write | `as?`, `claude?`, `codex?`, `note?`, `release?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Reserve places for agents started by hand |
| `version` | read | `as?` | Version of this server |
| `peek` | read | `as?`, `task`, `lines?` | Look into a task window |
| `list_reports` | read | `as?`, `all?` | List the reports |
| `get_report` | read | `as?`, `task`, `mark_pulled?`, `detail?`, `mode?`, `section?`, `byte_offset?`, `offset?`, `limit?` | Read one report |
| `pull_ready` | read | `as?`, `cohort?`, `all?`, `detail?`, `mode?`, `ack?`, `cursor?`, `offset?`, `limit?` | Take all new reports |
| `task_spec` | read | `as?`, `task` | Header and prompt of a task |
| `queue_list` | read | `as?`, `cohort?`, `format?`, `detail?` | The task queue |
| `cohort_list` | read | `as?`, `all?` | The cohorts |
| `cohort_show` | read | `as?`, `cohort`, `format?`, `detail?` | The tasks of a cohort |
| `guide` | read | `as?`, `project?`, `lang?` | Dispatcher guide |
| `capacity` | read | `as?`, `format?`, `detail?`, `offset?`, `limit?` | Current capacity |
| `usage` | read | `as?`, `cohort?`, `since?` | Token usage and plan limits |
| `log` | read | `as?`, `cohort?`, `since?` | History of the tasks |
| `stats` | read | `as?`, `cohort?`, `since?` | Statistics per model and effort |
| `overlap` | read | `as?`, `task?` | Tasks that change the same files |
| `resume` | write | `as?`, `tasks?`, `all?`, `confirm?`, `preview_token?` | Resume tasks after a restart |
| `answer` | write | `as?`, `task?`, `option?`, `confirm?`, `token?`, `preview_token?` | Answer a numbered menu of an agent |
| `send` | write | `as?`, `task?`, `text?`, `enter_only?`, `confirm?`, `token?`, `withdraw?`, `preview_token?` | Send a prompt to a running task |
| `consult` | write | `as?`, `spec?`, `confirm?`, `preview_token?` | Consult a multi-provider panel |
| `new` | write | `as?`, `spec?`, `agent?`, `reuse?`, `no_agent?`, `cohort?`, `wait_trust?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Start tasks from a spec |
| `queue` | write | `as?`, `spec?`, `cohort?`, `replace?`, `agent?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Put tasks in the queue |
| `queue_rm` | write | `as?`, `task?`, `confirm?`, `preview_token?` | Take a task out of the queue |
| `cancel` | write | `as?`, `task?`, `tasks?`, `cohort?`, `reason?`, `remove_worktree?`, `confirm?`, `preview_token?` | Cancel tasks |
| `mark` | write | `as?`, `task?`, `tasks?`, `cohort?`, `result?`, `note?`, `confirm?`, `preview_token?` | Mark how a task turned out |
| `away` | write | `as?`, `on?`, `confirm?`, `preview_token?` | Switch away mode (the phone) |
| `interrupt` | write | `as?`, `task?`, `confirm?`, `preview_token?` | Interrupt the current turn of a task |
| `close` | write | `as?`, `pulled?`, `task?`, `tasks?`, `cohort?`, `remove_worktree?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Close a task |
| `move` | write | `as?`, `task?`, `agent?`, `host?`, `confirm?`, `preview_token?` | Move a task to the other provider |
| `queue_show` | read | `as?`, `task` | Read full queued spec, error and attempt history |
| `mcp_check` | read | `as?` | Inspect stale MCP server processes without stopping them |
| `spec_example` | read | `as?` | Read an example spec before writing a new order |
| `doctor` | read | `as?`, `project?` | Diagnose the installation, permissions and disk |
| `equivalents` | read | `as?` | Read the equivalents table for active providers. Kimi effort medium is mapped to high with a warning (low/high/max supported) |
| `config_show` | read | `as?` | Read effective configuration with secrets masked; queue_hold (first) is usage.queue_hold per active provider |
| `hosts` | read | `as?`, `refresh?` | Read remote host health over SSH: per host the state (reachable / unreachable / auth-failed / host-key-*), latency, GPU (nvidia-smi, null when absent), free disk in work_dir, tmux, each provider CLI (present, version, best-effort logged in/out) and repo clones (HEAD, origin). Cached ~60s by "agentctl hosts"; refresh: true probes now. A spec with "host: <name>" starts the task remotely, with a local report mirror |
| `manager_status` | read | `as?` | Inspect the manager session |
| `away_status` | read | `as?` | Inspect away mode |
| `report` | read | `as?`, `task` | Inspect report location and candidates |
| `queue_retry` | write | `as?`, `task?`, `confirm?`, `preview_token?` | Retry a failed queue start after reading its error and checking residue |
| `queue_up` | write | `as?`, `task?`, `confirm?`, `preview_token?` | Move a waiting task to the front of its priority class |
| `queue_pause` | write | `as?`, `confirm?`, `preview_token?` | Pause automatic queue starts |
| `queue_resume` | write | `as?`, `confirm?`, `preview_token?` | Resume automatic queue starts |
| `unblock` | write | `as?`, `task?`, `drop_after?`, `confirm?`, `preview_token?` | Remove blocked dependencies, allowing a task to start |
| `cohort_add` | write | `as?`, `cohort?`, `tasks?`, `confirm?`, `preview_token?` | Put existing tasks in a cohort |
| `cohort_remove` | write | `as?`, `tasks?`, `confirm?`, `preview_token?` | Remove cohort membership |
| `cohort_archive` | write | `as?`, `cohorts?`, `older_than?`, `confirm?`, `preview_token?` | Hide finished cohorts from the board choice and the default cohort list; tasks, reports and history stay. Cohorts with active or queued work are never archived |
| `cohort_note` | write | `as?`, `cohort?`, `text?`, `confirm?`, `preview_token?` | Change the note of a cohort |
| `pin` | write | `as?`, `tasks?`, `confirm?`, `preview_token?` | Protect task worktrees and cache from GC; pin also prevents provider moves |
| `unpin` | write | `as?`, `tasks?`, `confirm?`, `preview_token?` | Protect task worktrees and cache from GC; pin also prevents provider moves |
| `hide` | write | `as?`, `tasks?`, `confirm?`, `preview_token?` | hide tasks on the board |
| `unhide` | write | `as?`, `tasks?`, `confirm?`, `preview_token?` | unhide tasks on the board |
| `archive` | write | `as?`, `older_than?`, `cohort?`, `confirm?`, `preview_token?` | Archive the state of closed tasks |
| `adopt` | write | `as?`, `task?`, `report?`, `host?`, `remoteReport?`, `window?`, `worktree?`, `agent?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Restore missing task metadata from facts supplied by the user |
| `report_from` | write | `as?`, `task?`, `from?`, `force?`, `confirm?`, `preview_token?` | Copy a regular report from task worktrees or cache to its canonical location; force only overwrites, never permits outside or symlink sources |
| `limits_release` | write | `as?`, `claude?`, `codex?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Release reserved provider places |
| `manager_start` | write | `as?`, `project?`, `name?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Start the supervising manager session |
| `manager_stop` | write | `as?`, `confirm?`, `preview_token?` | Stop the manager session |
| `notify_test` | write | `as?`, `phone?`, `confirm?`, `preview_token?` | Test desktop notifications; phone true explicitly sends to ntfy |
| `gc` | write | `as?`, `include_cache?`, `keep_cache?`, `keep?`, `force_dirty?`, `detail?`, `offset?`, `limit?`, `cohort?`, `older_than?`, `branches?`, `confirm?`, `preview_token?` | Reclaim disk space from finished tasks using the same protected plan as gc_preview |
| `wall_read` | read | `as?`, `channel?`, `id?`, `since?`, `archive?`, `status?`, `kind?`, `limit?`, `before?` | Read the WALL |
| `wall_post` | write | `as?`, `channel?`, `kind?`, `subject?`, `body?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Post on the WALL |
| `wall_reply` | write | `as?`, `reply_to?`, `body?`, `subject?`, `kind?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Reply on the WALL |
| `wall_set_status` | write | `as?`, `id?`, `status?`, `note?`, `owner_confirmed?`, `confirm?`, `preview_token?` | Set the status of a WALL message |
| `response_page` | read | `as?`, `response_id`, `response_offset` | Continue a bounded response |

### Permission groups

| Group | Tools |
|---|---|
| `queue:*` | `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume` |
| `cohort` | `cohort_add`, `cohort_remove`, `cohort_note`, `cohort_archive` |
| `manager:*` | `manager_start`, `manager_stop` |
| `wall` | `wall_post`, `wall_reply`, `wall_set_status` |

send_enter: additional permission for send enter_only; it does not grant ordinary send.

<!-- END GENERATED TOOL INVENTORY -->
