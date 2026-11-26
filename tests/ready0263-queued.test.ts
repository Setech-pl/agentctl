import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { inspectField } from '../src/core/input-field.ts';
import type { Notifier } from '../src/core/notify.ts';
import { deliverPendingPrompt, queuePrompt, QUEUED_IN_AGENT } from '../src/core/prompt-delivery.ts';
import { commitQueueAdd, planQueueAdd, queueTick, QueueMemory, readQueue } from '../src/core/queue.ts';
import { waitForReady } from '../src/core/ready.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { Tmux } from '../src/core/tmux.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';

/*
 * 0.26.3 hotfix (26.11, prod 0.26.1, dev 0.27.0, remote host pc): almost every Codex queue start failed with
 * "codex did not show its input prompt within 60s" although the saved start-failure screen shows a ready Codex 0.167.
 * Root cause: the structural composer reader required the footer model row "<model> <effort> · <dir>"; Codex now draws a
 * service tier after the effort ("GPT-6.2-Sol medium Fast · <dir>"), the composer was "unreadable" and readiness never matched.
 * The fixture is the production capture (start-failure-screen.txt, path anonymised). Only the public API of 0.26.2 is used,
 * so every scenario also runs against the release before the fix.
 */
const scratch = useScratch();
const FRAME = fs.readFileSync(new URL('./fixtures/screen-codex-0167-ready-fast.txt', import.meta.url), 'utf8');
const LOADING = '  >_ OpenAI Codex (v0.167.0)\n     ~/Projects/wt/demo-task-1\n  permissions: YOLO mode\n\n  Booting MCP server: playwright (0s • esc to interrupt)\n';
const T0 = Date.UTC(2026, 10, 26, 12);

// ---- busy-queued follow-ups (Codex ACTL-0261, Claude HEMS-2-INT-38) ----

const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BUSY = fx('screen-codex-0166-busy-paste.txt').replace('v0.166.0', 'v0.167.0').replace('› After this turn reply FOLLOWUP.', '› ');
const FOLLOWUP = 'Additional findings: re-run the smoke on the integration tip and add the result to your report.';

async function busyDelivery(name: string, extra: Record<string, unknown>) {
  const root = scratch.sub(name);
  const config = makeConfig(root, 'capacity: {snapshot: false, codex_refresh: false}\n');
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: BUSY };
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', windowId: '@1' });
  await queuePrompt(ctx, readTaskRecord(config, 't1')!, FOLLOWUP, 'pending', { kind: 'followup' });
  await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(runner.now()).toISOString(), delivery_field: 'image:x', delivery_enters: 1, ...extra });
  return { config, runner, ctx };
}

describe('READY0263-QUEUED: a follow-up sent to a busy agent is "queued – unconfirmed" past delivery_confirm_s, never needs-attention', () => {
  it('READY0263-QUEUED: the agent stays busy past delivery_confirm_s without hook/transcript → confirming, queued in agent', async () => {
    const { config, runner, ctx } = await busyDelivery('busy-long', {});
    await runner.sleep(61_000);
    assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming');
    const record = readTaskRecord(config, 't1')!;
    assert.equal(record.promptDelivery, 'confirming');
    assert.equal(record.deliveryResult, 'queued-in-agent');
    assert.match(record.promptError ?? '', new RegExp(QUEUED_IN_AGENT));
    assert.equal(record.pendingPrompt, FOLLOWUP);
  });

  it('READY0263-QUEUED: a busy delivery an older release left in "Prompt delivery not confirmed" goes back to queued – unconfirmed', async () => {
    const { config, runner, ctx } = await busyDelivery('busy-stuck', { prompt_delivery: 'needs-attention', prompt_error: 'Prompt delivery not confirmed: no acknowledgement (hook, transcript) before delivery_confirm_s elapsed. Inspect T1 with peek/attach; the prompt remains in TASK.md. agentctl will not silently retry or leave this as waiting.' });
    await runner.sleep(61_000);
    assert.equal(await deliverPendingPrompt(ctx, 't1'), 'confirming');
    assert.equal(readTaskRecord(config, 't1')!.promptDelivery, 'confirming');
  });
});
