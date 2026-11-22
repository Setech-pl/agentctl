import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { chatQuotaWait } from '../src/core/chat-quotas.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { ConfigStore } from '../src/core/config-store.ts';
import { Context } from '../src/core/context.ts';
import { collectLimits } from '../src/core/limits.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { providerHolds } from '../src/core/provider-hold.ts';
import { OWNER_IDENTITY, channelMessages, messageWithBody } from '../src/core/wall.ts';
import { reloadConfig } from '../src/core/watch.ts';
import { DiskRunner, FakeTmux, makeConfig, runCli, useScratch } from './helpers.ts';

const scratch = useScratch();
const startTime = Date.parse('2026-11-22T10:00:00Z');
const tool = (name: string) => MCP_TOOLS.find(t => t.name === name)!;

function fixture(name: string, yaml: string) {
  const config = makeConfig(scratch.sub(name), yaml);
  const runner = new DiskRunner({ dryRun: false, startTime, respond: new FakeTmux().respond });
  const load = () => loadGlobalConfig(path.dirname(config.path), runner.now());
  const ctx = new Context(runner, load(), () => {});
  const notifications: string[] = [];
  const deps = { context: () => new Context(runner, load(), () => {}), notify: async (text: string) => { notifications.push(text); }, clientId: 'fixture-nc' };
  const cli = (...args: string[]) => runCli(load(), runner, ['limits', ...args], { loadConfig: load });
  const post = (kind: string) => channelMessages(config, 'agentctl').filter(m => m.kind === kind);
  return { config, ctx, runner, load, cli, deps, notifications, post };
}

test('LIMITS0255-OWNER: an MCP confirm queues one request; only an owner decision applies it', async () => {
  const f = fixture('approve', `limits: {claude: 7, codex: 10}
mcp: {allow: [set_limits, wall]}
`);
  const before = fs.readFileSync(f.config.path, 'utf8');
  const args = { as: 'chat:agentctl', claude: 13, queue_hold: { codex: 87 }, reason: 'More windows for the release', confirm: true };
  const first = await tool('set_limits').run(f.deps, args);
  assert.equal(f.load().limits.claude, 7, 'confirm from chat:agentctl leaves the owner limit alone');
  assert.equal(fs.readFileSync(f.config.path, 'utf8'), before);
  assert.ok(!first.isError, first.text);
  const request = /Pending owner approval: (limit-\S+)/.exec(first.text)?.[1];
  assert.ok(request, first.text);
  const retry = await tool('set_limits').run(f.deps, { ...args, confirm: false });
  assert.match(retry.text, new RegExp(request));
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0]!, /chat:agentctl[\s\S]*claude 7 → 13[\s\S]*More windows for the release/);
  assert.equal(f.post('decision-request').length, 1);
  const wall = f.post('decision-request')[0]!;
  assert.equal(wall.to, OWNER_IDENTITY.id);
  assert.match(messageWithBody(f.config, wall).body, /chat:agentctl[\s\S]*More windows for the release[\s\S]*claude 7 → 13[\s\S]*codex off → 87%/);
  const spoof = await tool('wall_set_status').run(f.deps, { as: 'chat:agentctl', id: wall.id, status: 'accepted', owner_confirmed: true });
  assert.equal(spoof.isError, true);
  assert.match(spoof.text, /limits approve\/reject/);
  const approval = await f.cli('approve', request);
  assert.equal(approval.code, 0, approval.stderr);
  assert.equal((await f.cli('approve', request)).code, 0);
  assert.equal(f.load().limits.claude, 13);
  assert.equal(f.load().usage.queueHold.codex, 87);
  assert.equal(f.post('decision-request')[0]?.status, 'accepted');
  assert.equal(f.post('decision-request')[0]?.history.length, 1);
  assert.equal(f.post('info').length, 1);
  assert.match(messageWithBody(f.config, f.post('info')[0]!).body, /CLI właściciela[\s\S]*claude 7 → 13/);
});

test('LIMITS0255-SHARES: global changes recompute configured percentages and keep absolute overrides', async () => {
  const f = fixture('shares', `providers: [claude, codex, kimi, glm]
limits: {claude: 7, codex: 10, kimi: 3, glm: off}
quotas:
  floor: 1
  chats:
    nc: {share: 40, codex: 5}
    hems: {share: 40}
    vs65: {share: 20}
    blocked: {share: 0}
mcp: {max_response_kb: 64}
capacity: {snapshot: false, codex_refresh: false}
`);
  const live = Array.from({ length: 4 }, (_, i) => ({ window: `nc-${i}`, agent: 'claude' as const, owner: 'chat:nc' }));
  const provider = (id: string) => collectLimits(f.load(), live, f.runner.now()).providers.find(p => p.agent === id)!;
  const ceiling = (id: string, chat: string) => provider(id).chats!.find(c => c.chat === `chat:${chat}`)!.share;
  assert.deepEqual(['nc', 'hems', 'vs65', 'blocked'].map(name => ceiling('claude', name)), [4, 4, 2, 0]);
  assert.equal(ceiling('codex', 'nc'), 5);
  assert.equal(ceiling('codex', 'hems'), 6);
  assert.equal(ceiling('kimi', 'vs65'), 1);
  assert.equal(ceiling('glm', 'hems'), 0);
  assert.match(chatQuotaWait(f.load(), { agent: 'claude', owner: 'chat:nc' }, live) ?? '', /4\/4/);
  const changed = await f.cli('set', 'claude=10', '--yes');
  assert.equal(changed.code, 0, changed.stderr);
  assert.equal(chatQuotaWait(f.load(), { agent: 'claude', owner: 'chat:nc' }, live), undefined);
  assert.deepEqual(['nc', 'hems', 'vs65'].map(name => ceiling('claude', name)), [6, 6, 3]);
  assert.match(messageWithBody(f.config, f.post('info')[0]!).body, /Efektywne kwoty:[\s\S]*chat:nc=6/);
  for (const name of ['limits', 'capacity', 'config_show']) {
    const result = await tool(name).run(f.deps, { format: 'json' });
    assert.ok(!result.isError, result.text);
    const data = JSON.parse(result.text);
    if (name === 'config_show') assert.equal(data.effective_chat_ceilings.claude['chat:nc'].ceiling, 6);
    else assert.equal(data.providers.find((p: { agent?: string; provider?: string }) => (p.agent ?? p.provider) === 'claude').chats.find((q: { chat: string }) => q.chat === 'chat:nc').share, 6);
  }
});

test('LIMITS0255-SCHEDULE: local midnight and both Warsaw DST transitions use one chronological switch', async () => {
  const f = fixture('schedule', `limits:
  claude: 7
  profiles:
    day: {claude: 7}
    night: {claude: 4, shares: {nc: 20}}
    focus-nc: {claude: 10}
  schedule:
    timezone: Europe/Warsaw
    switches: {'07:00': day, '22:00': night, '02:30': focus-nc}
quotas: {chats: {nc: {share: 40}}}
`);
  const at = (iso: string) => loadGlobalConfig(path.dirname(f.config.path), Date.parse(iso));
  for (const [iso, profile, claude] of [
    ['2026-11-22T20:59:59Z', 'day', 7], ['2026-11-22T21:00:00Z', 'night', 4], ['2026-11-22T23:00:00Z', 'night', 4],
    ['2026-03-29T01:29:59Z', 'night', 4], ['2026-03-29T01:30:00Z', 'focus-nc', 10],
    ['2026-10-25T00:29:59Z', 'night', 4], ['2026-10-25T00:30:00Z', 'focus-nc', 10], ['2026-10-25T01:15:00Z', 'focus-nc', 10],
  ]) {
    const config = at(String(iso));
    assert.deepEqual([config.limitRuntime.profile, config.limits.claude], [profile, claude], String(iso));
  }
  const store = new ConfigStore(f.load, f.load());
  const init = await reloadConfig(f.ctx, store);
  assert.equal(init.config.limitRuntime.profile, 'day');
  await f.runner.sleep(11 * 3_600_000);
  assert.equal((await reloadConfig(f.ctx, store)).config.quotas?.chats.nc?.share, 20);
  await reloadConfig(f.ctx, store);
  assert.equal(f.post('info').length, 1);
  assert.match(messageWithBody(f.config, f.post('info')[0]!).body, /harmonogram[\s\S]*profil: day → night/);
});

test('a pending request can be rejected or expire, and changed old values require a fresh request', async () => {
  const f = fixture('decisions', `limits: {claude: 7}
wall: {chats: {nc: {channels: [nc], clients: [fixture-nc]}}}
mcp: {allow: [set_limits]}
`);
  const request = async (claude: number) => {
    const result = await tool('set_limits').run(f.deps, { claude, reason: 'Check owner decision' });
    assert.ok(!result.isError, result.text);
    const id = /Pending owner approval: (limit-\S+)/.exec(result.text)?.[1];
    assert.ok(id, result.text);
    return id;
  };
  const first = await request(9);
  assert.match((await f.cli('requests')).stdout, /chat:nc/);
  assert.equal((await f.cli('reject', first)).code, 0);
  assert.equal(f.post('decision-request')[0]?.status, 'rejected');
  const second = await request(10);
  assert.equal((await f.cli('set', 'claude=8', '-y')).code, 0);
  assert.match((await f.cli('approve', second)).stderr, /differs from the original request/);
  await f.runner.sleep(2 * 3_600_000);
  const { maintainLimitRequests } = await import('../src/core/limit-requests.ts');
  await maintainLimitRequests(f.ctx);
  assert.equal(f.post('decision-request').at(-1)?.status, 'stale');
  assert.match((await f.cli('approve', second)).stderr, /expired/);
  assert.equal(f.load().limits.claude, 8);
});

test('hold stays direct for ordinary chats while profile change waits for owner', async () => {
  const f = fixture('hold', `providers: [claude, codex, glm]
limits: {claude: 7, profiles: {night: {claude: 3, shares: {nc: 20}}}}
wall: {chats: {nc: {channels: [nc], clients: [fixture-nc]}}}
mcp: {allow: [set_limits]}
`);
  const result = await tool('set_limits').run(f.deps, { profile: 'night', hold: { glm: '3h' }, confirm: true });
  assert.ok(!result.isError, result.text);
  const id = /Pending owner approval: (limit-\S+)/.exec(result.text)?.[1];
  assert.ok(id, result.text);
  assert.equal(f.load().limits.claude, 7);
  assert.ok(providerHolds(f.config, f.runner.now()).glm);
  assert.equal((await f.cli('approve', id)).code, 0);
  assert.equal(f.load().limitRuntime.profile, 'night');
  assert.equal(f.load().quotas?.chats.nc?.share, 20);
  assert.equal(f.post('info').length, 2);
});

test('timed override follows the active profile on expiry and board edits work with a single decision key', async () => {
  const f = fixture('board', `limits: {claude: 7, profiles: {night: {claude: 4}}}
mcp: {allow: [set_limits]}
`);
  const board = await import('../src/core/board.ts');
  assert.equal((await f.cli('set', 'claude=10', '--until', '1h', '-y')).code, 0);
  assert.equal((await f.cli('profile', 'night')).code, 0);
  const store = new ConfigStore(f.load, f.load());
  await reloadConfig(f.ctx, store);
  assert.equal(f.ctx.config.limits.claude, 10);
  await f.runner.sleep(3_600_000);
  await reloadConfig(f.ctx, store);
  assert.equal(f.ctx.config.limits.claude, 4);
  assert.match(messageWithBody(f.config, f.post('info').at(-1)!).body, /wygaśnięcie limitu czasowego[\s\S]*claude 10 → 4/);

  const requested = await tool('set_limits').run(f.deps, { claude: 6 });
  assert.ok(!requested.isError, requested.text);
  const opened = board.handleKey(board.initialBoardState(100, 30), 'L', {}, 12).state;
  assert.ok(opened.mode.kind === 'view');
  const mode = board.updateLimitsPanel(opened.mode, await board.loadLimitsPanel(f.ctx));
  assert.match(mode.lines.join('\n'), /Profil: night[\s\S]*claude 4 → 6/);
  const approve = board.handleKey({ ...opened, mode }, 'a', {}, 12).effects[0]!;
  const result = await board.runBoardEffect(f.runner, f.load(), approve, { insideTmux: false });
  assert.equal(result.level, 'info', result.text);
  assert.equal(f.load().limits.claude, 6);
  const updated = { ...opened, mode: board.updateLimitsPanel(mode, await board.loadLimitsPanel(new Context(f.runner, f.load(), () => {}))) };
  const draft = board.handleKey(updated, '+', {}, 12).state;
  const edit = board.handleKey(draft, '', { return: true }, 12).effects[0]!;
  const changed = await board.runBoardEffect(f.runner, f.load(), edit, { insideTmux: false });
  assert.equal(changed.level, 'info', changed.text);
  assert.equal(f.load().limits.claude, 7);
  assert.equal(f.load().limitSettings.base.claude, 7);
  assert.match(messageWithBody(f.config, f.post('info').at(-1)!).body, /tablica właściciela[\s\S]*claude 6 → 7/);
});
