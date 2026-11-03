import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadProgram } from '../src/help.ts';
import { CLI_MCP, parityErrors, parityMarkdown } from '../src/core/mcp-parity.ts';
import { MCP_ALLOW_GROUPS, MCP_WRITE_TOOLS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, auditPath } from '../src/core/mcp-tools.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
import { readQueue, saveEntry } from '../src/core/queue.ts';
import { touchCohort } from '../src/core/cohort.ts';
import { readJournal } from '../src/core/journal.ts';
const scratch = useScratch();
const additions = MCP_WRITE_TOOLS.slice(13);
function fixture(name: string, allow = '') {
  const config = makeConfig(scratch.sub(name), `mcp: {allow: [${allow}]}\ncapacity: {codex_refresh: false}\n`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args, opts) => cmd === 'claude' ? { code: 0, stdout: '--remote-control --append-system-prompt-file' } : tmux.respond(cmd, args, opts) });
  const notices: string[] = [];
  const deps: McpDeps = { context: (out) => new Context(runner, config, out), notify: async (text) => { notices.push(text); } };
  const call = async (name: string, input = {}) => {
    const tool = MCP_TOOLS.find((t) => t.name === name)!;
    return tool.run(deps, z.object(tool.input).parse(input));
  };
  return { config, runner, tmux, notices, deps, call };
}
describe('MCP parity guard', () => {
  it('covers the full commander tree and generated docs; a new unmapped command fails', async () => {
    const program = await loadProgram();
    assert.deepEqual(parityErrors(program), []);
    assert.ok(fs.readFileSync('docs/mcp.md', 'utf8').includes(parityMarkdown(program)));
    program.command('future');
    assert.deepEqual(parityErrors(program), ['future: no MCP mapping or exception']);
    assert.ok(CLI_MCP['queue retry'].includes('queue_retry'));
  });
  it('explicit groups expand; existing names retain exactly their prior permissions', () => {
    const old = 'new, queue, send, close, cancel, set_limits, reserve';
    assert.deepEqual(makeConfig(scratch.sub('legacy'), `mcp: {allow: [${old}]}\n`).mcp.allow, old.split(', '));
    for (const [group, tools] of Object.entries(MCP_ALLOW_GROUPS)) assert.deepEqual(makeConfig(scratch.sub(group.replaceAll(':', '-')), `mcp: {allow: ['${group}']}\n`).mcp.allow, tools);
  });
  for (const name of additions) {
    it(`${name}: no allow denies before argument resolution and audits`, async () => {
      const f = fixture(`denied-${name}`);
      const tool = MCP_TOOLS.find((t) => t.name === name)!;
      const result = await tool.run(f.deps, {} as never);
      assert.equal(result.isError, true);
      assert.match(result.text, /not in mcp.allow/);
      assert.equal(JSON.parse(fs.readFileSync(auditPath(f.config), 'utf8')).outcome, 'denied');
      assert.deepEqual(f.notices, []);
    });
  }
  for (const [name, args] of [
    ['hide', { tasks: ['A-1'] }], ['unhide', { tasks: ['A-1'] }],
    ['cohort_add', { tasks: ['A-1'], cohort: 'Batch' }], ['cohort_remove', { tasks: ['A-1'] }],
    ['queue_pause', {}], ['queue_resume', {}], ['archive', {}], ['limits_release', {}],
    ['manager_stop', {}], ['notify_test', {}], ['gc', {}],
    ['adopt', { task: 'B-1', report: '/nonexistent/report.md' }],
  ] as const) {
    it(`${name}: allow, mandatory two steps, audit, journal and desktop`, async () => {
      const f = fixture(`allowed-${name}`, name);
      seedTask(f.config, 'A-1');
      assert.equal((await f.call(name, { ...args, confirm: true })).isError, true);
      const before = f.runner.commands.length;
      const preview = await f.call(name, args);
      assert.equal(preview.isError, undefined, preview.text);
      assert.equal(f.runner.commands.length, before);
      assert.deepEqual(f.notices, []);
      const result = await f.call(name, { ...args, confirm: true });
      assert.equal(result.isError, undefined, result.text);
      assert.ok(f.notices.length > 0);
      assert.ok(readJournal(f.config).some((e) => e.kind === 'mcp-write' && e.text.startsWith(name)));
      const audit = fs.readFileSync(auditPath(f.config), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(audit.at(-1).outcome, 'done');
      assert.equal((await f.call(name, { ...args, confirm: true })).isError, true, 'one use only');
    });
  }
  for (const name of ['queue_retry', 'queue_up', 'unblock', 'cohort_note', 'report_from', 'manager_start'] as const) {
    it(`${name}: valid shared-core execution is audited and confirmed`, async () => {
      const f = fixture(`extra-${name}`, `queue, ${name}`);
      const repo = scratch.sub(`extra-${name}/repo`);
      let args: Record<string, unknown> = {};
      if (['queue_retry', 'queue_up', 'unblock'].includes(name)) {
        const spec = `---\ntask: Q-1\nagent: claude\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n---\nFake.\n`;
        await f.call('queue', { spec });
        assert.equal((await f.call('queue', { spec, confirm: true })).isError, undefined);
        const entry = readQueue(f.config)[0]!;
        const ctx = f.deps.context(() => {});
        if (name === 'queue_retry') await saveEntry(ctx, { ...entry, status: 'failed', error: 'git ETIMEDOUT', failedAt: new Date().toISOString() });
        if (name === 'unblock') await saveEntry(ctx, { ...entry, after: ['OLD-1'] });
        args = { task: 'Q-1', ...(name === 'unblock' ? { drop_after: 'OLD-1' } : {}) };
      } else if (name === 'cohort_note') {
        await touchCohort(f.deps.context(() => {}), 'Batch');
        args = { cohort: 'Batch', text: 'User note' };
      } else if (name === 'report_from') {
        seedTask(f.config, 'A-1', { repos: [{ path: repo, worktree: repo }] });
        const from = path.join(repo, 'source.md'); fs.writeFileSync(from, 'Verdict: PASS\n');
        args = { task: 'A-1', from };
      } else {
        f.config.manager.project = repo;
        f.deps.self = [process.execPath, path.resolve('bin/agentctl.ts')];
        args = { project: repo };
      }
      const preview = await f.call(name, args);
      assert.equal(preview.isError, undefined, preview.text);
      const notices = f.notices.length;
      const done = await f.call(name, { ...args, confirm: true });
      assert.equal(done.isError, undefined, done.text);
      assert.ok(f.notices.length > notices);
      assert.ok(readJournal(f.config).some((e) => e.kind === 'mcp-write' && e.text.startsWith(name)));
    });
  }
  it('new previews the effective provider and supports no_agent without starting a provider', async () => {
    const f = fixture('new-options', 'new');
    const repo = scratch.sub('new-options/repo');
    const spec = `---\ntask: OPT-1\nagent: claude\nmodel: sonnet\neffort: medium\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n---\nFake.\n`;
    const args = { spec, agent: 'codex', no_agent: true, cohort: 'Batch' };
    const preview = await f.call('new', args);
    assert.equal(preview.isError, undefined, preview.text);
    assert.match(preview.text, /OPT-1  codex/);
    const done = await f.call('new', { ...args, confirm: true });
    assert.equal(done.isError, undefined, done.text);
    assert.match(done.text, /no agent started/);
    assert.ok(!f.runner.commands.some((line) => /tmux new|claude --|codex -/.test(line)));
  });
  it('all added reads remain available without allow', async () => {
    const f = fixture('reads'); seedTask(f.config, 'A-1');
    for (const name of ['doctor', 'equivalents', 'config_show', 'manager_status', 'away_status', 'report', 'mcp_check', 'spec_example']) {
      const result = await f.call(name, name === 'report' ? { task: 'A-1' } : {});
      assert.equal(result.isError, undefined, `${name}: ${result.text}`);
    }
  });
  it('changed task scope invalidates a pending batch cancellation and revocation takes effect', async () => {
    const f = fixture('cancel-change', 'cancel');
    seedTask(f.config, 'A-1', { cohort: 'Batch' });
    await f.call('cancel', { cohort: 'Batch' });
    seedTask(f.config, 'B-1', { cohort: 'Batch' });
    const changed = await f.call('cancel', { cohort: 'Batch', confirm: true });
    assert.equal(changed.isError, true);
    assert.match(changed.text, /changed preview/);
    await f.call('cancel', { tasks: ['A-1', 'B-1'] });
    f.config.mcp.allow = [];
    assert.match((await f.call('cancel', { tasks: ['A-1', 'B-1'], confirm: true })).text, /not in mcp.allow/);
  });
  it('rejects expansion of the gc plan and requires a new preview', async () => {
    const f = fixture('gc-expands', 'gc');
    await f.call('gc');
    seedTask(f.config, 'C-1', { closed: true });
    const result = await f.call('gc', { confirm: true });
    assert.equal(result.isError, true);
    assert.match(result.text, /changed preview/);
    assert.ok(!f.runner.commands.some((c) => /rename|worktree remove|branch -d/.test(c)));
  });
  it('masks environment, ntfy topic/token and credential-bearing server URL', async () => {
    const f = fixture('masked');
    f.config.env.SECRET = 'ENV_SECRET';
    f.config.notify.ntfy = { server: 'https://USER:PASSWORD@example.org/?key=URL_SECRET', token: 'TOKEN_SECRET', topic: 'TOPIC_SECRET', events: [], priority: {} as never, includeVerdict: false, includeQuestion: false, always: false };
    const result = await f.call('config_show');
    assert.doesNotMatch(result.text, /ENV_SECRET|TOKEN_SECRET|TOPIC_SECRET|PASSWORD|URL_SECRET/);
    assert.match(result.text, /masked/);
  });
  it('status exposes disk and tasks together; all tool descriptions name the CLI', async () => {
    const f = fixture('status-disk');
    const result = await f.call('status');
    const data = JSON.parse(result.text.split('\n\n').at(-1)!);
    assert.ok(data.disk.volumes.length > 0);
    assert.deepEqual(data.tasks, []);
    for (const tool of MCP_TOOLS) { assert.match(tool.description, /CLI: agentctl/); if (tool.kind === 'read') assert.doesNotMatch(tool.description, /^WRITE/); }
  });
});
