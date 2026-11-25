import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_IDS } from './providers/types.ts';
import type { ProviderId } from './providers/types.ts';
import { checkKeys, parseEnv } from './config.ts';
import type { AgentName } from './config.ts';
import { Problems, expandHome, isObject } from './util.ts';
import { parseAvailability } from './host-availability.ts';
import type { Availability } from './host-availability.ts';
import type { Runner } from './runner.ts';

/*
 * Remote hosts: config, transport, health and task execution. A host is a second machine reached over SSH
 * (WSL, a server, a GPU box) that runs tasks while the dispatcher keeps state and report mirrors. This module holds the config shape and
 * the on-disk health cache; the transport is host-ssh.ts, the probe is host-health.ts.
 *
 * No secrets are ever stored in the hosts config: the SSH identity is a key file path, and auth itself is
 * OpenSSH's job (ssh-agent or an unencrypted key). `config_show` therefore needs no masking for hosts.
 */

export interface HostConfig {
  /** `user@host` as ssh understands it; the hostname is passed to ssh verbatim on every call (no cached IP). */
  ssh: string;
  port: number;
  /** Local path of the private key; undefined: the ssh default (agent/default files). */
  identityFile?: string;
  /** Directory on the host that owns the task work and that disk health reports on. */
  workDir: string;
  /** Repository name (as the specs name it) -> clone path on the host. Tasks use their host's clone; optional fetch-only sync copies task refs to the dispatcher. */
  repos: Record<string, string>;
  /** Provider CLIs installed on this host. */
  providers: ProviderId[];
  /** Per-provider cap of simultaneous remote tasks (in addition to the provider account limit). */
  limits?: Partial<Record<AgentName, number>>;
  /** Extra environment for remote commands (in addition to the provider account limit). */
  env?: Record<string, string>;
  maxTotal?: number;
  loadThreshold?: number;
  availability?: Availability;
  sync?: 'fetch-back' | 'off';
  macSsh?: string;
  fetchRemote?: string;
  trustWorkDir?: boolean;
}

export type LocalHostConfig = Pick<HostConfig, 'limits' | 'maxTotal' | 'loadThreshold' | 'availability'> & { repos?: Record<string, string> };

export interface PlacementConfig {
  default: 'auto' | 'local';
  prefer: string[];
  failoverAfterMs: number;
  chats: Record<string, 'auto' | 'local'>;
  cohorts: Record<string, 'auto' | 'local'>;
}

export interface PerfConfig { waitMaxMs: number; maxArtifactBytes: number }

export function positive(raw: unknown, where: string, p: Problems, integer = true): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && (!integer || Number.isInteger(raw))) return raw;
  p.add(`${where} must be a positive ${integer ? 'integer' : 'number'}`);
}

function duration(raw: unknown, where: string, p: Problems, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw === 'number') return (positive(raw, where, p) ?? fallback / 1000) * 1000;
  const match = typeof raw === 'string' && /^(\d+)(s|m|h)$/.exec(raw);
  if (match && Number(match[1]) > 0) return Number(match[1]) * (match[2] === 'h' ? 3600_000 : match[2] === 'm' ? 60_000 : 1000);
  p.add(`${where} must be seconds or a duration like 10m`);
  return fallback;
}

export function parsePlacement(raw: unknown, p: Problems): PlacementConfig {
  const placement: PlacementConfig = { default: 'local', prefer: ['local'], failoverAfterMs: 600_000, chats: {}, cohorts: {} };
  if (raw === undefined) return placement;
  if (!isObject(raw)) { p.add('config.placement must be a mapping'); return placement; }
  checkKeys(raw, ['default', 'prefer', 'failover_after', 'chats', 'cohorts'], 'config.placement', p);
  if (raw.default === 'auto' || raw.default === 'local') placement.default = raw.default;
  else if (raw.default !== undefined) p.add('config.placement.default must be auto or local');
  const prefer = typeof raw.prefer === 'string' ? [raw.prefer] : raw.prefer;
  if (Array.isArray(prefer) && prefer.every(name => typeof name === 'string' && HOST_NAME.test(name))) placement.prefer = prefer;
  else if (prefer !== undefined) p.add('config.placement.prefer must be a host name or list of host names');
  placement.failoverAfterMs = duration(raw.failover_after, 'config.placement.failover_after', p, 600_000);
  for (const key of ['chats', 'cohorts'] as const) {
    const mapping = raw[key];
    if (mapping === undefined) continue;
    if (!isObject(mapping)) { p.add(`config.placement.${key} must be a mapping`); continue; }
    for (const [name, mode] of Object.entries(mapping)) {
      if (mode === 'auto' || mode === 'local') placement[key][name.normalize('NFC').toLowerCase()] = mode;
      else p.add(`config.placement.${key}.${name} must be auto or local`);
    }
  }
  return placement;
}

export function parsePerf(raw: unknown, p: Problems): PerfConfig {
  if (raw !== undefined && !isObject(raw)) p.add('config.perf must be a mapping');
  const value = isObject(raw) ? raw : {};
  checkKeys(value, ['wait_max', 'max_artifact_mb'], 'config.perf', p);
  return { waitMaxMs: duration(value.wait_max, 'config.perf.wait_max', p, 1800_000), maxArtifactBytes: (positive(value.max_artifact_mb, 'config.perf.max_artifact_mb', p) ?? 2048) * 1024 ** 2 };
}

function parseHostPolicy(raw: Record<string, unknown>, where: string, p: Problems): LocalHostConfig {
  const limits: NonNullable<HostConfig['limits']> = {};
  if (raw.limits !== undefined && raw.limits !== null) {
    if (!isObject(raw.limits)) p.add(`${where}.limits must be a mapping like {claude: 1}`);
    else {
      checkKeys(raw.limits, [...PROVIDER_IDS], `${where}.limits`, p);
      for (const [id, rawLimit] of Object.entries(raw.limits)) {
        const limit = positive(rawLimit, `${where}.limits.${id}`, p);
        if (limit !== undefined) limits[id as AgentName] = limit;
      }
    }
  }
  const maxTotal = positive(raw.max_total, `${where}.max_total`, p);
  const loadThreshold = positive(raw.load_threshold, `${where}.load_threshold`, p, false);
  const availability = parseAvailability(raw.availability, `${where}.availability`, p);
  return { ...(Object.keys(limits).length ? { limits } : {}), ...(maxTotal ? { maxTotal } : {}), ...(loadThreshold ? { loadThreshold } : {}), ...(availability ? { availability } : {}) };
}

export function parseLocalHost(raw: unknown, p: Problems): LocalHostConfig | undefined {
  const local = isObject(raw) ? raw.local : undefined;
  if (local === undefined) return undefined;
  if (!isObject(local)) { p.add('config.hosts.local must be a mapping'); return undefined; }
  checkKeys(local, ['limits', 'max_total', 'load_threshold', 'availability', 'repos'], 'config.hosts.local', p);
  return { ...parseHostPolicy(local, 'config.hosts.local', p), repos: parseRepoPaths(local.repos ?? {}, 'config.hosts.local', p) };
}

function parseRepoPaths(raw: unknown, where: string, p: Problems): Record<string, string> {
  if (!isObject(raw)) { p.add(`${where}.repos must map repository names to clone paths`); return {}; }
  return Object.fromEntries(Object.entries(raw).flatMap(([name, dir]) => {
    if (name.trim() && typeof dir === 'string' && dir.trim()) return [[name, dir.trim()]];
    p.add(`${where}.repos must map repository names to non-empty clone paths`);
    return [];
  }));
}

export const HOST_KEYS = ['ssh', 'port', 'identity_file', 'work_dir', 'repos', 'providers', 'limits', 'env', 'max_total', 'load_threshold', 'availability', 'sync', 'mac_ssh', 'fetch_remote', 'trust_work_dir'];
export const HOST_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function parseHostName(name: string, p: Problems): void {
  if (!HOST_NAME.test(name)) p.add(`config.hosts: "${name}" is not a valid host name (lowercase letters, digits, "_" and "-", at most 32)`);
}

function parseSshTarget(v: unknown, where: string, p: Problems): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') { p.add(`${where} must be "user@host" (the host may be a name or an IP)`); return undefined; }
  const target = v.trim();
  if (!/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*@(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(target)) {
    p.add(`${where} must be exactly "user@host", without spaces`);
    return undefined;
  }
  return target;
}

/** `hosts:` of the global config; a problem in any entry is a config error (like every other section). */
export function parseHosts(v: unknown, p: Problems): Record<string, HostConfig> {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) {
    p.add('config.hosts must be a mapping like {gpu-pc: {ssh: user@host, port: 2222, work_dir: ~/work, repos: {app: ~/src/app}, providers: [claude]}}');
    return {};
  }
  const hosts: Record<string, HostConfig> = {};
  for (const [name, raw] of Object.entries(v)) {
    if (name === 'local') continue;
    const where = `config.hosts.${name}`;
    if (name === 'auto') p.add('config.hosts.auto is reserved for placement');
    parseHostName(name, p);
    if (!isObject(raw)) { p.add(`${where} must be a mapping with ssh, work_dir, repos and providers`); continue; }
    checkKeys(raw, HOST_KEYS, where, p);
    const ssh = parseSshTarget(raw.ssh, `${where}.ssh`, p);
    if (raw.work_dir === undefined || typeof raw.work_dir !== 'string' || raw.work_dir.trim() === '') p.add(`${where}.work_dir must be a non-empty path on the host`);
    const repos = parseRepoPaths(raw.repos, where, p);
    let port = 22;
    if (raw.port !== undefined) {
      if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535) port = raw.port;
      else p.add(`${where}.port must be an integer from 1 to 65535`);
    }
    let identityFile: string | undefined;
    if (raw.identity_file !== undefined) {
      if (typeof raw.identity_file === 'string' && raw.identity_file.trim() !== '') identityFile = expandHome(raw.identity_file.trim());
      else p.add(`${where}.identity_file must be a path of the private key on this machine`);
    }
    const providers: ProviderId[] = [];
    if (!Array.isArray(raw.providers) || raw.providers.length === 0) p.add(`${where}.providers must list at least one provider CLI on the host (${PROVIDER_IDS.join(', ')})`);
    else {
      for (const id of raw.providers) {
        if (typeof id !== 'string' || !(PROVIDER_IDS as readonly string[]).includes(id)) p.add(`${where}.providers: unknown provider ${JSON.stringify(id)} (${PROVIDER_IDS.join(', ')})`);
        else if (providers.includes(id as ProviderId)) p.add(`${where}.providers: ${id} is listed twice`);
        else providers.push(id as ProviderId);
      }
    }
    const policy = parseHostPolicy(raw, where, p);
    if (raw.sync !== undefined && raw.sync !== 'off' && raw.sync !== 'fetch-back') p.add(`${where}.sync must be fetch-back or off`);
    const macSsh = typeof raw.mac_ssh === 'string' && /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+(?::[0-9]+)?$/.test(raw.mac_ssh) ? raw.mac_ssh : undefined;
    if (raw.mac_ssh !== undefined && !macSsh) p.add(`${where}.mac_ssh must be user@mac[:port]`);
    const fetchRemote = typeof raw.fetch_remote === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(raw.fetch_remote) ? raw.fetch_remote : undefined;
    if (raw.fetch_remote !== undefined && !fetchRemote) p.add(`${where}.fetch_remote must be a Git remote name`);
    if (raw.trust_work_dir !== undefined && typeof raw.trust_work_dir !== 'boolean') p.add(`${where}.trust_work_dir must be boolean`);
    const env = parseEnv(raw.env, `${where}.env`, p);
    if (ssh && typeof raw.work_dir === 'string' && raw.work_dir.trim() !== '' && isObject(raw.repos)) {
      hosts[name] = {
        ssh,
        port,
        ...(identityFile ? { identityFile } : {}),
        workDir: raw.work_dir.trim(),
        repos,
        providers,
        ...policy,
        ...(raw.sync === 'off' || raw.sync === 'fetch-back' ? { sync: raw.sync } : {}),
        ...(macSsh ? { macSsh } : {}),
        ...(fetchRemote ? { fetchRemote } : {}),
        ...(raw.trust_work_dir === true ? { trustWorkDir: true } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return hosts;
}

/** Directory of the multiplex sockets, under the config directory (AGENTCTL_HOME overrides ~/.agentctl). */
export function sshSocketDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.AGENTCTL_HOME ? expandHome(env.AGENTCTL_HOME) : path.join(os.homedir(), '.agentctl'), 'ssh');
}

export type HostState = 'reachable' | 'unreachable' | 'auth-failed' | 'host-key-unknown' | 'host-key-changed';

export const HOST_STATE_TEXT: Record<HostState, string> = {
  reachable: 'reachable',
  unreachable: 'unreachable',
  'auth-failed': 'auth failed',
  'host-key-unknown': 'host key unknown (run the ssh command once by hand)',
  'host-key-changed': 'HOST KEY CHANGED',
};

export interface HostGpu {
  name: string;
  totalMiB: number;
  usedMiB: number;
  utilizationPct?: number;
}

export interface HostCli {
  id: ProviderId;
  command: string;
  present: boolean;
  version?: string;
  /** Best effort, from the CLI's credentials file on the host: in / out / unknown (no check known for this CLI). */
  loggedIn: 'in' | 'out' | 'unknown';
}

export interface HostRepo {
  name: string;
  path: string;
  present: boolean;
  head?: string;
  remoteUrl?: string;
}

/** Everything `agentctl hosts` shows for one host; the JSON cache under the config directory stores these. */
export interface HostHealth {
  name: string;
  state: HostState;
  /** Wall time of the probe round trip (ssh connection establishment or reuse), when a connection happened. */
  latencyMs?: number;
  /** First stderr line when the state is not reachable. */
  detail?: string;
  disk?: { workDir: string; freeKb: number; totalKb: number };
  gpu?: HostGpu | null;
  rootDisk?: { freeKb: number; totalKb: number };
  load?: number;
  cpus?: number;
  memoryFreeKb?: number;
  processes?: string[];
  diagnostics?: Record<string, string>;
  offlineSince?: string;
  tmux?: { present: boolean; version?: string };
  clis?: HostCli[];
  repos?: HostRepo[];
  probedAt: string;
}

/** The exact command the owner runs once to accept a first-time host key (doctor prints it). */
export function firstConnectCommand(host: HostConfig): string {
  const parts = ['ssh'];
  if (host.port !== 22) parts.push('-p', String(host.port));
  if (host.identityFile) parts.push('-i', host.identityFile);
  parts.push(host.ssh);
  return parts.map((part) => (/\s/.test(part) ? `'${part.replaceAll("'", `'\\''`)}'` : part)).join(' ');
}

export interface HostsCache {
  writtenAt: string;
  hosts: HostHealth[];
}

/** `~/.agentctl/hosts-health.json`: what the board and the MCP hosts tool read between probes. */
export function hostsCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.AGENTCTL_HOME ? expandHome(env.AGENTCTL_HOME) : path.join(os.homedir(), '.agentctl'), 'hosts-health.json');
}

/** The cache when it exists and is younger than `maxAgeMs`; undefined otherwise. */
export function readHostsCache(env: NodeJS.ProcessEnv = process.env, now: number = Date.now(), maxAgeMs: number = Number.POSITIVE_INFINITY): HostsCache | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(hostsCachePath(env), 'utf8')) as HostsCache;
    if (!Array.isArray(parsed.hosts) || typeof parsed.writtenAt !== 'string') return undefined;
    if (now - Date.parse(parsed.writtenAt) > maxAgeMs) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeHostsCache(runner: Runner, hosts: HostHealth[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await runner.mkdir(path.dirname(hostsCachePath(env)));
  const previous = readHostsCache(env, runner.now());
  for (const host of hosts) {
    if (host.state === 'reachable') continue;
    const last = previous?.hosts.find(item => item.name === host.name);
    host.offlineSince = last?.state !== 'reachable' ? last?.offlineSince ?? last?.probedAt ?? host.probedAt : host.probedAt;
  }
  await runner.writeFile(hostsCachePath(env), JSON.stringify({ writtenAt: new Date().toISOString(), hosts }, null, 2));
}

/** Compact per-host summary for the board header. */
export interface HostsBoardSummary {
  name: string;
  state: HostState;
  gpu?: string;
  diskFreeGb?: number;
}

export function summarizeHosts(cache: HostsCache | undefined, names: string[]): HostsBoardSummary[] {
  if (names.length === 0) return [];
  const byName = new Map((cache?.hosts ?? []).map((h) => [h.name, h]));
  return names.map((name) => {
    const health = byName.get(name);
    if (!health) return { name, state: 'unreachable' as HostState };
    return {
      name,
      state: health.state,
      ...(health.gpu ? { gpu: health.gpu.name } : {}),
      ...(health.disk ? { diskFreeGb: Math.round(health.disk.freeKb / (1024 * 1024)) } : {}),
    };
  });
}

export function formatGb(kb: number): string {
  return kb >= 1024 * 1024 ? `${Math.round(kb / (1024 * 1024))}G` : kb >= 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`;
}
