# Release safety

Run the release checklist from a clean candidate checkout with an absolute task-owned `AGENTCTL_LIVE_CACHE`. Run `npm run gate -- quick`, `npm run gate -- full --node26-only`, and `npm run gate -- release` on the final SHA before tagging. Release verifies the SHA and file inputs before and after each step. It includes the regression catalog, installed package checks on Node 22 and 26, the live fixtures, and the production-shape canary. Run `npm run gate -- prodshape` to repeat the last check independently. Clean task-owned scratch with `npm run gate -- clean`.

The production fixture has 1,500 task records, more than 2,000 worktree directories across simulated volumes, 40 orders from four chats, and 150 WALL messages. It runs the real watcher for at least 20 ticks with fake agents, CPU load of at least twice the core count, and a slow filesystem shim. Each admissible order has two ticks to start. The gate checks for a full snapshot younger than 60 seconds, skips of at most three consecutive ticks per stage, complete MCP reads under eight seconds, queue/close/GC confirmation, and disk and limits in the rendered board header. If an MCP read exceeds eight seconds above three times the core count, the gate runs the canary once more.

Regression scenarios cover worktree data loss in 0.22.4 (D1, D2), watch and write recovery after ENOSPC in 0.23.1 (FIELD0253-ENOSPC), admission and stuck follow-up delivery in 0.25.2 (FIELD0253-ADMISSION, FIELD0253-BACKGROUND), external volumes (W102-VOLUME), and the nine 0.26.0 field reports (W110-A through W110-I). Each gate runs these scenarios. [Regression catalog](../../tests/regression/CATALOG.md)

## Shadow the candidate before upgrading

On the dev machine, run the candidate CLI against a readable copy or mounted view of the production `AGENTCTL_HOME`. Keep the canary cache outside that source home and its configured state and cache directories.

```sh
cd ~
~/Projects/agentctl/dist/bin/agentctl.js canary --from "$PROD_AGENTCTL_HOME" --minutes 30
```

The command reads the source configuration and state and keeps task and queue counts, dependency links, paths, and timestamps in a private temporary mirror. It replaces prompts and reports with fixtures and omits credentials, transcripts, hooks and setup commands. Git, tmux and providers run as fixtures. The mirror uses fake provider capacity with headroom for control orders. The exit code and printed metrics describe the replay. The temporary mirror is removed on exit.

## Upgrade the stable clone

Use the candidate updater for the first upgrade from a release that predates rollback. Once the tag is available in the clone, run:

```sh
cd ~
repo="$HOME/Projects/agentctl"
git -C "$repo" show v0.27.2:bin/agentctl-update | AGENTCTL_REPO="$repo" bash -s -- --ref v0.27.2
```

Subsequent clone upgrades can use `agentctl-update --ref vX.Y.Z` directly. The updater saves the previous executable, dependencies, Git checkout and configuration. It restarts watch and any existing board. Within three minutes the candidate must show its version, two completed watch ticks and a fresh snapshot, sensible queue reasons and a successful fake no-op admission, complete MCP reads, and a board header. On failure it prints the cause, restores the previous copy and configuration, restarts services, posts an owner WALL info, and exits nonzero. The backup remains available through the next successful upgrade. `--no-rollback` keeps a failed candidate in place. `--no-watch` skips the service restarts and health check. These clone options do not apply to npm installations.

## Reports and quotas

Put the verdict on the first report line. Recognized leading tokens are `PASS with findings` (PARTIAL for dependencies), `PASS`, `PARTIAL`, `FAIL`, `BLOCKED` and `GO`, plus the existing review aliases. Trailing detail is accepted. A complete report in an idle pane becomes report-ready. Watch records ambiguous verdicts and names terminal `after` dependencies that cannot supply one. A schema-1 `agentctl-outputs` block may include `deferred: [{cell: smoke, where: pc}]`. Top-level keys starting with `x_` are ignored.

In `set_limits` chat quotas, `{chat: nc, codex: 0}` blocks new Codex starts for that chat. Set `codex: "off"` or `codex: null` to clear its provider quota. The global provider limit still governs admission. State and cache volumes use `disk.min_free_state_gb` (default 5 GiB); each checkout volume uses `disk.min_free_start_gb` (default 30 GiB).

## Manual rollback to 0.26

Run `agentctl config downgrade-check --to 0.26.x` before switching versions. The command lists keys rejected by 0.26.0 and removes expired timed limit overrides. Use `--to 0.26.1` or `--to 0.26.2` to check that patch's configuration keys. Release any reported timed reservations before switching because 0.26 does not expire them. Start locks use a numeric PID readable by earlier versions, with owner details in a sidecar. After an upgrade, quit the Claude app with ⌘Q and reopen it so each chat loads the new MCP server with the active GC and limits policies.
