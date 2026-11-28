---
task: ACTL-0275
agent: claude
model: claude-opus-5-5
effort: high
repos:
  - path: ~/Projects/agentctl
    worktree: ~/Projects/agentctl-wt/agentctl-0275
    base: main
    branch: actl-0275-hooks-session-files
report: ~/Projects/cache-dev/agentctl-0275/ACTL-0275.md
---
0.27.5: native signals for the screen driver (prototype: spike/ACTL-0267). Screen stays the fallback; no protocol driver.
1. Claude registry: read ~/.claude/sessions/<pid>.json (status idle|busy|shell, sessionId, tmux pane) in status/watch; map by pane id; ignore dead pids. Unknown status values keep the screen result.
2. Session-file state: tail-parse the pinned Claude transcript and Codex rollout (adaptive tail 64 KB → 1 MB) for turn start/end, pending question (AskUserQuestion / request_user_input), last assistant message, per-turn usage. Screen capture only when files and registry are silent or disagree for > 1 poll.
3. Claude hooks (per-task --settings only, never global): use SessionStart (session pin) and UserPromptSubmit (delivery ack); add PermissionRequest (needs-input with tool + input) and SessionEnd (dead + reason). Command type only. Validate the generated settings file before launch.
4. Codex hooks: stable command (task/attempt via env), -c hooks.* for SessionStart/UserPromptSubmit/PermissionRequest/Stop; report trustStatus in doctor; no trust bypass. notify stays.
5. watch with ~90 windows: one registry read + one list-panes per poll, capture-pane only for windows whose state is unresolved. Record pollMs.
Tests: fixtures from spike/ACTL-0267/sessions/fixtures plus regression entries for each screen-guess bug this replaces. Docs EN+PL. Gate: quick.
