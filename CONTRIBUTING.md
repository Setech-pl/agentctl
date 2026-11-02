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

Tests never touch your tmux or your agents. When you try a change live, do it in an isolated tmux server (a throwaway `TMUX_TMPDIR`, `TMUX` unset) and a throwaway `AGENTCTL_HOME`, never in your own `agentctl` session or against your own tasks. Do not run `npm link` from a development checkout over your daily install: use the stable copy (`bin/agentctl-update`).

## Style

Match the surrounding code. agentctl never merges, pushes, rebases, deletes branches or turns on an auto-accept mode; a change that would do any of these is out of scope. Messages to the user are short and say what to do next.
