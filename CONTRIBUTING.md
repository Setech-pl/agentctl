# Contributing

`npm run build` compiles TypeScript into `dist/` and rewrites imports to JavaScript. The installed command runs `dist/bin/agentctl.js` without a TypeScript loader. Development still uses `node --experimental-strip-types bin/agentctl.ts`. Run `npm ci`, `npm run build`, then `npm pack` to prepare a package.

agentctl is a small TypeScript project. Sources and tests use Node's type stripping; npm packages use JavaScript compiled to dist/. Node 22.14 or newer, git and tmux are enough to work on it.

```sh
npm ci
npm test            # node:test; no real tmux, git or agent is involved
npm run typecheck   # tsc --noEmit
npm run build       # compile runtime into dist/, make executable
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

Match the surrounding code. agentctl never merges, pushes, rebases or turns on an auto-accept mode, and deletes a branch only in `gc --branches`, with `git branch -d` for a merged one; a change that would do any of these is out of scope. Messages to the user are short and say what to do next.

Codex: collapsed questions show their count and the shortcut read from “to answer”. `needs-input` takes priority while Codex keeps working; after answering, the screen determines the state again. Board preview, peek, status/MCP `question` and macOS show the question or opening instructions. ntfy sends only opening instructions by default; `notify.ntfy.include_question: true` opts into question text.

## npm releases and first publication (Marcin)

Normal releases: change the version in package.json and package-lock.json, update CHANGELOG, open a PR,
merge after CI, then create a GitHub release whose tag equals `v` plus the package version on the merge commit.
The `release: published` event runs `.github/workflows/publish.yml`: install, test, typecheck, build, then
`npm publish --provenance --access public` using OIDC. There is no NPM_TOKEN. A release whose version already exists
in the registry is logged and skipped (the bootstrap case); it does not gain provenance retroactively.
CI validates macOS with minimum Node 22.14.0 and latest Node. Ubuntu was not enabled because no Ubuntu runner or
working Docker daemon was available for validation. Linux runtime paths and notify-send are implemented, but remain unverified here.

The following are instructions for the maintainer to execute later, not steps run by the preparation task.

1. On [npmjs.com](https://www.npmjs.com/signup), create/verify your account and email. Enable 2FA in Account Settings
   (security key/passkey or the method currently offered by npm). Create the free public-package organization `setech-pl`
   or obtain owner/publish permissions from its existing owner. GitHub membership does not grant npm permissions.
2. Merge the 0.16.0 PR first. On the clean merge commit, prepare and inspect the package using zsh:

```zsh
cd ~/Projects/agentctl
[[ -z $(git status --porcelain) ]] || return 1
[[ $(node -p 'require("./package.json").version') == 0.16.0 ]] || return 1
mkdir -p ~/Projects/cache/agentctl-16
export npm_config_cache=~/Projects/cache/agentctl-16/npm-cache
export TMPDIR=~/Projects/cache/agentctl-16/tmp
export AGENTCTL_TEST_CACHE=~/Projects/cache/agentctl-16/tests
mkdir -p "$TMPDIR"
npm ci
npm test
npm run typecheck
npm run build
npm pack --dry-run
npm publish --dry-run
```

3. Trusted publisher configuration requires an existing package. For this new package the first publication is manual.
   Login interactively, complete browser authentication and 2FA, then publish 0.16.0 from that reviewed commit.
   Local publication explicitly disables provenance: attestations need a supported CI identity.
   These commands change npm authentication and publish publicly; execute them only when ready:

```zsh
cd ~/Projects/agentctl
npm login --registry=https://registry.npmjs.org/
npm whoami
npm publish --access public --provenance=false
npm view @setech-pl/agentctl@0.16.0 version dist --json
```

4. Create the GitHub release `v0.16.0` from the reviewed merge commit. The workflow sees the manual bootstrap and skips
   republishing that immutable npm version. The first OIDC/provenance publication must use a new version, for example 0.16.1.
5. When that next release is ready, open the package's Settings → Trusted publishing on npmjs.com. Choose GitHub Actions:
   owner **Setech-pl**, repository **agentctl**, workflow filename **publish.yml** (only the filename), environment blank.
   Enable direct **npm publish** permission; stage-only permission does not authorize this workflow.
   Publish the next GitHub release within **2 days** of adding the publisher, otherwise delete/recreate the expired configuration.
   The repository and package must be public for provenance. After the successful OIDC publication, set Publishing access to
   require 2FA and disallow tokens. No npm token or GitHub secret is required for public dependencies.
6. Future releases follow version → PR → merge → GitHub release → workflow publication. Verify the run and the provenance badge.

Requirements verified against [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/):
Node ≥22.14.0, npm ≥11.5.1, GitHub-hosted runner and `id-token: write`. The workflow uses Node 24 and checks the npm floor,
with setup-node caching disabled. [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
explicitly require the package to exist (the CLI trust-management command itself needs npm ≥11.15; the UI avoids that requirement).
See also [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
