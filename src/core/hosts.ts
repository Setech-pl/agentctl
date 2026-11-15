import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_IDS } from './providers/types.ts';
import type { ProviderId } from './providers/types.ts';
import { checkKeys, parseEnv } from './config.ts';
import type { AgentName } from './config.ts';
import { Problems, expandHome, isObject } from './util.ts';
import type { Runner } from './runner.ts';

/*
 * Remote hosts (0.23.0 part A: config + transport + health). A host is a second machine reached over SSH
 * (WSL, a server, a GPU box) that later parts of 0.23 run tasks on. This module holds the config shape and
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
  /** Repository name (as the specs name it) -> clone path on the host. Clones are synced through GitHub; agentctl fetches, never pushes. */
  repos: Record<string, string>;
  /** Provider CLIs installed on this host. */
  providers: ProviderId[];
  /** Per-provider cap of simultaneous remote tasks (0.23 part B consumes it). */
  limits?: Partial<Record<AgentName, number>>;
  /** Extra environment for remote commands (0.23 part B consumes it). */
  env?: Record<string, string>;
}

export const HOST_KEYS = ['ssh', 'port', 'identity_file', 'work_dir', 'repos', 'providers', 'limits', 'env'];
export const HOST_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function parseHostName(name: string, p: Problems): void {
  if (!HOST_NAME.test(name)) p.add(`config.hosts: "${name}" is not a valid host name (lowercase letters, digits, "_" and "-", at most 32)`);
}

function parseSshTarget(v: unknown, where: string, p: Problems): string | undefined {
  if (typeof v !== 'string' || v.trim() === '') { p.add(`${where} must be "user@host" (the host may be a name or an IP)`); return undefined; }
  const target = v.trim();
  if (/\s/.test(target) || (target.match(/@/g) ?? []).length !== 1 || target.startsWith('@') || target.endsWith('@')) {
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
    const where = `config.hosts.${name}`;
    parseHostName(name, p);
    if (!isObject(raw)) { p.add(`${where} must be a mapping with ssh, work_dir, repos and providers`); continue; }
    checkKeys(raw, HOST_KEYS, where, p);
    const ssh = parseSshTarget(raw.ssh, `${where}.ssh`, p);
    if (raw.work_dir === undefined || typeof raw.work_dir !== 'string' || raw.work_dir.trim() === '') p.add(`${where}.work_dir must be a non-empty path on the host`);
    if (!isObject(raw.repos) || Object.entries(raw.repos).some(([repo, dir]) => repo.trim() === '' || typeof dir !== 'string' || dir.trim() === '')) {
      p.add(`${where}.repos must map repository names to remote clone paths, e.g. {app: ~/src/app}`);
    }
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
    let limits: HostConfig['limits'];
    if (raw.limits !== undefined && raw.limits !== null) {
      if (!isObject(raw.limits)) p.add(`${where}.limits must be a mapping like {claude: 1}`);
      else {
        checkKeys(raw.limits, [...PROVIDER_IDS], `${where}.limits`, p);
        const parsed: Partial<Record<AgentName, number>> = {};
        for (const [id, n] of Object.entries(raw.limits)) {
          if (typeof n === 'number' && Number.isInteger(n) && n >= 1) parsed[id as AgentName] = n;
          else p.add(`${where}.limits.${id} must be a positive integer`);
        }
        if (Object.keys(parsed).length > 0) limits = parsed;
      }
    }
    const env = parseEnv(raw.env, `${where}.env`, p);
    if (ssh && typeof raw.work_dir === 'string' && raw.work_dir.trim() !== '' && isObject(raw.repos)) {
      hosts[name] = {
        ssh,
        port,
        ...(identityFile ? { identityFile } : {}),
        workDir: raw.work_dir.trim(),
        repos: Object.fromEntries(Object.entries(raw.repos as Record<string, unknown>).map(([repo, dir]) => [repo, (dir as string).trim()])),
        providers,
        ...(limits ? { limits } : {}),
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
