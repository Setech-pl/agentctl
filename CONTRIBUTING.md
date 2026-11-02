# Contributing

agentctl is a small TypeScript project that runs on Node's type stripping, with no build step. Node 22.6 or newer, git and tmux are enough to work on it.

```sh
npm ci
npm test            # node:test; no real tmux, git or agent is involved
npm run typecheck   # tsc --noEmit
npm run docs        # regenerates docs/commands.md from the command definitions
node bin/agentctl.ts doctor
```

## How the code is organised

The engine in `src/core/` returns data (status rows, plans, results). `src/cli.ts`, the board (`src/board/app.ts`) and the MCP server (`src/mcp/server.ts`) are thin fronts over it. All side effects go through the `Runner` interface (`src/core/runner.ts`): `RealRunner` in production, `RecordingRunner` for `--dry-run` and for the tests, which feed it scripted tmux screens and compare the commands it recorded. See [docs/diagrams.md](docs/diagrams.md#architecture).

## Documentation is tested

- `docs/commands.md` is generated. Change a command, an option or its description in `src/cli.ts` (examples in `src/examples.ts`), then run `npm run docs`. A test fails when the file differs from the generated one.
- Every key the code accepts must have a row in `docs/configuration.md`, and every MCP tool a row in `docs/mcp.md`; tests check both.
- The README must contain the example spec of `agentctl spec example` verbatim, and relative links and anchors in the documents must resolve.

## Closing a milestone

Every milestone is closed in this order:

1. Tests and typecheck pass; `agentctl doctor` exits 0.
2. Update `README.md` and `README.pl.md` (kept in step), the diagrams, and the pages in `docs/`.
3. Add the version to `CHANGELOG.md` (Keep a Changelog) and set the version in `package.json` (and `package-lock.json`).
4. Write the notes for the GitHub version page.
5. Open the pull request. Tags and GitHub versions are made on the merge commit, after the merge.

## Testing against the real tools

Tests never touch your tmux or your agents. When you try a change live (a real tmux, real git, a started task), do it only through `scripts/live-harness.ts`; never by hand in your own `agentctl` session, and never against your own tasks. Earlier hand-made attempts started the real Claude Code twice, ran the real `notify` program of a Codex config once and overwrote the clipboard once.

The harness builds a sandbox under `~/Projects/cache/<task>/live-<name>/` and gives every process under test:

- an isolated tmux server (`TMUX` unset, its own `TMUX_TMPDIR`, a `tmux.conf` with `exit-empty off` and a `default-command` that sets PATH explicitly, so a window's shell cannot find the real agents);
- its own `AGENTCTL_HOME`, `CODEX_HOME` (no `notify` chain), `CLAUDE_CONFIG_DIR` and `HOME`;
- a PATH with a directory of fakes (`claude`, `codex`, `pbcopy`, `pbpaste`, `terminal-notifier`, `osascript`, `notify-send`) and links to `tmux`, `git` and `node`, and no directory that holds a real `claude` or `codex`. The fake agents answer `--version` and `--help`, print an idle screen and log every start to `agent.log`.

Before anything is started the harness checks `command -v` of each faked command and the `#{socket_path}` of the tmux server, and refuses (`HarnessRefusal`) when one points at a real binary, at the default tmux server, or outside the sandbox. `tests/harness.test.ts` tests those refusals. Cleanup (the tmux server, background processes) runs in `finally`.

```ts
import { withHarness } from './scripts/live-harness.ts';
await withHarness({ name: 'my-try' }, (h) => {
  console.log(h.agentctl(['status']).stdout);   // agentctl in the sandbox
  h.tmux(['list-windows', '-a']);               // tmux on the sandbox's server only
});
```

`scripts/live-scenarios.ts` is the set of live checks of the milestone (a limit raised without restarting the watcher, events, gc, resume after a tmux restart). Do not run `npm link` from a development checkout over your daily install: use the stable copy (`bin/agentctl-update`).

## Style

Match the surrounding code. agentctl never merges, pushes, rebases, deletes branches or turns on an auto-accept mode; a change that would do any of these is out of scope. Messages to the user are short and say what to do next.
