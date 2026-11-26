import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {collectEvents} from '../src/core/chat-events.ts';
import {Context} from '../src/core/context.ts';
import {readJournal, recordJournalOnce} from '../src/core/journal.ts';
import {MCP_TOOLS} from '../src/core/mcp-tools.ts';
import {queueTick, queueViews, QueueMemory, saveEntry} from '../src/core/queue.ts';
import {planResume} from '../src/core/resume.ts';
import {RealRunner} from '../src/core/runner.ts';
import {pendingStarts} from '../src/core/start-lock.ts';
import {collectStatus} from '../src/core/status.ts';
import {runWatch, watchTick, WatchMemory} from '../src/core/watch.ts';
import {DiskRunner, FakeTmux, makeConfig, runCli, seedTask, useScratch} from './helpers.ts';

const scratch = useScratch();
const notifier = {notify: async () => {}};

function world(name: string, yaml = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, yaml);
  const tmux = new FakeTmux(config.session);
  const runner = new DiskRunner({dryRun: false, respond: tmux.respond});
  const out: string[] = [];
  const ctx = new Context(runner, config, line => {out.push(line);});
  const repo = scratch.sub(name + '/repo');
  return {config, tmux, runner, ctx, repo, out};
}

test('REVIEW0256-RESUME: a stalled tmux launch leaves the tick and releases its reservation', async () => {
  const w = world('resume', 'limits: {claude: 1}\n');
  const current = w.tmux.add('retry-1', 'exit');
  current.exitCode = 12;
  seedTask(w.config, 'RETRY-1', {windowId: current.id, repos: [{path: w.repo, worktree: w.repo}], launchAt: new Date(w.runner.now()).toISOString()});
  const exec = w.runner.exec.bind(w.runner);
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>(resolve => {enter = resolve;});
  const paused = new Promise<void>(resolve => {release = resolve;});
  w.runner.exec = async (cmd, args, opts) => {
    if (cmd === 'tmux' && args[0] === 'send-keys' && args.includes('-l')) {
      enter();
      await paused;
      return {code: 1, stdout: '', stderr: 'ETIMEDOUT while opening provider shell'};
    }
    return exec(cmd, args, opts);
  };
  const memory = new WatchMemory();
  let complete = false;
  const tick = watchTick(w.ctx, memory, notifier).then(() => {complete = true;});
  try {
    await entered;
    for (let i = 0; !complete && i < 10000; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(complete, 'watch waited for the launch command');
    assert.equal(pendingStarts(w.config).length, 1);
    assert.equal(fs.existsSync(path.join(w.config.stateDir, 'start.lock')), false);
  } finally {
    release();
    await tick;
    await memory.launchHealth?.idle();
    memory.launchHealth?.close();
  }
  assert.equal(pendingStarts(w.config).length, 0);
  assert.match(readJournal(w.config).find(event => event.kind === 'launch-failed')?.text ?? '', /ETIMEDOUT/);
});

test('REVIEW0256-LOAD: configured load alert does not hold admission unless opted in', async t => {
  t.mock.method(os, 'loadavg', () => [75, 75, 75]);
  for (const hold of [false, true]) {
    const w = world(`load-${hold}`, `capacity: {load_threshold: 20, codex_refresh: false}\n${hold ? 'queue: {hold_on_load: true}\n' : ''}`);
    await saveEntry(w.ctx, {task: 'LOAD-1', seq: 1, order: 1, status: 'queued', agent: 'claude', model: 'opus', effort: 'high',
      priority: 'normal', after: [], queuedAt: new Date(w.runner.now()).toISOString(),
      spec: `---\ntask: LOAD-1\nagent: claude\nrepos: [{path: ${w.repo}, worktree: ${w.repo}-target}]\n---\nFixture.\n`});
    const [view] = await queueViews(w.ctx);
    assert.equal(view?.condition.text.includes('obciążenie'), hold);
    const memory = new QueueMemory();
    assert.deepEqual(await queueTick(w.ctx, memory, notifier), hold ? [] : ['LOAD-1']);
    await memory.idle();
    if (hold) assert.ok(readJournal(w.config).some(event => event.kind === 'queue-held' && /obciążenie.*75\.0 > 20/.test(event.text)));
  }
});

test('REL0272-HOLD-WRITES: a held queue publishes one journal append and keeps all four reasons', async t => {
  t.mock.method(os, 'loadavg', () => [75, 75, 75]);
  const w = world('batch-holds', 'capacity: {load_threshold: 20}\nqueue: {hold_on_load: true}\n');
  for (let i = 0; i < 4; i++) {
    const task = `HELD-${i}`;
    await saveEntry(w.ctx, {task, seq: i + 1, order: i + 1, status: 'queued', agent: 'claude', model: 'opus', effort: 'high',
      priority: 'normal', after: [], queuedAt: new Date(w.runner.now()).toISOString(),
      spec: `---\ntask: ${task}\nagent: claude\nrepos: [{path: ${w.repo}, worktree: ${w.repo}-${i}}]\n---\nFixture.\n`});
  }
  const append = t.mock.method(w.runner, 'appendFile');
  const memory = new QueueMemory();
  for (let tick = 0; tick < 2; tick++) assert.deepEqual(await queueTick(w.ctx, memory, notifier), []);
  const writes = append.mock.calls.filter(call => String(call.arguments[0]).endsWith('/journal.jsonl') && String(call.arguments[1]).includes('queue-held'));
  assert.equal(writes.length, 1);
  assert.equal(readJournal(w.config).filter(event => event.kind === 'queue-held').length, 4);
  assert.ok((await queueViews(w.ctx)).every(view => /obciążenie/.test(view.condition.text)));
});

test('REVIEW0256-INDEX: repeated launch checks keep task reads and journal parsing bounded', async t => {
  const w = world('index');
  for (let i = 0; i < 12; i++) seedTask(w.config, `INDEX-${i}`, {launchAt: '2026-01-01T01:00:00Z'});
  const {TaskRecordIndex} = await import('../src/core/taskstore.ts');
  const index = new TaskRecordIndex();
  t.after(() => index.close());
  assert.equal((await index.current(w.config, w.runner.now())).length, 12);
  const open = t.mock.method(fs.promises, 'open');
  assert.equal((await index.current(w.config, w.runner.now())).length, 12);
  assert.ok(open.mock.calls.every(call => !String(call.arguments[0]).endsWith('/TASK.md')));
  const read = t.mock.method(fs, 'readFileSync');
  for (let i = 0; i < 3; i++) await recordJournalOnce(w.ctx, {kind: 'launch-failed', changeId: 'once', text: 'One exit.'});
  assert.equal(read.mock.calls.filter(call => String(call.arguments[0]).endsWith('journal.jsonl')).length, 0);
  assert.equal(readJournal(w.config).filter(event => event.changeId === 'once').length, 1);
});

test('REL0272-DELIVERY-SCAN: the watch locks only tasks with a pending prompt or queued follow-up', async t => {
  const w = world('delivery-fifo');
  const items = Array.from({length: 12}, (_, i) => {
    const pane = w.tmux.add(`fifo-${i}`, 'Working (esc to interrupt)');
    return seedTask(w.config, `FIFO-${i}`, {agent: 'codex', windowId: pane.id, promptDelivery: 'sent'});
  });
  const active = items[0]!;
  fs.writeFileSync(path.join(w.config.stateDir, active.window, 'prompt-queue.json'), JSON.stringify([
    {id: 'fixture-follow-up', text: 'Queued follow-up.', queuedAt: new Date(w.runner.now()).toISOString()}
  ]));
  const open = t.mock.method(fs, 'openSync');
  const memory = new WatchMemory();
  t.after(() => memory.launchHealth?.close());
  await watchTick(w.ctx, memory, notifier);
  const locks = open.mock.calls.map(call => String(call.arguments[0])).filter(file => file.endsWith('/prompt-queue.json.lock'));
  assert.deepEqual(locks, [path.join(w.config.stateDir, active.window, 'prompt-queue.json.lock')]);
});

test('REVIEW0256-LEGACY: dead legacy launching tasks are journaled once and wait for a named resume', async () => {
  const w = world('legacy');
  w.tmux.add('unrelated', '❯ ');
  const task = seedTask(w.config, 'LEGACY-1', {windowId: '@989', promptDelivery: 'launching', repos: [{path: w.repo, worktree: w.repo}]});
  const memory = new WatchMemory();
  try {
    await watchTick(w.ctx, memory, notifier);
    await watchTick(w.ctx, memory, notifier);
    assert.equal(w.tmux.windows.some(window => window.name.endsWith(task.window)), false);
    assert.equal(readJournal(w.config).filter(event => String(event.kind) === 'launch-legacy' && event.task === task.task).length, 1);
    assert.equal((await planResume(w.ctx, [])).items.some(item => item.task === task.task), false);
    assert.equal((await planResume(w.ctx, [task.task])).items[0]?.task, task.task);
  } finally { memory.launchHealth?.close(); }
});

test('REL0272-LEGACY-JOURNAL: legacy launch events share a single append', async t => {
  const w = world('legacy-batch');
  w.tmux.add('unrelated', '❯ ');
  for (let index = 0; index < 3; index++) seedTask(w.config, `BATCH-${index}`, {windowId: `@${989 + index}`, promptDelivery: 'launching'});
  const write = t.mock.method(w.runner, 'appendFile');
  const memory = new WatchMemory();
  t.after(() => memory.launchHealth.close());
  for (let tick = 0; tick < 2; tick++) await watchTick(w.ctx, memory, notifier);
  const legacyWrites = write.mock.calls.filter(call => String(call.arguments[0]).endsWith('/journal.jsonl') && String(call.arguments[1]).includes('launch-legacy'));
  assert.equal(legacyWrites.length, 1);
  assert.equal(readJournal(w.config).filter(event => event.kind === 'launch-legacy').length, 3);
});

test('REL0272-JOURNAL-APPEND: a torn last line does not absorb the next journal event', async () => {
  const w = world('journal-append');
  const file = path.join(path.dirname(w.config.path), 'journal.jsonl');
  const event = (text: string) => JSON.stringify({kind: 'watch-resumed', text, at: '2026-01-01T00:00:00Z'}) + '\n';
  fs.writeFileSync(file, event('old') + '{"torn":');
  const inode = fs.statSync(file).ino;
  await new RealRunner().appendFile(file, event('next'));
  assert.deepEqual(readJournal(w.config).map(entry => entry.text), ['old', 'next']);
  assert.equal(fs.statSync(file).ino, inode);
});

test('REL0272-TICK-PANES: many missing windows share one second tmux observation', async () => {
  const w = world('tick-panes');
  w.tmux.add('unrelated', '❯ ');
  for (let index = 0; index < 12; index++) seedTask(w.config, `PANE-${index}`, {windowId: `@${989 + index}`});
  const rows = await collectStatus(w.ctx, {progress: false, verifyWatchLoss: true});
  assert.equal(rows.filter(row => row.task.startsWith('PANE-') && row.window === 'gone').length, 12);
  assert.equal(w.tmux.seen.filter(command => command.startsWith('list-panes')).length, 1);
  assert.ok(!w.tmux.seen.some(command => command.startsWith('display-message @9')));
});

test('REVIEW0256-DOWNGRADE: check lists incompatible keys and prunes only expired overrides', async () => {
  const w = world('downgrade', 'launch: {grace_s: 5}\nlimits: {timed_overrides: {claude: {value: 2, until: 2020-01-01T00:00:00Z}, codex: {value: 2, until: 2099-01-01T00:00:00Z}}}\nquotas: {floor: 1}\n');
  fs.writeFileSync(path.join(path.dirname(w.config.path), 'reservations.json'), JSON.stringify({claude: {count: 1, until: '2099-01-01'}}));
  const r = await runCli(w.config, w.runner, ['config', 'downgrade-check', '--to', '0.26.x']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /launch.*limits.timed_overrides.*quotas.floor/);
  assert.match(r.stdout, /reservations.json.claude.until/);
  const text = fs.readFileSync(w.config.path, 'utf8');
  assert.doesNotMatch(text, /2020-01-01/);
  assert.match(text, /2099-01-01/);
});

test('REVIEW0256-MCP: starting watch fences old direct limits writers and identifies their version', async () => {
  const w = world('mcp-compat', 'mcp: {allow: [set_limits]}\nlimits: {claude: 3}\n');
  await runWatch(w.ctx, notifier, {maxTicks: 1, insideTmux: false});
  assert.match(fs.readFileSync(w.config.path, 'utf8'), /change_policy: owner-approve/);
  const tool = MCP_TOOLS.find(tool => tool.name === 'set_limits')!;
  const result = await tool.run({context: () => w.ctx, notify: async () => {},
    server: {version: '0.26.1', script: 'fixture', pid: 1, started: '2026-01-01'}}, {claude: 17, confirm: true});
  assert.ok(result.isError);
  assert.match(result.text, /⌘Q/);
  assert.equal(w.ctx.config.limits.claude, 3);
});

test('REVIEW0256-EVENTS: scoped events reuse headers and respect recorded chat ownership', async t => {
  const w = world('events');
  seedTask(w.config, 'EVENT-1', {owner: 'chat:nc', closed: true});
  seedTask(w.config, 'EVENT-2', {owner: 'chat:hems', closed: true});
  const time = new Date(w.runner.now()).toISOString();
  fs.writeFileSync(path.join(path.dirname(w.config.path), 'journal.jsonl'), [
    {at: time, kind: 'dead', task: 'EVENT-1', text: 'NC visible'},
    {at: time, kind: 'dead', task: 'EVENT-1', owner: 'chat:hems', text: 'Owner changed'},
    {at: time, kind: 'dead', task: 'EVENT-2', text: 'Other chat'},
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const opts = {client: 'mcp' as const, since: '1d', keep: true, chat: 'chat:nc'};
  await collectEvents(w.ctx, opts);
  const read = t.mock.method(fs, 'openSync');
  const events = await collectEvents(w.ctx, opts);
  assert.deepEqual(events.events.filter(e => e.kind === 'dead').map(e => e.text), ['NC visible']);
  assert.equal(read.mock.calls.filter(c => String(c.arguments[0]).endsWith('/TASK.md')).length, 0);
});

test('FIX-5246F46: an interrupted checkout before a worktree exists stays under queue ownership', async () => {
  const w = world('queued-verdict');
  seedTask(w.config, 'NO-TREE', {started: '', promptDelivery: 'launching',
    repos: [{path: w.repo, worktree: path.join(w.repo, 'missing')}]});
  assert.equal((await collectStatus(w.ctx, {progress: false})).some(row => row.task === 'NO-TREE'), false);
});
