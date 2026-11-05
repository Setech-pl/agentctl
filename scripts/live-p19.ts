import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';

/*
 * P19 live: real tmux (own server), real git, the fake agent of the harness, a real watcher process and real MCP servers over stdio.
 * Setup is `sleep 20` in each of two repositories, as in the production symptom (npm ci x 2).
 */
const cache = defaultCacheRoot('agentctl-p19');
const results: { name: string; ok: boolean; note?: string }[] = [];
const check = (name: string, value: unknown, note?: string) => { results.push({ name, ok: Boolean(value), ...(note ? { note } : {}) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}${note ? ` (${note})` : ''}`); assert.ok(value, name); };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SETUP_S = Number(process.env.P19_SETUP_S ?? 20);

await withHarness({ name: 'p19-live', cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new, queue_retry, close]}\nwatch: {interval: 2}\n' }, async (h) => {
  const git = (cwd: string, args: string[]) => { const r = spawnSync('git', ['-C', cwd, ...args], { env: h.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const makeRepos = (suffix: string, setup: (name: string) => string) => ['alpha', 'beta'].map((n) => {
    const dir = path.join(h.root, `${n}${suffix}`);
    fs.mkdirSync(dir); git(dir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    fs.writeFileSync(path.join(dir, '.agentctl.yaml'), YAML.stringify({ setup: [setup(n)] }));
    git(dir, ['add', '.']); git(dir, ['commit', '-m', 'fixture']);
    return dir;
  });
  const specOf = (task: string, repos: string[]) => `---\n${YAML.stringify({ task, agent: 'claude', model: 'sonnet', effort: 'high', repos: repos.map((p) => ({ path: p, worktree: `${p}-${task}`, branch: task.toLowerCase() })) })}---\nDo ${task}.\n`;
  const servers: { client: Client; transport: StdioClientTransport }[] = [];
  const connect = async (name: string) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name, version: '1' });
    await client.connect(transport);
    const s = { client, transport }; servers.push(s); return s;
  };
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return { ms: Date.now() - t0, error: Boolean(r.isError), text: (r.content as { text: string }[]).map((x) => x.text).join('\n') };
  };
  const journal = () => (fs.existsSync(path.join(h.agentctlHome, 'journal.jsonl')) ? fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; text: string; task?: string; at: string }) : []);
  const agentStarts = (task?: string) => h.agentStarts().filter((l) => l.startsWith('claude') && !/--version|--help/.test(l) && (task === undefined || l.includes(task.toLowerCase()) || true));
  const timeline: string[] = [];
  const note = (s: string) => timeline.push(`${new Date().toISOString().slice(11, 23)} ${s}`);
  try {
    // ---- 0. no watcher: refused, nothing created
    const repos0 = makeRepos('0', (n) => `sleep ${SETUP_S}; echo installed-${n}`);
    const first = await connect('chat-a');
    const refusedPreview = await call(first.client, 'new', { spec: specOf('NOWATCH-1', repos0) });
    check('L0 preview warns that the watcher is not running', /WARNING: .*watcher is not running/.test(refusedPreview.text), refusedPreview.text.split('\n').find((l) => /WARNING/.test(l)));
    const refused = await call(first.client, 'new', { spec: specOf('NOWATCH-1', repos0), confirm: true });
    check('L0 confirm without a watcher is refused, nothing created', refused.error && !fs.existsSync(`${repos0[0]}-NOWATCH-1`) && !fs.existsSync(path.join(h.agentctlHome, 'queue')), `${refused.ms} ms`);

    // ---- the watcher
    h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
    await pause(3500);

    // ---- 1. two repositories, setup 2 x SETUP_S
    const repos = makeRepos('1', (n) => `sleep ${SETUP_S}; echo installed-${n}`);
    const spec = specOf('SLOW-1', repos);
    const second = await connect('chat-b');
    check('L1 preview', !(await call(first.client, 'new', { spec })).error);
    const t0 = Date.now();
    const confirmed = await call(first.client, 'new', { spec, confirm: true });
    note(`confirm answered after ${confirmed.ms} ms`);
    check(`L1 confirm returns in under 5 s with a 2 x ${SETUP_S} s setup`, !confirmed.error && confirmed.ms < 5000 && /^Registered: SLOW-1/.test(confirmed.text), `${confirmed.ms} ms`);
    const mcpNew = journal().find((j) => j.kind === 'mcp-write' && j.text === 'new: new SLOW-1');
    check('L1 "MCP new" is in the journal before the setup ends', mcpNew && !fs.existsSync(path.join(h.root, 'state', 'slow-1', 'TASK.md')), mcpNew?.at);
    const seen = new Set<string>();
    const lat: Record<string, number[]> = {};
    let repeated = '';
    let killed = false;
    const killAt = SETUP_S * 1000 + 6000; // inside the second repository's setup
    while (Date.now() - t0 < (2 * SETUP_S + 40) * 1000) {
      for (const [who, c] of [['a', servers[0]!.client], ['b', second.client]] as const) {
        if (who === 'a' && killed) continue;
        for (const [tool, args] of [['status', {}], ['events_since', { client: `live-${who}` }], ['peek', { task: 'SLOW-1' }], ['queue_list', {}], ['version', {}]] as const) {
          const r = await call(c, tool, args as Record<string, unknown>);
          (lat[tool] ??= []).push(r.ms);
          const m = /setup w toku \(repo (\d)\/2 (\w+)/.exec(r.text); if (m && !seen.has(`${m[1]}`)) { seen.add(m[1]!); note(`${tool}: repo ${m[1]}/2 ${m[2]} at ${Date.now() - t0} ms`); }
        }
      }
      if (!repeated && seen.size > 0) { repeated = (await call(second.client, 'new', { spec, confirm: true })).text; note('repeated confirm: ' + repeated.slice(0, 90)); }
      if (!killed && Date.now() - t0 > killAt && seen.has('2')) {
        killed = true; const pid = servers[0]!.transport.pid; note(`SIGKILL MCP server pid ${pid} at ${Date.now() - t0} ms`);
        if (pid) process.kill(pid, 'SIGKILL');
        await pause(300);
        check('L2 the first MCP server is dead', (() => { try { process.kill(pid!, 0); return false; } catch { return true; } })());
      }
      if (journal().some((j) => j.kind === 'queue-start' && j.task === 'SLOW-1')) break;
      await pause(1000);
    }
    const slowest = Math.max(...Object.values(lat).flat());
    check('L1 status showed repo 1/2 and repo 2/2 in progress', seen.has('1') && seen.has('2'), [...seen].join(','));
    check('L1 every read answered in under 2 s during the setup', slowest < 2000, JSON.stringify(Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, Math.max(...v)]))));
    check('L2 a repeated confirm mid-setup answers with the state', /already being started/.test(repeated));
    check('L2 the setup finished although the MCP server that took the order was killed', journal().some((j) => j.kind === 'queue-start' && j.task === 'SLOW-1') && /installed-alpha[\s\S]*installed-beta/.test(fs.readFileSync(path.join(h.root, 'state', 'slow-1', 'setup.log'), 'utf8')));
    check('L2/L3 the agent started once, the entry is gone', agentStarts().length === 1 && !fs.readdirSync(path.join(h.agentctlHome, 'queue')).some((f) => f.endsWith('.json')), `${agentStarts().length} start(s)`);
    check('L1 events: SETUP and START in events_since', /SETUP[\s\S]*START\s+SLOW-1/.test((await call(second.client, 'events_since', { client: 'live-final' })).text));
    check('L1 the task is a running task in status', /SLOW-1/.test((await call(second.client, 'status', {})).text));

    // ---- 4. failing setup, then retry
    const bad = makeRepos('4', (n) => (n === 'beta' ? 'echo broken >&2; exit 3' : 'echo fine'));
    const badSpec = specOf('FAIL-1', bad);
    await call(second.client, 'new', { spec: badSpec });
    check('L4 confirm of the failing one returns at once', (await call(second.client, 'new', { spec: badSpec, confirm: true })).ms < 5000);
    for (let i = 0; i < 40 && !journal().some((j) => j.kind === 'queue-failed' && j.task === 'FAIL-1'); i++) await pause(500);
    const failedEvents = journal().filter((j) => j.task === 'FAIL-1' && ['setup-failed', 'queue-failed'].includes(j.kind));
    check('L4 setup failed: event with repo, exit code and log', failedEvents.some((j) => j.kind === 'setup-failed' && /beta\d* \(exit 3\)/.test(j.text) && /setup\.log/.test(j.text)), failedEvents[0]?.text);
    const list = await call(second.client, 'queue_list', { format: 'json' });
    check('L4 the task is failed with the reason and a retry hint; worktrees stay', /"status": "failed"/.test(list.text) && /queue_retry task=FAIL-1/.test(list.text) && bad.every((p) => fs.existsSync(`${p}-FAIL-1`)));
    check('L4 a repeated new returns the failed state', /FAIL-1: the start failed/.test((await call(second.client, 'new', { spec: badSpec })).text));
    fs.writeFileSync(path.join(bad[1]!, '.agentctl.yaml'), YAML.stringify({ setup: ['echo fixed'] }));
    const retryPreview = await call(second.client, 'queue_retry', { task: 'FAIL-1' });
    const retry = await call(second.client, 'queue_retry', { task: 'FAIL-1', confirm: true });
    for (let i = 0; i < 40 && !journal().some((j) => j.kind === 'queue-start' && j.task === 'FAIL-1'); i++) await pause(500);
    check('L4 queue_retry starts it over the kept worktrees', !retry.error && journal().some((j) => j.kind === 'queue-start' && j.task === 'FAIL-1'), retryPreview.error ? retryPreview.text.slice(0, 120) : retry.text.slice(0, 120));

    // ---- 5. the CLI in a terminal stays synchronous and prints the setup
    const cliRepo = makeRepos('5', () => 'echo cli-setup-ran')[0]!;
    const specFile = path.join(h.root, 'cli-spec.md');
    fs.writeFileSync(specFile, specOf('CLI-1', [cliRepo]));
    const cli = h.agentctl(['new', '--yes', '--no-agent', specFile], { timeoutMs: 60_000 });
    check('L5 agentctl new in a terminal runs the setup in place and prints it', cli.code === 0 && /setup .*echo cli-setup-ran/.test(cli.stdout + cli.stderr), `exit ${cli.code}`);
    check('L5 no queue entry for the CLI start', !fs.readdirSync(path.join(h.agentctlHome, 'queue')).some((f) => /CLI-1/.test(f)));
    fs.writeFileSync(path.join(cache, 'p19-live-timeline.txt'), `${timeline.join('\n')}\n`);
  } finally {
    for (const s of servers) await s.client.close().catch(() => undefined);
  }
});
fs.writeFileSync(path.join(cache, 'p19-live-results.json'), JSON.stringify({ passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2));
console.log(`${results.filter((r) => r.ok).length}/${results.length} P19 live checks passed`);
