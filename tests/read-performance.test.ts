import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { it } from 'node:test';
import os from 'node:os';
import { z } from 'zod';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { Context } from '../src/core/context.ts';
import { shutdownMeasurements } from '../src/core/fs-measure.ts';
import { archiveDir } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
// Wall-clock budgets are meaningless under the gate (nice 10, background throttling, the whole suite next to it):
// the deterministic read-contracts test carries the regression proof there. Elsewhere a `node --version` probe
// still skips a loaded host, and the budgets are tripwires against the pre-fix walks, not micro-budgets.
const probe = async () => { const start = performance.now(); await promisify(execFile)(process.execPath, ['--version']); return performance.now() - start; };
const quiet = async () => Math.min(await probe(), await probe()) <= 500;
it('P83: 400 records, 500 KB reports and 300k worktree files meet read budgets', { timeout: 180_000 }, async (t) => {
  if (os.getPriority(0) > 0 || !(await quiet())) { t.skip('niced or loaded host: read-contracts covers the regression'); return; }
  const root = scratch.sub('performance');
  const config = makeConfig(root, 'mcp: {allow: [queue]}\ncapacity: {codex_refresh: false}\n');
  const repo = scratch.sub('performance/repo');
  const worktree = scratch.sub('performance/worktree');
  for (let d = 0; d < 300; d++) {
    const dir = path.join(worktree, 'node_modules', `pkg-${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 1000; f++) fs.writeFileSync(path.join(dir, `${f}.js`), 'fixture');
  }
  for (let i = 0; i < 400; i++) {
    const record = seedTask(config, `PERF-${i}`, { repos: [{ path: repo, worktree }], hidden: i % 4 === 0, closed: i % 4 === 1, cancelled: i % 4 === 2 });
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, `Verdict: PASS\n${'x'.repeat(i % 2 ? 500_000 : 1000)}\n`);
    if (i % 4 === 1) {
      fs.mkdirSync(archiveDir(config), { recursive: true });
      fs.renameSync(path.join(config.stateDir, record.window), path.join(archiveDir(config), record.window));
    }
  }
  fs.mkdirSync(path.join(path.dirname(config.path), 'queue'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(config.path), 'queue/0001-waiting.json'), JSON.stringify({ seq: 1, order: 1, task: 'WAITING', status: 'queued', priority: 'normal', queuedAt: new Date().toISOString(), agent: 'claude', model: 'opus', effort: 'high', after: ['PERF-3'], spec: `---\ntask: WAITING\nagent: claude\nrepos:\n - path: ${repo}\n   worktree: ${repo}-preview\n---\nWait.` }));
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd) => cmd === 'tmux' ? { code: 1 } : cmd === 'git' ? { code: 0, stdout: '' } : { code: 1 } });
  const deps = { context: (out: (line: string) => void) => new Context(runner, config, out), notify: async () => {} };
  const results: { name: string; ms: number; budget: number }[] = [];
  const measure = async (name: string, budget: number, run: () => Promise<unknown>) => {
    const start = performance.now();
    await run();
    results.push({ name, ms: performance.now() - start, budget });
    console.log(`READ_TIMING ${JSON.stringify(results.at(-1))}`);
  };
  try {
    // Tripwires against the pre-fix behaviour (walks and full loads cost seconds to minutes), not micro-budgets:
    // healthy runs are 0.2–1.2 s and `doctor --timings` keeps the tight PASS/WARN budgets for production diagnosis.
    for (const [name, args, budget] of [['status', ['status'], 3000], ['queue list', ['queue', 'list'], 2000]] as const) await measure(name, budget, async () => {
      await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--no-warnings', new URL('../bin/agentctl.ts', import.meta.url).pathname, ...args], { env: { ...process.env, AGENTCTL_HOME: path.dirname(config.path) }, maxBuffer: 4 * 1024 * 1024 });
    });
    for (const [name, input] of [['status', { detail: true }], ['queue_list', {}], ['events_since', { peek: true }], ['queue', { spec: `---\ntask: PERF-NEW\nagent: claude\nrepos:\n - path: ${repo}\n   worktree: ${repo}-preview\n---\nPreview only.` }]] as const) await measure(`MCP ${name}`, 5000, async () => {
      const tool = MCP_TOOLS.find(t => t.name === name)!;
      const result = await tool.run(deps, z.object(tool.input).parse(input));
      assert.equal(result.isError, undefined, result.text);
      assert.doesNotMatch(result.text, /8 s response budget exhausted/);
    });
    // Load arriving mid-test (the gate starts neighbouring suites) makes the budgets observational again.
    const loaded = !(await quiet());
    console.log(`READ_TIMINGS ${JSON.stringify({ records: 400, files: 300000, maxReportBytes: 500000, observational: loaded, results })}`);
    if (!loaded) for (const result of results) assert.ok(result.ms < result.budget, `${result.name}: ${result.ms.toFixed(1)}ms >= ${result.budget}ms`);
  } finally { await shutdownMeasurements(); }
});
