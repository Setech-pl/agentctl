import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHarness, defaultCacheRoot, installPromptAgent } from './live-harness.ts';
const cache = defaultCacheRoot('agentctl-p28b');
const results: { window: string; eventAt: string; pulled: boolean }[] = [];
for (const gone of [false, true]) await withHarness({ name: gone ? 'p28b-gone' : 'p28b-alive', cacheRoot: cache, config: 'providers: [claude, codex, kimi]\nwatch: {interval: 1}\nreport: {settle_s: 1}\ncapacity: {snapshot: false, codex_refresh: false, kimi_usage_probe: false}\n' }, async h => {
  const log = path.join(h.root, 'fake-kimi.jsonl'); installPromptAgent(h, 'kimi', 'working', log);
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', repo], ['-C', repo, 'commit', '--allow-empty', '-qm', 'init']]) assert.equal(spawnSync('git', args, { env: h.env }).status, 0);
  const started = h.agentctl(['new', '-', '--no-switch', '--no-wait-trust'], { input: `---\ntask: P28B\nagent: kimi\nmodel: k3\neffort: high\nrepos: [{path: ${repo}, worktree: ${repo}-wt, branch: p28b}]\n---\nSynthetic task.\n` });
  assert.equal(started.code, 0, started.stderr);
  const taskFile = path.join(h.root, 'state/p28b/TASK.md'), task = fs.readFileSync(taskFile, 'utf8');
  const attempt = /^attempt_id: (.+)$/m.exec(task)![1];
  const watcher = h.spawnAgentctl(['watch'], path.join(cache, `p28b-${gone ? 'gone' : 'alive'}-watch.log`));
  await new Promise(r => setTimeout(r, 1500));
  const report = path.join(h.root, 'cache/p28b/P28B.md'); fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `Verdict: PASS\n<!-- agentctl:attempt ${attempt} -->\n`);
  const files = fs.readdirSync(path.join(h.env.KIMI_CODE_HOME!, 'sessions'), { recursive: true }).map(String).filter(p => p.endsWith('wire.jsonl'));
  assert.equal(files.length, 1);
  const wire = path.join(h.env.KIMI_CODE_HOME!, 'sessions', files[0]!);
  const at = new Date(Date.now() + 10).toISOString();
  fs.appendFileSync(wire, JSON.stringify({ type: 'llm.request', model: 'k3', prompt: 'ą'.repeat(300_000), timestamp: at }) + '\n' + JSON.stringify({ type: 'turn.ended', timestamp: at }) + '\n');
  fs.writeFileSync(log + '.mode', 'idle');
  if (gone) h.tmux(['kill-window', '-t', `=${h.session}:p28b`]);
  const deadline = Date.now() + 15000;
  let journal = '';
  while (Date.now() < deadline) {
    assert.equal(watcher.exitCode, null, 'watcher stays alive');
    try { journal = fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8'); } catch { /* first tick */ }
    if (journal.split('\n').some(line => line.includes('"kind":"report-ready"') && line.includes('"task":"P28B"'))) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.ok(journal.includes('"kind":"report-ready"'), journal);
  const event = JSON.parse(fs.readFileSync(path.join(h.root, 'state/p28b/event.json'), 'utf8'));
  assert.equal(event.type, 'turn.ended'); assert.equal(event.at, at);
  assert.ok(!/^pulled:/m.test(fs.readFileSync(taskFile, 'utf8')));
  results.push({ window: gone ? 'gone' : 'alive', eventAt: event.at, pulled: false });
  console.log(`PASS autonomous watcher: ${gone ? 'gone' : 'alive'} window, no status/MCP/pull`);
});
fs.writeFileSync(path.join(cache, 'live-p28b-results.json'), JSON.stringify(results, null, 2) + '\n');
