# From zero to a supervised task

Examples target macOS with Homebrew. On Linux, install Node ≥22.14.0, Git and tmux through the appropriate package manager; agentctl needs a POSIX shell, tmux and a UTF-8 terminal. Provider calls here use your real account and can consume its allowance; the committed screenshot demo uses fakes.

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
./bin/agentctl-update --ref v0.22.1 --dry-run
./bin/agentctl-update --ref v0.22.1
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
