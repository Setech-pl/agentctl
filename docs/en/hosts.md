# Hosts: remote tasks over SSH

A spec with `host: pc` runs its worktree, repository setup and interactive agent on the configured host. The dispatcher keeps task state and the local report mirror. Install Git, tmux, Node and the selected provider CLI on the host, log in as the SSH owner, and keep a separate clone of each repository there. No remote agentctl installation is needed. The owner account is assumed: generated hooks and settings belong to that account and are installed in task-owned files, without editing the owner's provider settings.

Add to the dispatcher's existing global config (keep its other keys):

```yaml
hosts:
  pc:
    ssh: owner@pc.local
    port: 22
    work_dir: ~/agentctl-work
    repos:
      app: ~/src/app
    providers: [claude, codex, kimi, glm]
    limits: {claude: 1, codex: 1, kimi: 1, glm: 1}
    # env: {PATH: /home/owner/.local/bin:/usr/local/bin:/usr/bin:/bin}
```

List only installed/logged-in providers. `env.PATH` can expose CLIs installed outside the noninteractive SSH shell's PATH. `identity_file` is an optional **local** key path. Never put credentials in this config; provider login stays on the host. For Windows/WSL use the SSH endpoint and forwarded port of WSL, e.g. `ssh: owner@192.168.2.64`, `port: 2222`.

Accept a first-time SSH key once in your own terminal (`agentctl doctor` prints the command), then check `agentctl hosts --refresh`. Agentctl fixes `BatchMode=yes` and `StrictHostKeyChecking=yes`; unknown, changed and unauthenticated hosts never prompt or auto-accept. Each host reuses one multiplexed SSH channel. The configured hostname is passed on every call, without an IP cache.

Save a spec as `remote.md`:

```yaml
---
task: PC-SMOKE
host: pc
agent: claude
model: sonnet
effort: high
review: false
repos:
  - path: app
    base: origin/main
    branch: pc-smoke
---
Inspect the repository and write a short report. Do not change files or commit.
```

Run `agentctl new remote.md --no-wait-trust`, then `agentctl attach PC-SMOKE`: for a host task it prints the `ssh -t … 'tmux attach-session …'` command. Run that command, approve the folder trust yourself, and leave watch running (`agentctl watch --tmux`). Detach with Ctrl-b d to return to your local terminal; F12 is the local board key and does not jump between hosts. Board Enter also shows the remote attach command and the task carries a `[pc]` badge.

`repos[].path` names a configured clone (its name or a path whose basename is that name). Agentctl fetches `origin` there, never pushes, then creates a branch or detached checkout using the same base/branch rules as local tasks. Prefer `origin/main` over a potentially stale local `main`. Missing bases identify the host clone's default branch. Worktrees must be separate directories inside `work_dir`; defaults are `<work_dir>/<repo>-<task>`. Setup is read from each new worktree's `.agentctl.yaml`; an explicit spec setup overrides it, including `[]`. Remote project links and environment run on the host; local project files and global links are not copied there.

The existing provider adapters handle readiness, trust, questions, prompt paste and delivery verification. Claude/GLM receive task-owned, repeatable hook/settings installation, reported at start. Codex preserves the owner's notify command and uses its named rollout for exact delivery proof; Kimi uses its task-bound state/wire protocol. Unknown Kimi protocols provide screen state only and cannot acknowledge a follow-up. `peek`, `send` (including Codex FIFO until turn end), token-bound `answer`, `interrupt`, `close` and `cancel` route to the remote window. An explicit `close --rm-worktree` removes a registered remote worktree through Git without force; branches stay.

The canonical remote report is `<work_dir>/reports/<task>/<TASK>.md`. The spec's `report:` remains the **local mirror** (normally under `config.cache`). Watch copies changed content and samples again when the task ends or is explicitly closed/cancelled; `get_report`, outputs parsing and pull read that mirror. Outputs branch/SHA checks run against the host clone and cache their validation for offline reads. The report must follow the normal attempt/report-end protocol.

SSH loss changes the task to `host-unreachable`, keeps it active and occupying a slot, emits an event and notification, and retries after 5 seconds with exponential backoff capped at 5 minutes. Tracking resumes when the host answers. Watch never closes remote windows by itself. Explicit operations report connection failures without marking a live remote task closed/cancelled.

Every remote task uses the provider account limit alongside local tasks and reservations; `hosts.<name>.limits` adds a host/provider cap. Queue admission and queued follow-ups respect both. HOST-0C continues remote GC, limit presentation and board polish. Local GC/cache cleanup and disk scans exclude remote worktrees. Remote `move`, `resume` and automatic reviews are not supported in this part; use a new spec/separate review task (`review: false` disables inherited auto-review). A real host/inference smoke test remains an owner action.
