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

// ---- queue starts (watcher) ----

const YAML = 'providers: [claude, codex]\nlimits: {claude: 2, codex: 2}\ncapacity: {snapshot: false, codex_refresh: false}\n';
/** An idle Codex 0.166 frame (recognised by 0.26.2 too): the retry and the load scaling are proven independently of the composer fix. */
const READY_0166 = FRAME.replace('medium Fast', 'medium');

function queueSetup(name: string, readyAfterMs: number | undefined) {
  const root = scratch.sub(name);
  const repo = scratch.sub(`${name}/app`);
  const config = makeConfig(root, YAML);
  const tmux = new FakeTmux();
  tmux.newWindowScreen = LOADING;
  const runner: DiskRunner = new DiskRunner({ dryRun: false, startTime: T0, respond: (cmd, args, opts) => {
    if (cmd === 'tmux' && args[0] === 'capture-pane' && readyAfterMs !== undefined && runner.now() >= T0 + readyAfterMs) {
      for (const w of tmux.windows) if (w.screen === LOADING) w.screen = READY_0166;
    }
    return tmux.respond(cmd, args, opts);
  } });
  const ctx = new Context(runner, config, () => {});
  const notifier: Notifier = { clickable: false, notify: async () => {} };
  const memory = new QueueMemory();
  return {
    config, repo, tmux, runner, ctx,
    async add(task: string) {
      const plan = await planQueueAdd(ctx, splitSpecs(`---\ntask: ${task}\nagent: codex\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-${task.toLowerCase()}\n---\nPrompt of ${task}.\n`, 'test'));
      await commitQueueAdd(ctx, plan.items);
    },
    async tick() { const began = await queueTick(ctx, memory, notifier, {}); await memory.idle(); return began; },
    pastes: () => runner.commands.filter(c => c.includes('paste-buffer')).length,
  };
}

describe('READY0263-RETRY: a readiness timeout of a queued start is transient: one more wait in the same window', () => {
  it('READY0263-RETRY: the agent becomes ready after the first 60 s window → the prompt is delivered, no needs-attention', async () => {
    const s = queueSetup('retry-ok', 90_000);
    await s.add('RETRY-1');
    assert.deepEqual(await s.tick(), ['RETRY-1']);
    const record = readTaskRecord(s.config, 'retry-1')!;
    assert.notEqual(record.promptDelivery, 'needs-attention', record.promptError ?? '');
    assert.doesNotMatch(record.promptError ?? '', /did not become ready/);
    assert.equal(s.pastes(), 1, 'the original prompt was pasted once');
    assert.notEqual(readQueue(s.config)[0]?.status, 'failed');
    assert.equal(s.tmux.windows.filter(w => w.name === 'retry-1').length, 1, 'the same window, not a second one');
  });

  it('READY0263-RETRY: a second timeout is a failed start: needs-attention with the screen, nothing pasted', async () => {
    const s = queueSetup('retry-fail', undefined);
    await s.add('RETRY-2');
    await s.tick();
    const record = readTaskRecord(s.config, 'retry-2')!;
    assert.equal(record.promptDelivery, 'needs-attention');
    assert.match(readQueue(s.config)[0]?.error ?? '', /did not show its input prompt within 60s \(twice\)/);
    assert.equal(s.pastes(), 0);
    assert.ok(s.runner.now() - T0 >= 120_000, 'two full windows were waited');
  });

  it('READY0263-RETRY: a task left in needs-attention by "did not become ready" is re-armed once its window shows the ready frame', async () => {
    const s = queueSetup('recover', undefined);
    await s.add('RETRY-4');
    await s.tick();
    assert.equal(readTaskRecord(s.config, 'retry-4')!.promptDelivery, 'needs-attention');
    for (const w of s.tmux.windows) if (w.name === 'retry-4') w.screen = FRAME;
    assert.equal(await deliverPendingPrompt(s.ctx, 'retry-4'), 'pending', 'watch re-arms the never-pasted initial prompt');
  });
});

