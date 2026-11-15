# Token economics

## Three different budgets

Provider plan windows, local concurrency and token accounting answer different questions. A 5-hour window or weekly percentage is a provider reading, not a fixed number of tokens promised by agentctl. Some providers expose other windows (Kimi can expose monthly); absent windows remain `n/d`. Plan usage can include sessions outside agentctl. Subscription rules, available models and multipliers change; consult the official [provider pages](providers.md) for your account rather than treating examples as prices.

`limits.<provider>` caps concurrent slots. Missing/0 means unlimited; `off` disables starts. Report-ready idle windows do not count by default (`limits.count_report_ready: false`), but a follow-up counts again. Reservations hold places for manual use; `count_external` can include detected interactive sessions outside agentctl. The heavy queue cap is separate. More slots do not increase the provider's plan.

Token columns count observed fresh input, output and cache reads/writes, with reasoning output when supplied. Unknown is null/n/d, not zero. Provider accounting differs; raw totals alone do not establish money or equal work. GLM uses separate transcript accounting and provider identity, but its plan is n/d: no quota endpoint/CLI panel is implemented, so queue_hold never blocks it.

## Capacity and queue_hold

Before allocating work, read `capacity`: windows, used/remaining percent, reset, source, age/stale, consumption pace/projected exhaustion, slots/reservations, queue, disk/load, equivalents and seven-day model×effort statistics. Estimates carry a basis/confidence; they are not a quota guarantee. Old readings can underestimate recent external use. A stale flag does not make a missing reading usable.

~~~sh
agentctl capacity
agentctl usage --since 7d
agentctl limits
agentctl limits set queue_hold=90
agentctl limits set queue_hold.codex=85
agentctl limits set queue_hold=off
~~~

MCP `set_limits({queue_hold: {claude: 90, codex: "off"}})` follows preview/confirm and keeps config comments plus a backup. A running watch reloads it next tick. Hold prevents queued starts when a known provider window is at/above the configured threshold; it does not interrupt running agents or silently choose another provider. Missing readings do not prove spare quota. `usage.warn`/`critical` emit deduplicated notifications independently of hold. Plan reset/exhaustion and local slot availability are separate conditions.

A provider's `limited` state comes from a limit observation, not a low slot count. Recovery can wait for reset, continue the live window after recovery or explicitly move through equivalents; resume recreates a lost window. `limited.auto_resume` defaults true: when the known plan has more than `limited.resume_above_percent` remaining (default 5), watch can send the configured continuation. Set false when the owner should control that step. No automatic cross-provider move occurs. Overload retries have separate retry/count/time limits.

## Model, effort and cache

Choose from [data/model-matrix.yaml](../../data/model-matrix.yaml), using the least expensive class adequate for the task. Its generic progression is report/simple/smoke → feature/bugfix/review → hard/sim; visual and escalate have explicit-selection policy where configured. Creative has no Kimi mapping. These are routing defaults, not measured quality guarantees. The actual file is authoritative for aliases and effort; user equivalents precede built-ins. Explicit model/effort overrides class with a diagnostic.

Small bounded edits normally need less reasoning than uncertain debugging, architecture or a high-impact review. Higher effort may increase reasoning output, latency and quota consumption; a cheaper first pass can be more expensive after repeated fixes. A different reviewer can catch blind spots but adds another full context and turn chain. CONSULT costs panel size × rounds + synthesis, plus any repairs and review: reserve it for decisions whose value justifies that work.

Keep model and effort stable within an active task session. Model changes, new system prompts/tools and session/context rebuilds can change cache identity or reduce reuse. Effort-specific cache behavior belongs to the provider; agentctl does not invalidate, price or guarantee the vendor's cache. Change the order deliberately for a new task/attempt and record why, rather than repeatedly switching mid-session. Narrow follow-ups and stable project instructions generally preserve useful context better than resending entire reports.

## Cost per accepted task

Measure the entire outcome chain:

~~~text
cost per accepted task =
(execution + fixes + independent review + repeated gates) / accepted outcomes
~~~

Apply the formula separately to observed tokens, elapsed time or a documented money estimate. Do not add token counts to minutes, divide by all starts, or label an unreviewed PASS as a human acceptance. Example: 100k execution + 30k fixes + 40k review + 10k gate-related agent work = 180k observed tokens for one accepted outcome. Local deterministic tests themselves consume no model tokens; an agent interpreting/fixing failures can. Cache tokens should stay separate or use explicitly documented provider-specific weights. Subscription cost allocation is an owner policy, not an agentctl output.

`mark ok/partial/fail` is human evaluation; report verdict is self-assessment. Group author, continuation, move and review attempts into one outcome. Include cancelled/failed work in total effort and report unmarked cases. Compare like task classes and repository complexity; small samples, requested/observed differences and missing attribution limit conclusions.

## Benchmark dataset

~~~sh
agentctl dataset export --since 30d --format jsonl --out attempts.jsonl
agentctl dataset export --format csv --out attempts.csv
# Sensitive content is opt-in:
agentctl dataset export --include-prompts --include-reports --out content.jsonl
~~~

The local CLI export is read-only and has no MCP counterpart. It does not contact tmux, acknowledge reports or create state. New output files are mode 0600 and existing files/symlinks are refused. JSONL schema v1 has a header and one known attempt per row; CSV is a flat summary and rejects content switches. Use the [dataset schema](../dataset-schema.json) and [detailed export contract](../dataset.md).

Join by instance_id/project/task/attempt_id, preserve provenance/unknown dimensions, and keep related cohorts/chains together in training/evaluation splits. Do not infer historical CLI versions from today's exporter, fabricate old attempt IDs, divide task-wide resumed usage into invented attempt totals, or treat current percent as historical cost. Requested/resolved/observed settings, self_verdict and human_mark are distinct. Content opt-in exports available reports, not whole conversations; redaction is best effort, so review before sharing.
