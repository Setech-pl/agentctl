import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { inspectField, pasteImage, areaKey } from '../src/core/input-field.ts';
import { withoutDimInput } from '../src/core/tmux.ts';
import { waitForReady } from '../src/core/ready.ts';
import type { Runner } from '../src/core/runner.ts';
import type { Tmux } from '../src/core/tmux.ts';
const fixture = (name: string) => {
  const read = (suffix: string) => fs.readFileSync(new URL(`./fixtures/screen-${name}${suffix}.txt`, import.meta.url), 'utf8');
  return withoutDimInput(read(''), read('-ansi'));
};
for (const agent of ['codex-0166', 'claude-fix5']) for (const state of ['fresh', 'short', 'busy-paste', ...(agent === 'codex-0166' ? ['long'] : [])]) {
  it(`FIX5 real ${agent} ${state} has bounded composer`, () => {
    const field = inspectField(fixture(`${agent}-${state}`));
    assert.equal(field.readable, true, field.reason ?? 'readable');
    if (state === 'short') assert.equal(pasteImage(field.area, 'Reply only OK', agent === 'codex-0166' ? 'codex' : 'claude'), true);
    if (state === 'long') assert.equal(pasteImage(field.area, 'collapsed source', 'codex'), true);
    if (field.area.length) assert.notEqual(areaKey(field.area), areaKey([...field.area, '  changed foreign text']));
  });
}
it('FIX5 compact startup accepts its entire bottom field and rejects foreign structures', () => {
  const screen = '\n  >_ OpenAI Codex (v0.166.0)\n     ~/project\n  permissions: YOLO mode\n\n› [Pasted Content 2103 chars]\n\n';
  assert.equal(inspectField(screen).readable, true);
  assert.equal(inspectField(screen.replace('› ', 'Select an option\n› ')).readable, false);
  assert.equal(inspectField('› [Pasted Content 2103 chars]\n').readable, false);
});
it('FIX5 startup waits through a half initialized screen', async () => {
  let now = 0;
  const runner = { dryRun: false, now: () => now, sleep: async (ms: number) => { now += ms; } } as Runner;
  let captures = 0;
  const tmux = { capture: async () => ({ code: 0, stdout: ++captures === 1 ? fixture('codex-0166-initializing') : fixture('codex-0166-fresh') }) } as unknown as Tmux;
  const result = await waitForReady(runner, tmux, 'test', { pattern: '›', structuralComposer: true, timeoutMs: 1000, intervalMs: 10 });
  assert.equal(captures, 2);
  assert.equal(result.ready, true);
  const unknown = { capture: async () => ({ code: 0, stdout: '› ' }) } as unknown as Tmux;
  assert.equal((await waitForReady(runner, unknown, 'test', { pattern: '›', structuralComposer: true, timeoutMs: 20, intervalMs: 10 })).ready, false);
});

import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, seedTask, useScratch, acknowledgingRespond } from './helpers.ts';
import { queuePrompt, deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
const scratch = useScratch();
for (const agent of ['codex', 'claude'] as const) it(`FIX5 ${agent} initial prompt submits on real fixture`, async () => {
  const name = agent === 'codex' ? 'codex-0166' : 'claude-fix5';
  let pasted = false, enters = 0;
  const runner = new DiskRunner({ dryRun: false, respond: acknowledgingRespond((cmd, args) => {
    if (cmd !== 'tmux') return undefined;
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'paste-buffer') pasted = true;
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') enters++;
    if (args[0] === 'capture-pane') return { stdout: fixture(`${name}-${pasted ? 'short' : 'fresh'}`) };
    return {};
  }) });
  const config = makeConfig(scratch.sub(agent));
  const ctx = new Context(runner, config, () => {});
  const record = seedTask(config, 'T1', { agent, windowId: '@1' });
  await queuePrompt(ctx, record, 'Reply only OK');
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'sent');
  assert.equal(enters, 1);
});
it('FIX5 initial unknown structure causes no paste and no Enter', async () => {
  const config = makeConfig(scratch.sub('unknown'));
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => cmd === 'tmux' ? { stdout: args[0] === 'capture-pane' ? '❯ \n' : '@1\tt1\ttask' } : undefined });
  const ctx = new Context(runner, config, () => {});
  await queuePrompt(ctx, seedTask(config, 'T1', { windowId: '@1' }), 'Original task');
  assert.equal(await deliverPendingPrompt(ctx, 't1'), 'needs-attention');
  assert.equal(runner.commands.some(line => /paste-buffer|send-keys.*Enter/.test(line)), false);
});
