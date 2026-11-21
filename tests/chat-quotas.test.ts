import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { ConfigStore } from '../src/core/config-store.ts';
import { readJournal } from '../src/core/journal.ts';
import { collectLimits } from '../src/core/limits.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { liveWindows } from '../src/core/plan.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, queueTick, QueueMemory, readQueue, validateAccepted } from '../src/core/queue.ts';
import type { QueueEntry } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { collectStatus } from '../src/core/status.ts';
import { readTaskRecord } from '../src/core/taskstore.ts';
import { reloadConfig } from '../src/core/watch.ts';
import { FakeTmux, fakeWatcher, makeConfig, makeContext, runCli, seedTask, specText, useScratch } from './helpers.ts';

const scratch = useScratch();
const notifier = { clickable: false, notify: async () => {} };
const fixedTime = Date.UTC(2026, 10, 20, 10);
const shares = { nc: {claude: 4}, hems: {claude: 3}, vs65: {claude: 2} };

function configFor(name: string, yaml = ''): GlobalConfig {
  return makeConfig(scratch.sub(name), `limits: {claude: 6}\ncapacity: {snapshot: false, codex_refresh: false}\n${yaml}`);
}

function queued(task: string, owner: string, seq: number, host?: string): QueueEntry {
  return {task, owner, seq, order: seq, host, status: 'queued', priority: 'normal', agent: 'claude',
    model: 'sonnet', effort: 'high', after: [], spec: '', queuedAt: new Date(fixedTime).toISOString()};
}

function withQuotas(config: GlobalConfig, overrides: Partial<NonNullable<GlobalConfig['quotas']>> = {}): GlobalConfig {
  return {...config, quotas: {chats: shares, overprovision: 1.5, per_host: false, self_service: 'off', default: {}, floor: {}, cohorts: {}, ...overrides}};
}

test('QUOTA0250-CONTENTION: below-floor chat takes the first place, lowest ratio takes the second, existing work stays', async () => {
  const config = withQuotas(configFor('contention', 'queue: {parallel_starts: 3, max_parallel_setups: 3}\n'));
  config.disk.minFreeStartGb = 0;
  const tmux = new FakeTmux();
  const {ctx} = makeContext(config, { startTime: fixedTime, respond: tmux.respond });
  const repo = scratch.sub('contention/repo');
  for (const [task, owner] of [['N-1','nc'], ['N-2','nc'], ['N-3','nc'], ['H-1','hems']] as const) {
    tmux.add(task.toLowerCase());
    seedTask(config, task, { owner: `chat:${owner}` });
  }
  for (const [task, cohort] of [['N-4','nc'], ['H-2','hems'], ['V-1','vs65'], ['V-2','vs65'], ['H-3','hems']] as const) {
    const text = specText({task, agent: 'claude', cohort, priority: task === 'H-2' ? 'high' : 'normal'}, repo).replace(`${repo}-wt`, `${repo}-${task}`);
    const plan = await planQueueAdd(ctx, splitSpecs(text, 'fixture'));
    // Supply already-recorded owners to exercise the scheduler on the prior release as well.
    await commitQueueAdd(ctx, plan.items);
    const entry = readQueue(config).find(e => e.task === task)!;
    const file = path.join(path.dirname(config.path), 'queue', `${String(entry.seq).padStart(4, '0')}-${task}.json`);
    fs.writeFileSync(file, JSON.stringify({...entry, owner: `chat:${cohort}`}));
  }
  const views = describeQueue(config, readQueue(config), await liveWindows(ctx), [], fixedTime);
  assert.deepEqual(views.filter(v => v.condition.kind === 'ready').map(v => v.entry.task), ['H-2','V-1']);
  assert.match(views.find(v => v.entry.task === 'N-4')!.condition.text, /czeka na miejsce globalne \(claude 6\/6\)/);
  const memory = new QueueMemory();
  const began = await queueTick(ctx, memory, notifier, {rows: []});
  await memory.idle();
  assert.deepEqual(began, ['V-1','H-2']);
  assert.equal(readTaskRecord(config, 'v-1')?.owner, 'chat:vs65');
  assert.equal(readTaskRecord(config, 'h-2')?.owner, 'chat:hems');
  assert.deepEqual((await liveWindows(ctx)).map(w => w.window).sort(), ['h-1','h-2','n-1','n-2','n-3','v-1']);
  assert.ok(readJournal(config).some(e => e.kind === 'queue-start' && e.task === 'V-1' && e.owner === 'chat:vs65'));
});

test('QUOTA0250-CEILINGS: chat use spans hosts, per_host changes shares only, and equal ratios retain queue priority', () => {
  const base = configFor('ceilings', 'hosts: {other: {ssh: fixture@host, work_dir: /work, repos: {}, providers: [claude]}}\n');
  base.disk.minFreeStartGb = 0;
  const config = withQuotas(base);
  const live = Array.from({length: 4}, (_, i) => ({window: `n-${i}`, agent: 'claude' as const, owner: 'chat:nc', host: i < 2 ? undefined : 'other'}));
  const candidate = queued('N-5', 'chat:nc', 1, 'other');
  assert.equal(describeQueue(config, [candidate], live, [], fixedTime)[0]?.condition.text, 'czeka na kwotę chat:nc (claude 4/4)');
  assert.equal(describeQueue(withQuotas(base, {per_host: true}), [candidate], live, [], fixedTime)[0]?.condition.kind, 'ready');
  const load = collectLimits(config, live, fixedTime).providers.find(p => p.agent === 'claude')!;
  assert.deepEqual([load.used, load.limit], [4,6]);
  assert.deepEqual(load.chats?.find(c => c.chat === 'chat:nc'), {chat: 'chat:nc', used: 4, share: 4, floor: 1});

  const narrow = withQuotas({...base, limits: {claude: 2}}, {chats: {nc: {claude: 4}, vs65: {claude: 2}}, floor: {claude: 0}});
  const one = live.slice(0, 1);
  const ready = describeQueue(narrow, [queued('H-2', 'chat:vs65', 1), queued('N-6', 'chat:nc', 2)], one, [], fixedTime);
  assert.deepEqual(ready.map(v => v.condition.kind), ['ready','slot'], 'lower ratio wins');
  const tied = [...one, {...one[0]!, window: 'n-2'}, {...one[0]!, window: 'v-1', owner: 'chat:vs65'}];
  const last = withQuotas({...base, limits: {claude: 4}}, {floor: {claude: 0}});
  const high = {...queued('V-2', 'chat:vs65', 2), priority: 'high' as const};
  assert.deepEqual(describeQueue(last, [high, queued('N-7', 'chat:nc', 1)], tied, [], fixedTime).map(v => v.condition.kind), ['ready','slot']);
  const full = [...live, {...live[0]!, window: 'n-5'}, {...live[0]!, window: 'n-6'}];
  assert.equal(describeQueue(withQuotas(base, {per_host: true}), [candidate], full, [], fixedTime)[0]?.condition.text, 'czeka na miejsce globalne (claude 6/6)');
});

test('QUOTA0250-IDENTITY: MCP confirmation records caller ownership and watcher validation preserves it', async () => {
  const config = withQuotas(configFor('identity', `
mcp: {allow: [new, queue]}
wall:
  chats:
    hems: {channels: [hems], clients: [hems-mcp]}
`), {cohorts: {dispatch: 'chat:vs65'}});
  const {ctx} = makeContext(config);
  fakeWatcher(config);
  const repo = scratch.sub('identity/repo');
  const order = async (toolName: string, task: string, header: Record<string, string>, as?: string, clientId?: string) => {
    const tool = MCP_TOOLS.find(t => t.name === toolName)!;
    const deps = {context: () => ctx, notify: async () => {}, clientId};
    const call = (args: object) => tool.run(deps, z.object(tool.input).parse(args));
    const preview = await call({spec: specText({task, agent: 'claude', ...header}, repo).replace(`${repo}-wt`, `${repo}-${task}`), as});
    assert.ok(!preview.isError, preview.text);
    const token = /^preview_token: (\S+)/m.exec(preview.text)?.[1];
    assert.ok(token);
    const confirmed = await call({confirm: true, preview_token: token});
    assert.ok(!confirmed.isError, confirmed.text);
  };
  await order('new', 'ID-1', {owner: 'vs65', cohort: 'dispatch'}, 'chat:nc', 'hems-mcp');
  await order('queue', 'ID-2', {owner: 'vs65', cohort: 'dispatch'}, undefined, 'hems-mcp');
  await order('queue', 'ID-3', {owner: 'nc', cohort: 'dispatch'});
  await order('queue', 'ID-4', {cohort: 'DISPATCH'});
  await order('queue', 'ID-5', {});
  const expected = ['chat:nc','chat:hems','chat:nc','chat:vs65','default'];
  assert.deepEqual(readQueue(config).map(e => e.owner), expected);
  config.quotas!.cohorts.dispatch = 'chat:nc';
  await validateAccepted(ctx, notifier);
  assert.deepEqual(readQueue(config).map(e => [e.status, e.owner]), expected.map(owner => ['queued', owner]));
  assert.deepEqual(readJournal(config).filter(e => e.kind === 'task-ordered').map(e => e.owner), expected);
  const queueList = MCP_TOOLS.find(t => t.name === 'queue_list')!;
  const listed = await queueList.run({context: () => ctx, notify: async () => {}}, {format: 'json'});
  assert.deepEqual(JSON.parse(listed.text).map((e: QueueEntry) => e.owner), expected);
  seedTask(config, 'ID-ACTIVE', {owner: 'chat:nc'});
  assert.equal((await collectStatus(ctx)).find(r => r.task === 'ID-ACTIVE')?.owner, 'chat:nc');
});

test('QUOTA0250-MANAGEMENT: scoped edits respect overprovision and announce each revision once', async () => {
  const initial = configFor('management', `
mcp: {allow: [set_limits], max_response_kb: 64}
wall:
  chats:
    nc: {channels: [nc], clients: [nc-mcp]}
    agentctl: {channels: [agentctl], clients: [owner-mcp]}
`);
  const {ctx, runner} = makeContext(initial);
  const load = () => loadGlobalConfig(path.dirname(initial.path));
  const setter = MCP_TOOLS.find(t => t.name === 'set_limits')!;
  const call = (clientId: string, args: object) => setter.run({context: () => ctx, notify: async () => {}, clientId}, z.object(setter.input).parse(args));
  const denied = await call('nc-mcp', {as: 'chat:agentctl', claude: 5, confirm: true});
  assert.equal(denied.isError, true);
  assert.match(denied.text, /decision-request/);
  const cli = await runCli(initial, runner, ['limits', 'set', 'quota.nc.claude=4', 'overprovision=1.5', '-y']);
  assert.equal(cli.code, 0, cli.stderr);
  ctx.setConfig(load());
  assert.equal((await call('nc-mcp', {quota: {chat: 'nc', claude: 3}, confirm: true})).isError, true);
  fs.writeFileSync(initial.path, fs.readFileSync(initial.path, 'utf8').replace('quotas:\n', 'quotas:\n  self_service: within_overprovision\n  floor: {claude: 4}\n  default: {claude: 4}\n'));
  ctx.setConfig(load());
  const show = MCP_TOOLS.find(t => t.name === 'config_show')!;
  const shown = await show.run({context: () => ctx, notify: async () => {}}, {});
  const configJson = JSON.parse(shown.text.slice(shown.text.indexOf('{')));
  assert.match(configJson.quota_warnings.join('\n'), /sum of floors 8 exceeds global limit 6/);
  assert.equal(collectLimits(ctx.config, []).providers[0]?.chats?.reduce((n, chat) => n + chat.floor, 0), 6);
  const store = new ConfigStore(load);
  store.refresh();
  const tooHigh = await call('nc-mcp', {quota: {chat: 'nc', claude: 6}, confirm: true});
  assert.equal(tooHigh.isError, true);
  assert.match(tooHigh.text, /overprovision budget 9/);
  assert.ok(!(await call('nc-mcp', {quota: {chat: 'nc', claude: 5}, confirm: true})).isError);
  await reloadConfig(ctx, store);
  assert.equal(ctx.config.quotas?.chats.nc?.claude, 5);
  assert.equal((await call('nc-mcp', {quota: {chat: 'hems', claude: 1}, confirm: true})).isError, true);
  assert.equal((await call('nc-mcp', {quota: {chat: 'nc', claude: 1}, overprovision: 3, confirm: true})).isError, true);
  assert.ok(!(await call('owner-mcp', {as: 'chat:agentctl', claude: 4, overprovision: 2, confirm: true})).isError);
  await reloadConfig(ctx, store);
  assert.equal(ctx.config.limits.claude, 4);
  assert.equal(ctx.config.quotas?.overprovision, 2);
  const journal = readJournal(initial);
  assert.equal(journal.filter(e => e.kind === 'limits-changed').length, 4);
  assert.equal(journal.filter(e => e.kind === 'wall' && e.wall?.kind === 'info' && e.wall.channel === 'agentctl').length, 4);
  assert.ok(journal.some(e => e.kind === 'limits-changed' && e.text.includes('config edit') && e.text.includes('floor claude')));
});

test('QUOTA0250-GLM: removing the global GLM cap does not restore the default cap', async () => {
  const config = makeConfig(scratch.sub('glm'), 'providers: [claude, codex, glm]\n');
  const {runner} = makeContext(config);
  assert.equal(config.limits.glm, 2);
  const result = await runCli(config, runner, ['limits', 'set', 'glm=0', '-y']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(loadGlobalConfig(path.dirname(config.path)).limits.glm, undefined);
  assert.ok(readJournal(config).some(e => e.kind === 'limits-changed' && /glm 2 → -/.test(e.text)));
});
