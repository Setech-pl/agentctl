import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { classifyScreen } from '../src/core/state.ts';
import { deliveryEvidence, deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { collectStatus } from '../src/core/status.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { readJournal } from '../src/core/journal.ts';
import { cohortTick, touchCohort } from '../src/core/cohort.ts';
import { hasReport, unmetAfter } from '../src/core/depends.ts';
import { readQueue } from '../src/core/queue.ts';
import { sendPrompts } from '../src/core/send.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
const working = fs.readFileSync(new URL('./fixtures/delivery/claude-2.1.311-working.txt', import.meta.url), 'utf8');
function fixture(name: string, agent: 'claude' | 'codex' = 'claude', extra = '') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\ncohort: {done_grace_s: 0}\nmcp: {allow: [new, send, queue]}\n${extra}`);
  const tmux = new FakeTmux(), runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args, opts) => {
    if (cmd === 'tmux' && args[0] === 'capture-pane') { const target = args[args.indexOf('-t') + 1] ?? ''; const pane = tmux.windows.find(w => w.id === target || target.endsWith(':' + w.name)); return pane ? { stdout: pane.screen } : { code: 1 }; }
    return tmux.respond(cmd, args, opts);
  } });
  const pane = tmux.add('t1', agent === 'claude' ? '❯ Try "fake"\n' : '› Ask Codex to do anything\n');
  const ctx = new Context(runner, config, () => {}), notified: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notified.push(text); } };
  seedTask(config, 'T1', { agent, cohort: 'P', windowId: pane.id });
  const record = () => readTaskRecord(config, 't1')!;
  const deps = { context: () => ctx, notify: async () => {} };
  const call = (tool: string, args: Record<string, unknown> = {}) => MCP_TOOLS.find(t => t.name === tool)!.run(deps, args as never);
  return { root, config, tmux, runner, pane, ctx, notified, notifier, record, call };
}
it('0173-P1: exact Claude Code 2.1.311 haiku/low screen and all spinner glyphs acknowledge working, footer alone does not', () => {
  for (const glyph of ['✶','✻','✽','✢','·','*']) assert.equal(classifyScreen(working.replace('✶', glyph), DEFAULT_AGENT_SETTINGS.claude), 'working');
  for (const text of ['○ low · /effort\npaste again to expand\n❯ ', '* Transmogrifying… is an example in prose', 'tokens thinking (5s ·)']) assert.equal(classifyScreen(text, DEFAULT_AGENT_SETTINGS.claude), 'idle');
  assert.equal(classifyScreen(working, { ...DEFAULT_AGENT_SETTINGS.claude, workingPattern: 'custom busy' }), 'idle');
});
for (const agent of ['claude','codex'] as const) it(`0173-P1/P4 ${agent}: hook/notify is preferred to an unreadable screen; stale generation cannot confirm send`, async () => {
  const f = fixture(`hook-${agent}`, agent); await queuePrompt(f.ctx, f.record(), 'Original prompt\nSecond line');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(f.runner.now()).toISOString() });
  const event = agent === 'claude' ? { task: 'T1', agent, kind: 'user-prompt-submit' as const, payload: { prompt: 'Original prompt\rSecond line' } } : { task: 'T1', agent, payload: { type: 'agent-turn-complete', 'last-assistant-message': 'Done', 'input-messages': ['Original prompt\nSecond line'] } };
  await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), event);
  assert.equal(deliveryEvidence(f.ctx, f.record(), ''), true);
  assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'sent');
  await queuePrompt(f.ctx, f.record(), 'Different follow-up');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(f.runner.now()).toISOString() });
  assert.equal(deliveryEvidence(f.ctx, f.record(), ''), false);
  if (agent === 'claude') { await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), event); assert.equal(deliveryEvidence(f.ctx, f.record(), ''), false); }
});
for (const kind of ['stop','notification'] as const) it(`0173-P1 Claude ${kind}: completion/idle hook without submission cannot acknowledge delivery`, async () => {
  const f = fixture(kind); await queuePrompt(f.ctx, f.record(), 'Original prompt');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(f.runner.now()).toISOString() });
  await handleEvent(f.ctx, new Alerts(f.ctx, f.notifier), { task: 'T1', agent: 'claude', kind, payload: { notification_type: 'idle_prompt' } });
  assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
});
it('0173-P2: later canonical PASS report beats needs-attention and reaches events, pull_ready, after and cohort-done', async () => {
  const f = fixture('late-report'); await touchCohort(f.ctx, 'P');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'needs-attention', prompt_error: 'old delivery error' });
  const memory = new WatchMemory(); await watchTick(f.ctx, memory, f.notifier);
  assert.equal((await collectStatus(f.ctx))[0]!.state, 'needs-attention');
  fs.mkdirSync(path.dirname(f.record().report), { recursive: true }); fs.writeFileSync(f.record().report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  f.pane.screen = working; // the final spinner may remain painted after the report is complete
  const row = (await collectStatus(f.ctx))[0]!; assert.equal(row.state, 'report-ready'); assert.equal(hasReport(row), true); assert.deepEqual(unmetAfter(['T1'], [row]), []);
  await watchTick(f.ctx, memory, f.notifier);
  assert.equal(f.record().promptDelivery, 'sent'); assert.equal(f.record().promptError, undefined); assert.equal((await collectStatus(f.ctx))[0]!.state, 'report-ready');
  assert.ok(readJournal(f.config).some(e => e.kind === 'report-ready'));
  assert.ok((await f.call('events_since')).text.includes('T1'));
  assert.ok((await f.call('pull_ready')).text.includes('Werdykt: PASS'));
  // cohortTick was already run by watch; its journal carries the completion.
  await cohortTick(f.ctx, f.notifier, await collectStatus(f.ctx));
  assert.ok(readJournal(f.config).some(e => e.kind === 'cohort-done'));
});
for (const agent of ['claude','codex'] as const) it(`0173-P3/P4 ${agent}: send succeeds with warning, watch deadline notifies once, later work clears attention without another paste`, async () => {
  const f = fixture(`send-${agent}`, agent), memory = new WatchMemory();
  // FakeTmux keeps the input idle: no hook, echo or working acknowledgement.
  const [sent] = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'Original prompt' }]);
  assert.match(sent!.warning!, /dostarczenie niepotwierdzone – sprawdzam/);
  assert.equal(f.record().promptDelivery, 'confirming');
  await watchTick(f.ctx, memory, f.notifier); assert.equal(f.record().promptDelivery, 'confirming');
  await f.runner.sleep(60000); await watchTick(f.ctx, memory, f.notifier);
  assert.equal(f.record().promptDelivery, 'needs-attention');
  assert.equal(f.notified.filter(t => t.includes('Prompt delivery')).length, 1);
  await watchTick(f.ctx, memory, f.notifier); assert.equal(f.notified.filter(t => t.includes('Prompt delivery')).length, 1);
  f.pane.screen = agent === 'claude' ? working : 'Working (esc to interrupt)\n';
  assert.equal((await collectStatus(f.ctx))[0]!.state, 'working');
  await watchTick(f.ctx, memory, f.notifier); assert.equal(f.record().promptDelivery, 'sent');
  assert.equal(f.runner.commands.filter(c => c.includes('paste-buffer')).length, 1);
});
it('0173-P3: watch restart at the deadline still emits one attention notification and journal event', async () => {
  const f = fixture('restart'); await queuePrompt(f.ctx, f.record(), 'Original prompt');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_started_at: new Date(f.runner.now() - 60001).toISOString() });
  await watchTick(f.ctx, new WatchMemory(), f.notifier); await watchTick(f.ctx, new WatchMemory(), f.notifier);
  assert.equal(f.notified.filter(t => t.includes('Prompt delivery')).length, 1);
  assert.equal(readJournal(f.config).filter(e => e.kind === 'needs-attention').length, 1);
});
for (const agent of ['claude','codex'] as const) it(`0173-P1/P4 ${agent}: transcript echo acknowledges submitted text, composer draft does not`, async () => {
  const f = fixture(`echo-${agent}`, agent); await queuePrompt(f.ctx, f.record(), 'Original prompt');
  await setHeaderFields(f.runner, taskFile(f.config, 't1'), { delivery_started_at: new Date(f.runner.now()).toISOString() });
  const marker = agent === 'claude' ? '❯' : '›';
  assert.equal(deliveryEvidence(f.ctx, f.record(), `${marker} Original prompt\n`), false);
  assert.equal(deliveryEvidence(f.ctx, f.record(), `${marker} Original prompt\n\n${marker} \n`), true);
});
for (const tool of ['new','queue'] as const) it(`0173-P3 ${tool}: uncertain delivery is successful, never an MCP error or failed queue entry`, async () => {
  const f = fixture(`mcp-${tool}`), repo = path.join(f.root, 'repo'); fs.mkdirSync(repo);
  f.tmux.windows.length = 0;
  const spec = `---\ntask: T2\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nOriginal prompt\n`;
  const preview = await f.call(tool, { spec }); assert.ok(!preview.isError, preview.text);
  const result = await f.call(tool, { spec, confirm: true }); assert.ok(!result.isError, result.text);
  if (tool === 'new') { assert.match(result.text, /Started: T2/); assert.match(result.text, /dostarczenie niepotwierdzone/); assert.equal(readTaskRecord(f.config, 't2')!.promptDelivery, 'confirming'); }
  else { const memory = new WatchMemory(); await watchTick(f.ctx, memory, f.notifier); await memory.queue.idle(); assert.equal(readTaskRecord(f.config, 't2')!.promptDelivery, 'confirming'); assert.deepEqual(readQueue(f.config), []); assert.ok(readJournal(f.config).some(e => e.kind === 'queue-start' && e.task === 'T2')); }
});

it('0173-P3: an old canonical report and unchanged assistant output cannot acknowledge a new send', async () => {
  const f = fixture('old-evidence');
  fs.mkdirSync(path.dirname(f.record().report), { recursive: true }); fs.writeFileSync(f.record().report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
  f.pane.screen = '⏺ Previous answer\n❯ Try "fake"\n';
  await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'Different follow-up' }]);
  assert.equal(f.record().promptDelivery, 'confirming');
  assert.equal(deliveryEvidence(f.ctx, f.record(), f.pane.screen), false);
  await f.runner.sleep(60000); await watchTick(f.ctx, new WatchMemory(), f.notifier);
  assert.equal((await collectStatus(f.ctx))[0]!.state, 'needs-attention');
});
it('0173-P3: delivery_confirm_s defaults to 60, supports overrides and rejects invalid deadlines', () => {
  assert.equal(makeConfig(scratch.sub('config-default')).deliveryConfirmS, 60);
  assert.equal(makeConfig(scratch.sub('config-custom'), 'delivery_confirm_s: 7\nagents: {claude: {delivery_pattern: custom_ack, working_pattern: custom_work}}\n').agents.claude.deliveryPattern, 'custom_ack');
  for (const value of ['0','-1','invalid']) assert.throws(() => makeConfig(scratch.sub('config-' + value), `delivery_confirm_s: ${value}\n`), /delivery_confirm_s/);
});
