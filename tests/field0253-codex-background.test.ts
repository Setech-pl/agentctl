import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerFixture } from './composer-fixture.ts';
import { world } from './hotfix-0194-fixture.ts';
import { drainPromptQueue, readPromptQueue } from '../src/core/prompt-queue.ts';
import { seedTask } from './helpers.ts';

for (const separateBadge of [false, true]) test(`FIELD0253-BACKGROUND: queued Codex send passes a stable empty background composer (separate badge: ${separateBadge})`, async () => {
  const w = world(`codex-background-send-${separateBadge}`);
  const record = seedTask(w.config, 'BACKGROUND', {agent: 'codex'});
  const screen = (prompt = 'Ask Codex to do anything', working = '') => {
    const composer = composerFixture(`${working}› ${prompt}\n`);
    return separateBadge ? `${composer.trimEnd()}\n  2 background terminals running\n`
      : composer.replace(/( · [^\n]+)(?=\n)/, '$1 · 2 background terminals running');
  };
  const pane = w.tmux.add(record.window, screen(undefined, '• Working (esc to interrupt)\n'));
  const preview = await w.call('send', {task: record.task, text: 'Finish the queued work.'});
  const token = /preview_token: (\S+)/.exec(preview.text)?.[1];
  assert.ok(token, preview.text);
  const accepted = await w.call('send', {confirm: true, preview_token: token});
  assert.ok(!accepted.isError, accepted.text);
  assert.equal(readPromptQueue(w.ctx, record.window)[0]?.waitForTurnEnd, true);
  const pastes = () => w.tmux.seen.filter(cmd => cmd.startsWith('paste-buffer')).length;
  const enters = () => w.tmux.seen.filter(cmd => cmd.startsWith('send-keys')).length;

  pane.screen = screen('Human draft');
  await drainPromptQueue(w.ctx, record.window, 'background');
  assert.equal(pastes(), 0, 'a background badge does not make a draft safe to overwrite');
  pane.screen = screen();
  await drainPromptQueue(w.ctx, record.window, 'background');
  assert.equal(pastes(), 0, 'one redraw is insufficient');
  pane.screen = screen(undefined, '• Working (esc to interrupt)\n');
  await drainPromptQueue(w.ctx, record.window, 'working');
  assert.equal(pastes(), 0);
  pane.screen = screen();
  await drainPromptQueue(w.ctx, record.window, 'background');
  assert.equal(pastes(), 0, 'renewed foreground work resets idle confirmation');
  for (let tick = 1; tick < w.config.watch.idleConfirmTicks; tick++) await drainPromptQueue(w.ctx, record.window, 'background');
  assert.equal(pastes(), 1);
  assert.equal(enters(), 1);
  assert.deepEqual(readPromptQueue(w.ctx, record.window), []);
});
