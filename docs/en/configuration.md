# Configuration reference

Order: global config → first repository's .agentctl.yaml → spec. Global home is AGENTCTL_HOME, else ~/.agentctl. Unknown keys are errors; MCP config instead warns and drops invalid permissions. Watch/MCP reload valid edits; invalid edits retain the previous config and warn. Restart MCP after providers change.

env merges by key; links by from; setup replaces the whole list ([] disables). Each repo uses repos[].setup or its own project setup; global/top-level setup applies only to the first repo. Later report/root/default values win. Paths expand ~ and {task}/{TASK}/{cache}. MCP rejects setup in supplied specs; reviewed project setup still runs.

Types/defaults below are cross-checked with [config.ts](../../src/core/config.ts), [spec.ts](../../src/core/spec.ts) and adapters. g/p/s = global/project/spec. Compact legacy rows sometimes state default/type in their meaning. Exact regex defaults: [shared adapters](../../src/core/providers/settings.ts), [Kimi](../../src/core/providers/kimi-settings.ts), and [detailed reference](../configuration.md). Report mapping uses path OR paths plus settle_s/clean_worktree_cache; readiness still requires the current attempt. No owner-specific capacities are implied.

## Layers and instance

| Key | Type / default / layers | Meaning |
|---|---|---|
| `worktree_root` | path · none · g p | Directory for new worktrees: `<worktree_root>/<repo-name>-<task>`. Without it every `repos[]` entry needs its own `worktree`. |
| `links` | list · `[]` · g p s | Symlinks created in the first worktree. |
| `links[].from` | path · required · g p s | Where the link goes, relative to the first worktree. A glob links every match. |
| `links[].to` | path · required · g p s | What it points at. Must exist. `from` and `to` ending in `/*` make one link per entry of the directory. |
| `env` | mapping · `{}` · g p s | Environment variables of the tmux window (strings, numbers or booleans). |
| `report` | path or list · `{cache}/{task}/{TASK}.md` · g p s | Where the agent writes its report. Used by `status`, `pull` and the notifications. A list: the first entry is the canonical path, the others are places to look (paths and globs `*`, `?`, `**`; absolute, `~/` or relative to the worktree; `{task}` and `{TASK}` work), e.g. `[~/workspace/cache/{task}/{TASK}.md, docs/reports/*{task}*.md, docs/reports/*{TASK}*.md]`. Fresh alternatives bearing the task ID become candidate flags (see [Report detection](../details.md#report-detection)); copying requires explicit `report --from` / `report_from`. |
| `setup` | list of strings · `[]` · g p s | Shell commands run after `git worktree add` and before the links; a failing command stops `new`. Every repository runs its own setup in its own worktree: `repos[].setup` in the spec, else the `setup` of that repository's `.agentctl.yaml`. The top-level spec `setup` and the global one belong to the first repository only (compatible with single-repo specs). The preview lists them per repository (`backend 1/1, client 1/1`). The chat (MCP) cannot send `setup`, top-level or per repo; project config setup still runs. |
| `defaults` | mapping · `{}` · g p | Values for a spec that leaves them out: `agent`, `model`, `effort`. |
| `defaults.agent` | active provider · none · g p | Agent when the spec has no `agent`. |
| `defaults.model` | string · `default` · g p | Model when the spec has none. `default` passes no model flag. |
| `defaults.effort` | `low` `medium` `high` `xhigh` `max` · `high` · g p | Effort when the spec has none. |
| `defaults.remote_control` | boolean · `false` · g p | `true`: Claude tasks start with Remote Control (see the spec key `remote_control`) unless the spec says `remote_control: false`. A Codex task is not affected. |
| `providers` | global · `[claude, codex]` | Active providers in order; both claude and codex are required, without duplicates. |
| `providers_config` | mapping · `{}` · g | Per-provider launch overrides: `providers_config.glm.command` and `providers_config.glm.env` (see [GLM](providers.md#glm-coding-plan-zai)). |
| `providers_config.glm.command` | string · `claude-glm` · g | The executable that starts GLM tasks (one name or path, no arguments). |
| `providers_config.glm.env` | mapping · `{CLAUDE_CODE_AUTO_MODE_SERVER: "0"}` · g | Environment of every GLM task, added to the built-in default; a key you set wins over the default. The Z.ai endpoint and token (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`) are refused: they come only from the wrapper. |
| `start_failure` | mapping · `{keep_window: true}` · g | What a start that did not reach the agent's input leaves behind. |
| `start_failure.keep_window` | boolean · `true` · g | `true`: the window of a failed start (the agent never showed its input) stays open for diagnosis, and its last screen is saved in `<state_dir>/<task>/start-failure-screen.txt` either way. `queue_retry` closes the leftover window first. `false`: the window is closed at once (the capture stays), so it cannot hold a provider slot. A window that waits for you (folder trust, first-run onboarding) is never closed. |
| `cache` | path · ~/Projects/cache · g | Directory with one folder per task, `<cache>/<task>/`: the only place the agents write to (reports). |
| `state_dir` | path · `<config dir>/tasks` · g | agentctl's own state per task (`TASK.md`, `setup.log`, `event.json`, `notified.json`), out of the agents' reach. Closed tasks are archived next to it, in `archive/`. |
| `tmux` | mapping · socket unset · g | Optional dedicated tmux server. |
| `tmux.socket` | string · unset · g | Server name passed to `tmux -L` for every invocation; letters, digits, `_` and `-`. Default: existing server selection. Doctor checks server/session AGENTCTL_HOME. |
| `session` | string · `agentctl` · g | Name of the tmux session. Letters, digits, `_` and `-`. |
| `ui` | mapping · `{}` · g | Instance labels for the board, tmux status-left and board/watch terminal titles. |
| `ui.instance_name` | string · automatic · g | Override `agentctl` (prod) or `agentctl-dev` (doctor/version dev detection). 1–64 letters/digits/spaces/dots/underscores/hyphens. Applied at board/watch/status-bar startup; restart those views after changing it. |
| `equivalents` | list · `[]` · g | Extra equivalents for active providers, e.g. `{claude: "opus/medium", codex: "gpt-6-astra/low", kimi: "kimi-for-coding/high"}`, consulted before the built-in table. Each provider column is `model/effort`. |
| `mirror_dir` | path · none (off) · g | `status` and `pull` copy reports and `status.json` there. |
| `preview` | mapping · `{ttl_s: 600}` · g | MCP preview token lifetime and argument identity. |
| `preview.ttl_s` | positive seconds · `600` · g | Lifetime measured from preview creation; responses include TTL and expiry. Canonical YAML key order/formatting and trailing prompt whitespace are ignored. Read tools and unrelated starts do not invalidate previews. Destructive target changes still require a fresh preview; refusals identify TTL, changed fields, session or invalidation. |
| `delivery_confirm_s` | seconds · `60` · g | Watch deadline for uncertain prompt delivery; positive number. Start/send succeeds with a warning while checking; no evidence by the deadline produces needs-attention. |
| `AGENTCTL_HOME` | — | Directory of the global config instead of `~/.agentctl`. |
| `CODEX_HOME` | — | Where agentctl looks for the `notify` command of Codex's own `config.toml`, to forward to it (default `~/.codex`; a spec's `env` may set it). |
| `guide` | mapping (global), path (project) · `{lang: en}` globally · g, p | Global guide settings; project `.agentctl.yaml` uses `guide: docs/agent-dispatch.md` (repository-relative or `~/…`) as a trusted project overlay. A missing file warns in guide and doctor, and does not fail an order. |
| `guide.lang` | en or pl · en · g | Default language for CLI, MCP and manager shared guide. |

## Spec and review

| Key | Type / default / layers | Meaning |
|---|---|---|
| `wall` | mapping · see below · g | WALL: the message board of your chats and agents (channels, chats, subscriptions, ref roots). |
| `task` | string · required · s | Task ID: uppercase letters, digits, `-`, `_`, starting with a letter, up to 40 characters (`NC-42`). The window is the lowercase ID. |
| `agent` | active claude/codex/kimi/glm · `defaults.agent` · s | Agent that runs the task. Required unless a `defaults.agent` is set. |
| `class` | one of the matrix classes · none · s | Task class from [data/model-matrix.yaml](../../data/model-matrix.yaml) (`report`, `simple`, `gate`, `smoke`, `feature`, `bugfix`, `review`, `merge`, `hard`, `sim`, `visual`, `visual-compare`, `design`, `creative`, `escalate`): with `agent`, the model and effort come from the matrix, before configured defaults. An explicit `model`/`effort` wins, with a preview warning when it contradicts the matrix. An unknown class is an error listing the classes; a class whose cell is `none` refuses that agent. |
| `model` | string · `defaults.model`, else `default` · s | Model name passed to the agent. `default`: no model flag. |
| `effort` | `low` `medium` `high` `xhigh` `max` · `defaults.effort`, else `high` · s | Effort level. Codex has no `max`. |
| `repos` | list · required · s | At least one repository. The agent starts in the worktree of the first one. |
| `repos[].path` | path · required · s | The existing checkout. |
| `repos[].worktree` | path · `<worktree_root>/<repo>-<task>` · s | Where the new worktree goes. Must differ from `path`. |
| `repos[].setup` | list of strings · none · s | Shell commands for this repository's own worktree (see `setup`). The chat cannot send it. |
| `repos[].base` | git ref · none · s | Start point of the worktree. |
| `repos[].branch` | string · none · s | Branch to create (or reuse). Without it the worktree is detached. |
| `review_of` | task ID or list · none · s | The task(s) under review. For every listed task the reviewer must use another agent or another model than its author; the preview warns when the reviewer shares the author's provider. The first ID is the primary reviewed task. |
| `keep_cache` | boolean · `false` · s | Keep all task cache entries during gc. Default cache deletion is off; include_cache: true / --include-cache requires explicit owner confirmation. Report persist/artifacts/refs also protect entries. |
| `remote_control` | boolean · `false` · s | `true` (Claude only): the agent starts with `claude --remote-control <TASK>`, so the task shows up as a session named after it in the Claude app (Code) and can be answered from the phone. It goes with `--settings` (the event hooks), `--model` and `--effort`: it is an interactive session, not the server mode `claude remote-control`. The first start asks in the window once to "Enable Remote Control" (agentctl does not answer it, like the folder trust). A `needs-input` notification to the phone then says where to answer. `remote_control: true` on a Codex task is an error. Needs a claude.ai login (Pro, Max, Team, Enterprise), not an API key. |
| `pin` | boolean · `false` · s | `true`: never move the task to the other provider, by `--agent` or by a limit. |
| `after` | task ID or list · none · s | Complete reports and accepted first-line verdicts. Missing verdict waits while author is live or report settling; rejection blocks. Corrected accepted reports auto-unblock next watch tick. Unknown tasks/cycles fail. |
| `after_verdict` | non-empty verdict list · `[PASS, PARTIAL]` · s | Non-empty accepted list; requires after. Default PASS/PARTIAL with first-line aliases PASS with findings and GO. |
| `touches` | glob or list of globs · none · s | Files the task will change. `queue` and `new` warn (and ask y/N) when an active task of the same repository already changes matching files. |
| `integration` | boolean · false · s | Suppress overlap warnings with a note; other tasks compare the spec base and exclude imported merges. |
| `cohort` | name · none · s | The cohort of the task: letters, digits, `-`, `_` and `.` (at most 40 characters), compared without regard to case and shown as it was first written. The cohort is made by its first task; its file is `<config dir>/cohorts/<name>.json`. Without the key the task belongs to no cohort (there is no default one). `new --cohort` and `queue --cohort` override it for the whole file. See [cohorts](../details.md#cohorts). |
| `weight` | `normal` or `heavy` · `normal` · s | Heavy tasks share the queue cap across providers; starting tasks and live task windows count, including report-ready. Immediate new is outside queue admission. |
| `priority` | `high` or `normal` · `normal` · s | Queue order: `high` tasks start before every `normal` one (first come, first served inside each class). `new` ignores it. |
| `report.settle_s` | — | 30 seconds without report changes after an ended agent turn. Set with mapping syntax below. Zero disables the settling delay, not attempt checks. |
| `report.path` | — | Canonical path in mapping syntax, compatible with legacy report: path. |
| `report.paths` | — | Canonical first path and detection alternatives in mapping syntax, compatible with legacy report: [paths]. |
| `cohort.done_grace_s` | `300` | Wait after the last observed membership or task-state change before announcing all reports ready. Adding work cancels the pending completion; persisted across watcher restarts. `0` restores immediate notices. |
| `review` | disabled · global, project, spec | Automatic review settings. In a spec: `auto`, `false`, or `{agent, model, effort, prompt_template}`. |
| `review.default` | `false` · global, project | `auto` schedules a review after a complete author report. Explicit spec `false` disables it. |
| `review.agent` | other provider · global, project, spec | Explicit reviewer provider. Prefer a different installed provider; if unavailable or unmapped, use a different configured model on the author provider. |
| `review.model` | equivalents · global, project, spec | Reviewer model; no guessed models. A same-provider reviewer must use another model. |
| `review.effort` | equivalents · global, project, spec | Reviewer effort, validated against the selected provider. |
| `review.template` | built-in · global, project | Path to a review prompt. Alias of `prompt_template`; relative paths use the author repository. Default example: [review-template.md](../examples/review-template.md). |
| `review.prompt_template` | built-in · global, project, spec | Template path. Placeholders: `{task}`, `{report}`, `{delta}`. |
| `review.rerun` | `false` · global, project, spec | A new author report schedules `TASK-REV2`, then `REV3`, etc.; the previous scheduled review SHA becomes the next delta base. |
| `review.prefer` | provider IDs · `providers` order | First active installed mappable provider other than the author. Inactive IDs are skipped. |
| `read_only` | — | Task spec boolean: detached worktrees only; skip setup and links, install a task-scoped commit-refusing Git hook, retain a HEAD baseline for CONSULT report findings. This is a cooperative guard, not an OS sandbox. |
| `report.clean_worktree_cache` | boolean · true · g | Remove eligible per-worktree .cache after a current sentinel report settles and its turn ends; shared checkouts, escaping symlinks and reports inside cache are protected. Does not remove node_modules. |

## Providers and limits

| Key | Type / default / layers | Meaning |
|---|---|---|
| `limits` | mapping · none · g | Most simultaneous windows per provider. |
| `limits.claude` | positive integer, `0` or `off` · unlimited · g | Cap for Claude windows (agentctl windows + reserved places + external sessions when counted). `agentctl limits set claude=3` changes it. `0` means no limit (kept for compatibility); `off` disables the provider: no Claude window starts. |
| `limits.codex` | positive integer, `0` or `off` · unlimited · g | Cap for Codex windows. `0` = no limit, `off` = disabled. |
| `limits.heavy` | positive integer · `1` · g | Maximum queued heavy tasks running or starting across providers; previews explain waits. |
| `limits.count_report_ready` | boolean · `false` · g | Idle windows with a complete report do not occupy provider slots by default. Capacity/limits separate working windows and reports awaiting collection. A follow-up counts again; send warns and refuses to resume it when the provider is full. |
| `limits.count_external` | boolean · `false` · g | Terminal sessions of active providers (`claude`, `codex`, `kimi` when enabled) outside the windows of agentctl (found with `ps`, not MCP servers, headless runs or agentctl itself) count against the limit and show as "external" in `agentctl limits`. Places for agents you start by hand can also be held with `agentctl limits reserve`. |
| `agents` | mapping · see below · g | Settings per provider: `agents.claude`, `agents.codex`, `agents.kimi` (when enabled). |
| `usage` | mapping · see below · g | Token usage and plan limits: thresholds, queue hold, tmux status line, where the agents keep their logs. |
| `usage.warn` | percentage or mapping · `80` · g | From this percentage of a plan window `watch` sends one notification per window and reset. |
| `usage.critical` | percentage or mapping · `95` · g | The same, louder; not below `warn`. |
| `usage.queue_hold` | percentage, mapping or `false` · `false` · g · The queue does not start a task of a provider whose plan is above this percentage (in any window); `queue list` says so. `false`: the plan never holds the queue. Set live with MCP `set_limits` `queue_hold` or `agentctl limits set queue_hold=90 · off | queue_hold.<provider>=N`; a running watch applies it from its next tick. |
| `usage.status_line` | boolean · `true` · g | The plan percentages (`C 62% · X 18%`) in the tmux status line of the agentctl session. |
| `usage.claude_tap` | boolean · `true` · g | `new` sets the `statusLine` of a Claude window to `agentctl usage-tap`, which records the plan limits that Claude gives only to a statusLine and passes your own statusLine on. `false`: Claude's limits are n/d. |
| `usage.claude_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Where Claude Code keeps `projects/` (the transcripts). |
| `usage.codex_dir` | path · `$CODEX_HOME`, else `~/.codex` · g | Where Codex keeps `sessions/`. |
| `usage.glm_dir` | path · `$CLAUDE_CONFIG_DIR`, else `~/.claude` · g | Transcript root: explicit usage.glm_dir, else process CLAUDE_CONFIG_DIR, else ~/.claude. Set to the wrapper directory for separate accounting; onboarding discovery separately inspects the wrapper. |
| `agents.<agent>.flags` | list of strings · `[]` · g | Extra flags appended to the agent command line. |
| `agents.<agent>.effort_args` | list of strings · claude `['--effort', '{effort}']`, codex `['-c', 'model_reasoning_effort={effort}']` · g | Flags that carry the effort; `{effort}` is replaced. `[]` passes nothing. |
| `agents.<agent>.ready_pattern` | regex · see below · g | The agent shows its input box. |
| `agents.<agent>.ready_timeout` | seconds · `60` · g | How long `new` waits for `ready_pattern`. |
| `agents.<agent>.trust_pattern` | regex · see below · g | The agent shows its folder-trust dialog. agentctl never answers it. |
| `agents.<agent>.dialog_pattern` | regex · claude and glm: the first-run onboarding screens (see below), codex `'Update available\|Skip until next version'` · g | Another startup dialog a human must answer (the Codex "Update available" modal, Claude Code's first-run onboarding: theme picker, "Security notes … Press Enter to continue", login choice): `new` stops at it at once as needs-input (with a clear line and a notification, the window stays) instead of failing after `ready_timeout`; once you have answered it, watch carries on with folder trust, the input and the prompt. agentctl never answers it. Codex task windows also start with `-c check_for_update_on_startup=false`, so a current Codex does not show the modal at all. |
| `agents.<agent>.trust_timeout` | seconds · `600` · g | How long `new` waits for you to answer the trust dialog. |
| `agents.<agent>.working_pattern` | regex · see below · g | A turn is running, including Claude 2.1.x spinner progress. The spinner frame `✳` is not in the pattern: it counts only as a spinner line (word, `…`, a bracket that starts with the elapsed time) right above the input box, never in the transcript, whatever the pattern says. |
| `agents.<agent>.delivery_pattern` | regex · see below · g | New adapter assistant output acknowledges a submitted prompt; input drafts never count. |
| `agents.<agent>.interrupt_key` | tmux key name · `Escape` · g | Key sent by `agentctl interrupt`. |
| `agents.<agent>.footer_patterns` | list of regexes · see below · g | Lines of TUI chrome that `status` and `peek` skip. |
| `agents.<agent>.question_pattern` | regex · see below · g | The agent asks you something and waits (state `needs-input`). |
| `agents.<agent>.async_question_pattern` | regex · see below · g | An asynchronous question the agent is not waiting on while it works (Codex's collapsed "? N question · … to answer"); `needs-input` only once the agent is no longer working. |
| `agents.<agent>.limit_patterns` | list of regexes · see below · g | The usage limit is used up (state `limited`). A message has to open its line, so a diff or a quoted sentence is not taken for one. |
| `agents.<agent>.background_patterns` | list of regexes · see below · g | The agent waits for its own shells or monitors (state `background`). |
| `capacity` | mapping · see below · g | Dispatcher capacity settings. |
| `capacity.load_threshold` | positive number · 3 × logical CPUs · g | Watch emits machine-load-high and machine-load-recovered on 1-minute load crossings. Capacity JSON/text and status --detail include load (1/5/15 min) and free memory bytes. |
| `capacity.snapshot` | boolean · true · g | Add both providers' capacity to new and queue responses. |
| `capacity.stale_minutes` | integer 1–10080 · 30 · g | Reading age that sets stale; emits one event per reading while that provider has active task windows. |
| `capacity.sample_limit` | integer 2–10000 · 2048 · g | Maximum combined provider samples in `usage-samples.jsonl` (under 10 MB even at maximum). Each distinct usage reading is sampled; repeated timestamps do not create samples. |
| `capacity.thresholds` | percentage list · `[80, 95]` · g | Up to 20 thresholds applied to each provider window. Crossings and reset events are deduplicated per provider, window and reset boundary. `usage.warn`/`critical` independently control desktop/phone warnings. |
| `capacity.codex_refresh` | boolean · true · g | For capacity, query Codex app-server account/rateLimits/read (3 s deadline), without a thread or agent turn. False uses existing session readings only. Failure retains the original timestamp and provenance of the last known reading. |
| `overload` | — | Technical recovery of provider overload; independent of usage limits. |
| `overload.auto_retry` | — | `true`; retry only at a visible idle prompt with no draft or background work. |
| `overload.retry_after` | — | `300` seconds between attempts; recheck busy windows next watch tick. |
| `overload.max_retries` | — | `3`; then keep overloaded and notify “wymaga uwagi”. Attempts persist and are journaled. |
| `overload.message` | — | `kontynuuj`; submitted as a prompt, never a command. |
| `agents.<agent>.overload_patterns` | — | Adapter-specific regexes matched only against the last non-chrome error element, outside fenced code. Claude: ⎿ API Error: 529 or ⎿ Overloaded directly below a ⏺ block (not tool output or intervening prose); Codex: ■ Selected model is at capacity. Mentions, test output and stale errors do not match. `[]` disables screen overload detection for this adapter. |
| `overload.give_up_after` | — | 1800 seconds from the start of an overload episode, including time when retry is unsafe. Independent of max_retries. Brief working/waiting does not reset it; watcher restarts preserve it. Completion/report clears it. |
| `overload.reset_after_s` | — | 600 seconds of continuous working without another overload before clearing the episode. Waiting/background/question interrupts the recovery timer. |
| `limited` | see below · global | Recovery of windows stopped at a provider usage limit; never changes provider or model. |
| `limited.auto_resume` | `true` · global | Send `limited.message` after confirmed recovery at an idle, empty composer. |
| `limited.resume_above_percent` | `5` · global | Remaining percentage must be strictly above this threshold (0–<100), from a fresh reading since the episode; a known elapsed reset also permits recovery. Unknown/stale readings do not imply recovery. |
| `limited.message` | `kontynuuj` · global | Recovery message. Uses overload retry delay, maximum attempts, give-up interval and sustained recovery duration. |
| `agents.<agent>.accepts_busy_prompt` | `true` · global | Claude/Codex accept follow-ups while working. Set `false` for an adapter that needs idle; messages remain in a durable FIFO, visible in status/peek. |
| `agents.<agent>.env` | Global · `{}` | Per-provider environment; task env overrides it. Kimi telemetry is disabled by default; trust bypass and disabled dangerous-command guard are rejected. |
| `agents.<agent>.approval_pattern` | Global · Adapter default | Separate approval dialog regex; Kimi approvals and question Submit are distinct panels. |
| `agents.kimi` | mapping · adapter defaults | Interactive Kimi settings; registered always, active only in `providers`. |
| `limits.kimi` | positive integer · unlimited | Simultaneous Kimi task windows, reservations and optional external sessions. |
| `usage.kimi_dir` | path/null · `$KIMI_CODE_HOME`, else `~/.kimi-code` | Legacy Kimi home fallback. `agents.kimi.env.KIMI_CODE_HOME` takes precedence, then this explicit setting, then process `KIMI_CODE_HOME`, then `~/.kimi-code`. Task windows, doctor and passive reads share this resolver. Only config.toml and candidate session logs are read. |
| `capacity.kimi_usage_probe_model` | string · `k3` | Model alias for the slash-command-only probe; configurable, including `default`. The default never selects Highspeed. No thinking effort is set or inherited; no model turn is submitted. |
| `capacity.kimi_usage_probe` | boolean · false | On-demand hidden TUI `/usage` probe in `<agentctl home>/kimi-usage-probe`; at most once per five minutes. |
| `limits.glm` | positive integer, `0` or `off` · `2` · g | Cap for GLM windows (agentctl windows + reserved places + external sessions when counted); `0` = no limit, `off` = disabled. Separate from the Claude account limit. |
| `capacity.claude_usage_probe` | boolean · false · g | Neutral slash-command-only /usage; no inference prompt. |
| `capacity.claude_usage_probe_interval_minutes` | integer 15–10080 · 15 · g | Minimum interval between attempts, including failures. |

## Watch, board and notifications

| Key | Type / default / layers | Meaning |
|---|---|---|
| `watch` | mapping · see below · g | `agentctl watch` and the window icons. |
| `notify` | mapping · see below · g | Notifications and the events of the agents. |
| `board` | mapping · see below · g | The board and the navigation in the tmux session. |
| `away` | mapping · see below · g | When the phone gets notifications: `away.auto_idle`. See also `notify.ntfy`. |
| `manager` | mapping · see below · g | The dispatcher session you talk to from the Claude app on the phone (`agentctl manager`). |
| `watch.interval` | seconds · `15` · g | Time between two polls of the watcher. |
| `watch.idle_confirm_ticks` | positive integer · `2` · g | Consecutive idle reads required after visible work before waiting. Working resets the counter. Stop may end an idle turn immediately; running tools/spinners always win over Stop. |
| `watch.waiting_after` | seconds · `120` · g | How long an idle task may wait before it is worth a notification. |
| `watch.window_icons` | `true`, `false` or mapping · `true` · g | State icon in front of tmux window names. A mapping replaces single icons by state name (`{working: "▶", needs-input: "❓"}`); `false` leaves the names alone. |
| `watch.status_line` | boolean · `true` · g | `watch --tmux` shows the task counts in the status bar of the agentctl session. |
| `notify.backend` | `auto`, `terminal-notifier`, `osascript` · `auto` · g | Channel of desktop notifications. `auto` tries terminal-notifier (a click goes to the window) and falls back to osascript when it fails. |
| `notify.events` | boolean · `true` · g | The agents report questions, end of turn and limits to `agentctl event` (Claude hooks, Codex `notify`). `false`: screen reading only. |
| `notify.turn_end` | boolean · `true` · g | A notification when a turn ends and the agent waits. `false`: only questions, reports and limits. |
| `notify.terminal_app` | bundle ID · detected · g | The terminal app a click on a notification brings to the front, for example `com.apple.Terminal`. |
| `notify.verdict_pattern` | regex · none · g | Picks the report line quoted in the "report ready" notification; its first group, else the whole line. Without it: the `verdict` of the report's `agentctl-outputs` block, else a verdict line in the report header (`Werdykt: PASS`, `Verdict - FAIL`, or `# Werdykt` with the value on the next line); never an arbitrary line of text. |
| `notify.ntfy` | mapping · none · g | Notifications to a phone through [ntfy](https://ntfy.sh); the keys below. Without `topic` nothing is sent. `agentctl ntfy-setup` writes it for you. |
| `notify.ntfy.server` | URL · `https://ntfy.sh` · g | The ntfy server; your own for a private one. |
| `notify.ntfy.topic` | text · none · g | The topic the phone subscribes to (letters, digits, `_`, `-`). On the public server its name is the only protection: keep it long and random. |
| `notify.ntfy.token` | text · none · g | Bearer token for a private server or an ntfy account. |
| `notify.ntfy.events` | list · all ten · g | `needs-input`, `needs-trust`, `limited`, `blocked`, `report-ready`, `cohort-done`, `queue-failed`, `orphan`, `dead`, `usage-critical`. |
| `notify.ntfy.priority` | mapping · `needs-input`, `limited`, `usage-critical`: `high`; the rest `default` · g | ntfy priority per event: `min`, `low`, `default`, `high`, `urgent`. |
| `notify.ntfy.include_question` | boolean · `false` · g | Opt in to sending question text to the phone (clipped to 120 characters). By default only the opening instructions and session hints are sent; local notifications, board, peek and status/MCP retain the question. Reloads live, including queued retries. |
| `notify.ntfy.include_verdict` | boolean · `true` · g | The first line of the verdict goes into "report ready". Never more of the report; no paths or file names. |
| `notify.ntfy.click_url` | URL · none · g | Opened by a tap on the notification, for example the address of the chat. |
| `notify.ntfy.always` | boolean · `false` · g | Send always, not only while `agentctl away` is on. |
| `away.auto_idle` | minutes · none · g | The Mac counts as away after this many minutes without keyboard or mouse (macOS, `HIDIdleTime`), and back at the first touch. Off by default; `agentctl away on|off` always works. |
| `manager.project` | path · none · g | The directory the session runs in (it should be a folder you have trusted in Claude Code, e.g. `~/src/sample-app`). Without it the manager runs in the directory where `agentctl manager` is typed. `--project` overrides it. |
| `manager.name` | string · `agentctl manager` · g | The name of the session in the Claude app (`claude --remote-control <name>`). One line, at most 80 characters. |
| `manager.model` | string · `sonnet` · g | `--model` of the session; `default` passes none. |
| `manager.effort` | `low` `medium` `high` `xhigh` `max` · `medium` · g | `--effort` of the session. |
| `manager.guide` | path · none · g | A local copy of the rules for writing specs (`claude/AGENTCTL-SPEC-GUIDE`): its text is appended to the role of the manager. Optional; a missing file is a warning, not an error. |
| `manager.autostart` | boolean · `false` · g | `agentctl up` starts the manager too. |
| `board.auto_hide_pulled_dead` | boolean · `true` · g | Pulled tasks without a window hide automatically except report-ready, which remains visible until closed. |
| `board.pulled_collapse_after` | number · `0` · g | Minutes since pull before cohort collapse; 0 is immediate. |
| `board.pulled_auto_close_after` | number/false · `false` · g | Owner opt-in: watch closes pulled report-ready tasks N hours since pull, with an event, keeping worktrees. |
| `board.mouse` | boolean · `true` · g | `mouse on` in the agentctl tmux session (this session only). |
| `board.return_key` | tmux key name or `false` · `F12` · g | Key (no prefix) that goes back to the board from any window of the session. `false`: none. |
| `board.model_versions` | alias → quoted version mapping · `{}` · g | Fallback versions for aliases after observed session model; never guessed. |
| `board.list_width` | integer >=64 or percentage string · automatic · g | List width with preview; 92+ at 140+ terminal columns by default, at least 32 columns left for preview. |
| `board.cohorts_recent` | integer >= 1 · `10` · g | How many of the most recently active cohorts the board's `k` choice lists (cohorts with active or queued work always show). Older quiet cohorts fold into `starsze… (n)`; ↑↓ PgUp/PgDn scroll the choice. `agentctl cohort archive` removes finished cohorts from it altogether. |
| `board.window_title` | boolean · `true` · g | The board names its terminal window `<instance> <version> · board` (OSC 2 with xterm title-stack restoration) and temporarily sets this session’s `set-titles` / `set-titles-string` (`<instance> <version> · #W`). Previous title settings are restored on exit. `false` disables board title changes; the instance label in status-left remains. |
| `board.selected_color` | Ink color name · `blue` · g | Color for the selected board row, manager line and queue entry. State and result cells keep their own colors. `NO_COLOR` disables color; the selection stays bold (manager line uses inverse video). |
| `notify.mcp_writes` | `summary` · global | `all`, `summary`, `off`. Audit and journal still record every write. Summary emits at most once per interval; watch flushes pending summaries. |
| `notify.mcp_writes_interval_s` | `60` · global | Positive seconds between write summaries, persisted over restarts. |

## Queue, MCP, WALL and maintenance

| Key | Type / default / layers | Meaning |
|---|---|---|
| `mcp` | mapping · see below · g | The local MCP server. |
| `queue` | mapping · see below · g | The task queue (`agentctl queue`). |
| `collisions` | mapping · see below · g | Warnings about two active tasks changing the same files. |
| `cancel` | mapping · see below · g | `agentctl cancel`: how a task at work is stopped. |
| `mcp.allow` | list · `[]` · g | Write tools the chat may call: any of `send`, `new`, `interrupt`, `close`, `move`, `queue`, `queue_rm`, `cancel`, `mark`, `set_limits`, `reserve`, `resume` (full list below); `wall` allows the three WALL writes (`wall_post`, `wall_reply`, `wall_set_status`). Read again on every call. |
| `mcp.allow_rm_worktree` | boolean · `false` · g | `close` and `cancel` from the chat may also remove the git worktree (never forced). |
| `wall.channels` | mapping · `agentctl`, `nc`, `hems`, `shared:sim`, `shared:weather`, `shared:maps` · g | The channels. A name is lower-case words with an optional `group:` prefix. |
| `wall.channels.<name>.authors` | list · `[owner]` (built-in: `agentctl` and `shared:*` `["*"]`; `nc`/`hems` owner, their chat, `task:*`) · g | Who may post: `owner`, `chat:<name>`, `chat:*`, `task:<ID>`, `task:*`, `*` (every known identity). |
| `wall.channels.<name>.description` | text · none · g | Shown by `wall channels`, `wall_read` and the board. |
| `wall.chats` | mapping · `nc` (`nc`, `agentctl`, `shared:*`), `hems` (`hems`, `agentctl`, `shared:*`), `agentctl` (`agentctl`, `shared:*`) · g | The chats that may name themselves with `as: "chat:<name>"`. Any other name is unknown: it reads only `agentctl` and posts nothing. |
| `wall.chats.<name>.channels` | list · `[agentctl]` · g | Channels (patterns like `shared:*`) the chat reads and may post in (posting also needs the chat among the channel's authors). `agentctl` is always readable. |
| `wall.chats.<name>.clients` | list · `[]` · g | MCP client names (the client's initialize name) that are this chat without an explicit `as`. |
| `wall.subscriptions` | mapping · own channel + `agentctl` + `shared:*` · g | Per chat (or MCP client) name: the channels whose `WALL` events `events_since` returns. Limited to what the chat reads. The owner (CLI, board) sees everything. |
| `wall.ref_roots` | list · `[~/Projects/cache]` · g | A path in `refs` must be under one of these; nothing is read from it (refs only, no attachments). |
| `queue.enabled` | boolean · `true` · g | `false`: `watch` never starts a queued task (entries can still be added and listed). |
| `queue.parallel_starts` | positive integer · `2` · g | Most queued tasks that `watch` is in the middle of starting (worktree, setup, waiting for the agent or for the folder-trust dialog) at the same time. |
| `cancel.grace` | seconds (0 or more) · `5` · g | Time between the interrupt key and the closing of the window of a task that is cancelled while it works. `0`: the window is closed at once. |
| `collisions.enabled` | boolean · `true` · g | `false`: no `COLLIDE` column, no marker on the board, no notification. `agentctl overlap` still works. |
| `collisions.interval` | positive number · `300` · g | Seconds between two checks by `watch`. |
| `collisions.notify` | boolean · `true` · g | One notification for each new pair of colliding tasks. |
| `collisions.ignore` | list of globs · `[]` · g | Paths that never count as shared, e.g. `["**/package-lock.json", "dist/**"]`. |
| `disk` | mapping | Disk thresholds, in GiB (1024³ bytes). |
| `disk.worktree_share_percent` | `20` | Warn when known worktrees exceed this percentage of their own filesystem; positive and at most 100. Status/doctor/disk events suggest agentctl gc --preview with safe reclaimable bytes. Budgeted reads show n/d; close reports task worktree bytes. |
| `disk.warn_gb` | `50` | Warn below this available space on any known filesystem. |
| `disk.critical_gb` | `20` | Critical below this space; must not exceed warn_gb. |
| `disk.workers` | `2` | Process-wide tree-measurement worker cap shared by disk facts, capacity, previews and GC; integer 1–8. A lower reloaded cap admits no new work until existing workers drain below it. |
| `disk.measurement_timeout_s` | `600` | Maximum execution time of a tree measurement. A timed-out worker is terminated and frees its slot; reads retain the last known value and report a measurement error. |
| `git` | mapping | Worktree checkout and setup limits. |
| `git.timeout_s` | `600` | Positive timeout in seconds for worktree add (including checkout) and each setup command. |
| `mcp.client` | — | Optional stable suffix to clientInfo.name that intentionally shares a cursor between sessions. Tool parameter client overrides it. By default each session consumes independently from its initialization checkpoint; new sessions inherit the client high-water mark. |
| `mcp.max_response_kb` | `8` | Limit of each serialized MCP tool result in KiB (1–1024). Larger results return fragments through `response_page`; continuation never repeats the operation. |

## Example

~~~yaml
providers: [claude, codex, kimi, glm]
worktree_root: ~/Projects/worktrees
cache: ~/Projects/cache
session: agentctl
limits: {claude: 2, codex: 2, kimi: 2, glm: 2, heavy: 1}
usage: {queue_hold: {claude: 90, codex: 85, kimi: 90, glm: 90}}
report: {path: "{cache}/{task}/{TASK}.md", settle_s: 30}
mcp: {allow: []}
~~~

[MCP](mcp-tools.md) · [Providers](providers.md) · [Tutorial](tutorial.md)

## WALL defaults / Domyślne czaty WALL

~~~yaml
mcp:
  allow: [wall]
wall:
  chats:
    nc: {channels: [nc, agentctl, "shared:*"]}
    hems: {channels: [hems, agentctl, "shared:*"]}
    agentctl: {channels: [agentctl, "shared:*"]}
~~~

## Hotfix 0.22.4: provider holds, snapshots and integrations

`set_limits` accepts `hold: {glm: "21:50"}` (next local occurrence), an ISO timestamp, a duration such as `"3h"`, or `"off"`. Every active provider supports it. CLI: `agentctl limits set hold.glm=3h`; clear with `hold.glm=off`. These durable holds are independent of percentage-based `queue_hold` and do not require a usage reading. They block queued and explicit asynchronous starts, survive watch restarts, appear in queue_list/limits/capacity/board, and expire with a `limits-changed` event. `off` clears the current timed hold; a new provider error can hold it again.

Provider quota/rate-limit errors in windows, hooks and the pinned current-attempt transcript set `limited` and an automatic provider hold. A stated reset (ISO/local clock or Retry-After) wins; otherwise the hold lasts one hour. Stale evidence does not extend or re-arm it. Only provider error records count in transcripts; ordinary user/tool discussion does not. GLM usage can remain n/d while its provider is held. Fixtures cover Z.ai 1113 (balance), 1302 (rate), 1308 (usage/reset), Anthropic-compatible 429 and existing Kimi errors; [Z.ai error codes](https://docs.z.ai/api-reference/api-code), [Claude rate limits](https://platform.claude.com/docs/en/api/rate-limits). Fixtures are deterministic examples based on those documented formats, without inference or network calls in tests.

Cached text begins with `stan z HH:MM, 2h 44m temu`; JSON snapshot records carry `snapshot_age_s` (and object responses `snapshot_age`). Status snapshots or budget caches older than five minutes return a short queue/journal fallback with last-observed event times instead of a stale full table. It explicitly says that it does not probe live windows.

`integration: true` in the spec suppresses overlap warnings with an explicit note. Otherwise overlap uses the spec base through its merge-base and excludes files imported by the predecessor's own merges; uncommitted changes still count. Declare the branch being integrated as `repos[].base`. Integration is a declaration about warnings, not permission to merge.

A pending `queue_rm` is named with its request ID in queue previews. MCP `queue` with `replace: true` removes a waiting entry and adds the new spec in one watch step; starting entries are refused. Never-started removals are hidden `cancelled` tasks, without vanished-window alerts. Report instructions put the attempt marker after the first verdict line; parsers tolerate leading comments. Report reads/events expose `outputs_errors`; duplicate blocks select the last valid block with a finding. `Verdict:` and `Werdykt:` and documented check aliases remain accepted.
