import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { commitQueueAdd, describeQueue, planQueueAdd, queueTick, QueueMemory, readQueue, saveEntry } from '../src/core/queue.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { DiskRunner, FakeTmux, makeConfig, seedTask, useScratch } from './helpers.ts';
import { writeSetupProgress } from '../src/core/setup-progress.ts';
import { sizeOf } from '../src/core/fs-measure.ts';
const scratch = useScratch();
async function fixture(name: string, yaml = '') {
  const config = makeConfig(scratch.sub(name), yaml);
  const tmux = new FakeTmux();
  const runner = new DiskRunner({dryRun: false, startTime: Date.parse('2026-11-17T12:00:00Z'), respond: tmux.respond});
  const ctx = new Context(runner, config, () => {});
  const repo = scratch.sub(`${name}/repo`);
  const raws = splitSpecs(['A', 'B', 'C'].map(task => `---\ntask: ${task}\nagent: claude\nrepos: [{path: '${repo}', worktree: '${repo}-${task}'}]\n---\nFake.`).join('\n'));
  const plan = await planQueueAdd(ctx, raws);
  await commitQueueAdd(ctx, plan.items);
  return {ctx, config, tmux, runner, repo, raws};
}
it('F3: fresh low disk holds queued and direct starts, including the watcher claim', async t => {
  const f = await fixture('low');
  let free = 18;
  const statfs = () => ({bavail: free, bsize: 1024 ** 3, blocks: 1000});
  t.mock.method(fs, 'statfsSync', statfs);
  t.mock.method(fs.promises, 'statfs', async () => statfs());
  const entries = readQueue(f.config);
  await saveEntry(f.ctx, {...entries[0]!, direct: true});
  let views = describeQueue(f.config, readQueue(f.config), [], [], f.runner.now());
  assert.ok(views.every(v => /^wstrzymane: dysk 18 GB < 30 GB(?: \(.*\))?$/.test(v.condition.text)));
  const memory = new QueueMemory();
  assert.deepEqual(await queueTick(f.ctx, memory, {clickable: false, notify: async () => {}}), []);
  assert.ok(!f.runner.commands.some(c => c.includes('worktree add')));
  free = 31;
  views = describeQueue(f.config, readQueue(f.config), [], [], f.runner.now());
  assert.equal(views[0]!.condition.kind, 'ready');
});
it('F3: max_parallel_setups counts setup phases across providers and frees launching slots', async () => {
  const f = await fixture('slots', 'limits: {claude: 4}\nqueue: {parallel_starts: 4, max_parallel_setups: 1}\ndisk: {min_free_start_gb: 1}');
  assert.equal(f.config.queue.maxParallelSetups, 1);
  const entries = readQueue(f.config);
  await saveEntry(f.ctx, {...entries[0]!, status: 'starting', startingPid: process.pid});
  const at = new Date(f.runner.now()).toISOString();
  await writeSetupProgress(f.ctx, 'a', {task: 'A', phase: 'setup', startedAt: at, stepAt: at});
  assert.equal(describeQueue(f.config, readQueue(f.config), [])[1]!.condition.text, 'czeka na setup: 1/1');
  assert.deepEqual(await queueTick(f.ctx, new QueueMemory(), {clickable: false, notify: async () => {}}), []);
  await saveEntry(f.ctx, {...entries[0]!, status: 'starting', startingPid: process.pid});
  await writeSetupProgress(f.ctx, 'a', {task: 'A', phase: 'launching', startedAt: at, stepAt: at});
  const views = describeQueue(f.config, readQueue(f.config), []);
  assert.equal(views.find(v => v.entry.task === 'B')!.condition.kind, 'ready');
  assert.equal(views.find(v => v.entry.task === 'C')!.condition.kind, 'slot');
});
it('F3: queue preview reports the last measured worktree cost and age per repo', async () => {
  const f = await fixture('estimate');
  const wt = scratch.sub('estimate/previous');
  fs.writeFileSync(`${wt}/payload`, '12345');
  seedTask(f.config, 'OLD', {closed: true, repos: [{path: f.repo, worktree: wt}]});
  await sizeOf(wt, {fresh: true, now: () => f.runner.now() - 60_000});
  const raw = splitSpecs(`---\ntask: NEXT\nagent: claude\nrepos: [{path: '${f.repo}', worktree: '${f.repo}-next'}]\n---\nFake.`);
  const plan = await planQueueAdd(f.ctx, raw);
  assert.match(plan.summary.join('\n'), /worktree estimate repo: .*last reading, 60 s old/);
});

it('F4: status/capacity snapshots use fresh free space and label stale worktree size/policy', async t => {
  const {MCP_TOOLS, publishMcpSnapshot} = await import('../src/core/mcp-tools.ts');
  const f = await fixture('fresh-read');
  const wt = scratch.sub('fresh-read/old');
  fs.writeFileSync(`${wt}/bytes`, '123');
  seedTask(f.config, 'OLD', {repos: [{path: f.repo, worktree: wt}]});
  await sizeOf(wt, {fresh: true, now: () => f.runner.now() - 3600000});
  let free = 80;
  t.mock.method(fs.promises, 'statfs', async () => ({bavail: free, bsize: 1024 ** 3, blocks: 1000}));
  await publishMcpSnapshot(f.ctx);
  free = 18;
  for (const name of ['status', 'capacity']) {
    const r = await MCP_TOOLS.find(t => t.name === name)!.run({context: () => f.ctx, notify: async () => {}}, {format: 'json'});
    const disk = JSON.parse(r.text).disk;
    assert.equal(disk.volumes[0].availableBytes, 18 * 1024 ** 3);
    assert.equal(disk.worktreeAgeSeconds, 3600);
    assert.equal(disk.gcHint, true);
    assert.match(disk.gcPolicyNote, /blocked.*pinned.*dirty/);
  }
});

it('F3: MCP queue preview shows persisted repository cost and current disk admission without inventory scans', async t => {
  const {MCP_TOOLS} = await import('../src/core/mcp-tools.ts');
  const f = await fixture('mcp-cost', 'mcp: {allow: [queue]}');
  const path = await import('node:path');
  fs.writeFileSync(path.join(path.dirname(f.config.path), 'disk-sizes.json'), JSON.stringify({version: 2, entries: [{target: `${f.repo}-old`, repo: f.repo, bytes: 1024 ** 3, at: f.runner.now() - 90000}]}));
  t.mock.method(fs, 'statfsSync', () => ({bsize: 1024 ** 3, bavail: 18, blocks: 1000}));
  const raw = `---\ntask: MCP-NEXT\nagent: claude\nrepos: [{path: '${f.repo}', worktree: '${f.repo}-mcp'}]\n---\nFake.`;
  const result = await MCP_TOOLS.find(t => t.name === 'queue')!.run({context: () => f.ctx, notify: async () => {}}, {spec: raw});
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /worktree estimate repo: 1.00 GB \(last reading, 90 s old\)/);
  assert.match(result.text, /wstrzymane: dysk 18 GB < 30 GB/);
});
