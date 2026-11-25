import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { canaryCacheDir, exerciseCanary, runIsolatedCanary, seedCanaryRecord, seedCanaryWall, type CanaryWorld } from './canary.ts';
import { CANARY_PROMPT } from './canary-runner.ts';
import { loadGlobalConfig, type GlobalConfig } from './config.ts';
import { listArchivedRecords, listTaskRecords, type TaskRecord } from './taskstore.ts';
import { channelMessages } from './wall.ts';
import { readQueue, saveEntry } from './queue.ts';
import { dependencyVerdict } from './outputs.ts';
import { splitSpecs } from './spec.ts';
import { watchSnapshotPath } from './watch-snapshot.ts';
import { chatOwner } from './chat-quotas.ts';
import { providerHolds } from './provider-hold.ts';
import { secretRedactor } from './secret-redaction.ts';
import { isObject, resolvePath } from './util.ts';
import { inferredWorktreeMount } from './worktree-volume.ts';

const fixedDate = '2025-11-25T12:00:00.000Z';
const time = (at: unknown): string | undefined => typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : undefined;
const safeNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function screenFor(state: unknown, codex: boolean): string | undefined {
  if (state === 'working') return 'Working (esc to interrupt)';
  if (state === 'background') return codex ? '1 background terminal running' : '1 shell still running';
  if (state === 'needs-trust') return codex ? 'Trust this folder?' : 'Yes, I trust this folder';
  if (state === 'needs-input') return codex ? 'Waiting for your answer' : 'Enter to select · Esc to cancel';
  if (state === 'limited') return 'Usage limit reached';
  if (state === 'overloaded') return '■ Overloaded';
  return undefined;
}

/** Put only known operational fields in the mirror. No source path is used for command execution or report reads. */
export async function mirrorCanary(world: CanaryWorld, source: GlobalConfig) {
  const current = listTaskRecords(source), archive = listArchivedRecords(source);
  const active = new Set(current.map(record => record.task));
  const queued = readQueue(source);
  const known = new Map<string, string>();
  const idFor = (original: string) => {
    if (!known.has(original)) known.set(original, `SHADOW-${known.size + 1}`);
    return known.get(original)!;
  };
  const rows = new Map<string, Record<string, unknown>>();
  try {
    const snapshot = JSON.parse(fs.readFileSync(watchSnapshotPath(source), 'utf8'));
    if (Array.isArray(snapshot.rows)) for (const row of snapshot.rows) if (isObject(row) && typeof row.task === 'string') rows.set(row.task, row);
  } catch { /* older installations may not have a watch snapshot */ }
  const redact = secretRedactor([source.env, source.agents, source.providersConfig, source.notify]);
  const paths = new Map<string, string>();
  const seen = new Map<string, string>();
  const mapPath = (original: string, kind: 'repo' | 'worktree', mount?: string): string => {
    if (kind === 'worktree' && seen.has(original)) return seen.get(original)!;
    const key = `${kind}:${original}`;
    const existing = paths.get(key);
    if (existing) return existing;
    const parent = mount || inferredWorktreeMount(original) ? world.volume : world.runner.root;
    const target = path.join(parent, `mirror-${kind}-${paths.size}`);
    paths.set(key, target);
    if (kind === 'worktree') seen.set(original, target);
    else fs.mkdirSync(path.join(target, '.git'), {recursive: true});
    return target;
  };
  const ownerIds = new Map<string, string>();
  const ownerFor = (owner: string | undefined) => {
    if (!owner || !chatOwner(owner) || owner === 'default') return 'default';
    if (!ownerIds.has(owner)) ownerIds.set(owner, `chat:mirrored${ownerIds.size + 1}`);
    return ownerIds.get(owner)!;
  };
  const occupied = {claude: 0, codex: 0};
  const combined = [...current.map(record => ({record, archived: false})), ...archive.filter(r => !active.has(r.task)).map(record => ({record, archived: true}))];
  for (const {record, archived} of combined) {
    const task = idFor(record.task), window = task.toLowerCase();
    const row = rows.get(record.task);
    const agent = record.agent === 'codex' ? 'codex' : 'claude';
    const repos = record.repos.map(r => {
      const repo = mapPath(r.path, 'repo');
      const external = Boolean(r.worktreeMount ?? inferredWorktreeMount(r.worktree));
      const worktree = r.path === r.worktree ? repo : mapPath(r.worktree, 'worktree', external ? world.volume : undefined);
      if (!world.runner.worktrees.has(worktree) && repo !== worktree) world.runner.addWorktree(repo, worktree);
      return {path: repo, worktree, ...(external ? {worktreeMount: world.volume} : {})};
    });
    const model = agent === 'codex' ? 'gpt-5.5' : 'opus';
    const clean: TaskRecord = {
      task, window, session: world.config.session, agent, model, effort: record.effort, repos,
      links: [], env: {}, requested: {agent, model, effort: 'high'},
      report: path.join(world.config.cache, window, 'report.md'), started: time(record.started) ?? fixedDate,
      owner: ownerFor(record.owner), ...(record.closed ? {closed: true} : {}), ...(record.cancelled ? {cancelled: true} : {}),
      ...(time(record.closedAt) ? {closedAt: time(record.closedAt)} : {}),
      ...(time(record.cancelledAt) ? {cancelledAt: time(record.cancelledAt)} : {}),
      ...(time(record.pulled) ? {pulled: time(record.pulled)} : {}),
      ...(record.pin ? {pin: true} : {}), ...(record.keepCache ? {keepCache: true} : {}),
      ...(record.hidden ? {hidden: true} : {}),
      ...(record.supersededBy ? {supersededBy: idFor(record.supersededBy)} : {}),
    };
    const verdict = typeof row?.verdict === 'string' ? dependencyVerdict(`Verdict: ${row.verdict}`) : undefined;
    if (!archived && !record.closed && !record.cancelled && row?.window === 'alive') {
      clean.windowId = world.runner.addPane(window, agent, screenFor(row.state, agent === 'codex')).id;
      occupied[agent]++;
    }
    seedCanaryRecord(world, clean, archived, verdict ?? (row?.state === 'report-ready' ? 'BLOCKED' : undefined), safeNumber(row?.reportMtime));
  }
  // Reserve capacity for the fixture controls even when the source snapshot had every slot occupied.
  // The mirror keeps the original limits in its private manifest.
  const config = parse(fs.readFileSync(world.config.path, 'utf8'));
  for (const agent of ['claude', 'codex'] as const) config.limits[agent] += occupied[agent];
  fs.writeFileSync(world.config.path, stringify(config), {mode: 0o600});
  world.ctx.setConfig(loadGlobalConfig(path.dirname(world.config.path)));
  world.config = world.ctx.config;
  let seq = 0;
  for (const entry of queued) {
    const task = idFor(entry.task), owner = ownerFor(entry.owner);
    const agent = entry.agent === 'codex' ? 'codex' : 'claude';
    const after = entry.after.map(idFor);
    let sourceRepos: unknown[] = [];
    try {
      const data = splitSpecs(entry.spec, 'shadow source')[0]?.header.repos;
      if (Array.isArray(data)) sourceRepos = data;
    } catch { /* bad old spec is represented by a safe placeholder */ }
    const repos = sourceRepos.flatMap(repo => {
      const original = typeof repo === 'string' ? repo : isObject(repo) && typeof repo.path === 'string' ? repo.path : undefined;
      if (!original) return [];
      const target = isObject(repo) && typeof repo.worktree === 'string' ? repo.worktree : `${original}-${task.toLowerCase()}`;
      return [{path: mapPath(original, 'repo'), worktree: mapPath(target, 'worktree')}];
    });
    if (!repos.length) repos.push({path: world.repo, worktree: path.join(world.volume, task.toLowerCase())});
    const header = {task, agent, repos, ...(after.length ? {after} : {})};
    const spec = `---\n${stringify(header)}---\n${CANARY_PROMPT}\n`;
    const status = entry.status === 'failed' ? 'failed' : 'queued';
    await saveEntry(world.ctx, {task, seq: ++seq, order: seq, status, spec, owner, after, agent,
      model: agent === 'codex' ? 'gpt-5.5' : 'opus', effort: 'high', priority: entry.priority,
      queuedAt: time(entry.queuedAt) ?? fixedDate, ...(time(entry.retryAt) ? {retryAt: time(entry.retryAt)} : {}),
      ...(status === 'failed' ? {error: 'Mirrored failed order'} : {})});
  }
  const wall = Object.keys(source.wall.channels).flatMap(channel => channelMessages(source, channel).flatMap(message => {
    const at = time(message.ts);
    return at ? [at] : [];
  })).sort();
  seedCanaryWall(world, wall);
  const counts = {tasks: combined.length, queued: queued.length, worktreeDirs: world.runner.worktrees.size, wall: wall.length};
  const pathFacts = [...paths].map(([key, target]) => ({source: redact(key.slice(key.indexOf(':') + 1)), target}));
  fs.writeFileSync(path.join(world.runner.root, 'mirror.json'), JSON.stringify({
    ...counts, paths: pathFacts, limits: source.limits, quotas: source.quotas,
    holds: Object.fromEntries(Object.entries(providerHolds(source, Date.now())).map(([agent, hold]) => [agent, hold?.until])),
  }), {mode: 0o600});
  return counts;
}

export async function shadowCanary(from: string, minutes: number, out: (line: string) => void, signal?: AbortSignal) {
  const home = fs.realpathSync(resolvePath(from));
  const source = loadGlobalConfig(home);
  if (!source.loaded) throw Error('Canary source has no config.yaml');
  const root = canaryCacheDir([home, source.stateDir, source.cache]);
  return runIsolatedCanary(root, out, async world => {
    const mirrored = await mirrorCanary(world, source);
    out(`Loaded ${mirrored.tasks} sanitized tasks, ${mirrored.queued} orders, ${mirrored.worktreeDirs} worktrees and ${mirrored.wall} WALL messages.`);
    const canary = await exerciseCanary(world, {scale: false, mirror: true, minTicks: 20, durationMs: minutes * 60_000, ...(signal ? {signal} : {})});
    return {mirrored, canary};
  }, 2);
}
