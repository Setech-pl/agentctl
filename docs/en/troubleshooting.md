# Troubleshooting

Start with `agentctl doctor`, `agentctl version`, `agentctl status --all` and `agentctl queue list` in the intended AGENTCTL_HOME. Do not repair one instance by changing another's home. `doctor --timings` reports read-budget sections; MCP doctor uses cached/budgeted facts and is not a live inference test.

| Symptom | Inspect and recover |
|---|---|
| CLI not found / wrong version | Check Node ≥22.14.0, PATH, command -v agentctl and the stable copy. Updater dry-run explains its target. Kimi's current npm baseline needs Node ≥22.19.0. |
| MCP tools absent or old | version/mcp_check; check absolute Node/script/env in desktop config. Quit app fully Cmd+Q and reopen after update. Inspect its mcp-server-agentctl.log/mcp.log in ~/Library/Logs/Claude. |
| Write denied | Read config_show and mcp.allow warnings. Grant only exact needed tools/group; do not bypass by shell or identity changes. |
| Preview expired / scope changed | Create a fresh preview, show its new scope and obtain any missing approval. Keep session and arguments. Timeout retry uses the same token, not a fresh duplicate order. |
| Accepted but no window | Check watch, events_since and queue_show/list: accepted → validation → queued/starting or failed. Look for dependencies, slots, pause, queue_hold, heavy admission and setup errors. |
| needs-trust / onboarding | Open task window, answer manually; watch sends the pending original prompt after ready input. Parent-directory trust does not reliably cover a new Git worktree. |
| Failed start | Read start-failure-screen.txt/peek and setup.log. Default keeps the window. Repair the actual cause, then queue_retry closes the leftover failed window and revalidates. Do not erase uncertain Git residue. |
| Input not delivered | Inspect prompt_delivery, pending message IDs and peek. Never press Enter blindly or resend the whole order. enter_only requires unchanged owned field/token; unknown geometry refuses. |
| Codex follow-up waiting | Busy Codex queues until confirmed turn end. Inspect message_id, pending state; withdraw if no longer needed. Existing reports remain readable with warnings. |
| after blocked | Read the predecessor's first verdict. FAIL/BLOCKED/NO-GO normally blocks; incomplete missing verdict can wait. Corrected accepted report auto-unblocks; manual unblock/drop-after is an owner decision. |
| Report missing/stale | Inspect report candidates, canonical path, current attempt marker and report-end. Touching mtime does not make an old attempt valid. report_from copies only allowed regular files; never symlinks/outside roots. |
| Report summary seen, still unpulled | `get_report` summary/first full page marks by default; check mark_pulled: false. Other pages combine in any order. pull_ready summary does not mark; full/ack does. Human mark is separate. |
| limited / n/d quota | Read capacity source/age/reset. n/d is unknown, especially GLM. Check same-provider auto-resume policy or explicit resume/move. No silent provider switching. |
| GLM theme or auto-mode notice | Run claude-glm once in its separate config directory and finish onboarding. Informational banners/MCP auth warning are not startup blockers. Default AUTO_MODE_SERVER=0 is GLM task-only. |
| Kimi refuses safety settings | Doctor reads config.toml: mode auto or disabled dangerous-command guard is refused. Keep guard enabled, use supported manual/yolo config, never bypass trust flags. |
| WALL invisible / denied | Pass configured as: chat:name; inspect wall.chats/channels/subscriptions/authors. Unknown identity reads only agentctl. Bodies require wall_read by ID; events contain headers only. |
| WALL decision status denied | Owner decides; a chat may relay only with owner_confirmed true after that decision. Board WALL is read-only except read marks. |
| CONSULT stalls | Keep watch; inspect cohort/consult state and report reasons. Repair structured/current-attempt answers or cancelled member decision; never invent the missing answer. |
| Window disappeared | status identifies dead/resumable; resume continues known session, adopt restores metadata only from explicit facts. Restarting watch alone does not resurrect lost tmux windows. |
| Disk warning / GC skips | gc --preview shows bytes/reasons. Protect active, dirty, foreign, linked and unmerged work. Apply only after reviewing the plan; do not force-delete to make a gate pass. |
| Bad config reload | Previous valid config stays active; doctor/status/watch log names the issue. Fix YAML/types/unknown keys and save again. Board title changes may need view restart. |

## Local data and diagnosis

Default instance files live under ~/.agentctl (tasks, queue, archive, journal, wall, consult, usage, MCP audit/requests/receipts). Configurable state/report roots may differ. Reports belong to tasks' canonical cache paths; use task_spec/report/config_show to learn them rather than guessing. Session windows and worktrees survive ordinary board exit. `q` exits the board, not agents.

Doctor checks installation/provider flags, trust/onboarding guidance, hooks/settings/MCP wiring, stale processes, config/link targets and disk. Warnings about passive Kimi protocols, unknown models or absent quota are limits of observation, not proof the task failed. Provider probes never run real model turns; only opt-in neutral /usage sessions and Codex read RPC. Tests/gates use fakes unless the specific live scenario says otherwise.

For development, run `npm run gate -- quick` with an absolute task-owned AGENTCTL_LIVE_CACHE; larger integration/release gates have their documented scope. Every tier includes regression scenarios. Never replace a failed test by guessed PASS evidence. See [regression catalog](../../tests/regression/CATALOG.md) and [CONTRIBUTING](../../CONTRIBUTING.md).

<!-- tmux-dev-start -->
### Dedicated tmux server for development

Use a separate config home **and** server: a different session name alone still shares the server environment, key bindings and buffers. From the development checkout, set the home and edit its existing config (keep its other settings):

```sh
export AGENTCTL_HOME="$HOME/.agentctl-dev"
mkdir -p "$AGENTCTL_HOME"
${EDITOR:-vi} "$AGENTCTL_HOME/config.yaml"
```

Add or update these top-level keys:

```yaml
session: agentctl-dev
tmux:
  socket: agentctl-dev
```

`tmux.socket` is the name passed to `tmux -L`, not a socket path. Omit it to keep the default tmux server selection. Watch, board, tasks, peek, send, close, attach and doctor all use this server, including direct tmux calls. Attach hints quote exact targets so `agentctl` cannot select `agentctl-dev` by prefix. Doctor displays the selected socket and warns about a different `AGENTCTL_HOME` in that server's global or session environment.

Start from a terminal outside tmux:

```sh
node --experimental-strip-types --no-warnings bin/agentctl.ts up --no-attach
node --experimental-strip-types --no-warnings bin/agentctl.ts doctor
tmux -L agentctl-dev attach -t '=agentctl-dev'
```

To migrate an existing **dev session named agentctl-dev on the default server**, first keep the old config (socket unset), inspect status and the old windows, and let agents finish or save their conversations. Killing the old dev session below terminates its processes; do this only after saving work and checking session receipts in the dev task state. Do not kill the default server: the production session may share it.

```sh
export AGENTCTL_HOME="$HOME/.agentctl-dev"
node --experimental-strip-types --no-warnings bin/agentctl.ts status --json
tmux list-windows -t '=agentctl-dev'
tmux kill-session -t '=agentctl-dev'
${EDITOR:-vi} "$AGENTCTL_HOME/config.yaml"
```

Now add the YAML keys above, leave the old worktrees and task state in place, and restart dev processes so they reload the socket. Restart any dev MCP process as well. tmux cannot transfer running agent processes between servers; resume recreates their windows on the new server.

```sh
node --experimental-strip-types --no-warnings bin/agentctl.ts up --no-attach
node --experimental-strip-types --no-warnings bin/agentctl.ts status
node --experimental-strip-types --no-warnings bin/agentctl.ts resume
node --experimental-strip-types --no-warnings bin/agentctl.ts doctor
tmux -L agentctl-dev attach -t '=agentctl-dev'
```

After server/session loss, unfinished tasks show `needs-attention` with a recovery hint and one `tmux-lost` journal event per loss. Claude records the session ID at `SessionStart`; other provider receipts are retained as soon as received. If a saved session exists, use the suggested `agentctl resume TASK` after reviewing the list. Without one, create a spec with a **new task ID**, point its repositories at the old worktree, and use `agentctl new --reuse recovery.md` to start a replacement task; do not assume that `--continue` or `--last` identifies the lost conversation. Finished reports, closed and cancelled tasks keep their existing state.
<!-- tmux-dev-end -->

Missing `main` base: the error identifies the locally known default (for example `master`) or unknown metadata. Correct `repos[].base` and retry; agentctl never substitutes it automatically.

## Watch stalls or `start.lock` times out

Check the watch log and `agentctl events` for the stalled stage, a reclaimed lock, and the restart result. A stage that remains active for more than three ticks emits one owner event. After ten minutes a stalled watcher exits. The tmux supervisor restarts it with backoff, up to five times in ten minutes. If the limit is reached, use `agentctl watch --tmux --restart` after checking the log.

Interrupted starts return to the queue and reuse a complete, verified worktree. Watch retains an existing prompt delivery and refuses unsafe checkout residue. An MCP write that stopped while applying is marked failed with instructions to check the result and preview again.

## Recover disk space from old Trash entries

`agentctl gc --purge-trash` lists candidates and their original paths. Review them, then run `agentctl gc --purge-trash --apply` and confirm. MCP uses `purge_trash: true` with a preview and confirmation token. GC reports the net gain in available filesystem blocks. Concurrent disk use can affect the reported number.


## Codex start fails with "did not show its input prompt"

Before 0.26.3, Codex 0.167+ starts could fail with `codex did not show its input prompt within 60s` even though `start-failure-screen.txt` showed a ready Codex. The footer contains a service tier, such as `GPT-6.2-Sol medium Fast · <dir>`, which older releases could not parse. 0.26.3 reads this footer and ignores ANSI codes and CRLF in a capture. It takes one more capture after the deadline. The ready timeout grows with load: the base is `providers_config.<p>.ready_timeout_s` or `agents.<p>.ready_timeout`, default 60 s, scaled by load1/cores up to 180 s. A queued start waits a second time in the same window. It reports `needs-attention` with the saved screen only after that second wait also times out.

Recovering tasks left in `needs-attention` with "did not become ready": upgrade, then keep `agentctl watch --tmux` running. If the window shows an empty Codex composer, watch delivers the original prompt from TASK.md once. Nothing is pasted twice. If the window is gone or still not ready, run `agentctl queue retry TASK`. It closes the kept window and starts a fresh one on the same worktree.

A follow-up sent while the agent was busy is processed when the current turn ends. It now stays `queued – unconfirmed` (`w kolejce agenta – niepotwierdzone`) after `delivery_confirm_s` instead of becoming `needs-attention`. A hook or a transcript entry confirms it later. On the first watch pass after the upgrade, older "Prompt delivery not confirmed" records for such deliveries return to the queued state.

## Claude Code: "SessionStart:startup hook failed – prompt-type hooks are not supported"

Claude Code 2.1.332 refuses SessionStart hooks that are not command-type. agentctl's task settings contain only command hooks (SessionStart, UserPromptSubmit, Notification, Stop, StopFailure), which every supported Claude Code version accepts. If the message appears, the rejected hook comes from your own or the project's Claude settings (or a plugin). `agentctl new` names the file in a WARNING, for example `~/.claude/settings.json (prompt)`. Change that hook to `"type": "command"` or remove it. Either way, the first prompt is delivered once the window shows a ready, empty input. It is confirmed by the session transcript, locally and on SSH hosts, even when no hook runs.
