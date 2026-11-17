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

});
