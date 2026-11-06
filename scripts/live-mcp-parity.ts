import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadGlobalConfig } from '../src/core/config.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { shellQuote } from '../src/core/util.ts';
import { withHarness, defaultCacheRoot } from './live-harness.ts';

const cache = defaultCacheRoot();
const evidence: Record<string, unknown> = {};
await withHarness({ name: 'mcp-parity', cacheRoot: defaultCacheRoot('agentctl-mcp-parity'), config: 'git: {timeout_s: 0.2}\nwatch: {interval: 1}\nmcp: {allow: [queue, queue_retry, gc, close]}\ncapacity: {codex_refresh: false}\n' }, async (h) => {
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '--allow-empty', '-qm', 'initial'], ['branch', 'parity-test']]) assert.equal(spawnSync('git', args, { env: h.env, cwd: repo }).status, 0);
  const git = path.join(h.fakeBin, 'git');
  const realGit = fs.realpathSync(git);
  fs.unlinkSync(git);
  const marker = path.join(h.root, 'first-start');
  // Only the first worktree add stalls. A shell shim avoids charging Node startup to git's 200 ms fault budget.
  fs.writeFileSync(git, `#!/bin/bash
if [ "$3" = worktree ] && [ "$4" = add ] && [ ! -e ${shellQuote(marker)} ]; then
  printf first > ${shellQuote(marker)}
  mkdir -p -- "$5"
  exec sleep 60
fi
exec ${shellQuote(realGit)} "$@"
`, { mode: 0o755 });
  const file = path.join(h.root, 'spec.md');
  const wt = path.join(h.root, 'wt');
  fs.writeFileSync(file, `---\ntask: PARITY-1\nagent: claude\nmodel: sonnet\neffort: medium\nrepos:\n  - path: ${repo}\n    worktree: ${wt}\n    branch: parity-test\n    base: main\n---\nFake work.\n`);
  assert.equal(h.agentctl(['queue', file, '-y']).code, 0);
  h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' });
  const client = new Client({ name: 'isolated-parity-test', version: '1' });
  await client.connect(transport);
  const call = async (name: string, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const text = (response.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { isError: response.isError, text };
  };
  try {
    let failed;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const list = await call('queue_list', { format: 'json' });
      if (list.text.includes('ETIMEDOUT')) { failed = list; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(failed, 'queue_list must expose timeout');
    assert.match(failed.text, /ETIMEDOUT/);
    const queued = JSON.parse(failed.text)[0];
    assert.equal(queued.status, 'queued');
    assert.ok(fs.existsSync(marker), 'the timed-out command reached the injected worktree add');
    assert.match(queued.error, /git worktree add failed/);
    evidence.failed = failed;
    evidence.capacity = JSON.parse((await call('capacity', { format: 'json' })).text);
    assert.ok((evidence.capacity as { disk: unknown }).disk);
    evidence.queueShow = await call('queue_show', { task: 'PARITY-1' });
    // The timeout was the injected fault. Retry with the real git and its normal production budget;
    // leaving the 200 ms fault budget in force also times out healthy git on a loaded Mac.
    fs.unlinkSync(git); fs.symlinkSync(realGit, git);
    const configFile = path.join(h.agentctlHome, 'config.yaml');
    fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace('timeout_s: 0.2', 'timeout_s: 600'));
    const reloadDeadline = Date.now() + 20000;
    let reloaded = false;
    while (Date.now() < reloadDeadline) {
      try { reloaded = /config: reloaded \(git\)/.test(fs.readFileSync(path.join(h.root, 'cache', 'agentctl-watch.log'), 'utf8')); } catch { /* watcher has not written yet */ }
      if (reloaded) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(reloaded, 'watcher acknowledged the normal git budget before retry');
    evidence.retryGitTimeoutS = 600;
    // Advance only the sandbox retry deadline; no production state or real clock changes.
    const queueDir = path.join(h.agentctlHome, 'queue');
    const entryFile = fs.readdirSync(queueDir).find(n => n.endsWith('.json'))!;
    const entryPath = path.join(queueDir, entryFile);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
    assert.equal(entry.attempts.length, 1);
    entry.retryAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(entryPath, JSON.stringify(entry));
    evidence.autoRetry = true;
    let working;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const status = await call('status', { format: 'json' });
      evidence.lastStatus = status;
      const data = JSON.parse(status.text.split('\n\n').at(-1)!);
      const ready = data.tasks.some((t: { task: string; state: string; prompt_delivery?: string; prompt_queue?: unknown[] }) =>
        t.task === 'PARITY-1' && ['working', 'waiting'].includes(t.state) && t.prompt_delivery === 'sent' && t.prompt_queue?.length === 0);
      // A visible window can still be receiving its first prompt. Wait for the launch transaction to commit.
      if (ready && JSON.parse((await call('queue_list', { format: 'json' })).text).length === 0) { working = data; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(working, 'retried task has a live agent window');
    // The fake agent's idle state is waiting; put a working indicator on screen to verify the same status path.
    // The watcher decorates window names; the persisted tmux ID remains stable.
    const target = readTaskRecord(loadGlobalConfig(h.agentctlHome), 'parity-1')?.windowId;
    assert.ok(target, 'the retried task has a persisted tmux window ID');
    // The line-based fake may retain the last line of the multiline initial paste; finish it first.
    assert.equal(h.tmux(['send-keys', '-t', target, 'Enter']).code, 0);
    assert.equal(h.tmux(['send-keys', '-t', target, '-l', 'esc to interrupt']).code, 0);
    assert.equal(h.tmux(['send-keys', '-t', target, 'Enter']).code, 0);
    const echoedDeadline = Date.now() + 20000;
    let echoed = false;
    while (Date.now() < echoedDeadline) {
      const capture = h.tmux(['capture-pane', '-p', '-t', target]);
      evidence.indicatorCapture = capture;
      echoed = capture.stdout.includes('● got: esc to interrupt');
      if (echoed) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(echoed, 'the fake agent echoed the working indicator after initial prompt delivery');
    const status = await call('status', { format: 'json' });
    evidence.working = status;
    assert.match(status.text, /working/);
    await call('close', { task: 'PARITY-1' });
    assert.ok(!(await call('close', { task: 'PARITY-1', confirm: true })).isError);
    evidence.gcPreview = await call('gc', { older_than: '1m' });
    evidence.gcConfirmed = await call('gc', { older_than: '1m', confirm: true });
    assert.ok(!(evidence.gcConfirmed as { isError?: boolean }).isError);
    evidence.audit = fs.readFileSync(path.join(h.agentctlHome, 'mcp-audit.log'), 'utf8');
    evidence.journal = fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8');
    evidence.ok = true;
  } finally {
    try {
      const dir = path.join(h.agentctlHome, 'queue');
      evidence.finalQueue = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      const log = path.join(h.root, 'cache', 'agentctl-watch.log');
      evidence.watch = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    } finally { await client.close(); }
  }
}).finally(() => {
  fs.writeFileSync(path.join(cache, 'live-mcp-parity-results.json'), JSON.stringify(evidence, null, 2));
});
console.log('PASS: isolated queue timeout → MCP retry reason → automatic retry → working → gc');
