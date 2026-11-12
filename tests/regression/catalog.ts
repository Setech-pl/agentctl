/*
 * Source of truth of the regression suite: one entry per known, FIXED bug.
 * `npm run regression` runs every scenario (a scenario is an existing test, or a test file of this directory, narrowed by an
 * optional test-name pattern); `npm run regression -- --catalog` renders CATALOG.md from this file and prefix-proof.json.
 * A new bug fix adds its entry here (see AGENTS.md). Scenarios are deterministic: fake tmux/agent fixtures, no inference, no network.
 */
export interface Scenario {
  /** Path below tests/. */
  file: string;
  /** Regular expression source matched against test titles; omitted = the whole file is the scenario. */
  name?: string;
}
export interface BugEntry {
  id: string;
  /** One line: what the user saw. */
  symptom: string;
  /** Release that shipped the fix. */
  fixedIn: string;
  scenarios: Scenario[];
  /** Why the scenario cannot be proven against the previous release (shown in CATALOG.md instead of a measured result). */
  noProof?: string;
}

// P19 scenarios leave out the three tests with sub-2-second wall-clock windows (R5 background parent, hung-worker timeout, collectDisk budget):
// a regression scenario must not flake on a loaded host. Their coverage stays in the normal test run.
const s = (file: string, name?: string): Scenario => ({ file, ...(name ? { name } : {}) });

export const BUGS: BugEntry[] = [
  // 0.19.4
  { id: 'P85', fixedIn: '0.19.4', symptom: 'MCP doctor probed every task report and link and walked worktrees, so it stalled on a large home.', scenarios: [s('hotfix-0194-p85.test.ts')] },
  { id: 'P89', fixedIn: '0.19.4', symptom: '`after` released dependents on any finished report; a FAIL/BLOCKED/NO-GO or missing first-line verdict did not hold them.', scenarios: [s('hotfix-0194-p89.test.ts')] },
  { id: 'P89-f1', fixedIn: '0.19.4', symptom: 'A spec with `after_verdict` but no `after` was accepted and the override silently did nothing.', scenarios: [s('spec.test.ts', 'after_verdict')] },
  { id: 'P90', fixedIn: '0.19.4', symptom: 'A follow-up sent to a working Codex was pasted at the first idle-looking redraw (or lost behind an existing report) instead of waiting for the confirmed turn end.', scenarios: [s('hotfix-0194-p90.test.ts', 'P90: (busy|an idle)')] },
  { id: 'P91', fixedIn: '0.19.4', symptom: 'A pending, withdrawn or stale follow-up (or a closed task) hid an existing report from get_report.', scenarios: [s('hotfix-0194-p91.test.ts', 'P91')] },
  { id: 'P91-f1', fixedIn: '0.19.4', symptom: 'Closing a task silently discarded queued and unsent follow-ups without a journal entry.', scenarios: [s('hotfix-0194-p91.test.ts', 'close journals')] },
  // 0.19.3 / 0.19.2
  { id: 'P83-write', fixedIn: '0.19.3', symptom: 'MCP write previews (close/cancel/mark/gc/queue) ran worker measurements, du and git status and took seconds on large homes.', scenarios: [s('write-contracts.test.ts')] },
  { id: 'P83-read', fixedIn: '0.19.2', symptom: 'status, queue list and MCP reads walked every worktree again (read-path regression on large homes).', scenarios: [s('read-contracts.test.ts')] },
  { id: 'P84', fixedIn: '0.19.2', symptom: 'MCP set_limits rejected integer strings such as "3" for a provider (P84/P79).', scenarios: [s('mcp-limit-strings.test.ts')] },
  { id: 'P77', fixedIn: '0.19.2', symptom: 'Several two-phase MCP tools refused a confirm that carried only the preview_token.', scenarios: [s('mcp-token-confirm.test.ts')] },
  // 0.19.1
  { id: 'L1', fixedIn: '0.19.1', symptom: 'A third gate entering while a live lock was displaced during stale-lock reclamation could own the gate lock too.', scenarios: [s('gate.test.ts', '^L1')] },
  { id: 'F1', fixedIn: '0.19.1', symptom: 'Automatic .cache cleanup ran during a live turn or in a worktree shared with another open task.', scenarios: [s('p73-cache-clean.test.ts', '^F1')] },
  { id: 'P65-b', fixedIn: '0.19.1', symptom: 'peek of a Codex task with a collapsed question did not name the question text.', scenarios: [s('p65b-peek-question.test.ts')] },
  { id: 'P70', fixedIn: '0.19.1', symptom: 'A declared outputs.verdict overrode the first-line verdict of a review report (NO-GO on line 1 showed as PASS).', scenarios: [s('p70-review-verdict.test.ts')] },
  { id: 'P71', fixedIn: '0.19.1', symptom: 'Attention summaries repeated outputs of closed/pulled tasks and the unrated count on every call.', scenarios: [s('chat-events.test.ts', 'P71')] },
  { id: 'P72', fixedIn: '0.19.1', symptom: 'Backend links ignored spec repository worktrees and base-stale targets raised no warning.', scenarios: [s('stale-links.test.ts', 'P72')] },
  { id: 'P73-a', fixedIn: '0.19.1', symptom: 'Task worktree .cache was left behind after the report was settled (and removal could escape through symlinks).', scenarios: [s('p73-cache-clean.test.ts', '^P73-a')] },
  // 0.19.0
  { id: 'P42', fixedIn: '0.19.0', symptom: 'A task that already had a window showed twice on the board (queue row "… starting" plus its own row).', scenarios: [s('p42-board-window.test.ts')] },
  { id: 'P51', fixedIn: '0.19.0', symptom: 'Limit notifications and events omitted unchanged optional providers.', scenarios: [s('p51-limits.test.ts')] },
  { id: 'P52', fixedIn: '0.19.0', symptom: 'Repeated report edits published the report/results notification several times per attempt.', scenarios: [s('p52-report-events.test.ts')] },
  { id: 'P62', fixedIn: '0.19.0', symptom: 'An MCP call could outlive its budget; retried confirms duplicated orders and fresh registrations vanished from partial responses.', scenarios: [s('p62-budget.test.ts')] },
  { id: 'P63', fixedIn: '0.19.0', symptom: 'Answering an agent menu with `send "1"` queued a message instead of choosing the option.', scenarios: [s('p63-answer.test.ts', 'P63')] },
  { id: 'B1-answer', fixedIn: '0.19.0', symptom: 'Answer tokens could be replayed, outlive their preview or apply to a changed frame; an old Kimi menu above a fresh composer was still answerable.', scenarios: [s('p63-answer.test.ts', '^integration')] },
  { id: 'P64', fixedIn: '0.19.0', symptom: 'A message queued inside a working Codex (↳ echo) raised a false needs-attention "Prompt delivery not confirmed".', scenarios: [s('p64-codex-queued.test.ts')] },
  { id: 'P65', fixedIn: '0.19.0', symptom: 'A collapsed async Codex question while the agent works was reported as needs-input although the agent kept going.', scenarios: [s('p65-collapsed-question.test.ts')] },
  { id: 'P67', fixedIn: '0.19.0', symptom: 'Credential masking replaced short substrings of ordinary words, field names and task IDs.', scenarios: [s('p67-redaction.test.ts', '^P67')] },
  { id: 'R1-redact', fixedIn: '0.19.0', symptom: 'camelCase credentials and passwd values were not masked in fields, text and URL queries.', scenarios: [s('p67-redaction.test.ts', '^R1')] },
  { id: 'P68', fixedIn: '0.19.0', symptom: 'A command run from a directory removed by gc crashed with an ENOENT uv_cwd stack trace.', scenarios: [s('p68-cwd.test.ts')] },
  { id: 'P69', fixedIn: '0.19.0', symptom: 'After gc --apply the board and status kept the pre-gc disk reading for minutes.', scenarios: [s('p69-gc-disk.test.ts')] },
  { id: 'B2-clean', fixedIn: '0.19.0', symptom: 'gate clean could follow dangling or nested symlinks to outside paths and stop a foreign tmux server.', scenarios: [s('gate-clean.test.ts', 'integration B2')] },
  { id: 'X1', fixedIn: '0.19.0', symptom: 'A preempted gate-lock reclaimer could unlink the live lock a successor had installed.', scenarios: [s('gate.test.ts', '^X1')] },
  { id: 'X2', fixedIn: '0.19.0', symptom: 'A SIGKILL between creating and writing the gate-lock sidecar left a lock that recovery waited on forever.', scenarios: [s('gate.test.ts', '^X2')] },
  { id: 'X3', fixedIn: '0.19.0', symptom: 'An interrupted FIFO→active transfer left one message in both stores; withdraw refused it as ambiguous and recovery could redeliver it.', scenarios: [s('p48-withdraw.test.ts', '^X3')] },
  { id: 'X4', fixedIn: '0.19.0', symptom: 'MCP set_limits refused "off" for the optional provider (Kimi) in its registered schema.', scenarios: [s('kimi.test.ts', '^X4')] },
  // 0.18.3 / 0.18.2
  { id: 'P49', fixedIn: '0.18.2', symptom: 'A follow-up to a working Codex used the wrong queue key, and wrapped pastes were not recognised as delivered.', scenarios: [s('p49-codex-queue.test.ts')] },
  { id: 'P50', fixedIn: '0.18.2', symptom: 'Requeueing a removed task ID reused the old attempt and cancelled its new dependents.', scenarios: [s('queue.test.ts', '^P50')] },
  { id: 'R2-gate', fixedIn: '0.18.2', symptom: 'The gate lock of a SIGKILLed gate (dead owner PID) was waited on forever.', scenarios: [s('gate.test.ts', 'SIGKILLed')] },
  { id: 'FIX1-update', fixedIn: '0.18.2', symptom: 'doctor judged the Codex update check from the first -c flag instead of the last one that wins.', scenarios: [s('p33-codex-update.test.ts', 'doctor')] },
  { id: 'FIX1-tmux-loss', fixedIn: '0.18.2', symptom: 'Closing a never-ready start window on purpose raised a tmux-loss event.', scenarios: [s('queue.test.ts', 'intentional close of a never-ready')] },
  { id: 'FIX1-kimi-trust', fixedIn: '0.18.2', symptom: 'The Kimi trust dialog stayed needs-trust although a ready prompt below it proved trust was answered.', scenarios: [s('kimi.test.ts', '^P48')] },
  { id: 'FIX1-gc-events', fixedIn: '0.18.2', symptom: 'Oversized legacy gc_preview events filled whole event pages.', scenarios: [s('chat-events.test.ts', 'summarized on read|gc_preview value')] },
  { id: 'INT4-trust', fixedIn: '0.18.2', symptom: 'A trust-wait timeout left a failed queue entry for a live pending task.', scenarios: [s('queue.test.ts', '^INT4')] },
  { id: 'SOAK', fixedIn: '0.18.2', symptom: 'Held action keys queued stale commands on the board and timers/caches grew during long sessions.', scenarios: [s('board-soak.test.ts', 'held action keys|eight-hour|progress cache')] },
  { id: 'P43', fixedIn: '0.18.2', symptom: 'Tasks lost with the tmux server vanished from status instead of staying visible with recovery guidance.', scenarios: [s('tmux-loss.test.ts')] },
  { id: 'P32', fixedIn: '0.18.2', symptom: 'The board tick re-scanned every task record and report, archived included, several times per 2 s tick.', scenarios: [s('board-p32-counts.test.ts')] },
  { id: 'P32-F1', fixedIn: '0.18.2', symptom: 'A cached report digest was trusted without re-checking the owner, allowed roots and symlinked ancestors.', scenarios: [s('board-p32-f1.test.ts')] },
  { id: 'P32-F2', fixedIn: '0.18.2', symptom: 'Atomic replacement or equal-size rewrite of TASK.md or a report went unnoticed by the caches.', scenarios: [s('board-p32-f2.test.ts')] },
  { id: 'P32-F3', fixedIn: '0.18.2', symptom: 'An archive duplicate won over the current task repositories on the board.', scenarios: [s('board-p32-f3.test.ts')] },
  { id: 'P32-F4', fixedIn: '0.18.2', symptom: 'Live closed/cancelled rows lost their tokens in default board mode.', scenarios: [s('board-p32-f4.test.ts')] },
  { id: 'P32-F5', fixedIn: '0.18.2', symptom: 'An immediate watch refresh left a superseded trailing timer that fired a duplicate tick.', scenarios: [s('board-p32-f5.test.ts')] },
  { id: 'P32-F6', fixedIn: '0.18.2', symptom: 'Expanding hidden/closed sections did not request deep data while an active row stayed selected.', scenarios: [s('board-p32-f6.test.ts')] },
  { id: 'P32-F7', fixedIn: '0.18.2', symptom: 'Board refresh sources kept several deadlines, re-armed after failures or after exit.', scenarios: [s('board-p32-f7.test.ts')] },
  { id: 'P32-F8', fixedIn: '0.18.2', symptom: 'Arrow keys on populated rows stalled while records were scanned or status collected.', scenarios: [s('board-p32-f8.test.ts')] },
  { id: 'P23', fixedIn: '0.18.2', symptom: 'Output repository names given as worktree directory names or paths were not normalised to the repository name.', scenarios: [s('p23.test.ts')] },
  { id: 'P18', fixedIn: '0.18.2', symptom: 'Recursive or self links were accepted in spec previews.', scenarios: [s('p18.test.ts')] },
  { id: 'P34', fixedIn: '0.18.2', symptom: 'MCP `new` confirm could hold the server for minutes for a checkout, setup or input prompt instead of registering the start for the watcher.', scenarios: [s('mcp.test.ts', 'confirm never starts in the server'), s('p19-setup.test.ts', 'also handed to the watcher')] },
  { id: 'P33', fixedIn: '0.18.2', symptom: 'The Codex "Update available" modal blocked a start for the full 60 s ready timeout.', scenarios: [s('p33-codex-update.test.ts')] },
  { id: 'P35', fixedIn: '0.18.2', symptom: '`prompt_delivery: sent` was set without a real delivery (a human answering a dialog flipped a failed start to sent).', scenarios: [s('p35-delivery.test.ts')] },
  { id: 'P36', fixedIn: '0.18.2', symptom: '`queue rm` left the live window of a cancelled failed start, so the cancelled state read as waiting.', scenarios: [s('queue.test.ts', '^P36')] },
  { id: 'P37', fixedIn: '0.18.2', symptom: '`events --since HH:MM` for a time later than now returned an empty "future" window instead of yesterday.', scenarios: [s('chat-events.test.ts', '^P37'), s('fix5.test.ts', 'P37')] },
  { id: 'P38', fixedIn: '0.18.2', symptom: 'A closed cohort journalled its whole GC plan, which flooded events_since with JSON fragments.', scenarios: [s('cohort.test.ts', '^P38')] },
  { id: 'P30', fixedIn: '0.18.2', symptom: 'A rejected config reload was forgotten between reads, hiding the rejection from doctor and status.', scenarios: [s('config-reload.test.ts', 'rejection receipt')] },
  { id: 'P27', fixedIn: '0.18.2', symptom: 'Long PATH or Codex notify arguments overflowed the tmux command line when launching an agent.', scenarios: [s('launch-script.test.ts')] },
  { id: 'P28', fixedIn: '0.18.2', symptom: 'Kimi status stayed on a stale error banner after a successful re-login.', scenarios: [s('c2-kimi.test.ts'), s('kimi.test.ts', 'P28')] },
  { id: 'P19', fixedIn: '0.18.2', symptom: 'The MCP server was held by a task start and by synchronous worktree-size walks over node_modules.', scenarios: [s('p19-setup.test.ts', '^P19'), s('p19-reads.test.ts', 'RealRunner: a child process|the size walks')] },
  { id: 'P19-FIX2', fixedIn: '0.18.2', symptom: 'Disk measurements were duplicated, never invalidated, and batched author/reviewer starts lost their order and scope.', scenarios: [s('p19-fix2-disk.test.ts', 'R2: cold inventory|R3: path TTLs|R3: removed and replaced'), s('p19-fix2-measurement.test.ts', 'disk.workers=1|a crashed foreground|shutdown cancels|MCP stdin end|GC rechecks'), s('p19-fix2-no-agent.test.ts'), s('p19-fix2-setup.test.ts')] },
  { id: 'P15', fixedIn: '0.18.2', symptom: '`send` to a working agent was silent and could press Enter into the wrong field or mark an undelivered message as delivered.', scenarios: [s('p15-fix3-contract.test.ts'), s('p15-fix3.test.ts'), s('p15-fix4.test.ts'), s('p15-fix5.test.ts')] },
  { id: 'P15b', fixedIn: '0.18.2', symptom: 'A collapsed Claude paste arrived wrapped in <pasted_content> and never matched the pending prompt, ending in needs-attention.', scenarios: [s('p15-send.test.ts', 'P15b')] },
  { id: 'P16', fixedIn: '0.18.2', symptom: 'Codex follow-ups to a working agent were not recognised as queued/steered, so delivery stayed unconfirmed.', scenarios: [s('p15-send.test.ts', 'P16')] },
];

/** IDs that appear in the CHANGELOG but are not a fixed bug (or have no behaviour to reproduce), with the reason. */
export const NOT_BUGS: Record<string, string> = {
  P10: 'feature: optional tmux.socket and attach hints',
  P44: 'feature: dedicated dev tmux server documentation and doctor checks',
  P17: 'feature: stale project link warnings in previews',
  P22: 'feature: report_from hints',
  P24: 'feature: disk share warnings',
  P29: 'guard: live harness refuses missing cache roots (process rule, covered by harness tests)',
  P39: 'convenience: token-only confirm for new/queue (the defect for every tool is P77)',
  P45: 'improvement: concise MCP report reads',
  P47: 'improvement: MCP footers only on demand',
  P54: 'feature: npm run gate -- clean',
  P55: 'feasibility study; no behaviour change claimed for Kimi trust',
  P59: 'no mapping in the supplied branches/reports; no behaviour claimed',
  P60: 'feature: spec class and model matrix',
  P61: 'feature: model matrix (data/model-matrix.yaml) and generated tables',
  P66: 'feature: review_of list',
  P79: 'covered by P84 (one test file)',
  P73: 'covered by P73-a and F1',
};
