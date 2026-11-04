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
const checks: { name: string; ok: boolean }[] = [], sizes: Record<string, Record<string, number>> = {};
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
await withHarness({ name: 'hotfix-0173', cacheRoot: defaultCacheRoot('agentctl-0173'), config: 'report: {settle_s: 0}\nwatch: {interval: 1}\ncapacity: {codex_refresh: false}\nmcp: {allow: [queue_pause, queue_resume, queue_rm, interrupt, report_from, new, queue]}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome), repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init', '-q', '-b', 'main'], ['commit', '--allow-empty', '-qm', 'fixture']]) assert.equal(spawnSync('git', args, { cwd: repo, env: h.env }).status, 0);
  fs.writeFileSync(path.join(repo, '.agentctl.yaml'), 'guide: rules.md\ndefaults: {model: sonnet, effort: low}\nreport: ["' + path.join(h.root, 'canonical/{TASK}.md') + '", "*{TASK}*.md"]\n');
  fs.writeFileSync(path.join(repo, 'rules.md'), 'NC-PROJECT-OVERLAY');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Read this file, not a report.');
  const records: TaskRecord[] = [];
  for (let i = 0; i < 160; i++) {
    const task = i === 1 ? 'T2' : `TASK-${i}`, window = task.toLowerCase();
    const record: TaskRecord = { task, window, session: h.session, agent: 'claude', model: 'sonnet', effort: 'medium', started: new Date(Date.now() - 60000).toISOString(), turnEndedAt: new Date().toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'medium' }, repos: Array.from({ length: i < 30 ? 2 : 1 }, (_, n) => ({ path: repo, worktree: path.join(h.root, `wt-${i}-${n}`) })), env: {}, links: [], report: path.join(h.root, 'canonical', `${task}.md`), cohort: 'NC', ...(i >= 10 ? { closed: true } : {}), ...(i === 1 ? { reportAlt: [path.join(repo, '*T2*.md')] } : {}) };
    records.push(record); fs.mkdirSync(path.join(config.stateDir, window), { recursive: true }); fs.writeFileSync(path.join(config.stateDir, window, 'TASK.md'), renderTaskMd(record, 'Read README.md, CHANGELOG.md, CLAUDE.md and docs/integration-12.md. Ask before continuing.'));
  }
  const fake = path.join(h.root, 'question.mjs'); fs.writeFileSync(fake, "process.stdout.write('Which option?\\n❯ 1. First\\n  2. Second\\nEnter to select · Esc to cancel\\n'); process.stdin.resume();");
  assert.equal(h.tmux(['new-session', '-d', '-s', h.session, '-n', 't2', `${process.execPath} ${fake}`]).code, 0);
  const spec = (task: string) => `---\ntask: ${task}\nagent: claude\nrepos:\n  - path: ${repo}\n    worktree: ${h.root}/work-${task}\n---\nFake work only.\n`;
  const q = path.join(h.root, 'Q1.md'); fs.writeFileSync(q, spec('Q1')); assert.equal(h.agentctl(['queue', q, '-y']).code, 0);
  const roots = [...(process.env.AGENTCTL_BASELINE_ROOT ? [process.env.AGENTCTL_BASELINE_ROOT] : []), path.resolve(import.meta.dirname, '..')];
  for (const root of roots) {
    const current = root === roots.at(-1), label = current ? 'after' : 'before'; sizes[label] = {};
    const client = new Client({ name: `hotfix-${label}`, version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.join(root, 'bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, cwd: '/', stderr: 'pipe' }));
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => { const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r)); return { wire: Buffer.byteLength(JSON.stringify(r)), text: (r.content as { text: string }[]).map(c => c.text).join('\n') }; };
      const full = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); let page; try { page = JSON.parse(r.text); } catch { return r.text; } if (!page.truncated || !page.response_id) return r.text; let text = page.fragment; while (page.has_more) { const next = await call('response_page', { response_id: page.response_id, response_offset: page.next_response_offset }); check('0173-1: continuation fits 8 KiB', next.wire <= 8192); page = JSON.parse(next.text); text += page.fragment; } return text; };
      for (const [name, args] of [['queue_pause', {}], ['interrupt', { task: 'T2' }], ['queue_rm', { task: 'Q1' }], ['status', { all: true, format: 'json' }], ['capacity', { format: 'json' }]] as const) {
        const r = await call(name, args); sizes[label]![name] = r.wire;
        if (current) check(`0173-1: ${name} <= 8 KiB with 160 tasks/190 worktrees`, r.wire <= 8192);
      }
      if (!current) continue;
      const guide = await full('guide', { project: repo }); check('0173-8: guide overlay from project with MCP cwd=/', guide.includes('NC-PROJECT-OVERLAY'));
      const doctor = await full('doctor'); check('0173-8: doctor without project reports bez projektu', doctor.includes('bez projektu') && !doctor.includes('no .agentctl.yaml in /'));
      for (const name of ['new', 'queue']) {
        const args = { spec: spec(`CONFIG-${name.toUpperCase()}`), ...(name === 'new' ? { no_agent: true } : {}) };
        const preview = await full(name, args); check(`0173-8: ${name} first repo project defaults from cwd=/`, preview.includes('sonnet/low'));
        const result = await full(name, { ...args, confirm: true }); check(`0173-8: ${name} executes from cwd=/`, name === 'new' ? result.includes('CONFIG-NEW') : (await full('queue_show', { task: 'CONFIG-QUEUE' })).includes('\"effort\": \"low\"'));
      }
      let rows = JSON.parse(await full('status', { format: 'json', cohort: 'NC' })).tasks;
      check('0173-2/3: T2 question wins, README mention is not a candidate', rows.some((r: any) => r.task === 'T2' && r.state === 'needs-input' && r.question && !r.reportCandidate));
      fs.writeFileSync(path.join(repo, 'T2-report.md'), 'Werdykt: PASS\n<!-- agentctl:report-end -->');
      const watch = h.spawnAgentctl(['watch'], path.join(h.root, 'watch.log'));
      try {
        const until = Date.now() + 10000; do { rows = JSON.parse(await full('status', { format: 'json', cohort: 'NC' })).tasks; if (rows.find((r: any) => r.task === 'T2')?.reportCandidate) break; await new Promise(r => setTimeout(r, 200)); } while (Date.now() < until);
        check('0173-3: configured candidate remains a flag beside needs-input', rows.some((r: any) => r.task === 'T2' && r.reportCandidate && r.state === 'needs-input' && r.question));
        check('0173-2: watcher never copies the candidate', !fs.existsSync(records[1]!.report));
        check('0173-3: events_since includes current question', (await full('events_since')).includes('Which option'));
        await full('report_from', { task: 'T2', from: path.join(repo, 'T2-report.md') }); await full('report_from', { task: 'T2', from: path.join(repo, 'T2-report.md'), confirm: true });
        check('0173-2: explicit report_from confirms canonical file', fs.existsSync(records[1]!.report));
      } finally { watch.kill('SIGTERM'); await new Promise(r => watch.once('close', r)); }
    } finally { await client.close(); }
  }
});
fs.writeFileSync(path.join(defaultCacheRoot('agentctl-0173'), 'hotfix-live-results.json'), JSON.stringify({ checks, sizes }, null, 2) + '\n');
console.log(`${checks.length}/${checks.length} hotfix checks passed`);
