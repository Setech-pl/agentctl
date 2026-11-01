import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { closeTask } from '../src/core/close.ts';
import { Context } from '../src/core/context.ts';
import { DEFAULT_WINDOW_ICONS, decorateName, knownIcons, stripIcon } from '../src/core/icons.ts';
import { interruptTask } from '../src/core/interrupt.ts';
import { newTasks } from '../src/core/new.ts';
import { peekTask } from '../src/core/peek.ts';
import { pullTask } from '../src/core/pull.ts';
import { sendPrompts } from '../src/core/send.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord, taskFile } from '../src/core/taskstore.ts';
import { decorateWindows, restoreWindowNames, runWatch, watchTick, WatchMemory } from '../src/core/watch.ts';
import type { Notifier } from '../src/core/notify.ts';
import { DiskRunner, FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier: Notifier = { notify: async () => {} };

const IDLE = '● done\n❯ \n  ? for shortcuts\n';
const WORKING = '● reading\n  ⏵⏵ auto mode (shift+tab to cycle) · esc to interrupt\n';
const QUESTION = '? Tea or coffee?\n  Enter to select · Esc to cancel\n';
const TRUST = 'Quick safety check: do you trust this folder?\n❯ 1. Yes, I trust this folder';

describe('stripIcon and decorateName', () => {
  const icons = knownIcons(DEFAULT_WINDOW_ICONS);

  it('round-trips every default icon', () => {
    for (const icon of Object.values(DEFAULT_WINDOW_ICONS)) {
      assert.equal(stripIcon(decorateName('nc-42', icon), icons), 'nc-42', icon);
    }
    assert.equal(decorateName('nc-42', '⚙'), '⚙ nc-42');
  });

  it('leaves plain names alone, also ones with spaces and digits', () => {
    for (const name of ['nc-42', 'watch', 'board', 'my window', '42', 'a b c']) assert.equal(stripIcon(name, icons), name);
  });

  it('strips a configured icon of any shape, and a symbol-only prefix nobody configured', () => {
    assert.equal(stripIcon('[W] nc-1', ['[W]']), 'nc-1');
    assert.equal(stripIcon('RUN nc-1', ['RUN']), 'nc-1');
    assert.equal(stripIcon('🚀 nc-1', icons), 'nc-1');
    assert.equal(stripIcon('⚙ ', icons), '⚙ ', 'an icon without a name is not stripped to nothing');
  });

  it('knownIcons has the configured and the default icons once', () => {
    const set = knownIcons({ ...DEFAULT_WINDOW_ICONS, working: '▶' });
    assert.ok(set.includes('▶') && set.includes('⚙'));
    assert.equal(new Set(set).size, set.length);
    assert.deepEqual(knownIcons(null).sort(), [...new Set(Object.values(DEFAULT_WINDOW_ICONS))].sort());
  });
});

describe('watch.window_icons', () => {
  it('is on with the default icons, can be switched off, and replaces single states', () => {
    const root = scratch.sub('cfg');
    assert.deepEqual(makeConfig(root).watch.windowIcons, DEFAULT_WINDOW_ICONS);
    assert.equal(makeConfig(root, 'watch: {window_icons: false}\n').watch.windowIcons, null);
    assert.deepEqual(makeConfig(root, 'watch: {window_icons: true}\n').watch.windowIcons, DEFAULT_WINDOW_ICONS);
    const custom = makeConfig(root, 'watch:\n  window_icons:\n    working: "▶"\n    needs-input: "❓"\n').watch.windowIcons;
    assert.deepEqual(custom, { ...DEFAULT_WINDOW_ICONS, working: '▶', 'needs-input': '❓' });
  });

  it('rejects unknown states and empty icons', () => {
    const root = scratch.sub('cfg2');
    assert.throws(() => makeConfig(root, 'watch: {window_icons: {sleeping: "z"}}\n'), /unknown key "sleeping"/);
    assert.throws(() => makeConfig(root, 'watch: {window_icons: {working: ""}}\n'), /config\.watch\.window_icons\.working/);
    assert.throws(() => makeConfig(root, 'watch: {window_icons: 3}\n'), /true, false or a mapping/);
  });
});

describe('operations find a window that carries an icon', () => {
  function setup(name: string, windowName = '⚙ nc-1') {
    const config = makeConfig(scratch.sub(name));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    const w = tmux.add(windowName, IDLE);
    return { config, tmux, w, ...makeContext(config, { respond: tmux.respond }) };
  }

  it('send, interrupt, peek, pull (no report) and close target the window ID', async () => {
    const { ctx, runner, tmux, w } = setup('ops1');
    await sendPrompts(ctx, [{ task: 'NC-1', window: 'nc-1', prompt: 'more please' }]);
    await interruptTask(ctx, 'nc-1');
    assert.deepEqual((await peekTask(ctx, 'nc')).lines, ['● done']);
    await pullTask(ctx, 'nc-1');
    await closeTask(ctx, 'nc-1');
    const used = runner.commands.filter((c) => c.startsWith('tmux') && !c.includes('list-windows'));
    assert.equal(used.length, 5, used.join('\n'));
    assert.ok(used.every((c) => c.includes(` ${w.id}`) || c.includes('load-buffer')), used.join('\n'));
    const reads = runner.queries.filter((q) => q.includes('capture-pane'));
    assert.equal(reads.length, 2, 'peek and the pull fallback');
    assert.ok(reads.every((q) => q.includes(` ${w.id}`)), reads.join('\n'));
    assert.equal(tmux.windows.length, 0, 'the decorated window was closed');
    assert.ok(!runner.commands.some((c) => c.includes('=agentctl:nc-1')), 'no target by the plain name');
  });

  it('without window IDs (an older tmux listing) the current name is the target', async () => {
    const config = makeConfig(scratch.sub('ops2'));
    seedTask(config, 'NC-1');
    const tmux = new FakeTmux();
    tmux.add('✓ nc-1', IDLE);
    const { ctx, runner } = makeContext(config, {
      respond: (cmd, args, opts) => (args[0] === 'list-windows' ? { stdout: '✓ nc-1' } : args[0] === 'send-keys' && args.includes('=agentctl:✓ nc-1') ? {} : tmux.respond(cmd, args, opts)),
    });
    await interruptTask(ctx, 'nc-1');
    assert.ok(runner.commands.some((c) => c.startsWith("tmux send-keys -t '=agentctl:✓ nc-1' Escape")), runner.commands.join('\n'));
  });

  it('status sees the task as alive and reads its screen', async () => {
    const { ctx } = setup('ops3');
    const [row] = await collectStatus(ctx);
    assert.equal(row?.window, 'alive');
    assert.equal(row?.state, 'waiting');
    assert.equal(row?.windowName, 'nc-1');
    assert.equal(row?.windowId, '@1');
    assert.equal(row?.lastLine, '● done');
  });

  it('the recorded window ID wins while it still carries the task name; a reused ID does not', async () => {
    const config = makeConfig(scratch.sub('ops4'));
    seedTask(config, 'NC-1', { windowId: '@7' });
    const tmux = new FakeTmux();
    tmux.add('✗ nc-2', IDLE, '@3');
    tmux.add('⚙ nc-1', IDLE, '@7');
    const { ctx } = makeContext(config, { respond: tmux.respond });
    assert.equal(await ctx.tmux.targetFor('nc-1'), '@7');

    // tmux restarted: @7 now belongs to another task, nc-1 is @9
    tmux.windows = [];
    tmux.add('nc-2', IDLE, '@7');
    tmux.add('nc-1', IDLE, '@9');
    assert.equal(await ctx.tmux.targetFor('nc-1'), '@9');
    // not listed at all: the plain name, which tmux then reports as an unknown window
    tmux.windows = [];
    assert.equal(await ctx.tmux.targetFor('nc-1'), '=agentctl:nc-1');
  });

  it('new records the tmux window ID in TASK.md; operations on a not-yet-recorded task still work', async () => {
    const config = makeConfig(scratch.sub('ops5'));
    const tmux = new FakeTmux();
    const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
    const ctx = new Context(runner, config, () => {});
    fs.mkdirSync(`${scratch.dir}/app`, { recursive: true });
    const text = `---\ntask: NC-1\nagent: claude\nmodel: opus\nreport: ${config.cache}/nc-1/NC-1.md\nrepos:\n  - {path: ${scratch.dir}/app, worktree: ${scratch.dir}/app-nc-1, branch: nc-1}\n---\nGo.\n`;
    const spec = resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined });
    await newTasks(ctx, [spec], {});
    const record = readTaskRecord(config, 'nc-1');
    assert.equal(record?.windowId, '@1');
    assert.match(fs.readFileSync(taskFile(config, 'nc-1'), 'utf8'), /window_id: "?@1"?/);
    assert.equal(record?.task, 'NC-1');
  });
});

describe('decorating window names', () => {
  function setup(name: string, extra = '') {
    const config = makeConfig(scratch.sub(name), extra);
    const tmux = new FakeTmux();
    for (const t of ['NC-1', 'NC-2', 'NC-3', 'NC-4']) seedTask(config, t);
    const screens = { 'nc-1': WORKING, 'nc-2': IDLE, 'nc-3': QUESTION, 'nc-4': TRUST };
    for (const [w, screen] of Object.entries(screens)) tmux.add(w, screen);
    tmux.add('stray', IDLE);
    tmux.add('watch', '');
    tmux.add('board', '');
    return { config, tmux, memory: new WatchMemory(), ...makeContext(config, { respond: tmux.respond }) };
  }

  const names = (tmux: FakeTmux): string[] => tmux.windows.map((w) => w.name);

  it('puts the state icon in front of each task window and leaves watch and board alone', async () => {
    const { ctx, tmux, memory } = setup('dec1');
    const renamed = await decorateWindows(ctx, memory, await collectStatus(ctx, { progress: false }));
    assert.deepEqual(renamed.sort(), ['NC-1', 'NC-2', 'NC-3', 'NC-4', 'STRAY']);
    assert.deepEqual(names(tmux), ['⚙ nc-1', '⏸ nc-2', '? nc-3', '🔒 nc-4', '✗ stray', 'watch', 'board']);
  });

  it('renames only when the state changed, and uses the new icon then', async () => {
    const { ctx, tmux, memory, runner } = setup('dec2');
    await watchTick(ctx, memory, notifier);
    const renames = (): number => runner.commands.filter((c) => c.includes('rename-window')).length;
    assert.equal(renames(), 5);
    await watchTick(ctx, memory, notifier);
    assert.equal(renames(), 5, 'the second tick finds the names right and renames nothing');
    tmux.windows.find((w) => w.id === '@1')!.screen = IDLE;
    await watchTick(ctx, memory, notifier);
    assert.equal(renames(), 6);
    assert.equal(tmux.windows[0]?.name, '⏸ nc-1');
    // a finished task: the report is there
    fs.mkdirSync(`${ctx.config.cache}/nc-1`, { recursive: true });
    fs.writeFileSync(`${ctx.config.cache}/nc-1/NC-1.md`, 'report');
    await watchTick(ctx, memory, notifier);
    assert.equal(tmux.windows[0]?.name, '✓ nc-1');
  });

  it('uses the configured icons', async () => {
    const { ctx, tmux, memory } = setup('dec3', 'watch:\n  window_icons:\n    working: "RUN"\n    needs-trust: "TRUST"\n');
    await decorateWindows(ctx, memory, await collectStatus(ctx, { progress: false }));
    assert.deepEqual(names(tmux).slice(0, 4), ['RUN nc-1', '⏸ nc-2', '? nc-3', 'TRUST nc-4']);
    // another config later: the old symbol in front of the name is recognised and replaced, not stacked
    const next = makeContext(makeConfig(scratch.sub('dec3b')), { respond: tmux.respond });
    for (const t of ['NC-1', 'NC-2', 'NC-3', 'NC-4']) seedTask(next.ctx.config, t);
    tmux.windows[0]!.name = '▶ nc-1';
    await decorateWindows(next.ctx, new WatchMemory(), await collectStatus(next.ctx, { progress: false }));
    assert.equal(names(tmux)[0], '⚙ nc-1');
  });

  it('window_icons: false never renames', async () => {
    const { ctx, tmux, memory, runner } = setup('dec4', 'watch: {window_icons: false}\n');
    await watchTick(ctx, memory, notifier);
    assert.ok(!runner.commands.some((c) => c.includes('rename-window')));
    assert.deepEqual(names(tmux).slice(0, 2), ['nc-1', 'nc-2']);
  });

  it('stopping the watcher gives the plain names back, also after an abort', async () => {
    const { ctx, tmux } = setup('dec5');
    await runWatch(ctx, notifier, { maxTicks: 1 });
    assert.deepEqual(names(tmux), ['nc-1', 'nc-2', 'nc-3', 'nc-4', 'stray', 'watch', 'board']);

    // Ctrl-C (or SIGTERM from a killed window) arrives during the pause between two ticks.
    const controller = new AbortController();
    const second = setup('dec5b');
    class AbortingRunner extends DiskRunner {
      override async sleep(): Promise<void> {
        controller.abort();
      }
    }
    const ctx2 = new Context(new AbortingRunner({ dryRun: false, respond: second.tmux.respond }), second.config, () => {});
    await runWatch(ctx2, notifier, { signal: controller.signal });
    assert.deepEqual(names(second.tmux), ['nc-1', 'nc-2', 'nc-3', 'nc-4', 'stray', 'watch', 'board']);
  });

  it('restoring only touches windows this watcher renamed', async () => {
    const { ctx, tmux, memory } = setup('dec6');
    tmux.windows.find((w) => w.name === 'nc-2')!.name = '⏸ nc-2'; // already right: not the watcher's doing
    await decorateWindows(ctx, memory, await collectStatus(ctx, { progress: false }));
    assert.equal(await restoreWindowNames(ctx, memory), 4);
    assert.deepEqual(names(tmux), ['nc-1', '⏸ nc-2', 'nc-3', 'nc-4', 'stray', 'watch', 'board']);
    assert.equal(await restoreWindowNames(ctx, memory), 0, 'nothing left to restore');
  });
});
