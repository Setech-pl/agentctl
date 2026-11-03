import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';

const evidence: Record<string, unknown> = {};
await withHarness({ name: 'mcp-parity', cacheRoot: defaultCacheRoot('agentctl-mcp-parity'), config: 'git: {timeout_s: 0.2}\nwatch: {interval: 1}\nmcp: {allow: [queue, queue_retry, gc, close]}\ncapacity: {codex_refresh: false}\n' }, async (h) => {
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '--allow-empty', '-qm', 'initial']]) assert.equal(spawnSync('git', args, { env: h.env, cwd: repo }).status, 0);
  const git = path.join(h.fakeBin, 'git');
  const realGit = fs.realpathSync(git);
  fs.unlinkSync(git);
  const marker = path.join(h.root, 'first-start');
  fs.writeFileSync(git, `#!${process.execPath}\nimport fs from 'node:fs'; import {spawnSync} from 'node:child_process'; const args=process.argv.slice(2); const i=args.indexOf('add'); if(args.includes('worktree') && i>=0 && !fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)},'first'); const target=args[i+1]==='-b'?args[i+3]:args[i+1]==='--detach'?args[i+2]:args[i+1]; fs.mkdirSync(target,{recursive:true}); setTimeout(()=>process.exit(1),2000); } else { const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'}); process.exit(r.status??1); }\n`, { mode: 0o755 });
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
      const list = await call('queue_list');
      if (list.text.includes('ETIMEDOUT')) { failed = list; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(failed, 'queue_list must expose timeout');
    assert.match(failed.text, /queue_retry/);
    evidence.failed = failed;
    evidence.capacity = JSON.parse((await call('capacity')).text);
    assert.ok((evidence.capacity as { disk: unknown }).disk);
    const preview = await call('queue_retry', { task: 'PARITY-1' });
    assert.ok(!preview.isError, preview.text);
    evidence.retryPreview = preview;
    const retry = await call('queue_retry', { task: 'PARITY-1', confirm: true });
    assert.ok(!retry.isError, retry.text);
    evidence.retryConfirmed = retry;
    let working;
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      const status = await call('status');
      const data = JSON.parse(status.text.split('\n\n').at(-1)!);
      if (data.tasks.some((t: { task: string; state: string }) => t.task === 'PARITY-1' && ['working', 'waiting'].includes(t.state))) { working = data; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(working, 'retried task has a live agent window');
    // The fake agent's idle state is waiting; put a working indicator on screen to verify the same status path.
    h.tmux(['send-keys', '-t', `=${h.session}:parity-1`, '-l', 'esc to interrupt']);
    h.tmux(['send-keys', '-t', `=${h.session}:parity-1`, 'Enter']);
    await new Promise((r) => setTimeout(r, 300));
    const status = await call('status');
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
  } finally { await client.close(); }
});
fs.writeFileSync(path.join(defaultCacheRoot('agentctl-mcp-parity'), 'live-mcp-parity-results.json'), JSON.stringify(evidence, null, 2));
console.log('PASS: isolated queue timeout → MCP failed reason → queue_retry → working → gc');
