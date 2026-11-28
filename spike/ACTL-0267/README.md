# ACTL-0267 spike: hybrid provider drivers

Research prototype only: nothing under `src/` changed. Observed on 2026-11-28 on macOS arm64 (load average 135–177),
Claude Code 2.1.326 (registry also shows 2.1.323), codex-cli 0.167.0 (shared app-server daemon 0.172.0), Kimi Code 2.5.2.
No model turn was started. The probes refuse `turn/start`, `session/prompt` and user messages.

Run: `node --experimental-strip-types --no-warnings --test spike/ACTL-0267/*/*.test.ts` (25 tests, fixtures only).

## 1. Quick wins in screen mode (0.27.5)

| Source | What it gives | Cost for 90 sessions (load 177) | Status today |
|---|---|---|---|
| `~/.claude/sessions/<pid>.json` (live registry) | `status` idle/busy/shell, `statusUpdatedAt`, `sessionId`, `version`, `tmux` = `session:@win.%pane` | **2.3 ms** (one readdir + 90 small reads) | not used |
| Claude transcript tail (`~/.claude/projects/*/*.jsonl`) | turn start (`user.promptSource`), turn end (`system/turn_duration`), `AskUserQuestion` pending, last text, usage (dedupe by `message.id`) | 0.32 s with 64 KB tails, 0.84 s with 256 KB | partly (delivery ack, usage) |
| Codex rollout tail (`~/.codex/sessions/**`) | `task_started`/`task_complete` (`last_agent_message`, `duration_ms`), `token_count` (last/total, context window), pending `request_user_input_async` | 0.29 s (64 KB) | partly |
| `tmux capture-pane` × 90 | screen guess | **4.6 s** sequential, 1.0 s with 8 in parallel (bench under `taskpolicy -b`: 101 s / 84 s) | primary today |
| `tmux list-panes -a -F …` once | pane pid/dead/command/activity | 14 ms | partly |

Evidence: `bench-90.json`, `bench-90-nice.json`, `real-files-check.json`. On 40 real Claude transcripts, the registry and the
transcript agreed every time both had a phase (idle↔turn-done 11, busy↔working 1). A 64 KB tail left 9/40 `unknown`
(long tool output), so the tail must grow until it finds a turn boundary (64 KB → 1 MB), with the registry as fallback. `shell`
seems to mean a shell/background command, but its exact meaning is unverified.

**Claude hooks.** These are already per task through `--settings <taskdir>/claude-settings.json`, and the user's global settings are never
edited. Gaps: `SessionStart` and `UserPromptSubmit` are parsed and then *ignored*. Use them for the session pin and the delivery ack.
Add `PermissionRequest` (a structured approval for `answer`) and `SessionEnd` (dead + reason). Keep `command` type only (2.1.332
rejects prompt-type SessionStart). `--bare` skips hooks, so never use it for driven tasks. `-p` silently ignores settings files
that fail validation, so validate the per-task file before launch. Hook availability on 2.1.332 must be confirmed with `--include-hook-events`.

**Codex.** `notify` gives only `agent-turn-complete` (already wired). Hooks are `stable` in 0.167 (`codex features list`), with 14 events:
preToolUse, permissionRequest, postToolUse, sessionStart, sessionEnd, userPromptSubmit, stop, interrupt, … Per-task
`-c hooks.<Event>=[…]` is accepted (`source: sessionFlags`) but **`trustStatus: untrusted`**, so it does not run. Trust is checked
per command hash, so the hook command must be byte-identical for every task, with task/attempt passed in env (`hooks/wiring.ts`).
`--dangerously-bypass-hook-trust` is acceptable only when `hooks/list` shows no project/user hooks. How trust is persisted is unverified.

**Claude stream-json control handshake** (`headless/claude-control-probe.ts`): one `initialize` control request with no user message
returns `claude_code_version`, `session_state`, `capabilities`, `models`, `commands`, and the hook flags `hook_on_failure_supported` and
`other_hook_ask_outranks_host`. That is a ~1 s version/capability probe with no inference, usable for the observation record.

## 2. Headless one-shot (0.28.x): review / report / simple / gate

| | `claude -p --output-format stream-json --verbose` | `codex exec --json` |
|---|---|---|
| session id | `system/init.session_id` (or `--session-id`) | `thread.started.thread_id` |
| progress | `assistant` tool_use / text, `system/api_retry` | `item.started/completed` (command_execution, file_change, agent_message) |
| end | `result` (`subtype`, `is_error`, `result`, `num_turns`) | `turn.completed` / `turn.failed` |
| usage | `result.usage` + `total_cost_usd` (+ `modelUsage`) | `turn.completed.usage` (input, cached, output, reasoning) |
| approvals | none: `--permission-prompts none` denies, so `permission_denials[]` → needs-attention | none: the sandbox/approval policy decides |
| failures | `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, limit/529 text, no `result` = dead | `turn.failed.error.message`, `error` (reconnecting = retry), exit code |

The report/verdict rule is unchanged: the canonical report file with attempt marker and report-end wins. Without it, the verdict comes from the
first line of the final message (`reportSource: stream`). The prompt goes on stdin, never in argv. Fixtures are schema-derived; real streams
were not recorded (that needs inference).

## 3. Protocol drivers (0.30): handshakes done

| | Codex App Server | codex-acp 2.12.1 | claude-agent-acp 0.113.0 | kimi acp 2.5.2 | acpx 0.23.0 |
|---|---|---|---|---|---|
| what | native JSON-RPC (stdio/unix/ws) | ACP wrapper over App Server, **pins @openai/codex ^0.172** (`CODEX_PATH` overrides) | ACP over Claude Agent SDK 0.3.331 (`CLAUDE_CODE_EXECUTABLE` overrides) | native ACP | ACP *client* CLI + queue owner |
| handshake | initialize 1.5 s, thread/start(ephemeral) ok without auth | initialize ok; session/new → `Authentication required` (isolated home) | initialize 6.2 s (load); session/new skipped (user SessionStart hook) | initialize 16 s (load) | `--help` only |
| needs-input / approval | `item/*/requestApproval`, `item/tool/requestUserInput`, `thread/status.activeFlags` waitingOnApproval/UserInput | `session/request_permission` | `session/request_permission`; AskUserQuestion via ACP unverified | same | policies (`--approve-reads`, `--deny-all`) |
| turn done / errors | `turn/completed.status` + `codexErrorInfo` (usageLimitExceeded, serverOverloaded, …), `error.willRetry` | `stopReason` | `stopReason` | `stopReason` | – |
| usage per turn | `thread/tokenUsage/updated` last + total + window | `usage_update` (context only) | same | – | – |
| resume / cancel | `thread/resume` / `turn/interrupt`, `turn/steer` | `session/resume`, `session/cancel` | same + steering `_meta` | same | `sessions`, `cancel` |
| tmux live viewer | **`codex --remote unix://…`**: the real TUI as a second client | render event log | render event log | render event log | – |

Mapping to agentctl states: `protocol/state-map.ts` (tests on recorded handshakes plus synthetic turns). `answer` = the JSON-RPC response
for choice n (approval: accept / acceptForSession / decline / cancel; ACP: optionId; question: option label).
The CLI 0.167 TUI already uses a **shared app-server daemon (0.172.0, auto-updated, `daemon update may interrupt running work`)**,
so the protocol version is the daemon's, not the CLI's. The driver should start its own per-task `app-server --listen unix://<taskdir>`
with the user's CLI, not the shared daemon.
WSL (note only, not run): every driver works over stdio inside WSL and over `ssh host codex app-server` (no ports); the Claude
registry carries `pidDomain`, so do not mix the WSL and Windows homes; ACP adapters need Node inside WSL.

## 4. `driver: auto` (`auto/driver-auto.ts`)
The key is provider × CLI version (minor) × host × driver (+ app-server/adapter version). A record is written per finished task:
outcome, readyMs, deliveryAcked, lostPrompt, stuckMin, interventions, unknownEvents, pollMs. Promote with N ≥ 20 when success is
≥ incumbent + 5 pp (or equal success with ≤ 70 % of the interventions), driver errors ≤ 2 % and no incidents. Demote with a −10 pp gap,
≥ 2 incidents or errors > 4 %, and do it fail-closed even inside the 24 h cooldown. A minor version bump restarts history. Pin wins.
The driver is resolved once at task start and stored in the task record. Exploration: 30 % of non-interactive tasks and 10 % of interactive ones until N.

```yaml
providers:
  codex:
    driver: auto            # screen | headless | protocol | auto
    protocol: app-server    # app-server | acp
    pin: {driver: screen, version: "0.167.*"}   # optional
    headless_classes: [review, report, simple, gate]
  claude:
    driver: screen          # hooks + registry + transcript
    protocol: acp           # claude-agent-acp, opt-in only
auto: {min_n: 20, window: 40, margin: 0.05, fallback_margin: 0.10, max_driver_errors: 0.02, cooldown: 24h}
```

## 5. Licences (reuse = code copied or depended on)
| Project | Licence | Use |
|---|---|---|
| OrgLoop/agentctl (npm @orgloop/agentctl 1.9.1) | MIT | ideas only (name clash: keep ours `@setech-pl/agentctl`) |
| openclaw/acpx 0.23.0 | MIT | ideas (permission policy JSON, queue owner TTL); code reuse allowed with notice |
| BloopAI/vibe-kanban | Apache-2.0 (package.json has none; repo LICENSE) | ideas only |
| agentclientprotocol/claude-agent-acp (ex zed-industries/claude-code-acp, deprecated) | Apache-2.0 | runtime dependency at most; **depends on @anthropic-ai/claude-agent-sdk = Anthropic Commercial Terms (not OSS)**: never bundle, let the user install it |
| agentclientprotocol/codex-acp (JetBrains, ex zed-industries) | Apache-2.0 (GitHub: NOASSERTION; LICENSE is Apache-2.0) | ideas; prefer App Server directly |
| @agentclientprotocol/sdk 2.12.0 / ACP spec | Apache-2.0 | dependency if ACP is adopted (NOTICE required) |
| openai/codex (CLI, app-server schema) | Apache-2.0 | generated schema/types may be vendored with notice |
agentctl is MIT: depending on Apache-2.0 is fine (keep NOTICE); copied Apache code keeps its header.
