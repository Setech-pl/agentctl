import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement as h } from 'react';
import { stringify } from 'yaml';
import { loadGlobalConfig, type AgentName, type GlobalConfig } from './config.ts';
import { Context } from './context.ts';
import { CANARY_PROMPT, CanaryRunner } from './canary-runner.ts';
import { archiveDir, listTaskRecords, listArchivedRecords, readTaskRecord, renderTaskMd, taskFile, type TaskRecord } from './taskstore.ts';
import { queueViews, readQueue, saveEntry } from './queue.ts';
import { sendPrompts } from './send.ts';
import { runWatch } from './watch.ts';
import { watchHeartbeatPath, watchSnapshotPath } from './watch-snapshot.ts';
import { MCP_TOOLS, type McpDeps } from './mcp-tools.ts';
import { readMcpRequest } from './mcp-requests.ts';
import { channelFile } from './wall.ts';
import { touchCohort } from './cohort.ts';
import { type DiskReport } from './disk.ts';
import { insidePath } from './worktree-volume.ts';
import { providerHoldFile } from './provider-hold.ts';
import { activeProviders } from './providers/registry.ts';

const chats = ['canarya', 'canaryb', 'canaryc', 'canaryd'];
const notifier = { notify: async () => {} };
const ID = 'CANARYFIX';
const GC_COHORT = 'Canary-GC';
const fixtureTasks = (scale: boolean) => scale ? 1500 : 12;
const date = (at: number) => new Date(at).toISOString();
const successReport = (verdict: string) => `Werdykt: ${verdict}\n\n<!-- agentctl:report-end -->\n`;

export function canaryCacheDir(forbidden: string[] = []): string {
  const dir = process.env.AGENTCTL_LIVE_CACHE ?? path.join(os.homedir(), '.cache', 'agentctl-canary');
  if (!path.isAbsolute(dir)) throw Error('Canary cache directory must be absolute');
  const resolve = (target: string): string => {
    if (fs.existsSync(target)) return fs.realpathSync(target);
    const parent = path.dirname(target);
    return parent === target ? target : path.join(resolve(parent), path.basename(target));
  };
  const target = resolve(dir);
  if (forbidden.some(source => insidePath(resolve(source), target))) throw Error('Canary cache must be outside the source state and cache directories');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  return fs.realpathSync(dir);
}

export interface CanaryWorld {
  config: GlobalConfig;
  runner: CanaryRunner;
  ctx: Context;
  deps: McpDeps;
  repo: string;
  volume: string;
  order: (task: string, agent: 'claude' | 'codex', after?: string) => string;
}

export function createCanaryWorld(root: string, out: (line: string) => void, slowMs = 0, interval = 1): CanaryWorld {
  const home = path.join(root, 'home'), repo = path.join(root, 'repo'), volume = path.join(root, 'volumes', 'Crucial');
  const session = 'agentctl-canary';
  const chatQuotas = Object.fromEntries(chats.map((chat, i) => [chat, i % 2 ? {claude: 2} : {codex: 2}]));
  const providers = {claude: 10, codex: 6, kimi: 1};
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
  fs.mkdirSync(volume, {recursive: true});
  fs.writeFileSync(path.join(home, 'config.yaml'), stringify({
    cache: path.join(root, 'cache'), state_dir: path.join(home, 'tasks'), session, providers: Object.keys(providers),
    report: {settle_s: 0, clean_worktree_cache: false},
    watch: {interval, window_icons: false},
    worktrees: {root: volume, mount: volume},
    queue: {parallel_starts: 10, max_parallel_setups: 10},
    limits: {...providers, count_external: false},
    quotas: {chats: chatQuotas},
    disk: {min_free_start_gb: 1, min_free_state_gb: 1},
    capacity: {codex_refresh: false, kimi_usage_probe: false},
    collisions: {enabled: false},
    notify: {events: false},
    mcp: {allow: ['queue', 'close', 'gc'], max_response_kb: 1024},
    usage: {claude_dir: path.join(root, 'claude'), codex_dir: path.join(root, 'codex')},
  }), {mode: 0o600});
  const config = loadGlobalConfig(home);
  const runner = new CanaryRunner(root, session, slowMs);
  runner.addPane('watch', 'unknown');
  const ctx = new Context(runner, config, out);
  ctx.fetch = async () => { throw Error('Network is disabled in the release canary'); };
  const deps = {context: () => ctx, notify: async () => {}};
  const order = (task: string, agent: 'claude' | 'codex', after?: string) => `---\n${stringify({
    task, agent, repos: [{path: repo, worktree: path.join(volume, task.toLowerCase())}],
    ...(after ? {after} : {}),
  })}---\n${CANARY_PROMPT}\n`;
  return {config, runner, ctx, deps, repo, volume, order};
}

/** The shim applies only to the disposable filesystem. It never opens or mounts a production volume. */
export function useCanaryFilesystem(world: CanaryWorld, latency: number): () => void {
  const stat = fs.statSync, statfs = fs.promises.statfs, statfsSync = fs.statfsSync;
  const root = world.runner.root, external = world.volume;
  fs.statSync = ((target: fs.PathLike, options?: object) => {
    const value = Reflect.apply(stat, fs, [target, options]) as fs.Stats | fs.BigIntStats | undefined;
    if (!value || typeof target !== 'string' || !insidePath(external, path.resolve(target))) return value;
    return Object.assign(Object.create(value), {dev: typeof value.dev === 'bigint' ? value.dev + 1n : value.dev + 1});
  }) as typeof stat;
  const counters = (target: fs.PathLike, stats: fs.StatsFs | fs.BigIntStatsFs) => {
    if (typeof target !== 'string' || !insidePath(root, path.resolve(target))) return stats;
    const block = Number(stats.bsize);
    return {...stats, blocks: Math.floor(1024 ** 4 / block), bavail: Math.floor(200 * 1024 ** 3 / block)};
  };
  fs.statfsSync = ((target: fs.PathLike, options?: object) => counters(target, Reflect.apply(statfsSync, fs, [target, options]))) as typeof statfsSync;
  fs.promises.statfs = (async (target: fs.PathLike, options?: object) => {
    if (latency && typeof target === 'string' && insidePath(root, path.resolve(target))) await world.runner.sleep(latency);
    return counters(target, await Reflect.apply(statfs, fs.promises, [target, options]));
  }) as typeof statfs;
  return () => { fs.statSync = stat; fs.statfsSync = statfsSync; fs.promises.statfs = statfs; };
}

export function seedCanaryRecord(world: CanaryWorld, record: TaskRecord, archived = false, verdict?: string, mtime?: number): void {
  const file = archived ? path.join(archiveDir(world.config), record.window, 'TASK.md') : taskFile(world.config, record.window);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, renderTaskMd(record, CANARY_PROMPT), {mode: 0o600});
  if (verdict) {
    fs.mkdirSync(path.dirname(record.report), {recursive: true});
    fs.writeFileSync(record.report, successReport(verdict), {mode: 0o600});
    if (mtime && Number.isFinite(mtime)) fs.utimesSync(record.report, mtime / 1000, mtime / 1000);
  }
}

function fixtureRecord(world: CanaryWorld, task: string, agent: AgentName = 'claude'): TaskRecord {
  const window = task.toLowerCase(), started = date(Date.UTC(2025, 10, 25, 12));
  const model = agent === 'codex' ? 'gpt-5.5' : 'opus';
  return { task, window, session: world.config.session, agent, model, effort: 'high',
    started, requested: {agent, model, effort: 'high'}, env: {}, links: [], repos: [],
    report: path.join(world.config.cache, window, 'report.md') };
}

export function seedCanaryWall(world: CanaryWorld, times: readonly string[]): void {
  const file = channelFile(world.config, 'agentctl');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const posts = times.map((ts, i) => JSON.stringify({v: 1, type: 'post', id: `agentctl-${i + 1}`, seq: i + 1,
    ts, channel: 'agentctl', from: 'owner', kind: 'info', subject: 'Canary fixture', body: '', refs: [], replyTo: null, status: 'answered'}));
  fs.writeFileSync(file, posts.join('\n') + '\n', {mode: 0o600});
}

async function seedFixture(world: CanaryWorld, scale: boolean, mirror: boolean) {
  const {config, ctx, runner} = world;
  const count = fixtureTasks(scale);
  const wallCount = scale ? 150 : 0;
  if (scale) seedCanaryWall(world, Array.from({length: wallCount}, (_, i) => date(Date.UTC(2025, 10, 25, 12, 0, i))));
  for (let i = 0; i < count; i++) {
    const task = `${ID}-ROW-${i}`, archived = i >= 10 && i % 5 !== 0;
    const record = fixtureRecord(world, task, i === 6 ? 'codex' : 'claude');
    if (i < 6) {
      const screen = ['Working (esc to interrupt)', '❯ ', 'Quick safety check', 'Enter to select · Esc to cancel', 'Usage limit reached', 'Update available! Run: brew upgrade claude-code'][i];
      record.windowId = runner.addPane(record.window, record.agent, screen).id;
    } else if (i === 6) {
      record.windowId = runner.addPane(record.window, 'codex', 'Working (esc to interrupt)').id;
    } else if (i >= 9) {
      if (i % 7 === 0) record.cancelled = true;
      else record.closed = true;
    }
    for (let copy = 0; copy < (i < count / 2 ? 2 : 1); copy++) {
      const external = i % 3 === 0, worktree = path.join(external ? world.volume : runner.root, `wt-${i}-${copy}`);
      runner.addWorktree(world.repo, worktree, 'HEAD', i === 9 && copy === 0);
      record.repos.push({path: world.repo, worktree, ...(external ? {worktreeMount: world.volume} : {})});
    }
    if (i === 9 || i === 10) record.cohort = GC_COHORT;
    seedCanaryRecord(world, record, archived, i === 5 || archived && i % 10 === 1 ? 'PASS' : undefined);
  }
  await touchCohort(ctx, GC_COHORT);
  const prepared: {task: string; after?: string; owner: string; agent: 'claude' | 'codex'}[] = [];
  const chains = scale ? 8 : 1, depth = scale ? 5 : 1;
  for (let chain = 0; chain < chains; chain++) {
    const owner = `chat:${chats[chain % chats.length]}`;
    const agent = chain % 2 === 0 ? 'codex' : 'claude';
    for (let item = 0; item < depth; item++) {
      const task = `${ID}-${chain}-${item}`, after = item ? `${ID}-${chain}-${item - 1}` : undefined;
      const seq = 900000 + prepared.length;
      await saveEntry(ctx, {task, status: 'queued', seq, order: mirror ? -1 : seq, owner, priority: mirror ? 'high' : 'normal', agent,
        model: agent === 'codex' ? 'gpt-5.5' : 'opus', effort: 'high', after: after ? [after] : [],
        queuedAt: date(runner.now()), spec: world.order(task, agent, after)});
      prepared.push({task, ...(after ? {after} : {}), owner, agent});
    }
  }
  const holds = {holds: {codex: {source: 'manual', until: date(runner.now() + 3_600_000), scope: 'global'}}, seen: {}};
  if (scale) fs.writeFileSync(providerHoldFile(config), JSON.stringify(holds), {mode: 0o600});
  return {count, prepared, wallCount: scale ? wallCount : 0};
}

const badRead = /bounded fallback|budget exhausted|partial result: 8 s|short queue\/journal fallback/i;
export async function canaryRead(deps: McpDeps, name: string, args: Record<string, unknown>, limit = 8000): Promise<{text: string; ms: number}> {
  const tool = MCP_TOOLS.find(t => t.name === name);
  assert.ok(tool, `Missing MCP tool ${name}`);
  const start = performance.now();
  const result = await tool.run(deps, args);
  assert.ok(!result.isError, `${name}: ${result.text.slice(0, 500)}`);
  type Page = { response_id: string; next_response_offset: number; response_offset: number; has_more: boolean; fragment: string };
  const page = (text: string): Page | undefined => {
    try {
      const value = JSON.parse(text);
      return value?.truncated === true && typeof value.response_id === 'string' && typeof value.fragment === 'string' ? value : undefined;
    } catch { return undefined; }
  };
  const first = page(result.text);
  let text = result.text;
  if (first) {
    const continuation = MCP_TOOLS.find(t => t.name === 'response_page')!;
    let current = first;
    const fragments = [first.fragment];
    while (current.has_more) {
      assert.ok(performance.now() - start < limit, `MCP_LATENCY ${name}: paging exceeded budget`);
      const next = await continuation.run(deps, {response_id: current.response_id, response_offset: current.next_response_offset});
      const parsed = page(next.text);
      assert.ok(!next.isError && parsed && parsed.response_offset === current.next_response_offset
        && parsed.next_response_offset > parsed.response_offset && fragments.length < 8192, `${name}: invalid continuation`);
      fragments.push(parsed.fragment);
      current = parsed;
    }
    text = fragments.join('');
  }
  const ms = performance.now() - start;
  assert.ok(ms < limit, `MCP_LATENCY ${name}: ${ms.toFixed(1)} ms`);
  assert.doesNotMatch(text, badRead, `${name}: fallback response`);
  return {text, ms};
}

export async function renderCanaryHeader(config: GlobalConfig, disk: DiskReport): Promise<string> {
  const [{Box, renderToString}, {BoardDisk, BoardLimits}] = await Promise.all([import('ink'), import('../board/header.ts')]);
  const render = renderToString(h(Box, {flexDirection: 'column'}, h(BoardDisk, {disk}), h(BoardLimits, {config})), {columns: 150});
  assert.match(render, /Disk: .*free \d/);
  assert.match(render, /Limity: /);
  for (const agent of activeProviders(config)) assert.ok(render.includes(`${agent} ${config.limits[agent] ?? '∞'}`));
  return render;
}

export const MCP_HEALTH_READS = [
  ['status', {format: 'json', all: true, limit: 100}],
  ['limits', {format: 'json'}],
  ['capacity', {format: 'json'}],
  ['queue_list', {format: 'json'}],
  ['events_since', {format: 'json', since: '1d', peek: true, limit: 20}],
  ['usage', {}],
] as const;

type Snapshot = {at: number; rows: {task: string; state: string; verdict?: string}[]; degraded?: string; capacity: {disk: DiskReport}; queue: {task: string; startCondition: string}[]};
const readSnapshot = (config: GlobalConfig): Snapshot => JSON.parse(fs.readFileSync(watchSnapshotPath(config), 'utf8'));
export interface CanaryMetrics {
  ticks: number; tasks: number; worktreeDirs: number; queued: number; wall: number;
  started: number; maxStartTicks: number; maxSnapshotAgeMs: number; maxMcpMs: number;
  maxSkipped: number; peakLoad1: number; minLoad1: number;
}

export async function exerciseCanary(world: CanaryWorld, opts: {
  scale: boolean; mirror?: boolean; minTicks: number; durationMs?: number; signal?: AbortSignal; load?: () => number; sample?: (metrics: CanaryMetrics) => void;
}): Promise<CanaryMetrics> {
  const {config, runner, ctx, deps} = world;
  const mirrored = opts.mirror ? listTaskRecords(config).length + listArchivedRecords(config).length : 0;
  const shape = await seedFixture(world, opts.scale, opts.mirror === true);
  const mirroredReady = new Map<string, number>();
  const begin = runner.now();
  const metrics: CanaryMetrics = {ticks: 0, tasks: shape.count + mirrored, worktreeDirs: runner.worktrees.size,
    queued: shape.prepared.length, wall: shape.wallCount, started: 0, maxStartTicks: 0, maxSnapshotAgeMs: 0, maxMcpMs: 0,
    maxSkipped: 0, peakLoad1: 0, minLoad1: Infinity};
  const readyAt = new Map<string, number>(), completed = new Set<string>();
  const stop = new AbortController();
  const signal = opts.signal ? AbortSignal.any([stop.signal, opts.signal]) : stop.signal;
  let requests: string[] = [], gcPreviewId: string | undefined, previousSnapshot: number | undefined;
  const sendTask = `${ID}-ROW-6`;
  const extraTask = `${ID}-PREVIEW`;
  const dirtyPath = path.join(world.volume, 'wt-9-0', 'only-copy');
  const cleanPath = path.join(runner.root, 'wt-10-0');
  const measure = async (name: string, args: Record<string, unknown>) => {
    const value = await canaryRead(deps, name, args);
    metrics.maxMcpMs = Math.max(metrics.maxMcpMs, value.ms);
    return value.text;
  };
  const register = async (name: string, args: Record<string, unknown>) => {
    const preview = await measure(name, args);
    const token = /^preview_token: (\S+)$/m.exec(preview)?.[1];
    assert.ok(token, `${name} preview token missing: ${preview.slice(0, 400)}`);
    const response = await measure(name, {preview_token: token, confirm: true});
    if (name === 'queue') {
      assert.ok(readQueue(config).some(entry => entry.task === extraTask && entry.status === 'accepted'), 'confirmed order was not accepted');
      return;
    }
    const id = /^request_id: (\S+)$/m.exec(response)?.[1];
    assert.ok(id, `${name} confirmation did not reach watch: ${response.slice(0, 500)}`);
    requests.push(id);
  };
  const markEligible = (tick: number) => {
    for (const probe of shape.prepared) {
      if (readyAt.has(probe.task) || probe.after && !completed.has(probe.after) || opts.scale && probe.agent === 'codex' && tick < 3) continue;
      readyAt.set(probe.task, tick);
    }
  };
  runner.tick = 1;
  markEligible(1);
  await runWatch(ctx, notifier, {signal, insideTmux: false, async onTick(tick, memory) {
    metrics.ticks = tick;
    await memory.queue.idle();
    const snap = readSnapshot(config);
    const age = runner.now() - snap.at;
    if (previousSnapshot !== undefined) assert.ok(snap.at - previousSnapshot < 60_000, 'watch publication gap reached 60 seconds');
    previousSnapshot = snap.at;
    metrics.maxSnapshotAgeMs = Math.max(metrics.maxSnapshotAgeMs, age);
    assert.ok(age < 60_000 && !snap.degraded, `snapshot age ${age} ms, degraded=${snap.degraded ?? 'no'}`);
    assert.ok(snap.rows.length >= metrics.tasks, `partial watch snapshot: ${snap.rows.length} < ${metrics.tasks}`);
    const heartbeat = JSON.parse(fs.readFileSync(watchHeartbeatPath(config), 'utf8')) as {consecutive?: Record<string, number>};
    metrics.maxSkipped = Math.max(metrics.maxSkipped, ...Object.values(heartbeat.consecutive ?? {}));
    assert.ok(metrics.maxSkipped <= 3, `watch stages skipped: ${JSON.stringify(heartbeat.consecutive)}`);
    if (opts.load) {
      const load = opts.load();
      metrics.peakLoad1 = Math.max(metrics.peakLoad1, load);
      metrics.minLoad1 = Math.min(metrics.minLoad1, load);
    }
    if (tick === 1 || tick % 5 === 0 || tick === opts.minTicks) {
      const status = JSON.parse(await measure('status', {format: 'json', all: true, limit: 100}));
      assert.equal(status.tasks?.length, Math.min(100, snap.rows.length) + snap.queue.filter(entry => !snap.rows.some(row => row.task === entry.task)).length);
      const limits = JSON.parse(await measure('limits', {format: 'json'}));
      assert.ok(limits, 'missing limits data');
      const capacity = JSON.parse(await measure('capacity', {format: 'json'}));
      assert.ok(capacity.disk?.volumes?.length > 0 && capacity.providers?.length >= 2, 'missing disk/provider capacity');
      const queue = JSON.parse(await measure('queue_list', {format: 'json'}));
      assert.equal(queue.length, snap.queue.length, 'queue list omitted orders');
      const events = JSON.parse(await measure('events_since', {since: '1d', format: 'json', peek: true, limit: 20}));
      assert.ok(Array.isArray(events.events), 'events_since omitted its event page');
      const usage = await measure('usage', {});
      assert.match(usage, /"plans":/, 'usage omitted plan facts');
      await renderCanaryHeader(config, snap.capacity.disk);
    }
    if (tick === 1 && opts.scale) {
      assert.ok(snap.queue.some(item => item.task === `${ID}-0-0` && /wstrzymane.*codex/i.test(item.startCondition)), 'manual hold missing from full queue data');
    }
    if (tick === 1) {
      const sent = await sendPrompts(ctx, [{task: sendTask, window: sendTask.toLowerCase(), prompt: CANARY_PROMPT}]);
      assert.equal(sent[0]?.outcome, 'queued_until_turn_end');
      runner.addPane(sendTask.toLowerCase(), 'codex');
    }
    if (tick === 2) {
      if (opts.scale) fs.writeFileSync(providerHoldFile(config), '{"holds":{},"seen":{}}');
      await register('queue', {spec: world.order(extraTask, 'codex')});
      await register('close', {task: `${ID}-ROW-0`});
      const preview = await measure('gc_preview', {cohort: GC_COHORT});
      gcPreviewId = /^request_id: (\S+)$/m.exec(preview)?.[1];
      assert.ok(gcPreviewId, 'GC did not hand the preview to watch');
    }
    if (tick === 3) {
      const preview = JSON.parse(await measure('gc_preview', {request_id: gcPreviewId}));
      assert.ok(preview.preview && preview.sections?.uncommitted?.count === 1, 'GC preview omitted the only data copy');
      await register('gc', {request_id: gcPreviewId});
    }
    if (tick === 4) {
      for (const id of requests) assert.equal(readMcpRequest(config, id)?.status, 'done');
      assert.ok(readTaskRecord(config, `${ID.toLowerCase()}-row-0`)?.closed, 'confirmed close did not close its task');
      assert.ok(fs.existsSync(dirtyPath), 'confirmed GC removed a data-carrying worktree');
      assert.ok(!fs.existsSync(cleanPath), 'confirmed GC did not remove its safe candidate');
      assert.ok(runner.delivered.has(sendTask.toLowerCase()), 'queued send did not reach the idle pane');
      requests = [];
    }
    for (const probe of shape.prepared) {
      if (completed.has(probe.task)) continue;
      const admissible = readyAt.get(probe.task);
      const launched = runner.launches.get(probe.task.toLowerCase());
      if (launched === undefined) {
        assert.ok(admissible === undefined || tick - admissible < 1, `${probe.task}: no start in two admissible ticks`);
        continue;
      }
      if (admissible === undefined) assert.fail(`${probe.task}: started before admissible`);
      metrics.maxStartTicks = Math.max(metrics.maxStartTicks, launched - admissible + 1);
      metrics.started++;
      completed.add(probe.task);
      const record = readTaskRecord(config, probe.task.toLowerCase());
      assert.ok(record, `${probe.task}: launch lacks TASK.md`);
      fs.writeFileSync(record.report, successReport('PASS'));
      runner.panes.delete(record.window);
    }
    if (opts.mirror) {
      const views = (await queueViews(ctx)).filter(view => view.entry.task.startsWith('SHADOW-'));
      for (const [task, eligible] of mirroredReady) {
        const launched = runner.launches.get(task.toLowerCase());
        const view = views.find(item => item.entry.task === task);
        if (launched !== undefined || view?.condition.kind !== 'ready') mirroredReady.delete(task);
        else assert.ok(tick < eligible + 1, `${task}: mirror admission missed two ticks`);
      }
      for (const view of views) if (view.condition.kind === 'ready' && !mirroredReady.has(view.entry.task)) mirroredReady.set(view.entry.task, tick + 1);
      // Mirror panes are simulated no-ops so later dependencies can be observed.
      for (const [window] of runner.launches) if (window.startsWith('shadow-') && runner.panes.has(window)) {
        const record = readTaskRecord(config, window);
        if (record) fs.writeFileSync(record.report, successReport('PASS'));
        runner.panes.delete(window);
      }
    }
    runner.tick = tick + 1;
    markEligible(runner.tick);
    opts.sample?.(metrics);
    if (tick >= opts.minTicks && runner.now() - begin >= (opts.durationMs ?? 0)) stop.abort();
  }});
  if (opts.signal?.aborted) throw Error('Canary interrupted');
  assert.equal(metrics.started, shape.prepared.length, `queued tasks remained: ${readQueue(config).map(entry => entry.task).join(', ')}`);
  assert.ok(metrics.maxStartTicks <= 2, 'queue start exceeded two ticks');
  assert.ok(runner.launches.has(extraTask.toLowerCase()) || opts.mirror && readQueue(config).some(entry => entry.task === extraTask && entry.status === 'queued'), `confirmed queue order never started: ${JSON.stringify(readSnapshot(config).queue.find(entry => entry.task === extraTask))}`);
  if (!opts.load) metrics.minLoad1 = 0;
  return metrics;
}

export async function runIsolatedCanary<T>(root: string, out: (line: string) => void, action: (world: CanaryWorld) => Promise<T>, slowMs = 0): Promise<T> {
  const sandbox = fs.mkdtempSync(path.join(root, 'canary-'));
  const previousKimi = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = path.join(sandbox, 'kimi');
  try {
    const world = createCanaryWorld(sandbox, out, slowMs);
    const restore = useCanaryFilesystem(world, slowMs);
    try { return await action(world); }
    finally { restore(); }
  } finally {
    if (previousKimi === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = previousKimi;
    fs.rmSync(sandbox, {recursive: true, force: true});
  }
}
