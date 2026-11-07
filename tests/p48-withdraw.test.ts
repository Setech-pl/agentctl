import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { Context } from '../src/core/context.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { readJournal } from '../src/core/journal.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import type { McpDeps, McpToolDef } from '../src/core/mcp-tools.ts';
import { deliveryNote, queuePrompt } from '../src/core/prompt-delivery.ts';
import { enqueuePrompt, promptQueueView, queueFile, readPromptQueue, withdrawPrompt } from '../src/core/prompt-queue.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { FakeTmux, makeConfig, makeContext, runCli, seedTask, useScratch } from './helpers.ts';

/*
 * P48(b): a waiting prompt-queue entry can be withdrawn — CLI `send --withdraw` and MCP `send` with withdraw. A FIFO entry
 * leaves the queue; the active pending prompt leaves only before its delivery began; once the delivery began (the agent may
 * already work on it) the message is marked stale instead of disappearing.
 */
const scratch = useScratch();

function world(name: string, extraYaml = '') {
  const config = makeConfig(scratch.sub(name), extraYaml);
  const tmux = new FakeTmux();
  const { ctx, runner } = makeContext(config, { dryRun: false, respond: tmux.respond });
  return { config, tmux, ctx, runner };
}

describe('P48: withdrawing a waiting message', () => {
  it('a queued FIFO entry leaves the queue (CLI), with a note in TASK.md and the journal', async () => {
    const w = world('fifo');
    seedTask(w.config, 'W-1');
    w.tmux.add('w-1', 'Working (esc to interrupt)');
    await enqueuePrompt(w.ctx, 'w-1', 'first message');
    const second = await enqueuePrompt(w.ctx, 'w-1', 'second message');
    const r = await runCli(w.config, w.runner, ['send', '--withdraw', 'W-1', '--entry', second.id.slice(0, 8)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wycofano wiadomość z kolejki/);
    assert.deepEqual(readPromptQueue(w.ctx, 'w-1').map((p) => p.text), ['first message']);
    assert.match(fs.readFileSync(taskFile(w.config, 'w-1'), 'utf8'), /## Follow-up withdrawn/);
    assert.ok(readJournal(w.config).some((e) => e.kind === 'delivery' && e.task === 'W-1' && /wycofano wiadomość z kolejki/.test(e.text)));
    assert.equal(promptQueueView(w.ctx, 'w-1').length, 1);
  });

  it('the active pending prompt leaves before its delivery began; afterwards nothing waits', async () => {
    const w = world('active');
    const record = seedTask(w.config, 'W-2');
    await queuePrompt(w.ctx, record, 'Pending original prompt');
    const id = readTaskRecord(w.config, 'w-2')!.deliveryId!;
    assert.equal(promptQueueView(w.ctx, 'w-2').length, 1);
    const done = await withdrawPrompt(w.ctx, 'w-2', id.slice(0, 8));
    assert.equal(done.outcome, 'withdrawn');
    const after = readTaskRecord(w.config, 'w-2')!;
    assert.equal(after.pendingPrompt, undefined);
    assert.equal(after.promptDelivery, undefined);
    assert.deepEqual(promptQueueView(w.ctx, 'w-2'), []);
    assert.ok(readJournal(w.config).some((e) => e.kind === 'delivery' && /przed rozpoczęciem dostarczania/.test(e.text)));
  });

  it('once the delivery began the message is marked stale, never silently dropped', async () => {
    const w = world('stale');
    const record = seedTask(w.config, 'W-3');
    await queuePrompt(w.ctx, record, 'Message the agent may already work on');
    await setHeaderFields(w.runner, taskFile(w.config, 'w-3'), { delivery_started_at: new Date(w.runner.now()).toISOString(), prompt_delivery: 'confirming' });
    const done = await withdrawPrompt(w.ctx, 'w-3', readTaskRecord(w.config, 'w-3')!.deliveryId!);
    assert.equal(done.outcome, 'stale');
    const after = readTaskRecord(w.config, 'w-3')!;
    assert.equal(after.deliveryResult, 'stale');
    assert.equal(after.pendingPrompt, 'Message the agent may already work on', 'the message stays on record');
    assert.equal(promptQueueView(w.ctx, 'w-3')[0]?.state, 'stale');
    assert.match(deliveryNote(after) ?? '', /stale/);
    assert.ok(readJournal(w.config).some((e) => e.kind === 'delivery' && /stale/.test(e.text)));
  });

  it('an ambiguous prefix is refused, a delivered or unknown id is an error', async () => {
    const w = world('ambiguous');
    seedTask(w.config, 'W-4');
    fs.writeFileSync(queueFile(w.ctx, 'w-4'), JSON.stringify([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', text: 'one', queuedAt: new Date().toISOString() },
      { id: 'aaaaaaaa-1111-4000-8000-000000000002', text: 'two', queuedAt: new Date().toISOString() },
    ]));
    await assert.rejects(withdrawPrompt(w.ctx, 'w-4', 'aaaaaaaa'), /matches 2 queued messages/);
    await assert.rejects(withdrawPrompt(w.ctx, 'w-4', 'bbbbbbbb'), /no waiting message/);
    assert.equal(readPromptQueue(w.ctx, 'w-4').length, 2, 'nothing left the queue');
  });

  it('F1: a prefix shared by the active delivery and a FIFO entry is refused as ambiguous, nothing changes', async () => {
    const w = world('cross-ambiguous');
    const record = seedTask(w.config, 'W-8');
    await queuePrompt(w.ctx, record, 'Pending original prompt');
    const activeId = readTaskRecord(w.config, 'w-8')!.deliveryId!;
    const queued = { id: `${activeId.slice(0, 8)}ffff-4000-8000-000000000099`, text: 'queued follow-up', queuedAt: new Date().toISOString() };
    fs.writeFileSync(queueFile(w.ctx, 'w-8'), JSON.stringify([queued]));
    await assert.rejects(withdrawPrompt(w.ctx, 'w-8', activeId.slice(0, 8)), /being delivered and 1 queued message/);
    const after = readTaskRecord(w.config, 'w-8')!;
    assert.equal(after.pendingPrompt, 'Pending original prompt', 'the active delivery is untouched');
    assert.deepEqual(readPromptQueue(w.ctx, 'w-8').map((p) => p.id), [queued.id], 'the FIFO is untouched');
    // a longer prefix still withdraws the active one alone
    const done = await withdrawPrompt(w.ctx, 'w-8', activeId.slice(0, 9));
    assert.equal(done.outcome, 'withdrawn');
  });

  it('MCP send with withdraw (send in mcp.allow); without the permission nothing is done', async () => {
    const w = world('mcp', 'mcp: {allow: [send]}\n');
    seedTask(w.config, 'W-5');
    w.tmux.add('w-5', 'Working (esc to interrupt)');
    const item = await enqueuePrompt(w.ctx, 'w-5', 'queued via MCP');
    const deps: McpDeps = { context: (out) => new Context(w.runner, loadGlobalConfig(path.dirname(w.config.path)), out), notify: async () => undefined };
    const tool = MCP_TOOLS.find((t) => t.name === 'send') as McpToolDef;
    const call = (args: Record<string, unknown>) => tool.run(deps, z.object(tool.input).parse(args) as never) as Promise<{ text: string; isError?: boolean }>;
    const denied = await call({ task: 'W-5', withdraw: item.id.slice(0, 8) });
    assert.equal(denied.isError, undefined, denied.text);
    assert.match(denied.text, /wycofano/);
    assert.equal(readPromptQueue(w.ctx, 'w-5').length, 0);
    assert.ok(readJournal(w.config).some((e) => e.kind === 'mcp-write' && /withdraw/.test(e.text)));
    // without the send permission nothing happens
    const off = world('mcp-off');
    seedTask(off.config, 'W-6');
    off.tmux.add('w-6', 'Working (esc to interrupt)');
    const other = await enqueuePrompt(off.ctx, 'w-6', 'queued');
    const depsOff: McpDeps = { context: (out) => new Context(off.runner, loadGlobalConfig(path.dirname(off.config.path)), out), notify: async () => undefined };
    const nope = await tool.run(depsOff, z.object(tool.input).parse({ task: 'W-6', withdraw: other.id }) as never) as { text: string; isError?: boolean };
    assert.equal(nope.isError, true);
    assert.match(nope.text, /not in mcp\.allow/);
    assert.equal(readPromptQueue(off.ctx, 'w-6').length, 1);
  });

  it('CLI: --entry belongs to --withdraw; without --entry the only waiting message goes, several ask for --entry', async () => {
    const w = world('cli-only');
    seedTask(w.config, 'W-7');
    w.tmux.add('w-7', 'Working (esc to interrupt)');
    assert.equal((await runCli(w.config, w.runner, ['send', '--entry', 'abc'])).code, 1);
    const only = await enqueuePrompt(w.ctx, 'w-7', 'the only one');
    const r = await runCli(w.config, w.runner, ['send', '--withdraw', 'W-7']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(only.id.slice(0, 8)));
    await enqueuePrompt(w.ctx, 'w-7', 'one');
    await enqueuePrompt(w.ctx, 'w-7', 'two');
    const many = await runCli(w.config, w.runner, ['send', '--withdraw', 'W-7']);
    assert.equal(many.code, 1);
    assert.match(many.stderr, /2 messages wait|--entry/);
  });
});
