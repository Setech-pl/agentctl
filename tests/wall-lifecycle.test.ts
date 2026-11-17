import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { collectEvents, renderEvents } from '../src/core/chat-events.ts';
import { readJournal } from '../src/core/journal.ts';
import { handleKey, initialBoardState } from '../src/core/board.ts';
import { wallMessages, wallView } from '../src/core/board-wall.ts';
import { channelFile, channelMessages, findMessage, loadWallBoard, maintainWall, markRead, postMessage, readThread, readWall, setStatus, wallDir, wallIdentity, OWNER_IDENTITY } from '../src/core/wall.ts';
import type { WallKind } from '../src/core/wall.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const day = 86400000;
function world(name: string, yaml = '') {
  const config = makeConfig(scratch.sub(name), yaml);
  const runner = new DiskRunner({ dryRun: false, startTime: Date.UTC(2026, 10, 1) });
  const ctx = new Context(runner, config, () => {});
  const nc = wallIdentity(config, { as: 'chat:nc' });
  const post = (kind: WallKind = 'question', subject = 'Lifecycle', to = 'chat:hems') => postMessage(ctx, nc, { channel: 'shared:sim', kind, subject, body: 'original body', to });
  return { config, runner, ctx, nc, post };
}

describe('WALL lifecycle (fake clock, no inference/network)', () => {
  it('archives closed records by month, keeps status history and ids, survives duplicate move copies and restart', async () => {
    const w = world('archive');
    const q = await w.post();
    await setStatus(w.ctx, OWNER_IDENTITY, { id: q.id, status: 'accepted', note: 'Owner accepted' });
    const raw = fs.readFileSync(channelFile(w.config, q.channel), 'utf8');
    await w.runner.sleep(15 * day);
    await maintainWall(w.ctx);
    const archive = path.join(wallDir(w.config), 'archive', 'shared:sim-2026-11.jsonl');
    assert.equal(fs.readFileSync(archive, 'utf8'), raw);
    assert.equal(fs.readFileSync(channelFile(w.config, q.channel), 'utf8'), '');
    assert.equal(readThread(w.config, w.nc, q.id).message.body, 'original body');
    assert.equal(findMessage(w.config, q.id).history[0]?.note, 'Owner accepted');
    assert.equal(findMessage(w.config, q.id).archived, true);
    assert.equal(readWall(w.ctx, w.nc).messages.length, 0);
    assert.equal(readWall(w.ctx, w.nc, { archive: true }).messages[0]?.id, q.id);
    assert.equal(readWall(w.ctx, w.nc, { since: '30d' }).messages[0]?.id, q.id);
    // Simulate interruption after the atomic archive replacement, before active replacement.
    fs.writeFileSync(channelFile(w.config, q.channel), raw);
    assert.equal(channelMessages(w.config, q.channel).length, 1);
    assert.equal(findMessage(w.config, q.id).history.length, 1);
    await maintainWall(w.ctx);
    assert.equal(fs.readFileSync(archive, 'utf8'), raw);
    assert.equal(fs.readFileSync(channelFile(w.config, q.channel), 'utf8'), '');
    const next = await w.post('info');
    assert.equal(next.seq, q.seq + 1, 'archive cannot reset the id counter');
    await setStatus(w.ctx, OWNER_IDENTITY, { id: q.id, status: 'rejected', note: 'later decision' });
    assert.equal(readThread(w.config, w.nc, q.id).message.history.length, 2);
    const copy = world('archive-copy');
    fs.cpSync(wallDir(w.config), wallDir(copy.config), { recursive: true });
    assert.equal(readThread(copy.config, copy.nc, q.id).message.body, 'original body');
    assert.equal(findMessage(copy.config, q.id).status, 'rejected');
  });

  it('defaults list reads to 7d, preserves old open items for board counts, and applies read marks', async () => {
    const w = world('window');
    const open = await w.post();
    await w.post('info', 'old closed');
    await w.runner.sleep(8 * day);
    const recent = await w.post('info', 'recent');
    assert.deepEqual(readWall(w.ctx, w.nc).messages.map(m => m.id), [recent.id]);
    assert.equal(readWall(w.ctx, w.nc, { since: '9d' }).messages.length, 3);
    const board = () => loadWallBoard(w.config, w.runner.now()).channels.find(c => c.channel === open.channel)!;
    assert.equal(board().unread, 2);
    await markRead(w.config, open.channel, { ids: [open.id] });
    assert.equal(board().unread, 1);
    assert.equal(board().open, 1);
  });

  it('reminds once across ticks/restarts and sends the reminder to author and addressee chats', async () => {
    const w = world('remind');
    const q = await w.post();
    await w.runner.sleep(day - 1);
    await maintainWall(w.ctx);
    assert.equal(readJournal(w.config).filter(e => e.text.includes('czeka na')).length, 0);
    await w.runner.sleep(1);
    await maintainWall(w.ctx);
    await maintainWall(new Context(w.runner, w.config, () => {}));
    const events = readJournal(w.config).filter(e => e.text.includes('czeka na'));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.text, `WALL czeka na odpowiedź: ${q.id}`);
    assert.deepEqual(events[0]?.wall?.recipients, ['chat:nc', 'chat:hems']);

  });

  it('stales unanswered questions with a note; owner-only decisions/contracts receive only reminders', async () => {
    const w = world('stale');
    const q = await w.post();
    const decision = await w.post('decision-request');
    const contract = await w.post('contract-change');
    await w.runner.sleep(7 * day);
    await maintainWall(w.ctx);
    assert.equal(findMessage(w.config, q.id).status, 'stale');
    assert.match(findMessage(w.config, q.id).history[0]!.note!, /Brak odpowiedzi/);
    assert.equal(findMessage(w.config, decision.id).status, 'open');
    assert.equal(findMessage(w.config, contract.id).status, 'open');
    assert.equal(readJournal(w.config).filter(e => e.text.includes('czeka na')).length, 3);
    await assert.rejects(setStatus(w.ctx, w.nc, { id: decision.id, status: 'stale' }), /only the owner/);
    const report = await collectEvents(w.ctx, { client: 'stale-test', keep: true, wallIdentity: w.nc.id, wallOpenChannels: new Set([q.channel]) });
    assert.ok(!report.wallOpen?.some(m => m.id === q.id));
    assert.equal(report.wallOpen?.length, 2);
  });

  it('uses latest reply/status activity, custom thresholds, and does not archive recent closures', async () => {
    const w = world('activity', 'wall: {remind_after_hours: 48, stale_after_days: 10, archive_after_days: 20}\n');
    const q = await w.post();
    await w.runner.sleep(9 * day);
    await postMessage(w.ctx, w.nc, { channel: q.channel, kind: 'info', subject: 'Progress', body: '', replyTo: q.id });
    await w.runner.sleep(day);
    await maintainWall(w.ctx);
    assert.equal(findMessage(w.config, q.id).status, 'open');
    assert.equal(findMessage(w.config, q.id).remindedAt, undefined);
    await w.runner.sleep(day);
    await maintainWall(w.ctx);
    assert.ok(findMessage(w.config, q.id).remindedAt);
    await setStatus(w.ctx, OWNER_IDENTITY, { id: q.id, status: 'accepted' });
    await w.runner.sleep(19 * day);
    await maintainWall(w.ctx);
    assert.ok(!findMessage(w.config, q.id).archived);
    await w.runner.sleep(2 * day);
    await maintainWall(w.ctx);
    assert.equal(findMessage(w.config, q.id).archived, true);
  });

  it('board A switches archived messages, stale has a distinct style, and unread excludes old closed items', async () => {
    const w = world('board');
    const archived = await w.post('info');
    await w.runner.sleep(15 * day);
    await maintainWall(w.ctx);
    const stale = await w.post();
    await setStatus(w.ctx, OWNER_IDENTITY, { id: stale.id, status: 'stale' });
    let state = handleKey(initialBoardState(120, 30), 'W', {}).state;
    state = { ...state, wall: loadWallBoard(w.config, w.runner.now()) };
    assert.equal(state.wall!.channels.find(c => c.channel === stale.channel)!.unread, 1);
    assert.equal(state.mode.kind, 'wall');
    if (state.mode.kind !== 'wall') throw new Error('WALL mode');
    state = { ...state, mode: { ...state.mode, level: 'messages', channel: state.wall!.channels.findIndex(c => c.channel === stale.channel) } };
    assert.deepEqual(wallMessages(state, state.mode as never).map(m => m.id), [stale.id]);
    assert.equal(wallView(state, state.mode as never).lines[0]?.dim, true);
    state = handleKey(state, 'A', {}).state;
    assert.deepEqual(wallMessages(state, state.mode as never).map(m => m.id), [archived.id]);
    assert.match(wallView(state, state.mode as never).title, /ARCHIVE/);
  });
});
