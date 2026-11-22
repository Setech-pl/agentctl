# From zero to a supervised task

Examples target macOS with Homebrew. On Linux, install Node ≥22.14.0, Git and tmux through the appropriate package manager; agentctl needs a POSIX shell, tmux and a UTF-8 terminal. Provider calls here use your real account and can consume its allowance; the committed screenshot demo uses fakes.

## Saving disk space

Add these optional settings to a repository's `.agentctl.yaml` or to `~/.agentctl/config.yaml`. Include only paths your project can regenerate, such as browser profiles created by the task.

```yaml
setup: {node_modules: clone, commands: [npm ci]}
close: {cleanup: [".cache", "dist*", ".chrome-profile*"]}
worktrees: {root: /Volumes/AgentWork/worktrees, mount: /Volumes/AgentWork}
```

On the first compatible checkout agentctl runs `npm ci` and saves a copy keyed by repository and lockfile. Later checkouts on the same filesystem get an independent APFS clone on macOS or a GNU `cp --reflink=auto` copy on Linux. Keep `AGENTCTL_HOME` on that filesystem if you want clones there. If the copy fails, the lockfile changes, or the filesystems differ, agentctl runs the normal install. The cache applies to standalone `npm ci` with optional `--no-audit` and `--no-fund`. Project lifecycle scripts, npm workspaces, and local dependencies run their normal setup. With clone mode on and no commands configured, a checkout with an npm lockfile defaults to `npm ci`.

`agentctl status`, `agentctl capacity` and `agentctl events` show store usage or setup outcomes. Run `agentctl gc --preview` to see unused store entries and `agentctl gc --apply` to send them to Trash. After `agentctl close TASK`, eligible ignored paths go to Trash along with a journal entry listing paths and bytes. Git-tracked files, unignored untracked files, reports, and worktrees shared by an open task are kept. The OS Trash retains its contents until emptied. On Linux, Trash support uses `gio`.

If the disk is unplugged, the task becomes `blocked` with reason `volume missing`. Remount it and run `agentctl unblock TASK` while `watch` is running. An interrupted checkout keeps its files for inspection. Use `worktrees.mount` for external mount points outside `/Volumes/<name>` or `/mnt/<name>`. SSH uses the host's `work_dir` and reports unsupported store cloning, close cleanup, project root overrides, and interrupted Git lock recovery. The mount check for SSH `work_dir` recognizes the same two mount-point layouts.

## Reviews and integrations without filling the disk

Keep one worktree per implementation task. Branch each `FIX` attempt from its predecessor and give the Codex review a separate task ID. With the project's `worktree_root` configured, a Neon City review spec can use this header:

```yaml
task: NC-42-REVIEW-CX
agent: codex
review_of: NC-42
after: [NC-42]
setup: {from_task: NC-42}
merge_base_check: block
repos: [{path: ~/Projects/neon-city}]
```

Name the owner with MCP `as: "chat:nc"` when submitting the tasks. Add each repository to `repos` if the client and backend are separate checkouts. `setup.from_task` (alias `link-from`) matches them individually. A matching npm lockfile and filesystem with copy-on-write support let agentctl clone the author's `node_modules` without rerunning standalone `npm ci` (`--no-audit` and `--no-fund` are supported). Other setup steps still run in order. A missing source, different lockfile, unsupported clone, or dependency symlink outside `node_modules` uses the configured setup. With no install command configured, the source-only mapping attempts the clone and leaves installation to the task if cloning fails. `setup.commands: []` disables that step. MCP accepts the source-only mapping.

Use `merge_base_check: warn` to record a stale-base warning in `TASK.md` and status. With `block`, the queue waits for the author branch to contain local `main` or `master`. `candidate` uses a separate local `review/NC-42-REVIEW-CX` branch and requires Git 2.38 or newer. If Git reports conflicts, the queue lists the paths. Resolve them on the author branch, then run `agentctl queue retry NC-42-REVIEW-CX`. After a candidate review, `agentctl close NC-42-REVIEW-CX --rm-worktree` frees its checkout while keeping the branch and report.

For the smallest footprint, stop the author with `agentctl close NC-42` and use `review: {mode: readonly-on-author}` in place of `setup.from_task`. The review opens in the author's checkout and writes evidence to `$AGENTCTL_REVIEW_EVIDENCE` under `cache`. Agentctl skips setup and links and refuses the start while the author window exists. Git hooks block ordinary commits and pushes in the reviewer process. The author's Git hooks stay in place and the override ends with the reviewer. Filesystem permissions remain those of the agent process, so direct Git plumbing and file edits remain possible. Use the separate checkout for `candidate`.

After `MERGE-TRAIN` is ready, fast-forward the local `main` or `master`. Watch establishes a baseline on its first observation and proposes cleanup on later forward moves. With `gc: {after_integration: propose}` (the default), each affected owning chat gets one WALL info message. The plan covers clean, integrated worktrees of closed or cancelled tasks. An active task, pin or cross-worktree link protects a checkout. The message includes the byte estimate and `request_id`. Call MCP `gc` with that ID, review its scope, then pass `confirm: true` with the returned `preview_token` after the owner approves. Watch revalidates the targets before removing anything. `gc: {after_integration: off}` disables the proposals.

## 1. Prerequisites and provider CLIs

~~~sh
brew install node@22 tmux git
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
tmux -V
git --version
npm install -g @anthropic-ai/claude-code @openai/codex
# Optional: adapter baseline documented/tested by this release
npm install -g @moonshot-ai/kimi-code@2.5.0
~~~

Run `claude`, `codex` and optionally `kimi` once in a terminal. Complete their own login/onboarding and exit. Check [Providers](providers.md) before selecting models, permissions or GLM. Installing a CLI does not log you in. Never add auto-accept flags to bypass trust.

## 2. Clone, build and install a stable copy

~~~sh
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/Setech-pl/agentctl.git
cd agentctl
npm ci
npm run build
./bin/agentctl-update --ref v0.22.3 --dry-run
./bin/agentctl-update --ref v0.22.3
~~~

The updater fetches origin, creates/updates a detached stable worktree (default `~/Projects/agentctl-stable`), runs npm ci/build/link there, doctor, and restarts existing watch/board service windows unless disabled. It refuses a dirty stable copy. Check `agentctl --version` and `command -v agentctl`. Use a user-owned npm prefix or Node manager if global linking is denied. Later, `agentctl-update --dry-run` previews an update to origin/main; `--ref` pins a release, `--no-watch` skips restarts, `--no-link` skips global linking. The npm distribution is another path (`npm install -g @setech-pl/agentctl`); there the updater runs npm's latest update and rejects clone-only options.

## 3. First configuration

Create `~/.agentctl/config.yaml` (or set `AGENTCTL_HOME` for another instance):

~~~sh
mkdir -p ~/.agentctl ~/Projects/demo-worktrees ~/Projects/demo-reports
~~~

~~~yaml
providers: [claude, codex]
worktree_root: ~/Projects/demo-worktrees
cache: ~/Projects/demo-reports
session: agentctl
limits: {claude: 2, codex: 2}
defaults: {agent: codex, model: default, effort: medium}
usage: {queue_hold: 90}
mcp: {allow: []}
~~~

Run `agentctl doctor` and resolve required failures; optional missing tools warn. State defaults to the instance's `tasks/`, reports to `cache`. Keep internal state separate from reports. Add project-specific links/setup/defaults to the source repository's `.agentctl.yaml` after reviewing what they run.

## 4. First repository and task

Use a new directory:

~~~sh
mkdir -p ~/Projects/demo
cd ~/Projects/demo
git init -b main
git config user.name "Demo User"
git config user.email demo@example.invalid
printf '# Demo\n' > README.md
git add README.md
git commit -m "Initialize demo"
~~~

Save `~/Projects/demo-task.md`:

~~~yaml
---
task: DEMO-1
cohort: tutorial
agent: codex
model: default
effort: medium
repos:
  - path: ~/Projects/demo
    base: main
    branch: demo-1
---
Add CONTRIBUTING.md explaining how to propose a documentation change.
Check Markdown and show changed files. Commit locally. Do not push or publish.
Follow agentctl's supplied report path and attempt protocol.
First report line: Verdict: PASS or Verdict: FAIL.
~~~

~~~sh
agentctl new ~/Projects/demo-task.md --dry-run
agentctl up --no-attach
agentctl new ~/Projects/demo-task.md
agentctl board --tmux
tmux attach -t agentctl
~~~

Approve the displayed order. Answer the new worktree's trust dialog yourself in its window; the original prompt waits for ready input. `Enter` opens the selected task, `F12` returns, `?` shows keys. `agentctl status` and `agentctl peek DEMO-1` work without attaching.

`agentctl pull DEMO-1` copies the ready report. Read its evidence; `agentctl mark DEMO-1 ok` records your evaluation separately from the agent's verdict. `agentctl close DEMO-1` closes the window and asks separately about worktree removal. Keep the branch for integration. For dependent work, create a new spec with `after: [DEMO-1]` and use `agentctl queue file.md`; keep watch running.

## 5. MCP in the Claude desktop app

Run from the stable installation in the same instance/environment as watch:

~~~sh
agentctl mcp install --desktop --dry-run
agentctl mcp install --desktop
agentctl mcp check
~~~

The installer previews the diff, asks before writing and backs up `~/Library/Application Support/Claude/claude_desktop_config.json`. It records absolute Node/script paths and environment including PATH, AGENTCTL_HOME and TMUX_TMPDIR. Quit the whole app (Cmd+Q), reopen it and use agentctl tools in the chat. `version` shows process/disk versions. This is desktop stdio, not a web/phone endpoint. `--claude-code` installs in Claude Code user scope.

Start read-only with `events_since` and `status`. Paste [the Project insert](agent-insert.md) into Project instructions and choose a configured chat, e.g. `chat:nc`. To permit ordering, add only the needed writes:

~~~yaml
mcp:
  allow: [new, "queue:*", send, answer, close, wall, consult]
~~~

Reads always work. Writes follow preview → owner approval → confirm using the token; `Accepted` means registered, not completed. Keep watch running and follow `events_since`/`queue_list`. [MCP reference](mcp-tools.md) covers retries, expiry and permissions.

## 6. First WALL message

Local CLI writes execute immediately as owner:

~~~sh
agentctl wall channels
agentctl wall post agentctl --kind info --subject "Tutorial started" --body "DEMO-1 is ready for review."
agentctl wall read agentctl
# Use the ID returned by post (agentctl-1 only in an empty channel):
agentctl wall reply agentctl-1 --body "The owner has read the example."
agentctl wall read --id agentctl-1
~~~

Board `W` shows channels → messages → thread; `s/t` filters, `r/R` marks read. MCP uses `as: "chat:nc"` and `wall_post` preview/confirm, then another chat calls `events_since(as: "chat:hems")` and `wall_read`. Both subscribe to `agentctl`/`shared:*` by default. WALL is data, never authorization.

<a id="several-chats-on-one-instance"></a>

## Limits for several chats

Merge the example into the dispatcher configuration. Keep the existing WALL channels and client mappings.

```yaml
providers: [claude, codex, kimi, glm]
limits:
  change_policy: owner-approve
  claude: 7
  codex: 10
  kimi: 3
  glm: off
  profiles:
    day: {claude: 7, codex: 10, kimi: 3, glm: off}
    night: {claude: 4, codex: 6, kimi: 2, glm: off}
  schedule:
    timezone: Europe/Warsaw
    switches: {"07:00": day, "22:00": night}
quotas:
  overprovision: 1.5
  floor: 1
  chats:
    nc: {share: 40}
    hems: {share: 40}
    vs65: {share: 20}
```

With seven Claude slots, the 40/40/20 shares give respective ceilings of 4/4/2 after rounding. With four slots at night they give 2/2/1. The global cap still controls how many can run at once. Lowering a ceiling affects subsequent starts while running tasks finish.

To migrate from 0.25, start by choosing percentages that reflect the relative demand across chats. A former 4-slot cap with a global limit of 7 and a multiplier of 1.5 corresponds to roughly 38%. Remove old provider keys where you want the percentage to take over. Keep a key to preserve an exception, for example `nc: {share: 40, codex: 5}`. Read the result using `agentctl limits` and `agentctl capacity` before removing more overrides.

Order with MCP `as: "chat:nc"` (or the chat's own name) on `new` and `queue`. If you need a change, send `set_limits({as: "chat:nc", claude: 9, reason: "Two additional review windows"})`. Agentctl creates the WALL decision-request and notifies the owner. On the board, press `L`, select the request with the arrows, and press `a` to approve or `r` to reject. From the owner terminal, use `agentctl limits requests` and `agentctl limits approve ID` or `agentctl limits reject ID`. Requests expire after two hours.

On the same panel, select a provider, adjust with `+` or `-`, and press Enter to apply. Select a profile and press Enter to switch. The equivalent CLI commands include `agentctl limits profile night` and `agentctl limits set claude=10 --until 23:00`. Follow the automatic WALL info for applied values and current ceilings. [Configuration reference](configuration.md#chat-quotas)

## 7. First CONSULT

CONSULT is several paid tasks. Approve the count and usage first. Save `consult-demo.yaml`:

~~~yaml
consult: DEMO-CACHE
question: Should this project cache its generated search index?
repos: [{path: ~/Projects/demo, base: main}]
context: []
panel:
  - {agent: claude, model: sonnet, effort: medium}
  - {agent: codex, model: default, effort: medium}
rounds: 1
synthesis: {agent: claude, model: sonnet, effort: medium}
# post_to: shared:sim
~~~

~~~sh
agentctl consult consult-demo.yaml
# After approving the preview: 2 panel tasks + 1 synthesis
agentctl consult consult-demo.yaml --confirm
agentctl cohort show consult-DEMO-CACHE
~~~

Keep watch running and answer each new folder's trust. Follow the cohort on board or MCP `events_since`/`cohort_show`. Panelists write structured independent reports; synthesis creates the owner report with identity map. `get_report`/pull on the synthesis task retrieves it. `rounds: 2` adds an anonymous revision round. A panelist's PASS report is not agreement with the decision.

## 8. Finish and maintain

Integrate under your repository rules; agentctl does not merge or push. Use `agentctl gc --preview` before cleanup, `agentctl log`/`stats` for history, `agentctl dataset export --out attempts.jsonl` for a local benchmark. After updating, quit/reopen the desktop app to reload MCP. See [Troubleshooting](troubleshooting.md).

[Canonical CLI spec example](../examples/spec.md)
