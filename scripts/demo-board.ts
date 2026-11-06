import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import type { Harness } from './live-harness.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { shellQuote } from '../src/core/util.ts';

/*
 * A demo session for the README screenshot: eight tasks of two cohorts on fake agents, in the sandbox of live-harness.ts (own tmux server,
 * own AGENTCTL_HOME, fake claude and codex that print a prepared screen). The real board runs on it at 160x24 and its screen is captured
 * with colours. The board process gets a frozen clock and a made-up amount of free disk space (demo-preload.mjs), so the capture is the
 * same on every run. No real agent, plan or path is involved.
 *
 *   node --experimental-strip-types --no-warnings scripts/demo-board.ts <out-dir>      writes <out-dir>/board.ansi and board.txt
 */

export const COLUMNS = 160;
export const ROWS = 24;
/** The board's clock: 2026-11-04 10:42:07 UTC (the board runs with TZ=UTC). */
const FIXED_MS = Date.UTC(2026, 10, 4, 10, 42, 7);
const minutes = (n: number): number => n * 60_000;

type Provider = 'claude' | 'codex';

interface DemoTask {
  id: string;
  cohort: string;
  agent: Provider;
  model: string;
  effort: string;
  /** What the window shows; the state of the task follows from it. */
  screen: string;
  /** Minutes the task has been running at FIXED_MS. */
  runningMin: number;
  /** Files committed in the worktree (one commit per entry) and files left uncommitted. */
  commits: string[][];
  dirty: string[];
  reviewOf?: string;
  /** The report the agent wrote, given the SHA of its last commit. */
  report?: (sha: string) => string;
  /** Fresh tokens the session log adds up to. */
  tokens: { input: number; output: number; cacheRead: number };
}

const CLAUDE_PROMPT = '─────────────────────────────────────────────────────────────────────────────\n❯ \n─────────────────────────────────────────────────────────────────────────────\n';
const CODEX_PROMPT = '› Ask Codex to do anything\n';

const TASKS: DemoTask[] = [
  {
    id: 'API-AUTH-1',
    cohort: 'sprint-1',
    agent: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'medium',
    runningMin: 41,
    commits: [['src/auth/token.ts', 'src/auth/token.test.ts'], ['src/auth/session.ts', 'src/auth/middleware.ts'], ['src/auth/session.test.ts']],
    dirty: [],
    report: (sha) => `Verdict: PASS – refresh rotates the session id, logout revokes the whole token family.

- Branch: agent/api-auth-1
- SHA: ${sha}
- Tests: 18 passed, 0 failed

## Summary

Refresh tokens are single-use and belong to a family (\`src/auth/token.ts\`). The session id rotates on every refresh (\`src/auth/session.ts\`) and a revoked family answers 401 (\`src/auth/middleware.ts\`).

## Blockers

None.

## Decisions

- Revoking one token revokes its whole family: a replayed refresh token is treated as theft.

## Open points

None.

\`\`\`agentctl-outputs
version: 1
verdict: PASS
commits: [{repo: shop, branch: agent/api-auth-1, sha: ${sha}}]
integrate: [{repo: shop, branch: agent/api-auth-1, sha: ${sha}, note: ready for human integration}]
decisions: [Choose the rollout window]
actions: []
checks: [{name: auth tests, result: PASS, note: 18 passed}]
notes: []
\`\`\`

<!-- agentctl:report-end -->
`,
    tokens: { input: 212_000, output: 38_000, cacheRead: 1_400_000 },
    screen: `• Ran npm test -- auth
  └ 18 passed, 0 failed

• Done. Session ids now rotate on every refresh and logout revokes the token
  family. The report is in the task folder.

${CODEX_PROMPT}
  gpt-6.1-sol medium · 71% context left
`,
  },
  {
    id: 'REVIEW-API-AUTH-1',
    cohort: 'sprint-1',
    agent: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    runningMin: 9,
    commits: [],
    dirty: ['REVIEW-NOTES.md'],
    reviewOf: 'API-AUTH-1',
    tokens: { input: 96_000, output: 21_000, cacheRead: 880_000 },
    screen: `● Read(src/auth/session.ts)
  ⎿  Read 142 lines

● Bash(npm test -- auth)
  ⎿  18 passed, 0 failed

● The refresh path rotates the session id, but the logout handler still accepts
  the old one for a few seconds. Checking whether that window is intended…

✻ Reviewing the diff… (3m 12s · esc to interrupt)

${CLAUDE_PROMPT}  ⏵⏵ accept edits on (shift+tab to cycle)
`,
  },
  {
    id: 'DB-MIGRATE-3',
    cohort: 'sprint-1',
    agent: 'codex',
    model: 'gpt-6.1-sol',
    effort: 'high',
    runningMin: 24,
    commits: [['db/migrations/0042_orders_index.sql'], ['db/migrations/0043_backfill_status.sql', 'db/rollback/0043.sql']],
    dirty: ['db/check.log'],
    tokens: { input: 305_000, output: 64_000, cacheRead: 2_900_000 },
    screen: `• Edited db/migrations/0043_backfill_status.sql (+22 -0)
• Ran npm run db:check
  └ 2 migrations pending, 0 conflicts

• Writing the rollback script and a dry run against the staging copy.

${CODEX_PROMPT}
  gpt-6.1-sol high · 58% context left       Working (2m 41s • esc to interrupt)
`,
  },
  {
    id: 'DOCS-SEARCH-1',
    cohort: 'sprint-1',
    agent: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    runningMin: 17,
    commits: [['docs/search.md', 'docs/search-index.md']],
    dirty: [],
    tokens: { input: 74_000, output: 18_000, cacheRead: 610_000 },
    screen: `● Wrote docs/search.md (84 lines) and docs/search-index.md (51 lines).

● The search index rebuilds in the background; I will check the result and
  link the final numbers when it finishes.

${CLAUDE_PROMPT}  2 shells still running
`,
  },
  {
    id: 'UI-CART-2',
    cohort: 'sprint-2',
    agent: 'codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    runningMin: 12,
    commits: [['src/cart/CartView.tsx']],
    dirty: ['src/cart/store.ts', 'src/cart/totals.ts'],
    tokens: { input: 118_000, output: 26_000, cacheRead: 990_000 },
    screen: `• Read src/cart/store.ts
• A price can change while an item sits in the cart,
  so the total has to be recalculated somewhere.

  Question 1/1
  Compute the cart total on the server or the client?

  › 1. Server (Recommended)  One source of truth.
    2. Client store          Instant UI, needs a guard.
    3. Something else

  Press enter to confirm or esc to cancel
`,
  },
  {
    id: 'PERF-CACHE-2',
    cohort: 'sprint-2',
    agent: 'codex',
    model: 'gpt-6-luna',
    effort: 'medium',
    runningMin: 15,
    commits: [['src/cache/lru.ts', 'src/cache/lru.test.ts'], ['src/cart/store.ts', 'src/cart/totals.ts']],
    dirty: [],
    tokens: { input: 154_000, output: 31_000, cacheRead: 1_250_000 },
    screen: `• Edited src/cache/lru.ts (+61 -4)
• Ran npm run bench -- cache
  └ p95 118 ms → 41 ms on the product page

• Wiring the cache into the cart store and re-running the benchmark.

${CODEX_PROMPT}
  gpt-6-luna medium · 66% context left      Working (1m 08s • esc to interrupt)
`,
  },
];

const QUEUED = [
  { id: 'REVIEW-DOCS-SEARCH-1', cohort: 'sprint-1', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', after: 'DOCS-SEARCH-1', reviewOf: 'DOCS-SEARCH-1' },
  { id: 'REVIEW-UI-CART-2', cohort: 'sprint-2', agent: 'claude', model: 'claude-opus-5-5', effort: 'high', after: 'UI-CART-2', reviewOf: 'UI-CART-2' },
] as const;

/** The fixed time of every commit of the demo repository, so that the SHAs in the report are the same on every run. */
const COMMIT_DATE = '2026-11-04T09:00:00+00:00';

const git = (h: Harness, cwd: string, args: string[]): void => {
  const r = spawnSync('git', args, { cwd, env: { ...h.env, GIT_AUTHOR_DATE: COMMIT_DATE, GIT_COMMITTER_DATE: COMMIT_DATE }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`);
};

const writeFile = (file: string, body: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/** The fake agent of the demo: answers --version/--help like the harness's, then shows the screen of its worktree (named after the task) and stays. */
function fakeAgent(name: Provider, screens: string): string {
  const base = name === 'claude' ? '2.1.309 (Claude Code, fake)' : 'codex-cli 0.166.0 (fake)';
  const help = name === 'claude'
    ? 'echo "  --effort <level>"; echo "  --remote-control [name]               Start an interactive session with Remote Control enabled"; echo "  --append-system-prompt <prompt>       Append a system prompt (--bare: --append-system-prompt[-file])"'
    : 'echo "  -c, --config <key=value>"';
  return `#!/bin/bash
echo "${name} $*" >> "\${HARNESS_AGENT_LOG:-/dev/null}"
case "$1" in
  app-server) while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}';;
      *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"rateLimits":{}}}';;
    esac
  done; exit 0;;
  --version) echo "${base}"; exit 0;;
  --help) ${help}; exit 0;;
esac
stty -echo 2>/dev/null
printf '${name === 'claude' ? '❯ ' : '› Ask Codex to do anything'}\\n'
screen=${shellQuote(screens)}/"$(basename "$PWD")".txt
while [ ! -f "$screen" ]; do sleep 0.2; done
last=
while :; do
  now=$(cksum < "$screen")
  if [ "$now" != "$last" ]; then
    printf '\\033[2J\\033[H\\033[3J'
    cat "$screen"
    last=$now
  fi
  sleep 0.3
done
`;
}

function specText(h: Harness, repo: string, t: { id: string; cohort: string; agent: string; model: string; effort: string; reviewOf?: string | undefined; after?: string | undefined }): string {
  const wt = path.join(h.root, 'wt', t.id.toLowerCase());
  return `---
task: ${t.id}
agent: ${t.agent}
model: ${t.model}
effort: ${t.effort}
cohort: ${t.cohort}
${t.reviewOf ? `review_of: ${t.reviewOf}\n` : ''}${t.after ? `after: [${t.after}]\n` : ''}repos:
  - path: ${repo}
    worktree: ${wt}
    branch: agent/${t.id.toLowerCase()}
    base: main
---
${t.reviewOf ? `Review the work of ${t.reviewOf}: correctness, edge cases, missing tests.` : `Work on ${t.id}.`}
`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Rewrites every timestamp of the task's TASK.md that `new` wrote with the real clock. */
function backdate(h: Harness, id: string, startedMs: number): void {
  const file = path.join(h.root, 'state', id.toLowerCase(), 'TASK.md');
  let text = fs.readFileSync(file, 'utf8');
  text = text.replace(/^(started|attempt_started): .*$/gm, (_m, key: string) => `${key}: ${iso(startedMs)}`);
  fs.writeFileSync(file, text);
}

function claudeLog(file: string, cwd: string, id: string, startMs: number, model: string, t: DemoTask['tokens']): void {
  const lines = [
    { type: 'user', sessionId: id, cwd, version: '2.1.309', timestamp: iso(startMs + 5_000), message: { role: 'user', content: 'start' } },
    { type: 'assistant', sessionId: id, cwd, version: '2.1.309', timestamp: iso(startMs + minutes(2)), requestId: `${id}-r1`, message: { id: `${id}-m1`, model, usage: { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: t.cacheRead, cache_creation_input_tokens: 0 } } },
  ];
  writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

function codexLog(file: string, cwd: string, id: string, startMs: number, model: string, effort: string, t: DemoTask['tokens']): void {
  const lines = [
    { timestamp: iso(startMs + 5_000), type: 'session_meta', payload: { id, cwd, timestamp: iso(startMs + 5_000), cli_version: '0.166.0' } },
    { timestamp: iso(startMs + 6_000), type: 'turn_context', payload: { model, effort } },
    { timestamp: iso(startMs + minutes(2)), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: t.input + t.cacheRead, cached_input_tokens: t.cacheRead, output_tokens: t.output } } } },
  ];
  writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

const gitOut = (h: Harness, cwd: string, args: string[]): string => spawnSync('git', args, { cwd, env: h.env, encoding: 'utf8' }).stdout;

/** Write the report where the task's TASK.md says it goes. */
function writeReport(h: Harness, id: string, text: string, mtimeMs: number): void {
  const status = JSON.parse(h.agentctl(['status', '--json']).stdout) as { rows?: { task: string; reportPath: string }[] } | { task: string; reportPath: string }[];
  const rows = Array.isArray(status) ? status : (status.rows ?? []);
  const p = rows.find((r) => r.task === id)?.reportPath;
  if (!p) throw new Error(`no report path for ${id}`);
  writeFile(p, text);
  const at = new Date(mtimeMs);
  fs.utimesSync(p, at, at);
}

const docsReport = (sha: string): string => `Verdict: PASS – search guide and API reference written, the index rebuild finished.

- Branch: agent/docs-search-1
- SHA: ${sha}

## Blockers

None.

\`\`\`agentctl-outputs
version: 1
verdict: PASS
commits: [{repo: shop, branch: agent/docs-search-1, sha: ${sha}}]
decisions: []
actions: []
checks: [{name: index rebuild, result: PASS}]
notes: []
\`\`\`

<!-- agentctl:report-end -->
`;

/** The readings the agents' own status lines would have given two minutes before `nowMs`. */
function writePlans(h: Harness, nowMs: number): void {
  const usage = path.join(h.agentctlHome, 'usage');
  const at = nowMs - minutes(2);
  const reset = (offsetMin: number): number => Math.floor((nowMs + minutes(offsetMin)) / 1000);
  writeFile(path.join(usage, 'claude-plan.json'), JSON.stringify({ v: 1, at, windows: [{ kind: 'session', minutes: 300, usedPercent: 62, resetsAt: reset(147) }, { kind: 'week', minutes: 10080, usedPercent: 41, resetsAt: reset(60 * 56) }] }));
  writeFile(path.join(usage, 'codex-plan.json'), JSON.stringify({ at, planType: 'pro', windows: [{ kind: 'session', minutes: 300, usedPercent: 34, resetsAt: reset(205) }, { kind: 'week', minutes: 10080, usedPercent: 83, resetsAt: reset(60 * 80) }] }));
}

async function mcpClient(h: Harness): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, cwd: h.root });
  const client = new Client({ name: 'demo-chat', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function mcpCall(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? []).map((c) => c.text ?? '').join('\n');
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return text;
}

/** Nothing of the machine stays in a text that goes into the README: the sandbox path becomes /home/demo/agentctl. */
const scrub = (h: Harness, text: string): string => {
  const ids = new Map<string, string>();
  const stable = ['3f9c2a7e-51d4-4b86-9e0a-7c1d6b2f8a45', '8b1e4d93-0a7c-42f5-b6d8-2e9f1c3a7d60', 'c47a0e15-96b2-4d38-8f1b-5a3e7d9c2b04'];
  return text
    .replaceAll(fs.realpathSync(h.root), '/home/demo/agentctl')
    .replaceAll(h.root, '/home/demo/agentctl')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, (id) => {
      if (!ids.has(id)) ids.set(id, stable[ids.size] ?? id);
      return ids.get(id) as string;
    });
};

/** The events carry the real time of the run: they are shown at the clock of the board screenshot, one minute apart from 10:37, in order. */
function fixTimes(events: string): string {
  let minute = 36;
  return events.replace(/^\d\d:\d\d(?=\s)/gm, () => `10:${++minute}`);
}


const CONFIG = `limits: {claude: 4, codex: 4}\ncapacity: {codex_refresh: false}\nwatch: {interval: 2}\ndisk: {warn_gb: 50, critical_gb: 20}\n`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const startMs = (t: DemoTask): number => FIXED_MS - minutes(t.runningMin) - 20_000;

/** The repository, the six running tasks (idle agents so far), their commits, start times and session logs. Returns the repository and the screens directory. */
function buildDemo(h: Harness): { repo: string; screens: string } {
  const screens = path.join(h.root, 'screens');
  fs.mkdirSync(screens, { recursive: true });
  for (const name of ['claude', 'codex'] as const) fs.writeFileSync(path.join(h.fakeBin, name), fakeAgent(name, screens), { mode: 0o755 });

  // one repository, one base commit
  const repo = path.join(h.root, 'shop');
  fs.mkdirSync(repo, { recursive: true });
  git(h, repo, ['init', '-q', '-b', 'main']);
  for (const f of ['src/auth/token.ts', 'src/auth/session.ts', 'src/cart/store.ts', 'src/cart/totals.ts', 'src/cart/CartView.tsx', 'src/cache/lru.ts', 'docs/index.md']) writeFile(path.join(repo, f), `// ${f}\n`);
  git(h, repo, ['add', '.']);
  git(h, repo, ['commit', '-qm', 'initial']);

  for (const t of TASKS) {
    const file = path.join(h.root, `${t.id}.md`);
    fs.writeFileSync(file, specText(h, repo, t));
    const r = h.agentctl(['new', file, '-y']);
    if (r.code !== 0) throw new Error(`new ${t.id} failed:\n${r.stdout}${r.stderr}`);
  }
  for (const t of TASKS) {
    const wt = path.join(h.root, 'wt', t.id.toLowerCase());
    t.commits.forEach((files, i) => {
      for (const f of files) writeFile(path.join(wt, f), `// ${f} (${t.id}, commit ${i + 1})\n`);
      git(h, wt, ['add', '.']);
      git(h, wt, ['commit', '-qm', `${t.id}: step ${i + 1}`]);
    });
    for (const f of t.dirty) writeFile(path.join(wt, f), `// ${f} (${t.id}, work in progress)\n`);
    backdate(h, t.id, startMs(t));
    const logId = `demo-${t.id.toLowerCase()}`;
    if (t.agent === 'claude') claudeLog(path.join(h.root, 'claude-logs', 'projects', wt.replace(/[^A-Za-z0-9]/g, '-'), `${logId}.jsonl`), wt, logId, startMs(t), t.model, t.tokens);
    else {
      const day = new Date(FIXED_MS).toISOString().slice(0, 10).split('-');
      codexLog(path.join(h.codexHome, 'sessions', ...day, `rollout-${logId}.jsonl`), wt, logId, startMs(t), t.model, t.effort, t.tokens);
    }
  }
  return { repo, screens };
}

function queueReviews(h: Harness, repo: string): void {
  for (const q of QUEUED) {
    const file = path.join(h.root, `${q.id}.md`);
    fs.writeFileSync(file, specText(h, repo, q));
    const r = h.agentctl(['queue', file, '-y']);
    if (r.code !== 0) throw new Error(`queue ${q.id} failed:\n${r.stdout}${r.stderr}`);
  }
}

const writeScreens = (screens: string): void => TASKS.forEach((t) => writeFile(path.join(screens, `${t.id.toLowerCase()}.txt`), t.screen));
const writeReports = (h: Harness): void => TASKS.forEach((t) => t.report && writeReport(h, t.id, t.report(gitOut(h, path.join(h.root, 'wt', t.id.toLowerCase()), ['rev-parse', 'HEAD']).trim()), FIXED_MS - minutes(3)));

/** The board of the demo session at 160x24, with colours, on a frozen clock. */
export async function captureBoard(cacheRoot: string): Promise<{ ansi: string; plain: string }> {
  return withHarness({ name: 'demo-board', cacheRoot, session: 'work', config: CONFIG }, async (h) => {
    const { repo, screens } = buildDemo(h);
    // The agents were idle while `new` pasted the prompts (it waits for the input box); now they show their screens.
    writeScreens(screens);
    writeReports(h);
    queueReviews(h, repo);
    writePlans(h, FIXED_MS);

    // the board, in a window of the session, at a fixed size, with colours and the frozen clock
    const preload = path.resolve(import.meta.dirname, 'demo-preload.mjs');
    const cli = path.resolve(import.meta.dirname, '../bin/agentctl.ts');
    const command = ['env', 'TZ=UTC', 'FORCE_COLOR=2', `DEMO_FIXED_MS=${FIXED_MS}`, process.execPath, '--experimental-strip-types', '--no-warnings', '--import', preload, cli, 'board'].map(shellQuote).join(' ');
    if (h.tmux(['new-window', '-d', '-t', `=${h.session}:`, '-n', 'board', command]).code !== 0) throw new Error('cannot open the board window');
    const target = `=${h.session}:board`;
    h.tmux(['resize-window', '-t', target, '-x', String(COLUMNS), '-y', String(ROWS)]);
    const plain = (): string => h.tmux(['capture-pane', '-p', '-t', target]).stdout;
    const until = async (what: string, ok: (screen: string) => boolean): Promise<string> => {
      const end = Date.now() + 30_000;
      while (Date.now() < end) {
        const s = plain();
        if (ok(s)) return s;
        await sleep(200);
      }
      throw new Error(`board never showed ${what}:\n${plain()}`);
    };
    await until('every task and the usage panel', (s) => TASKS.every((t) => s.includes(t.id)) && /codex .*83%/.test(s) && /↻/.test(s));
    for (let i = 0; i < 25 && !/▸\s*UI-CART-2/.test(plain()); i++) {
      h.tmux(['send-keys', '-t', target, 'Down']);
      await sleep(250);
    }
    await sleep(2500); // a refresh (the git progress and the preview of the selected window arrive with it)
    const ready = await until('the selected task and its preview', (s) => /▸\s*UI-CART-2/.test(s) && s.includes('Press enter to confirm') && /⚠/.test(s));
    const ansi = h.tmux(['capture-pane', '-e', '-p', '-t', target]).stdout;
    return { ansi, plain: ready };
  });
}

/**
 * What the chat sees in the same demo: the watcher records the events while the agents work, `pull_ready` takes the one report that is
 * ready, then the report of the documentation task arrives and the queue starts its review. Runs on the real clock.
 */
export async function captureChat(cacheRoot: string): Promise<{ events: string; pull: string }> {
  return withHarness({ name: 'demo-chat', cacheRoot, session: 'work', config: CONFIG }, async (h) => {
    writePlans(h, Date.now()); // before the first `new`: it looks at the plans too, and a missing reading with running agents is an event
    const { repo, screens } = buildDemo(h);
    queueReviews(h, repo);
    const watch = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.out'));
    const seen = async (what: string, ok: (events: { kind: string; task?: string }[]) => boolean): Promise<void> => {
      const end = Date.now() + 60_000;
      while (Date.now() < end) {
        try {
          if (ok((JSON.parse(h.agentctl(['events', '--json', '--keep']).stdout) as { events: { kind: string; task?: string }[] }).events)) return;
        } catch { /* not yet */ }
        await sleep(1000);
      }
      throw new Error(`the watcher never recorded ${what}: ${h.agentctl(['events', '--json', '--keep']).stdout}`);
    };
    await sleep(6000); // a few ticks while every agent is idle: the baseline the events are measured from
    writeScreens(screens);
    writeReports(h);
    await seen('the first events', (e) => e.some((x) => x.kind === 'needs-input' && x.task === 'UI-CART-2') && e.some((x) => x.kind === 'report-ready' && x.task === 'API-AUTH-1') && e.some((x) => x.kind === 'usage'));
    const mcp = await mcpClient(h);
    try {
      const pull = await mcpCall(mcp, 'pull_ready', {});
      // the background work is done: the agent is idle with a report, which is what the review waits for
      writeFile(path.join(screens, 'docs-search-1.txt'), `● The index rebuild finished (12 400 documents in 1.8 s). The report is written.\n\n${CLAUDE_PROMPT}`);
      writeReport(h, 'DOCS-SEARCH-1', docsReport(gitOut(h, path.join(h.root, 'wt', 'docs-search-1'), ['rev-parse', 'HEAD']).trim()), FIXED_MS - minutes(1));
      await seen('the start of the review from the queue', (e) => e.some((x) => x.kind === 'queue-start' && x.task === 'REVIEW-DOCS-SEARCH-1'));
      const events = await mcpCall(mcp, 'events_since', { since: '1d' });
      return { events: fixTimes(scrub(h, events)), pull: scrub(h, pull) };
    } finally {
      await mcp.close();
      watch.kill('SIGTERM');
    }
  });
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) throw new Error('usage: demo-board.ts <out-dir>');
  const cache = defaultCacheRoot();
  const dir = path.resolve(out);
  fs.mkdirSync(dir, { recursive: true });
  const cap = { ...(await captureBoard(cache)), ...(await captureChat(cache)) };
  fs.writeFileSync(path.join(dir, 'board.ansi'), cap.ansi);
  fs.writeFileSync(path.join(dir, 'board.txt'), cap.plain);
  fs.writeFileSync(path.join(dir, 'events.txt'), cap.events);
  fs.writeFileSync(path.join(dir, 'pull.txt'), cap.pull);
  console.log(cap.plain);
}
