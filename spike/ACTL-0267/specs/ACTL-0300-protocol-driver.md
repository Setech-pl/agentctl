---
task: ACTL-0300
agent: claude
model: claude-opus-5-5
effort: high
repos:
  - path: ~/Projects/agentctl
    worktree: ~/Projects/agentctl-wt/agentctl-0300
    base: main
    branch: actl-0300-protocol-driver
report: ~/Projects/cache-dev/agentctl-0300/ACTL-0300.md
---
0.30.0: protocol driver for Codex (App Server) behind providers.codex.driver: protocol|auto; screen driver unchanged and default.
1. Driver interface in src/core/providers: start/send/steer/interrupt/answer/resume/close/state/usage; screen and protocol implementations; the task record stores driver + protocol version, fixed for the task's life.
2. Codex: per-task `codex app-server --listen unix://<taskdir>/app.sock` with the user's CLI (not the shared daemon); JSON-RPC client from spike/ACTL-0267/protocol (generate types with `codex app-server generate-ts` per minor and vendor them with notice). States per protocol/state-map.ts; answer = approval decision / requestUserInput answers; resume = thread/resume; interrupt = turn/interrupt; usage = thread/tokenUsage/updated.
3. Live viewer: the tmux window runs `codex --remote unix://<taskdir>/app.sock resume <thread>`; if that fails, an event-log tail view. Closing the viewer never kills the task.
4. Observation record (JSONL per host) + driver: auto rule from spike/ACTL-0267/auto (min N 20, ±5/10 pp hysteresis, fail-closed fallback, pin). Unknown methods or missing required fields → driver-error → screen at the next task start.
5. Claude: ACP (claude-agent-acp) only as opt-in experiment; never bundle the Agent SDK (Anthropic Commercial Terms).
Tests: recorded handshakes + synthetic turns (no inference); fake app-server fixture for answer/interrupt/resume. Docs EN+PL. Gate: full.
