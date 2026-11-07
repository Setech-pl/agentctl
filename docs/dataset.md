# Benchmark dataset export v1

`agentctl dataset export` is a local, read-only CLI command. It exports this
instance only; it does not contact tmux, migrate state, acknowledge reports,
save usage caches, or create projects. Package version remains 0.18.0.

```sh
agentctl dataset export --out attempts.jsonl
agentctl dataset export --since 30d --until 2026-11-05T23:59:59Z --cohort sprint --agent codex
agentctl dataset export --format csv --out summary.csv
agentctl dataset export --include-prompts --include-reports --out content.jsonl
```

`--out` creates a new file with mode 0600 and refuses existing files (including
symlinks). Without it the export goes to stdout. `--since` and `--until` are
inclusive bounds on attempt start time, falling back to the history event time
only when start is unknown; accept ISO dates/times or ages such as `12h`, `7d`,
`2w`. Ages are relative to export time. Cohorts use the normal case/whitespace
normalization; `--agent` matches the resolved provider exactly. Unknown times
are excluded when a time filter is supplied. Use explicit UTC offsets for
repeatable time slices.

JSONL starts with a header declaring `dataset_schema: 1` and independent
`content_included.prompts` / `content_included.reports` choices. Every following
line is one known task attempt. Validate each line against
[dataset-schema.json](dataset-schema.json); distinguish the header by
`type: "header"`. CSV has one ordinary column-header row and a stable flat
summary, with empty cells for unknown values. CSV rejects content switches.
CSV quotes fields using RFC4180; treat imported strings as data in spreadsheet
software.

## Identity, sources and unknowns

The join key is `(instance_id, project, task, attempt_id)`. `instance_id` is the
agentctl home basename, so owners combining homes with identical basenames
must keep their source export identity separately. Canonical `project` is null
for legacy data. History v1's `project` is a repository basename and is exported
as `repo_label` / `repo_labels`, never inferred as ownership. The reader also
accepts the future history v2 convention (canonical `project`, separate repo
labels). P25 can add ownership without renaming dataset fields or implementing
project scoping here.

History is read line by line, merging timestamped fields into one summary per
attempt; memory is proportional to distinct attempts, not history events. No
whole-history array or sorting is used. Malformed/partial lines are ignored;
the source is never repaired. Current and archived TASK.md records enrich those
summaries. GC'd tasks remain exportable from history alone. Future history
snapshots preserve attempt ID/number/start, review relation and agentctl version.
For old snapshots without IDs, group by `(task, started)` and leave attempt ID
and number null. Historical resumes cannot always be reconstructed: no extra
attempts or synthetic UUIDs are invented. A newer resumed state is a separate
known attempt when it cannot be matched explicitly.

`requested`, `resolved` and `observed` remain separate. A legacy observed model
without a provider does not prove a provider. CLI versions are null unless
persisted/observed; the current exporter version is not the historical runtime
version. Tokens preserve fresh input, output, cache read/write and optional
reasoning output (a subset of output). There are no fabricated costs or plan
percentages. Usage collection is read-only and is used only for a task's first
attempt when history has no token snapshot; resumed task-wide usage is not
silently split. Reasoning remains null when absent.

`self_verdict` comes from report outputs or an explicitly persisted verdict;
`human_mark` is the latest human mark and is never inferred from self-verdict.
Cancellation, moves, continuation/review links, commit references and output
checks are separate facts. Output validity uses the existing read-only report
and local Git validation; history-only outputs stay unknown. A pending or wrong
attempt report contributes no verdict/content. `provenance` explains sources
and attribution; `unknown` lists missing dimensions and attribution limitations.
An empty checks/commits list with unknown output provenance is not proof that
there were no checks/commits. End time is report/close/cancellation evidence,
not the time of export or of a later human mark.

## Joining prompts and answers

Content is absent by default. Explicit `--include-prompts` adds `prompt_text`
from the original TASK.md prompt (including archived state); `--include-reports`
adds `report_text` from an eligible report. The report is the available answer
artifact, not a complete provider conversation. Join these fields on the same
identity tuple as summary rows. With null attempt IDs, join only within the
same export using task plus start time and keep the uncertainty visible; never
join solely on task across instances. A resumed attempt's original prompt is
not an attempt-specific prompt, so it remains null and is flagged. Removed
prompts/reports remain null; provider transcripts are not exported as answers.

The shared secret redactor removes configured secret values, secret
assignments and URL credentials/query secrets from exported text, including
metadata and checks. The header makes opt-in content visible. Redaction cannot
detect every unlabelled secret; review content exports before sharing. Group
related continuation/review chains and cohorts together when splitting training
and evaluation data to avoid leakage or double-counting outcomes.
