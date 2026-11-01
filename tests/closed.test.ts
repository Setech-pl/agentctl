import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { archiveClosed, parseAge } from '../src/core/archive.ts';
import { applySnapshot, closedRows, displayRows, handleKey, initialBoardState, listItems, loadBoard, ProgressCache } from '../src/core/board.ts';
import type { BoardState } from '../src/core/board.ts';
import { closeTask } from '../src/core/close.ts';
import { checkWindowLimit } from '../src/core/checks.ts';
import { Context } from '../src/core/context.ts';
import { pullReady } from '../src/core/pull.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { liveWindows } from '../src/core/plan.ts';
import { collectStatus, shownRows } from '../src/core/status.ts';
import { archiveDir, readTaskRecord, taskDir } from '../src/core/taskstore.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
const DAY = 86_400_000;

function setup(name: string, extraYaml = '') {
  const config = makeConfig(scratch.sub(name), extraYaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({ dryRun: false, respond: tmux.respond });
  const out: string[] = [];
  const ctx = new Context(runner, config, (l) => out.push(l));
  return { config, tmux, runner, ctx, out };
}

const WORKING = '● Reading src/menu.ts\n  esc to interrupt\n';

describe('close: the task is marked closed and leaves every list', () => {
  it('writes closed and closedAt, keeps TASK.md and the report, and the row turns into state "closed"', async () => {
    const { config, tmux, runner, ctx } = setup('c1');
    const record = seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, '# done\n');
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    await closeTask(ctx, 'NC-1');
    const after = readTaskRecord(config, 'nc-1');
    assert.equal(after?.closed, true);
    assert.equal(after?.closedAt, new Date(runner.now()).toISOString());
    assert.ok(fs.existsSync(record.report), 'the report stays');
    const rows = await collectStatus(ctx, { progress: false });
    const closed = rows.find((r) => r.task === 'NC-1')!;
    assert.deepEqual([closed.state, closed.closed, closed.hidden, closed.hiddenBy, closed.archived], ['closed', true, true, 'closed', false]);
    assert.equal(closed.closedAt, after?.closedAt);
    assert.deepEqual(shownRows(rows, false).map((r) => r.task), ['NC-2']);
    assert.deepEqual(shownRows(rows, true).map((r) => r.task), ['NC-1', 'NC-2']);
  });

  it('a closed task whose window is back (made by hand) follows its window: closed applies without one', async () => {
    const { config, tmux, ctx } = setup('c2');
    seedTask(config, 'NC-1', { closed: true, closedAt: '2026-11-01T10:00:00.000Z' });
    tmux.add('nc-1', WORKING);
    const [row] = await collectStatus(ctx, { progress: false });
    assert.equal(row?.state, 'working');
    assert.equal(row?.closed, false);
  });

  it('closing frees the provider limit', async () => {
    const { config, tmux, ctx } = setup('c3', 'limits:\n  claude: 2\n');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    assert.match(checkWindowLimit('claude', config.limits.claude, await liveWindows(ctx), config.session) ?? '', /limit for claude reached: 2 of 2/);
    await closeTask(ctx, 'NC-1');
    assert.equal(checkWindowLimit('claude', config.limits.claude, await liveWindows(ctx), config.session), undefined);
  });

  it('pull --ready never takes the report of a closed task', async () => {
    const { config, ctx, out } = setup('c4');
    const record = seedTask(config, 'NC-1', { closed: true });
    const open = seedTask(config, 'NC-2');
    for (const r of [record, open]) {
      fs.mkdirSync(path.dirname(r.report), { recursive: true });
      fs.writeFileSync(r.report, `# ${r.task}\n`);
    }
    const result = await pullReady(ctx, {}, 'darwin');
    assert.deepEqual(result.pulled.map((p) => p.task), ['NC-2']);
    assert.ok(!result.text.includes('# NC-1'));
    assert.ok(out.length > 0);
  });

  it('watch neither notifies nor logs for a task that was just closed (a closed task without a report is not a vanished window)', async () => {
    const { config, tmux, ctx } = setup('c5');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    const sent: string[] = [];
    const notifier = { notify: async (_t: string, m: string) => void sent.push(m) };
    const memory = new WatchMemory();
    await watchTick(ctx, memory, notifier);
    await closeTask(ctx, 'NC-1');
    tmux.windows = tmux.windows.filter((w) => !w.name.endsWith('nc-2')); // control: this one vanishes without close
    const events = await watchTick(ctx, memory, notifier);
    assert.deepEqual(events.map((e) => e.task), ['NC-2']);
    assert.deepEqual(sent, ['NC-2: okno zniknęło bez raportu']);
  });

  it('a closed task without a window does not make a task prefix ambiguous', async () => {
    const { config, tmux, ctx } = setup('c6');
    seedTask(config, 'ZOMBIE-A', { closed: true });
    seedTask(config, 'ZOMBIE-B');
    tmux.add('zombie-b', WORKING);
    const { resolveRunningTask } = await import('../src/core/resolve.ts');
    assert.equal((await resolveRunningTask(ctx, 'zombie')).task, 'ZOMBIE-B');
  });
});

describe('status --all and the closed section of the board', () => {
  it('status hides the closed task; --all lists it as (closed), also in --json', async () => {
    const { config, tmux, runner, ctx } = setup('s1');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    await closeTask(ctx, 'NC-1');
    const plain = await runCli(config, runner, ['status']);
    assert.match(plain.stdout, /NC-2/);
    assert.doesNotMatch(plain.stdout.split('\n').slice(0, -2).join('\n'), /NC-1/);
    assert.match(plain.stdout, /1 hidden task not shown: agentctl status --all/);
    const all = await runCli(config, runner, ['status', '--all']);
    assert.match(all.stdout, /NC-1 \(closed\)\s+claude\/opus\/high\s+closed/);
    const json = JSON.parse((await runCli(config, runner, ['status', '--json', '--all'])).stdout) as { task: string; closed: boolean }[];
    assert.deepEqual(json.map((r) => [r.task, r.closed]), [['NC-1', true], ['NC-2', false]]);
    assert.deepEqual((JSON.parse((await runCli(config, runner, ['status', '--json'])).stdout) as { task: string }[]).map((r) => r.task), ['NC-2']);
  });

  it('the board lists closed tasks only after a, in their own section, and offers only c on them', async () => {
    const { config, tmux, ctx } = setup('b1');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    await closeTask(ctx, 'NC-1');
    const snap = await loadBoard(ctx, null, new ProgressCache());
    let state: BoardState = applySnapshot(initialBoardState(100, 30), snap);
    assert.deepEqual(displayRows(state).map((r) => r.task), ['NC-2']);
    assert.deepEqual(listItems(state).map((i) => i.kind), ['row']);
    state = handleKey(state, 'a', {}).state;
    assert.deepEqual(closedRows(state).map((r) => r.task), ['NC-1']);
    assert.deepEqual(listItems(state).map((i) => i.kind), ['row', 'closed', 'row']);
    state = handleKey(state, 'j', {}).state;
    assert.equal(state.selected, 'NC-1');
    assert.equal(snap.preview?.task, 'NC-2');
    const enter = handleKey(state, '', { return: true });
    assert.equal(enter.state.mode.kind, 'finished');
    for (const key of ['x', 'h', 'm', 'i', 'M']) {
      const r = handleKey(state, key, {});
      assert.equal(r.state.notice?.level, 'error', key);
      assert.deepEqual(r.effects, [], key);
    }
    assert.deepEqual(handleKey(state, 'c', {}).effects, [{ type: 'pull', task: 'NC-1' }]);
  });
});

describe('archive', () => {
  it('parses ages', () => {
    assert.equal(parseAge('7d'), 7 * DAY);
    assert.equal(parseAge('12h'), 12 * 3_600_000);
    assert.equal(parseAge('2w'), 14 * DAY);
    assert.throws(() => parseAge('soon'), /cannot read the age/);
    assert.throws(() => parseAge('0d'), /cannot read the age/);
  });

  it('moves the state of closed tasks only, never of open ones or ones with a window', async () => {
    const { config, tmux, ctx } = setup('a1');
    seedTask(config, 'NC-1');
    seedTask(config, 'NC-2');
    seedTask(config, 'NC-3', { closed: true });
    tmux.add('nc-1', WORKING);
    tmux.add('nc-2', WORKING);
    await closeTask(ctx, 'NC-1');
    const result = await archiveClosed(ctx);
    assert.deepEqual(result.moved.map((m) => m.task).sort(), ['NC-1', 'NC-3']);
    assert.ok(!fs.existsSync(taskDir(config, 'nc-1')));
    assert.ok(fs.existsSync(path.join(archiveDir(config), 'nc-1', 'TASK.md')));
    assert.ok(fs.existsSync(taskDir(config, 'nc-2')), 'an open task stays');
    assert.equal(path.basename(archiveDir(config)), 'archive');
  });

  it('--older-than keeps recent ones; the age counts from closedAt', async () => {
    const { config, tmux, runner, ctx } = setup('a2');
    seedTask(config, 'NC-1');
    tmux.add('nc-1', WORKING);
    await closeTask(ctx, 'NC-1');
    await runner.sleep(3 * DAY);
    let r = await archiveClosed(ctx, { olderThanMs: parseAge('7d') });
    assert.deepEqual([r.moved.length, r.kept.map((k) => k.task)], [0, ['NC-1']]);
    await runner.sleep(5 * DAY);
    r = await archiveClosed(ctx, { olderThanMs: parseAge('7d') });
    assert.deepEqual(r.moved.map((m) => m.task), ['NC-1']);
  });

  it('keeps a task when the archive already has a folder of that name; a dry run only records the move', async () => {
    const { config, ctx } = setup('a3');
    seedTask(config, 'NC-1', { closed: true });
    fs.mkdirSync(path.join(archiveDir(config), 'nc-1'), { recursive: true });
    const clash = await archiveClosed(ctx);
    assert.match(clash.kept[0]?.reason ?? '', /already exists/);
    fs.rmSync(path.join(archiveDir(config), 'nc-1'), { recursive: true });
    const dry = new RecordingRunner();
    const dryCtx = new Context(dry, config, () => {});
    const planned = await archiveClosed(dryCtx);
    assert.equal(planned.moved.length, 1);
    assert.match(dry.commands[0] ?? '', /^mv .*state\/nc-1 .*archive\/nc-1$/);
    assert.ok(fs.existsSync(taskDir(config, 'nc-1')), 'nothing moved');
  });

  it('the CLI says what it moved', async () => {
    const { config, runner } = setup('a4');
    seedTask(config, 'NC-1', { closed: true });
    const r = await runCli(config, runner, ['archive']);
    assert.match(r.stdout, /NC-1: state moved to .*archive\/nc-1/);
    assert.match((await runCli(config, runner, ['archive'])).stdout, /No closed tasks to archive/);
    assert.equal((await runCli(config, runner, ['archive', '--older-than', 'later'])).code, 1);
  });

  it('a folder moved to the archive by hand (or by archive) is a closed task, not an orphan and not an error', async () => {
    const { config, tmux, runner, ctx } = setup('a5');
    const record = seedTask(config, 'OLD-1'); // never closed with agentctl: moved by hand
    fs.mkdirSync(path.dirname(record.report), { recursive: true });
    fs.writeFileSync(record.report, '# old\n');
    fs.mkdirSync(archiveDir(config), { recursive: true });
    fs.renameSync(taskDir(config, 'old-1'), path.join(archiveDir(config), 'old-1'));
    seedTask(config, 'NC-2');
    tmux.add('nc-2', WORKING);
    assert.deepEqual((await collectStatus(ctx, { progress: false })).map((r) => r.task), ['NC-2'], 'not in the normal listing');
    const rows = await collectStatus(ctx, { progress: false, archived: true });
    const old = rows.find((r) => r.task === 'OLD-1')!;
    assert.deepEqual([old.state, old.archived, old.closed, old.hidden, old.report], ['closed', true, true, true, 'yes']);
    assert.ok(!rows.some((r) => r.state === 'orphan'));
    const all = await runCli(config, runner, ['status', '--all']);
    assert.equal(all.code, 0, all.stderr);
    assert.match(all.stdout, /OLD-1 \(archived\)/);
    assert.doesNotMatch(all.stdout, /orphan/);
    assert.doesNotMatch((await runCli(config, runner, ['status'])).stdout, /OLD-1/);
  });

  it('a live window with the name of an archived task is not taken for the archived one', async () => {
    const { config, tmux, ctx } = setup('a6');
    seedTask(config, 'OLD-1');
    fs.mkdirSync(archiveDir(config), { recursive: true });
    fs.renameSync(taskDir(config, 'old-1'), path.join(archiveDir(config), 'old-1'));
    tmux.add('old-1', WORKING);
    const rows = await collectStatus(ctx, { progress: false, archived: true });
    assert.deepEqual(rows.map((r) => [r.task, r.state, r.archived]), [['OLD-1', 'orphan', false]]);
  });
});
