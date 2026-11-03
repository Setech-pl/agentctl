import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { renderTaskMd } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';

const cache = defaultCacheRoot('agentctl-economy');
const checks: string[] = [];
const check = (name: string, ok: unknown) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`); };
await withHarness({ name: 'economy', cacheRoot: cache, config: 'watch: {interval: 1}\noverload: {retry_after: 1, max_retries: 2}\ncapacity: {codex_refresh: false}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome);
  const seed = (task: string, report: string, extra: Partial<TaskRecord> = {}) => {
    const record: TaskRecord = { task, window: task.toLowerCase(), session: h.session, agent: 'claude', model: 'sonnet', effort: 'medium', repos: [], links: [], env: {}, report, started: new Date(Date.now() - 60000).toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'medium' }, ...extra };
    const dir = path.join(config.stateDir, record.window); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'TASK.md'), renderTaskMd(record, 'Fake work'));
  };
  for (let i = 1; i <= 6; i++) {
    fs.appendFileSync(path.join(h.agentctlHome, 'history.jsonl'), JSON.stringify({ v: 1, event: 'report', at: new Date().toISOString(), task: `NC-${i}`, reportAt: new Date().toISOString(), result: null }) + '\n');
    const report = path.join(h.root, `NC-${i}.md`); seed(`NC-${i}`, report);
    fs.writeFileSync(report, `Werdykt: PASS\nSHA: abc123; branch: economy\n## Summary\nResult ${i}\n## Evidence\n${'x'.repeat(20000)}\n`);
  }
  fs.writeFileSync(path.join(h.agentctlHome, 'journal.jsonl'), JSON.stringify({ at: new Date(Date.now() - 5000).toISOString(), kind: 'report-ready', task: 'NC-1', text: 'fixture ready' }) + '\n');
  seed('OVER-1', path.join(h.root, 'OVER-1.md'));
  const control = path.join(h.root, 'screen-mode'); fs.writeFileSync(control, 'draft');
  const fake = path.join(h.root, 'fake-pane.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs'; import readline from 'node:readline'; let mode=''; const render=()=>{ const m=fs.readFileSync(${JSON.stringify(control)},'utf8'); if(m===mode)return;mode=m;process.stdout.write('\\x1b[2J\\x1b[HSelected model is at capacity\\n'+(m==='busy'?'esc to interrupt\\n':m==='background'?'3 monitors still running\\n':'')+'❯ '+(m==='draft'?'unsent draft':'')+'\\n'); };setInterval(render,100);readline.createInterface({input:process.stdin}).on('line',()=>{mode='';render();});render();`);
  assert.equal(h.tmux(['new-session', '-d', '-s', h.session, '-n', 'over-1', `${process.execPath} ${fake}`]).code, 0);
  const watch = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  const retryCount = () => fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8').split('\n').filter(l => l.includes('"kind":"overload-retry"')).length;
  for (const mode of ['draft', 'busy', 'background']) {
    fs.writeFileSync(control, mode); await delay(2200);
    check(`real tmux overload does not retry ${mode}`, retryCount() === 0);
  }
  fs.writeFileSync(control, 'empty');
  const deadline = Date.now() + 10000;
  while (retryCount() < 2 && Date.now() < deadline) await delay(200);
  check('real tmux idle empty prompt retries twice', retryCount() === 2);
  await delay(2200); check('real watcher enforces retry cap', retryCount() === 2);
  watch.kill('SIGTERM');
  await new Promise(r => watch.once('close', r));
  const clients: Client[] = [];
  try {
    for (const name of ['manager', 'claude-chat']) {
      const c = new Client({ name, version: '1' });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' }));
      clients.push(c);
    }
    const call = async (client: Client, name: string, args = {}) => {
      const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
      return (r.content as { text: string }[]).map(c => c.text).join('\n');
    };
    const a = await call(clients[0]!, 'events_since'); const b = await call(clients[1]!, 'events_since');
    check('two initialized MCP clients independently see same event', a.includes('fixture ready') && b.includes('fixture ready'));
    check('manager cursor consumes only its own event', !(await call(clients[0]!, 'events_since')).includes('fixture ready'));
    const full = await call(clients[0]!, 'pull_ready', { mode: 'full', all: true });
    const summary = await call(clients[1]!, 'pull_ready', { all: true });
    check('six full reports exceed 120KB; summaries under 16KB', Buffer.byteLength(full) > 120000 && Buffer.byteLength(summary) < 16000);
    check('summary includes path bytes verdict SHA branch and six decisions', /bytes:/.test(summary) && /path:/.test(summary) && /Werdykt: PASS/.test(summary) && /abc123/.test(summary) && summary.includes('Result 6'));
    const section = await call(clients[0]!, 'get_report', { task: 'NC-1', section: 'Summary', offset: 1, limit: 1 });
    check('section and pagination return only requested lines', section.includes('Result 1') && !section.includes('Evidence'));
    check('events remind about unmarked tasks after pull', (await call(clients[0]!, 'events_since')).includes('bez oceny'));
    const status = await call(clients[0]!, 'status'); const json = await call(clients[0]!, 'status', { all: true, format: 'json' });
    check('default status concise; JSON opt-in parses', !status.includes('"tasks":') && JSON.parse(json).tasks.filter((r: { task: string }) => r.task.startsWith('NC-')).length === 6);
    fs.writeFileSync(path.join(cache, 'live-economy-sizes.json'), JSON.stringify({ before: Buffer.byteLength(full), after: Buffer.byteLength(summary) }, null, 2));
  } finally { for (const c of clients) await c.close(); }
  const candidateDir = path.join(h.root, 'candidates'); fs.mkdirSync(candidateDir);
  for (const name of ['CLAUDE.md', 'README.md', 'integration-12.md']) fs.writeFileSync(path.join(candidateDir, name), name === 'integration-12.md' ? '# Missing verdict' : 'Werdykt: PASS');
  const canonical = path.join(h.root, 'canonical-integration.md');
  seed('integration-12', canonical, { reportAlt: [path.join(candidateDir, '*.md')], cohort: 'candidate-fixture' });
  const watcher = h.spawnAgentctl(['watch'], path.join(h.root, 'candidate-watch.log'));
  const rows = () => JSON.parse(h.agentctl(['status', '--all', '--json']).stdout) as { task: string; state: string; reportCandidate?: string }[];
  let end = Date.now() + 10000;
  while (!rows().find(r => r.task === 'integration-12')?.reportCandidate && Date.now() < end) await delay(200);
  check('live README/CLAUDE/no-verdict remain candidates, canonical absent', !fs.existsSync(canonical) && rows().some(r => r.task === 'integration-12' && r.state === 'report-candidate' && r.reportCandidate));
  check('candidate cohort never announces done', !fs.readFileSync(path.join(h.agentctlHome, 'journal.jsonl'), 'utf8').split('\n').some(l => l.includes('"kind":"cohort-done"') && l.includes('candidate-fixture')));
  fs.writeFileSync(path.join(candidateDir, 'integration-12-good.md'), 'Werdykt: PASS\n## Summary\nConfirmed');
  end = Date.now() + 10000;
  while (!fs.existsSync(canonical) && Date.now() < end) await delay(200);
  check('live valid configured report confirms automatically', fs.existsSync(canonical) && fs.readFileSync(canonical, 'utf8').startsWith('Werdykt: PASS'));
  fs.writeFileSync(canonical, 'Werdykt: CANONICAL');
  fs.writeFileSync(path.join(candidateDir, 'integration-12-good.md'), 'Werdykt: FAIL');
  await delay(1300); check('live canonical always wins over modified source', fs.readFileSync(canonical, 'utf8') === 'Werdykt: CANONICAL');
  watcher.kill('SIGTERM'); await new Promise(r => watcher.once('close', r));
  const git = (repo: string, args: string[]) => spawnSync('git', args, { cwd: repo, env: h.env, encoding: 'utf8' });
  for (const name of ['front', 'back']) {
    const dir = path.join(h.root, name); fs.mkdirSync(path.join(dir, 'packages/sim'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages/sim/index.txt'), 'fixture');
    assert.equal(git(dir, ['init', '-q', '-b', 'main']).status, 0);
    assert.equal(git(dir, ['add', '.']).status, 0);
    assert.equal(git(dir, ['commit', '-qm', 'fixture']).status, 0);
  }
  const order = (id: string, two: boolean, fallback: boolean) => `---\ntask: ${id}\nagent: claude\nrepos:\n  - {path: ${h.root}/front, worktree: ${h.root}/${id}-front}\n${two ? `  - {path: ${h.root}/back, worktree: ${h.root}/${id}-back}\n` : ''}links:\n  - {from: linked-sim, to: "{worktree:back${fallback ? `|${h.root}/back` : ''}}/packages/sim"}\nenv: {BACKEND: "{worktree:back${fallback ? `|${h.root}/back` : ''}}"}\n---\nFake work only\n`;
  for (const [id, two] of [['ONE', false], ['TWO', true]] as const) {
    const spec = path.join(h.root, `${id}.md`); fs.writeFileSync(spec, order(id, two, true));
    const run = h.agentctl(['new', spec, '--no-agent', '-y']);
    check(`live ${id} task-local worktree/fallback link exists`, run.code === 0 && fs.readlinkSync(path.join(h.root, `${id}-front/linked-sim`)) === path.join(h.root, two ? `${id}-back/packages/sim` : 'back/packages/sim'));
  }
  const missing = path.join(h.root, 'MISSING.md'); fs.writeFileSync(missing, order('MISSING', false, false));
  const refusal = h.agentctl(['new', missing, '--no-agent', '-y']);
  check('live missing worktree without fallback has clear error', refusal.code !== 0 && /no repository "back"/.test(refusal.stderr));

});
fs.writeFileSync(path.join(cache, 'live-economy-results.json'), JSON.stringify({ passed: checks.length, failed: 0, checks }, null, 2));
