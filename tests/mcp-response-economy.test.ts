import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, responseWireBytes, type McpDeps } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
function fixture(name: string) {
  const config = makeConfig(scratch.sub(name), 'capacity: {codex_refresh: false}\n');
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const deps: McpDeps = { context: out => new Context(runner, config, out), notify: async () => {} };
  const call = (name: string, args = {}) => { const tool = MCP_TOOLS.find(t => t.name === name)!; return tool.run(deps, z.object(tool.input).parse(args)); };
  return { config, deps, call };
}
it('P45: concise reports keep decisions/actions/final Polish summary; full metadata occurs only on the first page', async () => {
  const f = fixture('p45');
  const r = seedTask(f.config, 'E-1');
  const text = `Verdict: PASS\n## Checks\n${'Verbose check evidence.\n'.repeat(40)}\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ndecisions: [Keep concise]\nactions: [{title: Review, shell: git status}]\nchecks: [{name: unique-check, result: PASS}]\n\`\`\`\nMarcinie, zadanie gotowe. Testy przeszły. Można scalać.\n<!-- agentctl:report-end -->\n`;
  fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, text);
  const concise = await f.call('get_report', { task: 'E-1' });
  assert.match(concise.text, /Keep concise/); assert.match(concise.text, /git status/);
  assert.match(concise.text, /Marcinie, zadanie gotowe/);
  assert.doesNotMatch(concise.text, /unique-check|Verbose check|"outputs"|agentctl-outputs/);
  const full = await f.call('get_report', { task: 'E-1', detail: true, limit: 2 });
  assert.match(full.text, /"outputs"/);
  const next = await f.call('get_report', { task: 'E-1', detail: true, offset: 2, limit: 2 });
  assert.doesNotMatch(next.text, /"outputs"|unique-check/);
  const summary = await f.call('pull_ready', { all: true });
  assert.match(summary.text, /Keep concise/); assert.match(summary.text, /Marcinie/);
  assert.doesNotMatch(summary.text, /unique-check|Verbose check|"outputs"/);
  const verbose = await f.call('get_report', { task: 'E-1', mode: 'full' });
  assert.ok(responseWireBytes(concise) < responseWireBytes(verbose) / 2);
  console.log('P45 bytes', JSON.stringify({ before: responseWireBytes(verbose), after: responseWireBytes(concise) }));
});
