import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { provider } from '../src/core/providers/registry.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';
const scratch = useScratch();
function setup(name: string) {
  const root = scratch.sub(name), home = path.join(root, 'kimi'), wt = path.join(root, 'wt');
  fs.mkdirSync(wt); fs.mkdirSync(home);
  const config = makeConfig(root, `providers: [claude, codex, kimi]\ncapacity: {snapshot: false, kimi_usage_probe: false}\nusage: {kimi_dir: ${home}}\n`);
  const tmux = new FakeTmux(config.session), pane = tmux.add('k', '│ > │');
  const now = Date.now(), at = now + 2000;
  const record = seedTask(config, 'K', { agent: 'kimi', model: 'k3', repos: [{ path: root, worktree: wt }], started: new Date(now - 1000).toISOString(), attemptId: 'A', turnEndedAt: undefined, windowId: pane.id });
  const dir = path.join(home, 'sessions/workspace/session_S/agents/main'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl'), state = path.join(config.stateDir, 'k');
  const { ctx, runner } = makeContext(config, { respond: tmux.respond }); runner.now = () => at + 1000;
  const produce = (mode: string) => {
    const r = spawnSync(path.join(import.meta.dirname, 'fixtures/p28b-fake-kimi.mjs'), [file, wt, String(at), mode], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const report = () => { fs.mkdirSync(path.dirname(record.report), { recursive: true }); fs.writeFileSync(record.report, 'Verdict: PASS\n<!-- agentctl:attempt A -->\n'); fs.utimesSync(record.report, now / 1000, now / 1000); };
  const notifier = { notify: async () => {} };
  return { config, tmux, record, ctx, file, state, at, produce, report, notifier };
}
for (const gone of [false, true]) it(`watch alone discovers completion behind a large wire record (window ${gone ? 'gone' : 'alive'})`, async () => {
  const w = setup(`large-${gone}`), memory = new WatchMemory();
  w.produce('start');
  await watchTick(w.ctx, memory, w.notifier);
  w.report(); w.produce('large'); w.produce('end');
  if (gone) w.tmux.windows = [];
  const transitions = [];
  // Polling must advance without status, usage, MCP, pull, or a selected/attached pane.
  for (let i = 0; i < 4; i++) transitions.push(...await watchTick(w.ctx, memory, w.notifier));
  assert.ok(transitions.some(e => e.to === 'report-ready'));
  const event = JSON.parse(fs.readFileSync(path.join(w.state, 'event.json'), 'utf8'));
  assert.equal(event.type, 'turn.ended'); assert.equal(event.at, new Date(w.at).toISOString());
  assert.equal(readTaskRecord(w.config, 'k')?.pulled, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'kimi-wire-cursor.json'), 'utf8'))[w.file].offset, fs.statSync(w.file).size);
});
it('watch discovers a previously unselected session and resets a truncated cursor after restart', async () => {
  const w = setup('selection');
  w.produce('start');
  const state = path.join(path.dirname(w.file), '../../state.json');
  fs.writeFileSync(state, JSON.stringify({ id: 'S', cwd: '/unrelated', createdAt: w.at }));
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.equal(fs.existsSync(path.join(w.state, 'event.json')), false);
  fs.writeFileSync(state, JSON.stringify({ id: 'S', cwd: w.record.repos[0]!.worktree, createdAt: w.at }));
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'event.json'), 'utf8')).outcome, 'needs-input');
  // Binding survives an older/changed cwd; a beyond-EOF cursor must replay metadata.
  fs.writeFileSync(state, JSON.stringify({ id: 'S', cwd: '/unrelated', createdAt: 0 }));
  fs.writeFileSync(path.join(w.state, 'kimi-wire-cursor.json'), JSON.stringify({ [w.file]: { offset: 999999, parserVersion: 2, protocol: '1.5' } }));
  w.report(); w.produce('end');
  const events = await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.ok(events.some(e => e.to === 'report-ready'));
  assert.equal(readTaskRecord(w.config, 'k')?.pulled, undefined);
});
it('poll retains an incomplete wire line until its newline, preserving UTF-8 byte offsets', async () => {
  const w = setup('partial'); w.produce('start');
  await provider('kimi').events.poll!(w.ctx, w.record);
  const before = fs.readFileSync(path.join(w.state, 'kimi-wire-cursor.json'), 'utf8');
  const line = JSON.stringify({ type: 'turn.ended', text: 'ą'.repeat(300_000), time: w.at });
  fs.appendFileSync(w.file, line);
  await provider('kimi').events.poll!(w.ctx, w.record);
  assert.equal(fs.readFileSync(path.join(w.state, 'kimi-wire-cursor.json'), 'utf8'), before);
  fs.appendFileSync(w.file, '\n');
  await provider('kimi').events.poll!(w.ctx, w.record);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'event.json'), 'utf8')).type, 'turn.ended');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.state, 'kimi-wire-cursor.json'), 'utf8'))[w.file].offset, fs.statSync(w.file).size);
});
