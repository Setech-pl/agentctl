import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { spawn } from 'node:child_process';

/*
 * P19 measurement: MCP `new` with confirm for a task of two repositories whose .agentctl.yaml runs `sleep <N>` as setup.
 * Prints how long confirm takes and how long reads (status, events_since, peek, queue_list, version) take WHILE it runs,
 * from the same MCP server process and from a second one (another chat). Usage: node ... scripts/measure-p19.ts [setup seconds] [label]
 */
const seconds = Number(process.argv[2] ?? 20);
const label = process.argv[3] ?? 'measure';
const windows = Number(process.env.P19_WINDOWS ?? 0), hogs = Number(process.env.P19_HOGS ?? 0), files = Number(process.env.P19_FILES ?? 0);
const cache = defaultCacheRoot('agentctl-p19');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out: Record<string, unknown> = { label, setupSeconds: seconds };

await withHarness({ name: 'p19-measure', cacheRoot: cache, config: `capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [new, queue]}\n` }, async (h) => {
  const git = (cwd: string, args: string[]) => { const r = spawnSync('git', ['-C', cwd, ...args], { env: h.env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const repos = ['alpha', 'beta'].map((n) => {
    const p = path.join(h.root, n);
    fs.mkdirSync(p); git(p, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(p, 'file.txt'), 'x\n');
    fs.writeFileSync(path.join(p, '.agentctl.yaml'), YAML.stringify({ setup: [`sleep ${seconds}; echo installed-${n}`] }));
    git(p, ['add', '.']); git(p, ['commit', '-m', 'fixture']);
    return p;
  });
  // Optional realism: N running task windows (real tmux, `cat`) with their TASK.md, and M CPU hogs while the confirm runs (npm ci x N).
  const config = loadGlobalConfig(h.agentctlHome);
  for (let i = 0; i < windows; i++) {
    const task = `LIVE-${i}`, window = task.toLowerCase();
    // A worktree with a node_modules: `files` small files in directories of 100.
    const wt = path.join(h.root, `live-wt-${i}`);
    for (let d = 0; d * 100 < files; d++) { const dir = path.join(wt, 'node_modules', `pkg${d}`); fs.mkdirSync(dir, { recursive: true }); for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(dir, `f${f}.js`), 'x'); }
    fs.mkdirSync(wt, { recursive: true });
    const r: TaskRecord = { task, window, session: h.session, agent: 'claude', model: 'sonnet', effort: 'high', links: [], env: {}, repos: [{ path: repos[0]!, worktree: wt }], report: path.join(config.cache, window, `${task}.md`), started: new Date(Date.now() - 60_000).toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'high' } };
    fs.mkdirSync(path.dirname(taskFile(config, window)), { recursive: true }); fs.writeFileSync(taskFile(config, window), renderTaskMd(r, 'live'));
    const args = i === 0 ? ['new-session', '-d', '-s', h.session, '-n', window] : ['new-window', '-d', '-t', `=${h.session}:`, '-n', window];
    h.tmux([...args, "printf '❯ \\n'; exec cat"]);
  }
  const hogProcs = Array.from({ length: hogs }, () => spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore' }));
  const spec = `---\n${YAML.stringify({ task: 'SLOW-1', agent: 'claude', model: 'sonnet', effort: 'high', repos: repos.map((p) => ({ path: p, worktree: `${p}-SLOW-1`, branch: 'slow-1' })) })}---\nDo the thing.\n`;
  const connect = async (name: string) => {
    const client = new Client({ name, version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve('bin/agentctl.ts'), 'mcp'], env: { ...(h.env as Record<string, string>), ...(process.env.LAGPROBE_LOG ? { LAGPROBE_LOG: process.env.LAGPROBE_LOG, NODE_OPTIONS: `--import ${process.env.LAGPROBE_PRELOAD}` } : {}) }, stderr: 'pipe' }));
    return client;
  };
  const a = await connect('chat-a'), b = await connect('chat-b');
  const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const t0 = Date.now();
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
    return { ms: Date.now() - t0, error: Boolean(r.isError), text: (r.content as { text: string }[]).map((x) => x.text).join('\n') };
  };
  try {
    const preview = await call(a, 'new', { spec });
    out.previewMs = preview.ms; out.windows = windows; out.hogs = hogs; out.filesPerWorktree = files;
    const confirmStart = Date.now();
    const confirm = call(a, 'new', { spec, confirm: true });
    let done = false; void confirm.then(() => { done = true; });
    const reads: { at: number; client: string; tool: string; ms: number }[] = [];
    await pause(1500);
    if (process.env.P19_RETRY) {
      // The chat retries after its own timeout: same spec, preview again, then confirm again, while the first confirm still runs.
      const t0 = Date.now();
      const p2 = await call(a, 'new', { spec });
      const c2 = await call(a, 'new', { spec, confirm: true });
      out.retry = { previewMs: p2.ms, previewError: p2.error, previewText: p2.text.slice(0, 300), confirmMs: c2.ms, confirmError: c2.error, confirmText: c2.text.slice(0, 500), totalMs: Date.now() - t0 };
    }
    while (!done && Date.now() - confirmStart < 120_000) {
      for (const [client, c] of [['same', a], ['other', b]] as const) {
        for (const [tool, args] of [['status', {}], ['events_since', {}], ['peek', { task: 'SLOW-1' }], ['queue_list', {}], ['version', {}]] as const) {
          if (done) break;
          const r = await call(c, tool, args as Record<string, unknown>);
          reads.push({ at: Date.now() - confirmStart, client, tool, ms: r.ms });
        }
      }
      await pause(1000);
    }
    const result = await confirm;
    out.confirmMs = Date.now() - confirmStart;
    out.confirmError = result.error;
    out.confirmText = result.text.slice(0, 600);
    out.readsDuringConfirm = reads.length;
    out.readMaxMs = Math.max(0, ...reads.map((r) => r.ms));
    out.readMedianMs = reads.map((r) => r.ms).sort((x, y) => x - y)[Math.floor(reads.length / 2)] ?? null;
    out.reads = reads;
    const journal = path.join(h.agentctlHome, 'journal.jsonl');
    out.journalHasMcpNew = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter((l) => /MCP new|mcp-write/.test(l)).slice(0, 3) : 'no journal file';
  } finally { await a.close(); await b.close(); for (const p of hogProcs) p.kill('SIGKILL'); }
});
fs.mkdirSync(cache, { recursive: true });
fs.writeFileSync(path.join(cache, `${label}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ...out, reads: undefined }, null, 2));
