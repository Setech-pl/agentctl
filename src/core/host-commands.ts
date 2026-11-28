import path from 'node:path';
import type { Context } from './context.ts';
import { editConfigText, writeConfigText } from './config-edit.ts';
import { withFileLock } from './file-lock.ts';
import { hostAvailability } from './host-availability.ts';
import { firstConnectCommand, HOST_NAME, readHostsCache } from './hosts.ts';
import type { HostHealth } from './hosts.ts';
import { probeHost, probeLocalHost, renderHostsHealth } from './host-health.ts';
import { activeProviders } from './providers/registry.ts';
import { AgentctlError, resolvePath, shellQuote } from './util.ts';
import { readQueue } from './queue.ts';
import { liveWindows } from './plan.ts';

export async function addHost(ctx: Context, name: string, ssh: string, port: number): Promise<string> {
  if (!HOST_NAME.test(name) || name === 'local' || name === 'auto') throw new AgentctlError('choose a remote host name (lowercase, digits, dash or underscore)');
  const file = ctx.config.path;
  await withFileLock(`${file}.hosts.lock`, async () => {
    const text = editConfigText(ctx.config, doc => {
      if (doc.hasIn(['hosts', name])) throw new AgentctlError(`host ${name} already exists in ${file}`);
      const providers = activeProviders(ctx.config).filter(id => id === 'claude' || id === 'codex');
      doc.setIn(['hosts', name], { ssh, port, work_dir: '~/agentctl-work', repos: {}, providers: providers.length ? providers : activeProviders(ctx.config) });
    });
    await writeConfigText(ctx, file, text);
  });
  return `Dodano [${name}] w ${file}. Uzupełnij hosts.${name}.repos i uruchom agentctl hosts doctor ${name}.`;
}

export async function doctorHost(ctx: Context, name: string): Promise<string[]> {
  const host = ctx.config.hosts[name];
  if (name === 'local') return renderHostsHealth([await probeLocalHost(ctx.runner, ctx.config)]);
  if (!host) throw new AgentctlError(`unknown remote host ${name}`);
  const health = await probeHost(ctx.runner, name, host, ctx.config, { doctor: true });
  const lines = renderHostsHealth([health]);
  const connect = firstConnectCommand(host);
  lines.push(`SSH BatchMode: ${health.state === 'reachable' ? 'OK' : health.state}`);
  if (health.state !== 'reachable') {
    lines.push(`Na Macu (klucz hosta sprawdź przed zaakceptowaniem): ${connect}`);
    lines.push('W Ubuntu WSL: sudo apt install openssh-server && sudo service ssh start');
    lines.push('Windows PowerShell jako administrator (WSL NAT, po zmianie adresu):');
    lines.push("$ip = ((wsl.exe -d Ubuntu hostname -I).Trim() -split '\\s+')[0]");
    const address = host.ssh.split('@')[1]!;
    lines.push(`netsh interface portproxy delete v4tov4 listenport=${host.port} listenaddress=${address}`);
    lines.push(`netsh interface portproxy add v4tov4 listenport=${host.port} listenaddress=${address} connectport=22 connectaddress=$ip`);
    lines.push(`New-NetFirewallRule -DisplayName "agentctl WSL SSH" -Direction Inbound -Action Allow -Protocol TCP -LocalAddress ${address} -LocalPort ${host.port} -RemoteAddress LocalSubnet`);
    return lines;
  }
  if (!health.disk) lines.push(`W WSL: mkdir -p -- ${wslPath(host.workDir)}`);
  const minimum = Math.max(20, ctx.config.disk.minFreeStartGb);
  const windowsFree = Number(health.diagnostics?.windows_c_free);
  if (health.rootDisk && health.rootDisk.freeKb / 1024 ** 2 < minimum || Number.isFinite(windowsFree) && windowsFree / 1024 ** 3 < minimum) {
    lines.push('Mało miejsca na WSL / lub Windows C:. Windows PowerShell: wsl --shutdown', 'wsl --manage Ubuntu --move E:\\WSL\\Ubuntu');
  }
  if (!health.tmux?.present || health.diagnostics?.git === 'missing' || health.diagnostics?.rsync === 'missing') lines.push('W WSL: sudo apt install tmux git rsync');
  if (health.diagnostics?.node === 'missing') lines.push('W WSL: zainstaluj Node ≥22 systemowo lub dodaj katalog Node do PATH w nieinteraktywnej powłoce.');
  for (const cli of health.clis ?? []) {
    if (!cli.present) lines.push(`Sprawdź nieinteraktywny PATH: ${connect} ${shellQuote(`command -v ${shellQuote(cli.command)}`)}`);
    else if (cli.loggedIn !== 'in' && (cli.id === 'codex' || cli.id === 'claude')) lines.push(`W WSL: ${shellQuote(cli.command)} ${cli.id === 'codex' ? 'login' : 'auth login'}`);
  }
  if (health.diagnostics?.powershell === 'missing') lines.push("W /etc/wsl.conf ustaw [interop], enabled=true oraz appendWindowsPath=true, potem w Windows: wsl --shutdown");
  for (const repo of health.repos ?? []) {
    if (repo.present) continue;
    const local = resolvePath(ctx.config.localHost?.repos?.[repo.name] ?? path.join(process.cwd(), repo.name));
    const origin = await ctx.runner.exec('git', ['-C', local, 'remote', 'get-url', 'origin'], { readOnly: true, timeoutMs: 3000 });
    lines.push(`W WSL: git clone -- ${origin.code === 0 && origin.stdout.trim() ? shellQuote(origin.stdout.trim()) : "'<repo-url>'"} ${wslPath(repo.path)}`);
  }
  lines.push(`Codex: hosts.${name}.trust_work_dir: true oznacza zgodę na zaufanie katalogom zadań poniżej work_dir.`);
  return lines;
}

const wslPath = (value: string) => value === '~' ? '"$HOME"' : value.startsWith('~/') ? '"$HOME"/' + shellQuote(value.slice(2)) : shellQuote(value);

export async function hostPlacementStats(ctx: Context, health: HostHealth[] = readHostsCache()?.hosts ?? []) {
  const live = await liveWindows(ctx, undefined, undefined, true);
  const queued = readQueue(ctx.config);
  const names = ['local', ...Object.keys(ctx.config.hosts)];
  return names.map(name => {
    const slots = live.filter(slot => slot.agent && (slot.host ?? 'local') === name);
    const sample = health.find(h => h.name === name);
    const cfg = name === 'local' ? ctx.config.localHost : ctx.config.hosts[name];
    const availability = hostAvailability(ctx.config, name, sample, ctx.runner.now());
    return {
      name, availability: availability ?? 'available',
      running: slots.filter(slot => !slot.reportReady).length, max_total: cfg?.maxTotal ?? null, limits: cfg?.limits ?? {},
      perf: slots.find(slot => slot.perf && !slot.reportReady)?.window ?? null,
      waiting_perf: queued.filter(entry => entry.perf && entry.host === name && entry.status === 'queued').map(entry => entry.task),
      queued: queued.filter(entry => (entry.host ?? 'local') === name && !entry.placement && entry.status === 'queued').length,
    };
  });
}
