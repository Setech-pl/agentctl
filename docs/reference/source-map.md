# Documentation verification map — 0.22.1

The bilingual manual shares chapter filenames. Runtime behavior was checked against the merged v0.22.0 code; 0.22.1 changes package metadata, documentation, test expectations and documentation generators only. Examples are instructional; the screenshot fixture is isolated and synthetic.

| Topic | Implementation | Existing deterministic coverage |
|---|---|---|
| Specs/layers/matrix | [config](../../src/core/config.ts), [spec](../../src/core/spec.ts), [matrix](../../data/model-matrix.yaml) | [docs](../../tests/docs.test.ts), [classes](../../tests/spec-class.test.ts) |
| Queue/after/P94 | [queue](../../src/core/queue.ts), [dependencies](../../src/core/depends.ts) | [verdict dependencies](../../tests/hotfix-0194-p89.test.ts), [regression catalog](../../tests/regression/CATALOG.md) |
| Accepted/confirmation/deferred writes | [tool registry](../../src/core/mcp-tools.ts), [requests](../../src/core/mcp-requests.ts), [watch](../../src/core/watch.ts) | [deferred](../../tests/p93b-mcp-deferred.test.ts), [contracts](../../tests/write-contracts.test.ts) |
| Prompt delivery/menu/FIFO | [send](../../src/core/send.ts), [field](../../src/core/input-field.ts), [answer](../../src/core/answer.ts), [prompt queue](../../src/core/prompt-queue.ts) | [busy Codex](../../tests/hotfix-0194-p90.test.ts), [menu](../../tests/p63-answer.test.ts) |
| Reports/outputs/events | [report state](../../src/core/report-state.ts), [outputs](../../src/core/outputs.ts), [events](../../src/core/chat-events.ts) | [reports](../../tests/p52-report-events.test.ts), [NC](../../tests/nc-workflow.test.ts) |
| Providers | [adapter registry](../../src/core/providers/registry.ts), [Claude](../../src/core/providers/claude.ts), [Codex](../../src/core/providers/codex.ts), [Kimi](../../src/core/providers/kimi.ts), [GLM](../../src/core/providers/glm.ts) | [Kimi](../../tests/kimi.test.ts), [GLM startup](../../tests/p95-p96-glm-start.test.ts), [Claude probe](../../tests/claude-probe.test.ts) |
| Limits/queue_hold/capacity/recovery | [limits](../../src/core/limits.ts), [usage limits](../../src/core/usage-limits.ts), [capacity](../../src/core/capacity.ts), [limited](../../src/core/limited.ts) | [hold](../../tests/qh-queue-hold.test.ts), [capacity](../../tests/capacity.test.ts), [usage](../../tests/usage-mcp.test.ts) |
| Board/WALL screens | [Ink](../../src/board/app.ts), [board state](../../src/core/board.ts), [WALL view](../../src/core/board-wall.ts) | [board](../../tests/board.test.ts), [WALL board](../../tests/wall-board.test.ts), [capture script](../../scripts/docs-gallery.ts) |
| WALL identity/secrets/posts | [WALL](../../src/core/wall.ts), [config](../../src/core/wall-config.ts) | [identity](../../tests/wall2-identity.test.ts), [secrets](../../tests/wall2-secrets.test.ts), [posts](../../tests/wall2-posts.test.ts) |
| CONSULT/read-only | [consult](../../src/core/consult.ts), [read-only guard](../../src/core/read-only.ts) | [consult suite](../../tests/consult.test.ts) |
| Review isolation | [review](../../src/core/review.ts), [review gate](../../src/core/review-gate.ts) | [review gate](../../tests/p70-review-verdict.test.ts) |
| Cleanup/history/benchmark | [GC](../../src/core/gc.ts), [history](../../src/core/history.ts), [dataset](../../src/core/dataset.ts), [cache cleanup](../../src/core/worktree-cache.ts) | [history](../../tests/history.test.ts), [dataset](../../tests/dataset.test.ts) |
| Notifications/phone | [notify](../../src/core/notify.ts), [phone](../../src/core/phone.ts), [manager](../../src/core/manager.ts) | [trust notification](../../tests/trust-notify.test.ts), [ntfy](../../tests/ntfy-setup.test.ts), [manager](../../tests/manager.test.ts) |
| Doctor/install/release | [doctor](../../src/core/doctor.ts), [updater](../../bin/agentctl-update), [publish workflow](../../.github/workflows/publish.yml) | [installation](../../tests/publish.test.ts), [MCP](../../tests/mcp-update.test.ts) |

The tool inventory is generated from all 67 registrations and all four permission groups by [docs-reference.ts](../../scripts/docs-reference.ts). The JSON retains full runtime descriptions and input JSON Schema including enabled optional provider fields. The configuration manual indexes 204 existing keys, adds probe/cache controls previously prose-only, and points at the exact regex defaults.

The screenshots exercise real TUI view rendering and navigation, not actual provider inference. Provider screen heuristics, account access, live model cost/cache behavior, real notifications/phone and real desktop approval UI are not revalidated by these captures. Kimi synthetic hypotheses and GLM quota n/d are explicitly documented.

External product/CLI links were checked with curl -I -L on 2026-11-15; see the provider pages and task report. Rendering used local Java 21, PlantUML 1.2026.6 with bundled C4, native Graphviz 16.1.1 and the existing resvg ANSI renderer. No public diagram service was used.
