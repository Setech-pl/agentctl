# TUI screen gallery

These are real Ink/tmux screens captured at 160×45 using capture-pane -e -p and the repository ANSI→SVG→PNG renderer (resvg, bundled DejaVu monospace, dark theme). No images were drawn as substitute UI.

The isolated live harness uses its own tmux server/session agentctl-demo and a unique temporary AGENTCTL_HOME ending agentctl-demo, inside the task cache. Provider executables are test fakes; task screens, delivery receipts, reports, token/quota readings, clock and disk are synthetic. Real CLI/core/Ink code generates the views; CONSULT is registered as a group, not executed with inference. Only the generic ~/Projects/demo path is visible. A capture assertion rejects host paths/usernames rather than redacting them.

Queue is a section of the main board, not a separate screen. Task detail is the selected peek; Enter opens the provider window. WALL is read-only except local read marks. Its synthetic posts cover agentctl/shared:sim/nc, info/question/decision-request, replies and answered/accepted/open statuses. Both PASS and FAIL reports are complete report-ready tasks; verdict and human mark remain distinct.

[Capture manifest](../reference/gallery.json) · [Reproducible script](../../scripts/docs-gallery.ts)

Run with an absolute task-owned AGENTCTL_LIVE_CACHE: node --experimental-strip-types --no-warnings scripts/docs-gallery.ts. The harness stops all its processes/server in finally; npm run gate -- clean removes its disposable sandbox/home. Worktree node_modules stays.

## Main list: working/waiting/question/trust/limited, PASS/FAIL reports, cohorts and queue_hold

![Main list: working/waiting/question/trust/limited, PASS/FAIL reports, cohorts and queue_hold](../img/board-main.png)

## Selected task detail and menu question

![Selected task detail and menu question](../img/board-peek.png)

## Message composer

![Message composer](../img/board-message.png)

## Close confirmation

![Close confirmation](../img/board-confirm.png)

## Cancellation reason

![Cancellation reason](../img/board-cancel-reason.png)

## Help and complete key list

![Help and complete key list](../img/board-help.png)

## Cohort picker

![Cohort picker](../img/board-cohorts.png)

## Provider limits and holds

![Provider limits and holds](../img/board-limits.png)

## Capacity, plan observations and estimates

![Capacity, plan observations and estimates](../img/board-capacity.png)

## Protected cleanup preview

![Protected cleanup preview](../img/board-gc.png)

## Attempt history and human mark

![Attempt history and human mark](../img/board-log.png)

## Queue and selected dependency spec

![Queue and selected dependency spec](../img/board-queue.png)

## WALL channels, unread/open counts

![WALL channels, unread/open counts](../img/wall-channels.png)

## Channel messages

![Channel messages](../img/wall-messages.png)

## Status filter

![Status filter](../img/wall-filter-status.png)

## Kind filter combined with status

![Kind filter combined with status](../img/wall-filter-kind.png)

## Single message, status history and reply thread

![Single message, status history and reply thread](../img/wall-thread.png)

## Synthetic FAIL report-ready task

![Synthetic FAIL report-ready task](../img/board-report-fail.png)

## Finished task without a window: menu

![Finished task without a window: menu](../img/board-finished-menu.png)

## Finished/all visibility

![Finished/all visibility](../img/board-all.png)

Help is height-bounded; ↑↓ and PgUp/PgDn scroll, any other key returns. Recapture only help with `scripts/docs-gallery.ts --help-only` using the same Node flags above.
