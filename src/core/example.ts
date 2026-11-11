/** The example spec printed by `agentctl spec example` and shown in the README (a test keeps them in sync). */
export const EXAMPLE_SPEC = `---
task: TASK-42
agent: claude
model: claude-opus-5-5
effort: high
repos:
  - path: ~/src/sample-app
    worktree: ~/worktrees/sample-app-task-42
    base: main
    branch: task-42-notification-sound
# Links apply to the first repo; targets must exist.
links: [{from: .env.local, to: ~/src/sample-app/.env.local}]
# after: TASK-41
# after_verdict: [PASS, PARTIAL, GO]  # override accepted verdicts for every dependency
env:
  APP_TASK: TASK-42
report: ~/reports/task-42/TASK-42.md
---
Play a notification sound when a background task finishes.

- Reuse the existing audio bus; do not add new dependencies.
- Cover the new behaviour with a test.
- When you are done, write a short report (what changed, how you checked it,
  what is left) to ~/reports/task-42/TASK-42.md.
`;
