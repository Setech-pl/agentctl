import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { readHistory } from '../src/core/history.ts';
import { auditPath, MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef, ToolResult } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, useScratch } from './helpers.ts';
import { makeWorld, setClaudePlan, setCodexPlan } from './usage-world.ts';

const scratch = useScratch();
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const tool = (name: string): McpToolDef => MCP_TOOLS.find((t) => t.name === name) as McpToolDef;

function setup(name: string, mcpYaml = '') {
  const w = makeWorld(scratch, name);
  if (mcpYaml) fs.appendFileSync(w.config.path, mcpYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, startTime: NOW, respond: tmux.respond });
  const notified: string[] = [];
  const deps: McpDeps = {
    context: (out) => new Context(runner, loadGlobalConfig(path.dirname(w.config.path)), out),
    notify: async (m) => void notified.push(m),
  };
  const call = (n: string, args: Record<string, unknown> = {}): Promise<ToolResult> => tool(n).run(deps, z.object(tool(n).input).parse(args) as never);
  const wt = w.worktree('nc-1');
  w.task('NC-1', wt, { started: '2026-11-01T09:00:00.000Z', cohort: 'sprint' });
  w.claudeSession(wt, 'sess-1', '2026-11-01T10:00:00.000Z');
  tmux.add('nc-1', '● Working\n  esc to interrupt\n');
  return { ...w, tmux, runner, deps, call, notified };
}

const json = (r: ToolResult): unknown => JSON.parse(r.text.slice(r.text.search(/[[{]\s*\n/)));

describe('mcp: usage, log and stats are read tools', () => {
  it('usage returns the plans (n/d where the provider did not say), the tokens and the cohorts', async () => {
    const t = setup('usage');
    setClaudePlan(t.config.path, NOW, { session: 62, week: 41 });
    const r = await t.call('usage', { since: '30d' });
    assert.equal(r.isError, undefined);
    assert.match(r.text, /^Plan limits - claude: 5h 62% ↻ .* · week 41% ↻ .*; codex: n\/d \(/);
    const report = json(r) as { plans: Record<string, { available: boolean; maxPercent: number | null }>; tasks: { task: string; fresh: number }[]; cohorts: { cohort: string }[] };
    assert.equal(report.plans.claude?.maxPercent, 62);
    assert.equal(report.plans.codex?.available, false);
    assert.equal(report.plans.codex?.maxPercent, null);
    assert.equal(report.tasks[0]?.task, 'NC-1');
    assert.equal(report.tasks[0]?.fresh, 5 + 326 + 17200 + 5 + 400);
    assert.deepEqual(report.cohorts.map((c) => c.cohort), ['sprint']);
  });

  it('usage takes cohort and since; a wrong cohort or age is a tool error, not a crash', async () => {
    const t = setup('usage2');
    const other = await t.call('usage', { cohort: 'sprint', since: '1d' });
    assert.equal(other.isError, undefined);
    assert.equal((await t.call('usage', { cohort: 'nope' })).isError, true);
    assert.match((await t.call('usage', { since: 'soon' })).text, /cannot read the age/);
  });

  it('the Codex plan comes from the newest session log', async () => {
    const t = setup('usage3');
    const file = t.codexSession(t.worktree('holder'), 'holder', new Date(NOW - 3600_000).toISOString());
    setCodexPlan(file, NOW, { session: 33, week: 12 });
    const report = json(await t.call('usage')) as { plans: { codex: { windows: { label: string; usedPercent: number }[] } } };
    assert.deepEqual(report.plans.codex.windows.map((w) => [w.label, w.usedPercent]), [['5h', 33], ['week', 12]]);
  });

  it('status carries a one-line summary of the plans', async () => {
    const t = setup('status');
    setClaudePlan(t.config.path, NOW, { session: 62, week: 41 });
    const lines = (await t.call('status')).text.split('\n');
    const plans = lines.find((l) => l.startsWith('Plans:'));
    assert.match(plans ?? '', /^Plans: claude 5h 62% ↻ .* \| codex n\/d \(.*\)\. usage has the tokens\.$/);
  });

  it('log and stats read the history; an empty history says so', async () => {
    const t = setup('log');
    assert.match((await t.call('log')).text, /history is empty/);
    assert.match((await t.call('stats')).text, /history is empty/);
  });
});

describe('mcp: mark', () => {
  it('is refused unless mcp.allow lists it, and the refusal is audited', async () => {
    const t = setup('mark-off');
    const r = await t.call('mark', { task: 'NC-1', result: 'ok' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Writing is off for "mark"/);
    assert.equal(readHistory(t.config).length, 0);
    const audit = fs.readFileSync(auditPath(t.config), 'utf8');
    assert.match(audit, /"tool":"mark".*"outcome":"denied"/);
  });

  it('with mark in mcp.allow it records the result at once (no confirm step), audits it and tells the desktop', async () => {
    const t = setup('mark-on', 'mcp: {allow: [mark]}\n');
    const r = await t.call('mark', { task: 'nc-1', result: 'partial', note: 'edge case missed' });
    assert.equal(r.isError, undefined, r.text);
    assert.match(r.text, /^NC-1: marked partial\./);
    const [h] = readHistory(t.config);
    assert.equal(h?.event, 'mark');
    assert.equal(h?.result, 'partial');
    assert.equal(h?.note, 'edge case missed');
    assert.deepEqual(t.notified, ['czat zlecił: mark NC-1 partial']);
    const entries = fs.readFileSync(auditPath(t.config), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string; outcome: string });
    assert.deepEqual(entries.map((e) => [e.tool, e.outcome]), [['mark', 'requested'], ['mark', 'done']]);
    const again = await t.call('mark', { task: 'NC-1', result: 'ok' });
    assert.match(again.text, /marked ok \(was partial\)/);
    const stats = json(await t.call('stats')) as { agent: string; ok: number; partial: number }[];
    assert.equal(stats[0]?.ok, 1);
    assert.equal(stats[0]?.partial, 0);
    const log = json(await t.call('log')) as { task: string; result: string }[];
    assert.deepEqual(log.map((x) => [x.task, x.result]), [['NC-1', 'ok']]);
  });

  it('rejects a result that is not ok, partial or fail, and an unknown task, without writing', async () => {
    const t = setup('mark-bad', 'mcp: {allow: [mark]}\n');
    assert.throws(() => z.object(tool('mark').input).parse({ task: 'NC-1', result: 'great' }));
    const unknown = await t.call('mark', { task: 'NC-99', result: 'ok' });
    assert.equal(unknown.isError, true);
    assert.equal(readHistory(t.config).length, 0);
  });

  it('the tool descriptions: mark says it needs no confirmation but only the user\'s verdict; usage tells when to call it', () => {
    assert.match(tool('mark').description, /^WRITE, off unless the user put "mark" in mcp\.allow/);
    assert.match(tool('mark').description, /needs no confirmation/);
    assert.match(tool('usage').description, /BEFORE the user orders more tasks/);
    assert.equal(tool('usage').kind, 'read');
    assert.equal(tool('log').kind, 'read');
    assert.equal(tool('stats').kind, 'read');
    assert.equal(tool('mark').kind, 'write');
  });
});
