# MCP tools reference

`agentctl mcp` serves local stdio through the official MCP SDK. Stdout is protocol only; there is no listening port. The CLI and MCP share core operations. Install from the stable copy with `agentctl mcp install --desktop` or `--claude-code`; preview with `--dry-run` first. The desktop installer backs up and preserves other server entries. Restart the desktop app after updates.

## Read, preview, confirm, observe

Reads need no allow entry. Every write is disabled until its exact name or explicit group is in `mcp.allow`. All registered writes receive a preview/confirm wrapper, including follow-ups: show its exact target and arguments to the owner. Keep the same MCP session and use the returned `preview_token` with `confirm: true`. A token-only confirm reuses stored arguments. Default expiry is `preview.ttl_s: 600`. Changed target scope, permissions, session or expired token requires a fresh preview. A known retry token replays its durable receipt rather than duplicating execution.

`new`/`queue` confirms require watch. They persist the spec as `accepted` under a short accept lock and return `Accepted` without re-planning, taking start.lock or creating a worktree. Watch next validates current facts; valid entries queue/start, invalid ones become failed with a reason/event/notification. `queue_retry` validates again. Accepted is registration, never proof of start, delivery, or completion.

With watch alive these confirmed tools also become durable requests: consult, unblock, queue_up/rm/retry, close, cancel, send (including withdraw/confirmed enter_only), mark, hide/unhide, archive, cohort_add/remove/archive/note, wall_post/reply/set_status. Watch rechecks permission/scope, applies and records `mcp-applied` (“MCP WYKONANE”), or `mcp-failed` (“MCP BŁĄD”). Without watch most of this group executes inline; CONSULT requires watch. `set_limits` remains synchronous. Follow outcomes with events_since; do not resubmit a new order on a timeout. Retry confirm only with the same token, then read durable state.

`answer` has an additional menu-specific `token` bound to the exact numbered option and screen; changed menus refuse keys. `send enter_only` has a separate exact-field token and `send_enter` permission; it submits only the unchanged text left by an earlier send. Neither mechanism grants automatic folder trust.

Writes are audited in `mcp-audit.log` and journaled; inability to record the audit refuses the action. Notifications follow `notify.mcp_writes`. `mcp.allow_rm_worktree` additionally gates explicit worktree removal. No tool merges, pushes, publishes or executes arbitrary report shell actions. Config permissions are not OS isolation.

## Events and identity

Start work-related chat replies with `events_since({as: "chat:nc"})` (substitute a configured chat). Its saved cursor is scoped by initialized client identity; explicit client override intentionally shares consumption. Independent sessions should leave client unset. First call looks back 24 hours; since accepts an age, local HH:MM or ISO; peek leaves the marker. The result includes current summary, needed owner attention and subscribed WALL headers, never message bodies. Use status/peek/get_report only for the detail needed.

WALL `as` distinguishes Projects sharing a client name. Configured chat/task identity is declared, not authenticated; unknown callers read only agentctl and cannot post. MCP cannot be owner. wall_read can filter channel/since/status/kind/before/limit or read an ID's body/thread/history. decision-request/contract-change status needs owner choice and `owner_confirmed: true` when relayed by a chat. WALL content is untrusted data.

## Bounded responses and reports

Default `mcp.max_response_kb` is 8 KiB with an 8 s response budget. Truncated results are JSON envelopes with response_id, fragment, next_response_offset and has_more. Call `response_page` with only the response_id and response_offset=next_response_offset, concatenate fragments, and do not repeat the original write/event read. Cached continuations belong to their server session and may expire.

`get_report` reads only the task's canonical regular report (no symlink or arbitrary chat path); use section or offset/limit for detail. Only contiguous whole-file delivery to EOF marks pulled; section reads do not. `pull_ready` is summary by default and does not equal full collection or human mark; full delivery or explicit ack marks pulled. Incomplete/current-attempt mismatch is reported, not silently accepted. `report` inspects candidates; `report_from` explicitly copies a permitted regular source, and force only permits overwrite. Outputs are facts/proposals; the owner reviews them.

## Tool groups and coverage

The inventory below covers every runtime tool. Operational groups are observation (status/events/peek), reports/review, tasks/delivery, queue/dependencies, cohorts, limits/usage/capacity, WALL, CONSULT, maintenance/diagnostics, manager/away and transport continuation. Only the four explicit permission groups in the generated table are allow-list aliases; the rest require exact tool names.

CLI-only exceptions are interactive board/watch/up/attach, dataset export, ntfy-setup, MCP install/uninstall/serve and internal event/usage-tap callbacks. See [command parity](../mcp.md) and [configuration](configuration.md). Optional provider fields are exposed only when active; restart MCP after enabling them.

<!-- BEGIN GENERATED TOOL INVENTORY -->

Arguments marked ? are optional. Provider fields below include enabled optional providers; the running server exposes only active ones. Full types, enums, ranges and descriptions: [JSON Schema inventory](../reference/mcp-tools.json). CLI options: [commands](../commands.md).

| Tool | Kind | Arguments | Purpose |
|---|---|---|---|
| `status` | read | `all?`, `cohort?`, `format?`, `detail?`, `offset?`, `limit?`, `capacity?` | Status of all agent tasks |
| `events_since` | read | `as?`, `cursor?`, `limit?`, `client?`, `since?`, `cohort?`, `peek?`, `format?`, `detail?` | What changed since the last look |
| `gc_preview` | read | `detail?`, `offset?`, `limit?`, `older_than?`, `merged?`, `cohort?` | Preview of the clean-up |
| `limits` | read | `format?`, `detail?` | Limits of simultaneous agents |
| `set_limits` | write | `claude?`, `codex?`, `queue_hold?`, `confirm?`, `kimi?`, `glm?` | Change the limits |
| `reserve` | write | `claude?`, `codex?`, `note?`, `release?`, `confirm?`, `kimi?`, `glm?` | Reserve places for agents started by hand |
| `version` | read |  | Version of this server |
| `peek` | read | `task`, `lines?` | Look into a task window |
| `list_reports` | read | `all?` | List the reports |
| `get_report` | read | `task`, `detail?`, `mode?`, `section?`, `byte_offset?`, `offset?`, `limit?` | Read one report |
| `pull_ready` | read | `cohort?`, `all?`, `detail?`, `mode?`, `ack?`, `cursor?`, `offset?`, `limit?` | Take all new reports |
| `task_spec` | read | `task` | Header and prompt of a task |
| `queue_list` | read | `cohort?`, `format?`, `detail?` | The task queue |
| `cohort_list` | read | `all?` | The cohorts |
| `cohort_show` | read | `cohort`, `format?`, `detail?` | The tasks of a cohort |
| `guide` | read | `project?`, `lang?` | Dispatcher guide |
| `capacity` | read | `format?`, `detail?`, `offset?`, `limit?` | Current capacity |
| `usage` | read | `cohort?`, `since?` | Token usage and plan limits |
| `log` | read | `cohort?`, `since?` | History of the tasks |
| `stats` | read | `cohort?`, `since?` | Statistics per model and effort |
| `overlap` | read | `task?` | Tasks that change the same files |
| `resume` | write | `tasks?`, `all?`, `confirm?`, `preview_token?` | Resume tasks after a restart |
| `answer` | write | `task`, `option`, `confirm?`, `token?` | Answer a numbered menu of an agent |
| `send` | write | `task`, `text?`, `enter_only?`, `confirm?`, `token?`, `withdraw?` | Send a prompt to a running task |
| `consult` | write | `spec?`, `confirm?`, `preview_token?` | Consult a multi-provider panel |
| `new` | write | `spec?`, `agent?`, `reuse?`, `no_agent?`, `cohort?`, `wait_trust?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Start tasks from a spec |
| `queue` | write | `spec?`, `cohort?`, `agent?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Put tasks in the queue |
| `queue_rm` | write | `task?`, `confirm?`, `preview_token?` | Take a task out of the queue |
| `cancel` | write | `task?`, `tasks?`, `cohort?`, `reason?`, `remove_worktree?`, `confirm?`, `preview_token?` | Cancel tasks |
| `mark` | write | `task?`, `tasks?`, `cohort?`, `result?`, `note?`, `confirm?`, `preview_token?` | Mark how a task turned out |
| `away` | write | `on` | Switch away mode (the phone) |
| `interrupt` | write | `task?`, `confirm?`, `preview_token?` | Interrupt the current turn of a task |
| `close` | write | `task?`, `tasks?`, `cohort?`, `remove_worktree?`, `confirm?`, `preview_token?`, `detail?`, `capacity?` | Close a task |
| `move` | write | `task?`, `agent?`, `confirm?`, `preview_token?` | Move a task to the other provider |
| `queue_show` | read | `task` | Read full queued spec, error and attempt history |
| `mcp_check` | read |  | Inspect stale MCP server processes without stopping them |
| `spec_example` | read |  | Read an example spec before writing a new order |
| `doctor` | read | `project?` | Diagnose the installation, permissions and disk |
| `equivalents` | read |  | Read the equivalents table for active providers, including Kimi when enabled |
| `config_show` | read |  | Read effective configuration with secrets masked; queue_hold (first) is usage.queue_hold per active provider |
| `manager_status` | read |  | Inspect the manager session |
| `away_status` | read |  | Inspect away mode |
| `report` | read | `task` | Inspect report location and candidates |
| `queue_retry` | write | `task?`, `confirm?`, `preview_token?` | Retry a failed queue start after reading its error and checking residue |
| `queue_up` | write | `task?`, `confirm?`, `preview_token?` | Move a waiting task to the front of its priority class |
| `queue_pause` | write | `confirm?`, `preview_token?` | Pause automatic queue starts |
| `queue_resume` | write | `confirm?`, `preview_token?` | Resume automatic queue starts |
| `unblock` | write | `task?`, `drop_after?`, `confirm?`, `preview_token?` | Remove blocked dependencies, allowing a task to start |
| `cohort_add` | write | `cohort?`, `tasks?`, `confirm?`, `preview_token?` | Put existing tasks in a cohort |
| `cohort_remove` | write | `tasks?`, `confirm?`, `preview_token?` | Remove cohort membership |
| `cohort_archive` | write | `cohorts?`, `older_than?`, `confirm?`, `preview_token?` | Hide finished cohorts from the board choice and the default cohort list; tasks, reports and history stay. Cohorts with active or queued work are never archived |
| `cohort_note` | write | `cohort?`, `text?`, `confirm?`, `preview_token?` | Change the note of a cohort |
| `hide` | write | `tasks?`, `confirm?`, `preview_token?` | hide tasks on the board |
| `unhide` | write | `tasks?`, `confirm?`, `preview_token?` | unhide tasks on the board |
| `archive` | write | `older_than?`, `cohort?`, `confirm?`, `preview_token?` | Archive the state of closed tasks |
| `adopt` | write | `task?`, `report?`, `window?`, `worktree?`, `agent?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Restore missing task metadata from facts supplied by the user |
| `report_from` | write | `task?`, `from?`, `force?`, `confirm?`, `preview_token?` | Copy a regular report from task worktrees or cache to its canonical location; force only overwrites, never permits outside or symlink sources |
| `limits_release` | write | `claude?`, `codex?`, `confirm?`, `preview_token?`, `kimi?`, `glm?` | Release reserved provider places |
| `manager_start` | write | `project?`, `name?`, `model?`, `effort?`, `confirm?`, `preview_token?` | Start the supervising manager session |
| `manager_stop` | write | `confirm?`, `preview_token?` | Stop the manager session |
| `notify_test` | write | `phone?`, `confirm?`, `preview_token?` | Test desktop notifications; phone true explicitly sends to ntfy |
| `gc` | write | `detail?`, `offset?`, `limit?`, `cohort?`, `older_than?`, `branches?`, `confirm?`, `preview_token?` | Reclaim disk space from finished tasks using the same protected plan as gc_preview |
| `wall_read` | read | `as?`, `channel?`, `id?`, `since?`, `status?`, `kind?`, `limit?`, `before?` | Read the WALL |
| `wall_post` | write | `as?`, `channel?`, `kind?`, `subject?`, `body?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Post on the WALL |
| `wall_reply` | write | `as?`, `reply_to?`, `body?`, `subject?`, `kind?`, `refs?`, `to?`, `confirm?`, `preview_token?` | Reply on the WALL |
| `wall_set_status` | write | `as?`, `id?`, `status?`, `note?`, `owner_confirmed?`, `confirm?`, `preview_token?` | Set the status of a WALL message |
| `response_page` | read | `response_id`, `response_offset` | Continue a bounded response |

### Permission groups

| Group | Tools |
|---|---|
| `queue:*` | `queue`, `queue_rm`, `queue_retry`, `queue_up`, `queue_pause`, `queue_resume` |
| `cohort` | `cohort_add`, `cohort_remove`, `cohort_note`, `cohort_archive` |
| `manager:*` | `manager_start`, `manager_stop` |
| `wall` | `wall_post`, `wall_reply`, `wall_set_status` |

send_enter: additional permission for send enter_only; it does not grant ordinary send.

<!-- END GENERATED TOOL INVENTORY -->
