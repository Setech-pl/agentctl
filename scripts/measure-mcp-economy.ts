import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { renderTaskMd } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
const baseline = process.env.AGENTCTL_BASELINE_ROOT;
if (!baseline) throw new Error('Set AGENTCTL_BASELINE_ROOT to a read-only 0.17.1 export');
const results: Record<string, unknown> = { fixture: 'same six reports, ~20KB each, same tasks, cohort and journal; pull_ready all:true', versions: ['0.17.1', '0.17.2'] };
await withHarness({ name: 'measure-economy', cacheRoot: defaultCacheRoot(), config: 'capacity: {codex_refresh: false}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome);
  for (let i = 1; i <= 6; i++) {
    const task = `NC-${i}`, window = task.toLowerCase(), report = path.join(h.root, `${task}.md`);
    const record: TaskRecord = { task, window, session: h.session, agent: 'claude', model: 'sonnet', effort: 'medium', repos: [], links: [], env: {}, report, started: new Date(Date.now() - 60000).toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'medium' }, cohort: 'fixture' };
    fs.mkdirSync(path.join(config.stateDir, window), { recursive: true });
    fs.writeFileSync(path.join(config.stateDir, window, 'TASK.md'), renderTaskMd(record, 'Fixture'));
    fs.writeFileSync(report, `Werdykt: PASS\nSHA: abc123; branch: fixture\n## Summary\nDecision ${i}\n## Evidence\n${'x'.repeat(20000)}\n`);
  }
  fs.writeFileSync(path.join(h.agentctlHome, 'journal.jsonl'), JSON.stringify({ at: new Date(Date.now() - 5000).toISOString(), kind: 'report-ready', task: 'NC-1', text: 'Fixture ready' }) + '\n');
  const originals = new Map(fs.readdirSync(config.stateDir).map(n => { const file = path.join(config.stateDir, n, 'TASK.md'); return [file, fs.readFileSync(file, 'utf8')]; }));
  const measurements: Record<string, number[]> = {};
  for (const root of [baseline, path.resolve(import.meta.dirname, '..')]) {
    const client = new Client({ name: 'economy-measure', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.join(root, 'bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' }));
    try {
      for (const [name, args] of [['events_since', { peek: true }], ['status', { all: true }], ['queue_list', {}], ['cohort_show', { cohort: 'fixture' }], ['limits', {}], ['capacity', {}], ['pull_ready', { all: true }]] as const) {
        const r = await client.callTool({ name, arguments: args }); assert.ok(!r.isError, JSON.stringify(r));
        const text = (r.content as { text: string }[]).map(c => c.text).join('\n');
        (measurements[name] ??= []).push(Buffer.byteLength(text));
      }
    } finally { await client.close(); for (const [file, text] of originals) fs.writeFileSync(file, text); }
  }
  results.tools = Object.fromEntries(Object.entries(measurements).map(([name, [before, after]]) => [name, { before, after, reductionPercent: Number((100 * (1 - after! / before!)).toFixed(2)) }]));
});
fs.writeFileSync(path.join(defaultCacheRoot(), 'mcp-before-after.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
