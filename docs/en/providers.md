# Providers

This page describes agentctl's adapters, not a promise that an account can access every model alias. Check the provider's installed version/login and `agentctl doctor`. The adapter baselines in fixtures are Claude Code 2.1.309/2.1.311, Codex 0.166/0.167 and Kimi Code 2.5.x; newer CLIs can change screen formats.

## Enable and configure

~~~yaml
providers: [claude, codex, kimi, glm]
limits: {claude: 2, codex: 2, kimi: 2, glm: 2}
defaults: {agent: codex, model: default, effort: medium}
capacity:
  codex_refresh: true
  claude_usage_probe: false
  kimi_usage_probe: false
~~~

Claude and Codex remain mandatory in `providers`; Kimi and GLM are optional. Restart MCP after enabling providers so its provider enums expand. `agents.<provider>` sets flags, environment, effort arguments and parsing patterns; `usage.<provider>_dir` selects transcript roots. `limits` counts local concurrency, not plan entitlement. Avoid auto-approve flags: adapters reject unsafe launch settings. Worktrees are not an OS sandbox; Codex is launched with `--sandbox danger-full-access` while approval bypass remains forbidden.

| Adapter | Launch/model | Effort accepted by agentctl | Plan/token source |
|---|---|---|---|
| `claude` | `claude --model MODEL`; default omits model | low, medium, high, xhigh, max via `--effort` | statusLine tap, optional neutral /usage probe; Claude JSONL tokens/subagents |
| `codex` | `codex -m MODEL`; default omits model | low, medium, high, xhigh via `-c model_reasoning_effort=…` | app-server account/rateLimits/read plus session logs; input/cache/output |
| `kimi` | `kimi -m` with qualified alias; default omits it | low, high, max; native thinking config; model catalog can restrict levels | passive wire/session state usage.record; optional /usage probe |
| `glm` | `claude-glm --model`, only glm-5.3 / glm-5.3-flash or default | same as Claude | separate Claude-format transcripts/statusLine; plan normally n/d |

The [matrix](../../data/model-matrix.yaml) is a dispatch policy, not a benchmark or access check. Board short labels show model family/version/effort when known; requested and observed settings remain distinct.

## Claude Code (Anthropic)

[Product](https://claude.com/product/claude-code) · [CLI setup](https://code.claude.com/docs/en/setup) · [Authentication](https://code.claude.com/docs/en/authentication).

Install with `npm install -g @anthropic-ai/claude-code` (the official setup also offers native installation). Run `claude` and complete browser login/onboarding. agentctl's hooks use a per-task settings file and forward supported existing hooks/statusLine; it does not replace global settings with auto-accept permissions. `remote_control: true` is Claude-only and starts an interactive Remote Control session; first-use consent is manual.

Plan observations normally come from `usage.claude_tap: true`. Optional `capacity.claude_usage_probe: true` opens a separate neutral TUI, submits only `/usage`, and closes it; minimum interval 15 minutes. No inference prompt is submitted. Trust/login in that neutral directory must be completed manually; doctor never probes. The parser requires the all-model weekly panel, preserves unknown resets and retains the last reading after failure. Model-specific weekly panels are not combined into the all-model quota.

## OpenAI Codex CLI

[Product](https://chatgpt.com/features/codex) · [CLI docs](https://developers.openai.com/codex/cli) · [Official source](https://github.com/openai/codex).

Install `npm install -g @openai/codex`, run `codex`, and complete its sign-in flow. agentctl passes model/effort and disables startup update checking per task. If an update modal still appears, answer it in the window; it is not ready input. Trust is always manual. Session notify/transcript evidence helps distinguish a real turn from a draft.

`capacity.codex_refresh: true` reads `account/rateLimits/read` from a short-lived app-server RPC (3 s deadline), without creating a thread or inference turn. Failure retains the last reading's provenance/time. Tokens from session logs separate cached input from fresh input. Busy follow-ups stay in agentctl's durable prompt queue until confirmed idle/turn end; status/peek show IDs and `send` can withdraw them. Do not repeat a send because its delivery is pending.

## Kimi Code CLI (Moonshot AI)

[Product](https://www.kimi.com/code) · [CLI docs](https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started).

For this adapter baseline install `npm install -g @moonshot-ai/kimi-code@2.5.0`. Current upstream npm installation requires Node ≥22.19.0; use a compatible Node 22/26 runtime. Run `kimi`, enter `/login`, complete provider authentication and inspect its model catalog. Legacy Python kimi-cli is not this adapter. Config lives in `~/.kimi-code/config.toml` by default; resolve home from `agents.kimi.env.KIMI_CODE_HOME`, explicit `usage.kimi_dir`, process `KIMI_CODE_HOME`, then the default.

Kimi aliases are server-dependent; the matrix uses k3-256k/k3 and explicit-only k3.1-pro. Agentctl's documented policy reserves the latter for explicit costly work; the historical ~10× plan multiplier is an adapter-era observation, not a current billing guarantee. Catalog display_name/support_efforts and passive llm.request evidence determine effective version/effort; unknown versions are not guessed. Resume uses session/continue without forcing a model override.

Permission mode `auto` (Never Ask) is refused. `manual` or `yolo` requires `permission.dangerous_command_guard=true`; this name in config does not permit the forbidden `--yolo` launch flag. Guard-off, trust environment shortcuts, -p/--prompt and auto-approval flags fail safety validation. Agentctl never edits Kimi's config. Exact reviewed Bash rules are safer than broad wildcards; permissions are not a sandbox.

Every canonical worktree needs its own trust. Prompt delivery requires a whole, stable composer, bracketed paste and separately checked Enter; a folded paste is still a draft. Busy delivery defaults off. Passive protocol 1.5 is recognized, with screen fallback and warnings for unknown versions. Some limit/overload/background patterns and busy footer behavior remain synthetic hypotheses. Tokens come from usage.record, never token_counting estimates. Optional `capacity.kimi_usage_probe` opens neutral /usage at most every five minutes (model key defaults k3, never Highspeed); missing weekly/monthly windows stay n/d.

## GLM Coding Plan (Z.ai)

[Product](https://z.ai/subscribe) · [Claude Code integration docs](https://docs.z.ai/devpack/tool/claude).

Install Claude Code and obtain a Z.ai Coding Plan key through Z.ai's account flow. Agentctl expects an owner-installed executable `claude-glm` on PATH, or `providers_config.glm.command` (one executable name/path, no arguments). This wrapper is a local integration, not a bundled official CLI. Store the key through macOS Keychain Access as a generic password with service `neon-city-zai`; agentctl's doctor checks that item's existence without reading its value.

Example owner-maintained wrapper (protect it with chmod 700; the Keychain read occurs only in the wrapper's process):

~~~sh
#!/bin/sh
export CLAUDE_CONFIG_DIR="$HOME/.claude-glm"
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
ANTHROPIC_AUTH_TOKEN="$(security find-generic-password -s neon-city-zai -w)" || exit 1\nexport ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_API_KEY
exec claude "$@"
~~~

Run `claude-glm` once and finish theme/security/onboarding, then each folder's trust. `usage.glm_dir` should match that separate Claude config directory when discovery cannot resolve it. The adapter reuses Claude hooks, prompt/report handling and skills/subagents. It adds `CLAUDE_CODE_AUTO_MODE_SERVER=0` to GLM task environment by default (overridable in providers_config.glm.env; agents.glm.env/spec env win). It does not set it for Claude or write it to global Claude settings. Onboarding remains needs-input, informational auto-mode banners and MCP-auth warnings do not block ready input.

Endpoint/token variables are refused in providers_config.glm.env, stripped from GLM spec env with a warning and redacted from persisted captures. They belong only in the wrapper. Do not change the Anthropic account's global settings to use Z.ai. GLM has a separate default concurrency limit 2 and separate tokens/benchmark identity. This release has no documented Z.ai quota API/CLI reading: 5-hour/weekly plan is `n/d` and queue_hold never holds GLM. Its warn/critical config cannot trigger without a reading. Remote Control is unsupported for this wrapper.

## Shared trust and failure behavior

Agentctl never answers folder trust or provider onboarding. Open the task's tmux window, answer, return with F12; watch delivers the pending original prompt once ready. A CLI layout change can fail closed: input not structurally recognized means no Enter. `start_failure.keep_window: true` keeps failed-start windows and the saved screen; inspect before queue_retry. See [Troubleshooting](troubleshooting.md), [Configuration](configuration.md) and [Economics](token-economics.md).

Official product/CLI links were checked with curl HEAD+redirects on 2026-11-15; the original openai.com/codex marketing URL returned 403 in this environment, so the product link above uses the accessible official ChatGPT page. External documentation can move independently of this release.
