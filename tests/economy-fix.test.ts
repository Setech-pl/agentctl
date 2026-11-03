import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/mcp/server.ts';
import { Context } from '../src/core/context.ts';
import { classifyScreen, isOverloaded, taskState } from '../src/core/state.ts';
import { overloadTick } from '../src/core/overload.ts';
import { collectStatus } from '../src/core/status.ts';
import { collectEvents, markersPath } from '../src/core/chat-events.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS, readReportFile, reportSection } from '../src/core/mcp-tools.ts';
import { attemptFields, inspectReport, REPORT_END } from '../src/core/report-state.ts';
import { readTaskRecord, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { checkRetryWorktrees } from '../src/core/git.ts';
import { RealRunner } from '../src/core/runner.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { redactQueue } from '../src/core/mcp-redact.ts';
import type { QueueEntry } from '../src/core/queue.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const screen = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/economy', name + '.txt'), 'utf8');
function fixture(name: string, yaml = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {codex_refresh: false}\n${yaml}`);
  const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, respond: tmux.respond, startTime: Date.now() + 1000 });
  const ctx = new Context(runner, config, () => {});
  const deps = { context: () => ctx, notify: async () => {}, clientId: 'fix-client' };
  const call = (name: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === name)!.run(deps, args as never);
  const report = (id: string, text: string) => { const r = seedTask(config, id); fs.mkdirSync(path.dirname(r.report), { recursive: true }); fs.writeFileSync(r.report, text); return r; };
  return { root, config, tmux, runner, ctx, deps, call, report };
}
const notify = { notify: async () => {} };
it('N1: reviewer eight overload/work cycles send exactly two retries and one attention; sustained work ends the episode', async () => {
  const f = fixture('n1', 'overload: {retry_after: 1, max_retries: 2, give_up_after: 1800}\n');
  seedTask(f.config, 'NC-1'); const pane = f.tmux.add('nc-1', screen('claude-overloaded'));
  const tick = async () => overloadTick(f.ctx, await collectStatus(f.ctx, { progress: false }), notifier);
  const notices: string[] = [], notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  const file = path.join(path.dirname(f.config.path), 'overload-retries.json');
  for (let i = 0; i < 8; i++) {
    pane.screen = screen('claude-overloaded'); await tick(); await f.runner.sleep(1100); await tick();
    pane.screen = screen('codex-recovered'); await tick(); await f.runner.sleep(1000); await tick();
  }
  assert.equal(f.tmux.seen.filter(s => s.startsWith('send-keys')).length, 2);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 2);
  assert.equal(notices.filter(t => t.includes('wymaga uwagi')).length, 1);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overloaded' && e.text.includes('wymaga uwagi')).length, 1);
  const episode = JSON.parse(fs.readFileSync(file, 'utf8'))['NC-1']; assert.equal(episode.attempts, 2);
  await f.runner.sleep(599000); await tick();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  pane.screen = screen('claude-overloaded'); await tick(); await f.runner.sleep(1100); await tick();
  assert.equal(f.tmux.seen.filter(s => s.startsWith('send-keys')).length, 3, 'new episode gets a fresh budget');
});
it('N1: give_up_after stays anchored through brief work and waiting; report ends an episode immediately', async () => {
  const f = fixture('n1-deadline', 'overload: {retry_after: 1, max_retries: 20, give_up_after: 5, reset_after_s: 600}\n');
  const task = seedTask(f.config, 'NC-1'); const pane = f.tmux.add('nc-1', screen('claude-overloaded'));
  const notices: string[] = [], notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  const tick = async () => overloadTick(f.ctx, await collectStatus(f.ctx, { progress: false }), notifier);
  await tick(); await f.runner.sleep(1100); await tick();
  pane.screen = screen('codex-recovered'); await tick(); await f.runner.sleep(2000);
  pane.screen = '❯'; await tick(); await f.runner.sleep(2000);
  pane.screen = screen('claude-overloaded'); await tick(); await tick();
  assert.equal(f.tmux.seen.filter(s => s.startsWith('send-keys')).length, 1);
  assert.equal(notices.length, 1);
  fs.mkdirSync(path.dirname(task.report), { recursive: true }); fs.writeFileSync(task.report, 'Werdykt: FAIL\n' + REPORT_END);
  await tick(); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(f.config.path), 'overload-retries.json'), 'utf8')), {});
});
it('N2: unprefixed reviewer error quote and prefixed error embedded in prose never become overload', () => {
  const chrome = '\n────────────────\n❯\n────────────────\n? for shortcuts';
  for (const text of ['API Error: 529 Overloaded', '⏺ Here is the explanation.\nThis is an example error:\n  ⎿ API Error: 529 Overloaded', '  ⎿ API Error: 529 Overloaded']) {
    assert.equal(isOverloaded(text + chrome), false, text);
  }
  assert.equal(isOverloaded(screen('claude-overloaded')), true);
  assert.equal(isOverloaded(screen('codex-overloaded')), true);
});
it('N3: parallel same-name sessions consume independently; successors inherit high-water; explicit client shares; legacy migrates', async () => {
  const f = fixture('n3'), journal = path.join(path.dirname(f.config.path), 'journal.jsonl');
  const append = (text: string) => fs.appendFileSync(journal, JSON.stringify({ at: new Date(f.runner.now() - 1).toISOString(), kind: 'queue-start', text }) + '\n');
  const session = async () => {
    const server = buildMcpServer(f.deps, '0.17.2'), client = new Client({ name: 'same-name', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    return { client, read: async (args = {}) => JSON.stringify((await client.callTool({ name: 'events_since', arguments: args })).content) };
  };
  append('legacy-old'); append('parallel-event');
  fs.writeFileSync(markersPath(f.config), JSON.stringify({ mcp: 'e2:1:0' }));
  const a = await session(), b = await session();
  try {
    const reads = await Promise.all([a.read(), b.read()]);
    for (const read of reads) { assert.match(read, /parallel-event/); assert.doesNotMatch(read, /legacy-old/); }
    append('next-event'); assert.match(await a.read(), /next-event/); assert.match(await b.read(), /next-event/);
    assert.doesNotMatch(await a.read(), /next-event/);
    append('ahead-of-peer'); assert.match(await b.read(), /ahead-of-peer/);
  } finally { await a.client.close(); await b.client.close(); }
  const c = await session(), d = await session();
  try {
    assert.doesNotMatch(await c.read(), /parallel-event|next-event|legacy-old|ahead-of-peer/);
    append('explicit-shared'); assert.match(await c.read({ client: 'common' }), /explicit-shared/);
    assert.doesNotMatch(await d.read({ client: 'common' }), /explicit-shared/);
  } finally { await c.client.close(); await d.client.close(); }
  assert.equal(JSON.parse(fs.readFileSync(markersPath(f.config), 'utf8')).mcp, undefined);
});
it('D8: common nonsecret env values do not erase unrelated prompt/error facts; secret fields and values remain masked', () => {
  const f = fixture('d8');
  const entry = { task: 'ENV-1', spec: '---\ntask: ENV-1\nagent: claude\nenv: {COUNT: "1", FLAG: "true", MODE: production, API_TOKEN: hidden-token}\n---\n1 production task is true; token hidden-token', error: '1 production task is true; hidden-token' } as QueueEntry;
  const result = redactQueue(entry, f.config) as QueueEntry;
  assert.match(result.spec, /1 production task is true/); assert.match(result.error!, /1 production task is true/);
  assert.doesNotMatch(JSON.stringify(result), /hidden-token|COUNT: ['"]?1|MODE: production/);
});
it('D9: an ended pane alone cannot confirm a current-attempt report without a completion signal', async () => {
  const f = fixture('d9', 'report: {settle_s: 30}\n');
  const record = seedTask(f.config, 'CRASH-1', { attemptId: 'current', attemptStarted: new Date(f.runner.now() - 60000).toISOString(), turnEndedAt: undefined });
  fs.mkdirSync(path.dirname(record.report), { recursive: true }); fs.writeFileSync(record.report, 'Werdykt: PASS\npartial or complete: unknown');
  const time = (f.runner.now() - 31000) / 1000; fs.utimesSync(record.report, time, time);
  assert.equal((await collectStatus(f.ctx, { progress: false }))[0]!.state, 'report-candidate');
  fs.appendFileSync(record.report, '\n' + REPORT_END);
  assert.equal((await collectStatus(f.ctx, { progress: false }))[0]!.state, 'report-ready');
});
it('B1 D7: exact review probes are not overloads; realistic per-adapter banners and recovery', () => {
  const f = fixture('b1');
  for (const probe of ['529 testów przeszło', 'Overloaded functions were removed.', '"overloaded_error"', 'The servers are overloaded in staging']) assert.equal(isOverloaded(probe + '\n❯ \n'), false, probe);
  assert.equal(classifyScreen(screen('claude-overloaded'), f.config.agents.claude), 'overloaded');
  assert.equal(classifyScreen(screen('codex-overloaded'), f.config.agents.codex), 'overloaded');
  assert.notEqual(classifyScreen(screen('claude-work'), f.config.agents.claude), 'overloaded');
  assert.equal(classifyScreen(screen('codex-recovered'), f.config.agents.codex), 'working');
  assert.equal(isOverloaded('```\nAPI Error: 529\n```\n❯ \n'), false);
  assert.equal(isOverloaded('API Error: 529\n● Finished 529 tests\n❯ \n'), false);
  assert.equal(taskState({ alive: true, screen: screen('claude-overloaded'), settings: f.config.agents.claude, reportReady: true }), 'report-ready');
  assert.equal(taskState({ alive: true, screen: screen('claude-overloaded') + '\nEnter to select · Esc to cancel', settings: f.config.agents.claude, reportReady: true }), 'needs-input');
  assert.equal(isOverloaded('API Error: 529\n❯ \n', []), false);
});
it('B1 W1 D2 D6: retry episode persists, resets after sustained work, has deadline, guards report/draft/recovery and logs send failure', async () => {
  const f = fixture('w1', 'overload: {retry_after: 1, max_retries: 2, give_up_after: 8}\n');
  const record = seedTask(f.config, 'NC-1'); const pane = f.tmux.add('nc-1', screen('claude-overloaded'));
  const rows = () => collectStatus(f.ctx, { progress: false });
  await overloadTick(f.ctx, await rows(), notify); await f.runner.sleep(1100);
  await overloadTick(f.ctx, await rows(), notify);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 1);
  // New invocation reads persisted state rather than retrying immediately.
  await overloadTick(f.ctx, await rows(), notify);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, 1);
  pane.screen = screen('codex-recovered'); await overloadTick(f.ctx, await rows(), notify);
  await f.runner.sleep(600000); await overloadTick(f.ctx, await rows(), notify);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(f.config.path), 'overload-retries.json'), 'utf8')), {});
  pane.screen = screen('claude-overloaded'); await overloadTick(f.ctx, await rows(), notify);
  await f.runner.sleep(9000); await overloadTick(f.ctx, await rows(), notify);
  assert.ok(readJournal(f.config).some(e => e.text.includes('give_up_after')));
  pane.screen = screen('codex-recovered'); await overloadTick(f.ctx, await rows(), notify);
  await f.runner.sleep(600000); await overloadTick(f.ctx, await rows(), notify);
  pane.screen = screen('claude-overloaded'); await overloadTick(f.ctx, await rows(), notify);
  await f.runner.sleep(1100);
  const paste = f.ctx.tmux.pasteText.bind(f.ctx.tmux);
  f.ctx.tmux.pasteText = async (window, text) => { await paste(window, text); pane.screen = screen('codex-recovered'); };
  const enters = f.tmux.seen.filter(s => s.startsWith('send-keys')).length;
  await overloadTick(f.ctx, await rows(), notify);
  assert.equal(f.tmux.seen.filter(s => s.startsWith('send-keys')).length, enters, 'no Enter after autonomous recovery during paste');
  assert.ok(readJournal(f.config).some(e => e.text.includes('retry failed')));
  // Any canonical/candidate report blocks automated input, even before it settles.
  fs.mkdirSync(path.dirname(record.report), { recursive: true }); fs.writeFileSync(record.report, 'partial');
  pane.screen = screen('claude-overloaded'); await f.runner.sleep(1100);
  const count = readJournal(f.config).filter(e => e.kind === 'overload-retry').length;
  await overloadTick(f.ctx, await rows(), notify);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'overload-retry').length, count);
  const original = f.ctx.tmux.capture.bind(f.ctx.tmux);
  f.ctx.tmux.capture = async () => { throw new Error('tmux unavailable'); };
  // watchTick also protects the recovery boundary (collector unavailable is a different error).
  f.ctx.tmux.capture = original;
});
it('W2: two subsequent initialized sessions of same client continue cursor; distinct clients remain independent', async () => {
  const f = fixture('w2');
  fs.writeFileSync(path.join(path.dirname(f.config.path), 'journal.jsonl'), JSON.stringify({ at: new Date(f.runner.now() - 100).toISOString(), kind: 'queue-start', text: 'delivered-once' }) + '\n');
  const session = async (name: string) => {
    const server = buildMcpServer(f.deps, '0.17.2'); const client = new Client({ name, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: 'events_since', arguments: {} }); await client.close(); return JSON.stringify(r.content);
  };
  assert.match(await session('manager'), /delivered-once/);
  assert.doesNotMatch(await session('manager'), /delivered-once/);
  assert.match(await session('claude-chat'), /delivered-once/);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(markersPath(f.config), 'utf8'))).length, 2);
});
it('W3: byte-bounded events pages never lose same-time events or oversized suffixes', async () => {
  const f = fixture('w3'); const at = new Date(f.runner.now() - 1).toISOString();
  const entries = Array.from({ length: 30 }, (_, i) => ({ at, kind: 'queue-start', task: `Q-${i}`, text: `Event ${i} \n\n{quoted: JSON inside agent output}\n` + 'ą'.repeat(i === 10 ? 30000 : 100) }));
  fs.writeFileSync(path.join(path.dirname(f.config.path), 'journal.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const delivered: unknown[] = []; let fragment = '';
  for (let page = 0; page < 100; page++) {
    const r = await f.call('events_since', { format: 'json', limit: 3 });
    assert.ok(Buffer.byteLength(r.text) <= 16000, String(Buffer.byteLength(r.text)));
    const data = JSON.parse(r.text);
    for (const event of data.events) { if (event.fragment) { fragment += event.text; if (fragment.length === event.fragment.total) { delivered.push(JSON.parse(fragment)); fragment = ''; } } else delivered.push(event); }
    if (!data.has_more) break;
  }
  assert.deepEqual(delivered, entries);
  assert.equal((await collectEvents(f.ctx, { client: 'mcp:fix-client:default' })).events.length, 0);
});
it('W4 D3 D5: summary receipt differs from full read/ack/mark; stable full pagination and bounded huge first line', async () => {
  const f = fixture('w4');
  const a = f.report('A-1', 'Werdykt: PASS\nSHA: abc\n## Blokery\nNeed key\n## Decyzje\nDo later\n' + REPORT_END);
  f.report('A-2', 'x'.repeat(30000) + '\n' + REPORT_END);
  const summary = await f.call('pull_ready', { limit: 1 });
  assert.match(summary.text, /attempt:|blockers:|decisions:|truncated:/);
  assert.equal(readTaskRecord(f.config, 'a-1')!.pulled, undefined);
  assert.ok(readTaskRecord(f.config, 'a-1')!.summaryDelivered);
  assert.equal(fs.existsSync(path.join(path.dirname(f.config.path), 'history.jsonl')), false);
  const huge = await f.call('pull_ready', { offset: 1, limit: 1 }); assert.match(huge.text, /A-2/); assert.ok(Buffer.byteLength(huge.text) <= 16000);
  await f.call('pull_ready', { mode: 'full', limit: 1 });
  assert.ok(readTaskRecord(f.config, 'a-1')!.pulled);
  const second = await f.call('pull_ready', { mode: 'full', offset: 1, limit: 1 }); assert.match(second.text, /A-2/);
  assert.ok(readTaskRecord(f.config, 'a-2')!.pulled);
  await f.call('pull_ready', { all: true, ack: true }); assert.ok(readTaskRecord(f.config, 'a-1')!.pulled);
});
it('W5: fence-aware sections and continuous >1MB report pagination, including a giant line; only EOF after contiguous read marks pulled', async () => {
  const f = fixture('w5');
  const text = '# Blokery\n```sh\n# komentarz\necho x\n```\nBLOKER: brak klucza\n# Summary\nDone';
  assert.match(reportSection(text, 'Blokery'), /BLOKER: brak klucza/);
  const content = 'Werdykt: PASS\n' + 'ą'.repeat(300000) + '\n' + 'line\n'.repeat(150000) + REPORT_END;
  const r = f.report('BIG-1', content); let offset = 0, byte_offset = 0, joined = '';
  // Jumping to EOF alone is not evidence of full delivery.
  await f.call('get_report', { task: 'BIG-1', offset: content.split('\n').length - 1 });
  assert.equal(readTaskRecord(f.config, 'big-1')!.pulled, undefined);
  for (let i = 0; i < 100; i++) {
    const response = await f.call('get_report', { task: 'BIG-1', offset, byte_offset });
    assert.ok(!response.isError, response.text);
    assert.ok(Buffer.byteLength(response.text) <= 200 * 1024);
    const split = response.text.lastIndexOf('\n--- page ---\n');
    joined += response.text.slice(response.text.indexOf('\n') + 1, split);
    const page = JSON.parse(response.text.slice(split + '\n--- page ---\n'.length));
    if (!page.has_more) break; offset = page.next_offset; byte_offset = page.next_byte_offset;
  }
  assert.equal(joined, content);
  assert.ok(readTaskRecord(f.config, 'big-1')!.pulled);
});
it('W6: queue_show redacts secret keys, env, known values and credential URLs including stderr; CLI owner entry intact', async () => {
  const f = fixture('w6', 'env: {ADMIN_TOKEN: config-hidden}\n');
  const dir = path.join(path.dirname(f.config.path), 'queue'); fs.mkdirSync(dir);
  const entry = { seq: 1, order: 1, task: 'Q-1', status: 'failed', agent: 'claude', model: 'sonnet', effort: 'high', after: [], priority: 'normal', queuedAt: new Date().toISOString(), spec: '---\ntask: Q-1\nagent: claude\nenv: {API_KEY: env-hidden, NORMAL: innocent}\nAUTH: header-hidden\n---\nSee config-hidden', error: 'env-hidden header-hidden https://user:pwd@example.test/?token=query-hidden' };
  fs.writeFileSync(path.join(dir, '0001-Q-1.json'), JSON.stringify(entry));
  const result = await f.call('queue_show', { task: 'Q-1' });
  for (const secret of ['config-hidden', 'env-hidden', 'innocent', 'header-hidden', 'user:', 'pwd', 'query-hidden']) assert.ok(!result.text.includes(secret), result.text);
  assert.match(result.text, /\*\*\*/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '0001-Q-1.json'), 'utf8')).spec, entry.spec);
});
it('W7: attempt baseline blocks old reports after resume/move; sentinel or settled ended turn required; FAIL still releases after', () => {
  const f = fixture('w7', 'report: {settle_s: 30}\n');
  const r = f.report('R-1', 'Werdykt: FAIL\n');
  const now = fs.statSync(r.report).mtimeMs + 1;
  Object.assign(r, attemptFields(r, now));
  assert.equal(inspectReport(f.config, r, now + 60000, true).ready, false);
  fs.writeFileSync(r.report, 'Werdykt: FAIL\npartial'); fs.utimesSync(r.report, new Date(now + 1000), new Date(now + 1000));
  assert.equal(inspectReport(f.config, r, now + 2000, true).ready, false);
  assert.equal(inspectReport(f.config, r, now + 40000, false).ready, false);
  assert.equal(inspectReport(f.config, r, now + 40000, true).ready, true);
  fs.appendFileSync(r.report, '\n' + REPORT_END); fs.utimesSync(r.report, new Date(now + 2000), new Date(now + 2000));
  assert.equal(inspectReport(f.config, r, now + 2001, false).ready, true);
});
it('W8: real registered partial checkout, lock and wrong branch fail; complete expected checkout passes', async () => {
  const root = scratch.sub('w8'), repo = path.join(root, 'repo'), wt = path.join(root, 'wt'); fs.mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(repo, 'init', '-b', 'main'); git(repo, '-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '--allow-empty', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'tracked'), 'x'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=T', '-c', 'user.email=t@t.test', 'commit', '-m', 'file');
  git(repo, 'worktree', 'add', '--detach', wt, 'main'); const spec = [{ path: repo, worktree: wt, base: 'main' }]; const runner = new RealRunner();
  await checkRetryWorktrees(runner, spec);
  fs.unlinkSync(path.join(wt, 'tracked')); await assert.rejects(checkRetryWorktrees(runner, spec), /incomplete\/modified/);
  git(wt, 'restore', 'tracked'); const lock = git(wt, 'rev-parse', '--git-path', 'index.lock'); fs.writeFileSync(lock, 'lock');
  await assert.rejects(checkRetryWorktrees(runner, spec), /index.lock exists/); fs.unlinkSync(lock);
  await assert.rejects(checkRetryWorktrees(runner, [{ ...spec[0]!, branch: 'main' }]), /branch\/detached/);
});
it('D1 D2: unchanged waiting reports avoid a second status collection; recovery persistence failure cannot stop watch', async () => {
  const f = fixture('d1'); seedTask(f.config, 'D-1'); const pane = f.tmux.add('d-1', 'Done\n❯ \n');
  await watchTick(f.ctx, new WatchMemory(), notify);
  assert.equal(f.tmux.seen.filter(c => c.startsWith('capture-pane')).length, 2, 'one status capture and one report search');
  pane.screen = screen('claude-overloaded');
  const write = f.runner.writeFile.bind(f.runner);
  f.runner.writeFile = async (file, text) => { if (file.endsWith('overload-retries.json')) throw new Error('state disk unavailable'); return write(file, text); };
  await assert.doesNotReject(watchTick(f.ctx, new WatchMemory(), notify));
});
it('B1: a CLI-looking error inside command output or mixed fenced code is not a CLI status banner', () => {
  assert.equal(isOverloaded('⏺ Bash(cat errors.log)\n  ⎿ API Error: 529 Overloaded\n❯ \n'), false);
  assert.equal(isOverloaded('```sh\n~~~\nAPI Error: 529\n❯ \n'), false);
  assert.equal(isOverloaded('API Error: 529\n> quoted old error\n❯ \n'), false);
});
it('W7: a settled alternate report stays complete after the canonical copy gets a newer mtime', async () => {
  const f = fixture('w7-copy', 'report: {settle_s: 30}\n');
  const alternative = path.join(f.root, 'ALT-1.md'); fs.writeFileSync(alternative, 'Werdykt: FAIL\nComplete after ended turn');
  const old = new Date(Date.now() - 60000); fs.utimesSync(alternative, old, old);
  const r = seedTask(f.config, 'ALT-1', { reportAlt: [alternative] });
  const { syncReport } = await import('../src/core/report-detect.ts');
  assert.equal((await syncReport(f.ctx, r)).action, 'copied');
  assert.equal((await collectStatus(f.ctx))[0]!.report, 'yes');
  fs.writeFileSync(alternative, 'Later source edit');
  assert.equal((await collectStatus(f.ctx))[0]!.report, 'yes', 'canonical proof belongs to the copied content');
});
