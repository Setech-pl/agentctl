import type { GlobalConfig } from './config.ts';
import { providerCommand } from './providers/registry.ts';
import type { HostConfig, HostHealth, HostCli, HostRepo } from './hosts.ts';
import { formatGb } from './hosts.ts';
import { runOnHost, SSH_COMMAND_TIMEOUT_MS } from './host-ssh.ts';
import type { Runner } from './runner.ts';

/*
 * The health probe of `agentctl hosts`: one ssh round trip per host that collects everything (disk, GPU,
 * tmux, provider CLIs, repo clones). The ControlMaster socket makes the connection itself cheap from the
 * second call on. Everything is best effort: a missing nvidia-smi, tmux or a CLI is data, not an error —
 * only the ssh states (unreachable / auth-failed / host-key-*) are failures, and they come from the
 * transport (host-ssh.ts).
 *
 * The "logged in" check looks at the CLI's credentials file on the host. It cannot prove the token is
 * valid; it only distinguishes "somebody signed in here" from "nobody did". CLIs without a known
 * credentials file (kimi, glm) report `unknown`. This is documented in the README "Hosts" section.
 */

/** The credentials file whose presence counts as "logged in", per provider; undefined: no check known. */
export const AUTH_FILE: Partial<Record<string, string>> = {
  claude: '$HOME/.claude/.credentials.json',
  codex: '$HOME/.codex/auth.json',
};

function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Expand only the remote HOME, keeping all other path characters literal. */
function hostPath(value: string): string {
  return value === '~' ? '"$HOME"' : value.startsWith('~/') ? '"$HOME"/' + shQuote(value.slice(2)) : shQuote(value);
}

/** One remote shell script; sections are tagged so the parser below stays trivial. */
export function healthScript(host: HostConfig, config: Pick<GlobalConfig, 'providersConfig'>): string {
  const lines: string[] = [
    ...Object.entries(host.env ?? {}).map(([key, value]) => `export ${key}=${shQuote(value)}`),
    'echo ==df==',
    `df -Pk ${hostPath(host.workDir)} 2>/dev/null | tail -1 | awk '{print $2, $4}'`,
    'echo ==gpu==',
    'command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader | head -1 || echo none',
    'echo ==tmux==',
    'command -v tmux >/dev/null 2>&1 && tmux -V || echo none',
  ];
  for (const id of host.providers) {
    const command = providerCommand(config, id);
    lines.push(`echo ==cli== ${id} ${command}`);
    lines.push(`command -v ${shQuote(command)} 2>/dev/null || echo none`);
    lines.push(`${shQuote(command)} --version 2>/dev/null | head -n 1`);
    lines.push(`echo ==auth== ${id}`);
    const authFile = AUTH_FILE[id];
    lines.push(authFile ? `[ -f "${authFile}" ] && echo in || echo out` : 'echo unknown');
  }
  for (const [name, dir] of Object.entries(host.repos)) {
    lines.push(`echo ==repo== ${name}`);
    lines.push(`git -C ${hostPath(dir)} rev-parse --verify HEAD 2>/dev/null || echo missing`);
    lines.push(`git -C ${hostPath(dir)} remote get-url origin 2>/dev/null || echo noremote`);
  }
  return lines.join('\n');
}

function parseMiB(text: string): number {
  return Number(/(\d+)/.exec(text)?.[1] ?? 0) || 0;
}

/** The tagged script output back into fields; missing or malformed sections just stay undefined. `repoPaths` is the ordered remote path of each repos section. */
export function parseHealthOutput(name: string, stdout: string, latencyMs: number | undefined, probedAt: string, repoPaths: string[] = []): Omit<HostHealth, 'state' | 'detail'> {
  const health: Omit<HostHealth, 'state' | 'detail'> = { name, probedAt };
  if (latencyMs !== undefined) health.latencyMs = latencyMs;
  const lines = stdout.split('\n');
  let i = 0;
  const clis: HostCli[] = [];
  const repos: HostRepo[] = [];
  while (i < lines.length) {
    const line = (lines[i] as string).trimEnd();
    i++;
    const [tag, ...rest] = line.split(' ');
    if (tag === '==df==') {
      const [total, free] = (lines[i] ?? '').trim().split(/\s+/);
      i++;
      if (/^\d+$/.test(total ?? '') && /^\d+$/.test(free ?? '')) health.disk = { workDir: '', freeKb: Number(free), totalKb: Number(total) };
    } else if (tag === '==gpu==') {
      const row = (lines[i] ?? '').trim();
      i++;
      if (row && row !== 'none') {
        const [gpuName = '', total = '', used = ''] = row.split(',').map((part) => part.trim());
        health.gpu = { name: gpuName, totalMiB: parseMiB(total), usedMiB: parseMiB(used) };
      } else health.gpu = null;
    } else if (tag === '==tmux==') {
      const row = (lines[i] ?? '').trim();
      i++;
      if (row && row !== 'none') health.tmux = { present: true, version: row.replace(/^tmux\s+/, '') };
      else health.tmux = { present: false };
    } else if (tag === '==cli==') {
      const [id = '', command = ''] = rest;
      const pathLine = (lines[i] ?? '').trim();
      i++;
      const version = (lines[i] ?? '').trim();
      i++;
      let loggedIn: HostCli['loggedIn'] = 'unknown';
      const authTag = (lines[i] ?? '').trim().split(' ');
      if (authTag[0] === '==auth==') {
        i++;
        const auth = (lines[i] ?? '').trim();
        i++;
        if (auth === 'in' || auth === 'out') loggedIn = auth;
      }
      clis.push({ id: id as HostCli['id'], command, present: pathLine !== '' && pathLine !== 'none', ...(version ? { version } : {}), loggedIn });
    } else if (tag === '==repo==') {
      const repoName = rest.join(' ');
      const head = (lines[i] ?? '').trim();
      i++;
      const remote = (lines[i] ?? '').trim();
      i++;
      repos.push({ name: repoName, path: repoPaths[repos.length] ?? '', present: head !== 'missing', ...(head !== 'missing' && /^[0-9a-f]{7,40}$/i.test(head) ? { head } : {}), ...(remote !== 'noremote' && remote !== '' ? { remoteUrl: remote } : {}) });
    }
  }
  if (clis.length > 0) health.clis = clis;
  if (repos.length > 0) health.repos = repos;
  return health;
}

export interface ProbeOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** One host: connect (or reuse the master), run the health script, classify the outcome. */
export async function probeHost(runner: Runner, name: string, host: HostConfig, config: Pick<GlobalConfig, 'providersConfig'>, opts: ProbeOptions = {}): Promise<HostHealth> {
  const started = runner.now();
  const run = await runOnHost(runner, name, host, healthScript(host, config), opts.timeoutMs ?? SSH_COMMAND_TIMEOUT_MS, opts.env);
  const probedAt = new Date().toISOString();
  const latencyMs = run.state === 'reachable' ? Math.max(0, runner.now() - started) : undefined;
  if (run.state !== 'reachable') {
    return { name, state: run.state, probedAt, ...(latencyMs !== undefined ? { latencyMs } : {}), detail: run.stderr.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? (run.timedOut ? 'timed out' : `ssh exit ${run.code}`) };
  }
  const parsed = parseHealthOutput(name, run.stdout, latencyMs, probedAt, Object.values(host.repos));
  if (parsed.disk) parsed.disk = { ...parsed.disk, workDir: host.workDir };
  return { ...parsed, state: 'reachable', ...(run.code !== 0 ? { detail: `probe exited ${run.code}` } : {}) };
}

/** Every configured host, probed in parallel, each under its own timeout. */
export async function probeHosts(runner: Runner, hosts: Record<string, HostConfig>, config: Pick<GlobalConfig, 'providersConfig'>, opts: ProbeOptions = {}): Promise<HostHealth[]> {
  return Promise.all(Object.entries(hosts).map(([name, host]) => probeHost(runner, name, host, config, opts)));
}

/** `agentctl hosts` output: one block per host. */
export function renderHostsHealth(health: HostHealth[]): string[] {
  const lines: string[] = [];
  for (const host of health) {
    const latency = host.latencyMs !== undefined ? ` · ${host.latencyMs}ms` : '';
    lines.push(`${host.name}  ${host.state}${latency}${host.detail ? ` — ${host.detail}` : ''}`);
    if (host.state !== 'reachable') continue;
    const parts: string[] = [];
    if (host.gpu) parts.push(`GPU ${host.gpu.name} ${host.gpu.usedMiB}/${host.gpu.totalMiB} MiB`);
    else if (host.gpu === null) parts.push('GPU n/d (no nvidia-smi)');
    if (host.disk) parts.push(`disk free ${formatGb(host.disk.freeKb)} of ${formatGb(host.disk.totalKb)} in ${host.disk.workDir}`);
    if (parts.length > 0) lines.push(`  ${parts.join(' · ')}`);
    if (host.tmux) lines.push(`  tmux ${host.tmux.present ? (host.tmux.version ?? 'present') : 'missing'}`);
    if (host.clis) lines.push(`  ${host.clis.map((cli) => `${cli.command}${cli.present ? ` ${cli.version ?? ''} (logged ${cli.loggedIn})` : ' (missing)'}`).join(' · ')}`);
    for (const repo of host.repos ?? []) lines.push(`  repo ${repo.name} ${repo.present ? `@ ${repo.path} · HEAD ${repo.head ?? 'n/d'} · origin ${repo.remoteUrl ?? 'n/d'}` : `missing at ${repo.path}`}`);
  }
  return lines;
}

/** The board `H` view and the `--json` shape share the cached HostHealth records as they are. */
export function hostsViewLines(health: HostHealth[] | undefined, writtenAt: string | undefined): string[] {
  if (!health || health.length === 0) return ['No hosts configured: see the README "Hosts" section.'];
  const lines = [`Cached ${writtenAt ? new Date(writtenAt).toLocaleTimeString() : 'n/d'} — H closes, r refreshes the board.`];
  for (const host of health) {
    const bits: string[] = [host.state];
    if (host.gpu) bits.push(`${host.gpu.name} ${host.gpu.usedMiB}/${host.gpu.totalMiB} MiB`);
    else if (host.gpu === null) bits.push('GPU n/d');
    if (host.disk) bits.push(`free ${formatGb(host.disk.freeKb)}/${formatGb(host.disk.totalKb)}`);
    lines.push(`${host.name}  ${bits.join(' · ')}${host.detail ? ` — ${host.detail}` : ''}`);
    if (host.clis) lines.push(`    ${host.clis.map((cli) => `${cli.command} ${cli.present ? (cli.version ?? '') : 'missing'} · logged ${cli.loggedIn}`).join('  ')}`);
    for (const repo of host.repos ?? []) lines.push(`    ${repo.name}: ${repo.present ? `HEAD ${repo.head ?? 'n/d'} · ${repo.remoteUrl ?? 'no origin'}` : `missing at ${repo.path}`}`);
  }
  return lines;
}
