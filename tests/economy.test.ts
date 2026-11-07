import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { parseClaudeEvent } from '../src/core/events.ts';
import { Context } from '../src/core/context.ts';
import { MCP_TOOLS, readReportFile, reportSection, reportSummary } from '../src/core/mcp-tools.ts';
import { syncReport } from '../src/core/report-detect.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { readJournal } from '../src/core/journal.ts';
import { collectEvents, markersPath } from '../src/core/chat-events.ts';
import { hasReport } from '../src/core/depends.ts';
import { overloadTick } from '../src/core/overload.ts';
import { classifyScreen, isOverloaded } from '../src/core/state.ts';
import { transientStartError, QueueMemory, queueTick, readQueue, planQueueAdd, commitQueueAdd } from '../src/core/queue.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { screenMetadata, lastContentLine } from '../src/core/tmux.ts';
import { emptyStats, feedText, freshTokens, sumBuckets } from '../src/core/usage-parse.ts';
import { selfVerdict, snapshot, foldHistory, computeStats } from '../src/core/history.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
function fixture(name: string, yaml = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, `capacity: {codex_refresh: false}\n${yaml}`);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const deps = { context: () => ctx, notify: async () => {} };
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args as never);
  return { root, config, tmux, runner, ctx, call, deps };
}
const notify = { notify: async () => {} };

it('economy: six 20KB reports have bounded summaries, full mode and section/line pagination', async () => {
  const f = fixture('six', 'mcp: {max_response_kb: 256}\n');
  for (let i = 1; i <= 6; i++) {
    const r = seedTask(f.config, `NC-${i}`);
    fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, `Werdykt: PASS\nSHA: abcdef123; branch: economy\n## Summary\nDecision ${i}\n## Evidence\n${'x'.repeat(20000)}\n`);
  }
  await f.runner.sleep(1000);
  const full = await f.call('pull_ready', { mode: 'full', all: true });
  const brief = await f.call('pull_ready', { all: true });
  assert.ok(Buffer.byteLength(brief.text) < 16000);
  assert.ok(Buffer.byteLength(full.text) > 120000);
  for (let i = 1; i <= 6; i++) {
    assert.match(brief.text, new RegExp(`=== NC-${i} ===`));
    assert.match(brief.text, new RegExp(`Decision ${i}`));
  }
  assert.match(brief.text, /path: .*NC-1.md/);
  assert.match(brief.text, /bytes: 20\d+/);
  assert.match(brief.text, /Werdykt: PASS/);
  assert.match(brief.text, /abcdef123/);
  assert.match((await f.call('pull_ready')).text, /No new reports/);
  const section = await f.call('get_report', { task: 'NC-1', section: 'summary', offset: 1, limit: 1 });
  assert.match(section.text, /Decision 1/);
  assert.doesNotMatch(section.text, /Evidence/);
  assert.equal(reportSection('# A\na\n## B\nb\n# C\nc', 'A'), '# A\na\n## B\nb');
  assert.equal(reportSummary('# X\n' + 'a'.repeat(3000)).length, 1500);
  const sizes = { fixture: '6 reports, ~20KB each', before: Buffer.byteLength(full.text), after: Buffer.byteLength(brief.text) };
  if (process.env.AGENTCTL_ECONOMY_RESULTS) fs.writeFileSync(process.env.AGENTCTL_ECONOMY_RESULTS, JSON.stringify(sizes, null, 2));
});

it('economy: concise reads never duplicate JSON; explicit format JSON contains full facts', async () => {
  const f = fixture('formats');
  seedTask(f.config, 'NC-1'); f.tmux.add('nc-1', 'Working\n❯ \n');
  for (const name of ['status', 'events_since', 'queue_list', 'limits', 'capacity']) {
    const a = await f.call(name, { peek: true });
    const b = await f.call(name, { peek: true, format: 'json' });
    assert.ok(!a.isError, a.text); assert.ok(!b.isError, b.text);
    assert.doesNotThrow(() => JSON.parse(b.text), b.text);
    assert.doesNotMatch(a.text, /"tasks":|"providers":|"summary":/);
  }
  assert.match((await f.call('status')).text, /NC-1 claude\/opus\/high waiting .*cohort=n\/d report=no/);
});

it('economy: independent MCP clients and conservative migration preserve events', async () => {
  const f = fixture('cursors');
  const now = f.runner.now();
  fs.writeFileSync(markersPath(f.config), JSON.stringify({ mcp: new Date(now - 3 * 86400000).toISOString() }));
  await f.runner.appendFile(path.join(path.dirname(f.config.path), 'journal.jsonl'), JSON.stringify({ at: new Date(now - 2 * 86400000).toISOString(), kind: 'queue-start', text: 'old', task: 'NC-1' }) + '\n');
  const a = await collectEvents(f.ctx, { client: 'mcp:manager:1' });
  const b = await collectEvents(f.ctx, { client: 'mcp:chat:2' });
  assert.equal(a.events.length, 1); assert.equal(b.events.length, 0);
  assert.equal((await collectEvents(f.ctx, { client: 'mcp:manager:1' })).events.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(markersPath(f.config), 'utf8')).mcp, undefined);
});

it('economy: usage footer and unsent draft never become lastLine; monitors are background', () => {
  const screen = '● Ran tests\n❯ check deployment\n⚠ weekly limit: 20% left\n';
  assert.deepEqual(screenMetadata(screen), { usage_hint: '⚠ weekly limit: 20% left', draft_input: 'check deployment' });
  assert.equal(lastContentLine(screen, []), '● Ran tests');
  const f = fixture('background');
  for (const text of ['3 monitors still running', '2 shells still running', '⏵⏵ auto mode on · 1 shell, 6 monitors']) assert.equal(classifyScreen(text, f.config.agents.claude), 'background');
});

it('economy: report candidates cannot satisfy dependencies; valid configured report and canonical win', async () => {
  const f = fixture('reports');
  const wt = path.join(f.root, 'wt'); fs.mkdirSync(wt);
  const git = (...args: string[]) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' } });
  assert.equal(git('init').status, 0);
  fs.writeFileSync(path.join(wt, 'NC-1-tracked.md'), 'Werdykt: PASS\n');
  git('add', '.'); assert.equal(git('-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '-m', 'initial').status, 0);
  const rec = seedTask(f.config, 'NC-1', { repos: [{ path: wt, worktree: wt }], reportAlt: ['*.md'] });
  f.tmux.add('nc-1', '❯ \n');
  for (const name of ['CLAUDE.md', 'README.md', 'AGENTS.md', 'CHANGELOG.md', 'integration-12.md', 'NC-1-no-verdict.md', 'NC-1-tracked.md']) {
    fs.writeFileSync(path.join(wt, name), ['integration-12.md', 'NC-1-no-verdict.md'].includes(name) ? '# no verdict' : 'Werdykt: PASS\n');
    assert.equal((await syncReport(f.ctx, rec)).action, 'none', name);
    assert.ok(!fs.existsSync(rec.report), name);
  }
  const rows = await collectStatus(f.ctx, { progress: false });
  assert.equal(rows[0]!.state, 'waiting');
  assert.equal(hasReport(rows[0]), false);
  assert.match((await f.call('pull_ready')).text, /No reports ready/);
  const candidateEvents = readJournal(f.config).filter(e => e.kind === 'report-candidate');
  await syncReport(f.ctx, rec);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'report-candidate').length, candidateEvents.length);
  fs.writeFileSync(path.join(wt, 'NC-1-valid.md'), 'Werdykt: PASS\n## Summary\nDone');
  assert.equal((await syncReport(f.ctx, rec, { from: path.join(wt, 'NC-1-valid.md') })).action, 'copied');
  fs.writeFileSync(rec.report, 'canonical wins');
  fs.writeFileSync(path.join(wt, 'NC-1-valid.md'), 'Werdykt: FAIL');
  assert.equal((await syncReport(f.ctx, readTaskRecord(f.config, 'nc-1')!)).action, 'none');
  assert.equal(fs.readFileSync(rec.report, 'utf8'), 'canonical wins');
});

it('economy: overload retry requires idle visible empty input, honors interval, restart and cap', async () => {
  const f = fixture('overload', 'overload: {retry_after: 1, max_retries: 2}\n');
  seedTask(f.config, 'NC-1'); const w = f.tmux.add('nc-1', '⏺ Request failed.\n  ⎿ API Error: 529 Overloaded\n❯ \n');
  assert.ok(isOverloaded(w.screen));
  assert.ok(isOverloaded('⏺ Request failed.\n  ⎿ API Error: 529 Overloaded'));
  assert.ok(isOverloaded('■ Selected model is at capacity. Please try a different model.'));
  assert.equal(parseClaudeEvent('stop-failure', { error: 'overloaded_error' }).outcome, 'overloaded');
  const tick = async () => overloadTick(f.ctx, await collectStatus(f.ctx, { progress: false }), notify);
  await tick(); await f.runner.sleep(1001);
  w.screen += 'esc to interrupt'; await tick();
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 0);
  w.screen = '⏺ Request failed.\n  ⎿ API Error: 529 Overloaded\n❯ unsent\n'; await tick();
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 0);
  w.screen = '⏺ Request failed.\n  ⎿ API Error: 529 Overloaded\n❯ \n3 monitors still running'; await tick();
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 0);
  w.screen = '⏺ Request failed.\n  ⎿ API Error: 529 Overloaded\n❯ \n'; await tick();
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 1);
  await f.runner.sleep(1001); await tick();
  await f.runner.sleep(1001); await tick();
  await f.runner.sleep(1001); await tick(); await tick();
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 2);
  assert.equal(readJournal(f.config).filter(e => e.text.includes('wymaga uwagi')).length, 1);
});

it('economy: worktree placeholders resolve within this task and use fallback only for absent repos', () => {
  const f = fixture('placeholders', 'worktree_root: /worktrees\n');
  const spec = (repos: string, target: string) => resolveSpec(splitSpecs(`---\ntask: NC-1\nagent: claude\nrepos: ${repos}\nlinks: [{from: packages/sim, to: "${target}/packages/sim"}]\nenv: {BACKEND: "${target}"}\n---\nTask`)[0]!, { config: f.config, loadProject: () => undefined });
  const one = spec('[{path: /repos/front}]', '{worktree:back|~/fallback}');
  assert.equal(one.links[0]!.to, path.join(process.env.HOME!, 'fallback/packages/sim'));
  const two = spec('[{path: /repos/front}, {path: /repos/back}]', '{worktree:back|~/fallback}');
  assert.equal(two.links[0]!.to, '/worktrees/back-nc-1/packages/sim');
  assert.equal(two.env.BACKEND, '/worktrees/back-nc-1');
  assert.throws(() => spec('[{path: /repos/front}]', '{worktree:missing}'), /no repository "missing"/);
});

it('economy: session observations, reasoning subset and self verdict remain facts separate from mark', async () => {
  const stats = emptyStats('codex');
  feedText(stats, [
    { type: 'session_meta', payload: { cli_version: '0.test', id: 's', cwd: '/wt' } },
    { type: 'turn_context', payload: { model: 'gpt-test', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 12 } } } },
  ].map(o => JSON.stringify({ timestamp: new Date().toISOString(), ...o })).join('\n') + '\n');
  const tokens = sumBuckets(stats.buckets);
  assert.equal(tokens.reasoning_output_tokens, 12); assert.equal(tokens.output, 20); assert.equal(freshTokens(tokens), 30);
  assert.deepEqual(stats.observed, { model: 'gpt-test', effort: 'low', cliVersion: '0.test' });
  const f = fixture('history'); const r = seedTask(f.config, 'NC-1');
  fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, 'Werdykt: BLOCKED\n');
  assert.equal(selfVerdict(r.report), 'BLOCKED');
  const h = await snapshot(f.ctx, r, 'report');
  assert.deepEqual(h.resolved, h.effective); assert.equal(h.observed!.model, 'unknown'); assert.equal(h.agent_cli_version, 'unknown');
  assert.equal(h.self_verdict, 'BLOCKED'); assert.equal(h.result, null);
  const groups = computeStats(foldHistory([h])); assert.equal(groups[0]!.unmarked, 1); assert.equal(groups[0]!.self_verdicts.BLOCKED, 1);
  const wt = path.join(f.root, 'wt'); fs.mkdirSync(wt);
  const c = seedTask(f.config, 'NC-2', { agent: 'codex', model: 'resolved-model', effort: 'high', requested: { agent: 'codex', model: 'requested-model', effort: 'medium' }, repos: [{ path: wt, worktree: wt }] });
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '/');
  const logDir = path.join(f.config.usage.codexDir!, 'sessions', day); fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'rollout-fixture.jsonl'), [
    { type: 'session_meta', payload: { id: 'observed-session', cwd: wt, cli_version: '0.fixture' } },
    { type: 'turn_context', payload: { model: 'observed-model', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 12 } } } },
  ].map(o => JSON.stringify({ timestamp: new Date().toISOString(), ...o })).join('\n') + '\n');
  const observed = await snapshot(f.ctx, c, 'closed');
  assert.equal(observed.requested!.model, 'requested-model');
  assert.equal(observed.resolved!.model, 'resolved-model');
  assert.equal(observed.observed!.model, 'observed-model');
  assert.equal(observed.observed!.effort, 'low');
  assert.equal(observed.agent_cli_version, '0.fixture');
  assert.equal(observed.tokens!.reasoning_output_tokens, 12);
  assert.equal(observed.tokens!.fresh, 30);
  assert.match(foldHistory([observed])[0]!.observation_warning!, /differs from requested/);

});

it('economy: queue classifies explicit transient failures, shows full spec and records delayed retries', async () => {
  for (const e of ['ETIMEDOUT', 'EAGAIN', 'lock temporarily busy', 'network timeout', 'Timed out waiting for /repo/.git/agentctl-worktree.lock']) assert.ok(transientStartError(e));
  for (const e of ['ENOENT', 'invalid spec', 'branch already exists', 'unknown error']) assert.equal(transientStartError(e), false);
  const f = fixture('retryqueue');
  fs.mkdirSync(path.join(f.root, 'missing'));
  const raw = splitSpecs(`---\ntask: Q-1\nagent: claude\nrepos: [{path: ${f.root}/missing, worktree: ${f.root}/wt}]\n---\nComplete spec prompt`);
  await commitQueueAdd(f.ctx, (await planQueueAdd(f.ctx, raw)).items);
  const shown = await f.call('queue_show', { task: 'Q-1' }); assert.match(shown.text, /Complete spec prompt/);
  assert.match(shown.text, /"after":/);
});
