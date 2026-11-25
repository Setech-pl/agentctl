import fs from 'node:fs';
import type { Context } from './context.ts';
import type { ResolvedRepo } from './spec.ts';
import type { TaskRecord } from './taskstore.ts';
import { findRecordAnywhere } from './taskstore.ts';
import { recordJournal } from './journal.ts';
import { shellLine } from './util.ts';

const timeoutMs = 8_000;
const ssh = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5'];
const gitEnvironment = (args: string[] = []) => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: shellLine('ssh', [...ssh, ...args]),
});
const sshClone = (target: string, clone: string, port?: number) =>
  `ssh://${target}${port && port !== 22 ? `:${port}` : ''}${clone.split('/').map(encodeURIComponent).join('/')}`;

export async function fetchRemoteBranches(ctx: Context, record: TaskRecord): Promise<boolean> {
  const name = record.host;
  const host = name && ctx.config.hosts[name];
  if (!host || host.sync === 'off') return true;
  let complete = true;
  await Promise.all(record.repos.map(async repo => {
    const branch = repo.branch;
    const clone = repo.localPath ?? ctx.config.localHost?.repos?.[repo.name ?? ''];
    if (!branch || !clone || !fs.existsSync(clone)) return;
    const env = gitEnvironment(host.identityFile ? ['-i', host.identityFile] : []);
    const git = (args: string[]) => ctx.runner.exec('git', ['-C', clone, ...args], { timeoutMs, env });
    const ref = `refs/heads/${branch}`;
    if ((await git(['check-ref-format', ref])).code !== 0) return;
    const tracking = `refs/remotes/${name}/${branch}`;
    const source = host.fetchRemote ?? sshClone(host.ssh, repo.path, host.port);
    const fetched = await git(['fetch', '--no-tags', '--no-write-fetch-head', '--', source, `+${ref}:${tracking}`]);
    if (fetched.code !== 0) {
      complete = false;
      await recordJournal(ctx, { kind: 'host-sync', task: record.task, text: `[${name}] ${branch}: fetch-back nie powiódł się (${fetched.code}); klon: ${clone}` });
      return;
    }
    const trackingSha = await git(['show-ref', '--hash', '--verify', tracking]);
    const localSha = await git(['show-ref', '--hash', '--verify', ref]);
    if (localSha.code === 0 && trackingSha.code === 0 && localSha.stdout.trim() === trackingSha.stdout.trim()) return;
    // Git checks ancestry and refuses an update to any checked-out branch. The tracking ref is retained in either case.
    const updated = await git(['fetch', '--no-tags', '--no-write-fetch-head', '--', '.', `${tracking}:${ref}`]);
    if (updated.code !== 0) {
      await recordJournal(ctx, { kind: 'host-sync', task: record.task, text: `[${name}] konflikt ${branch}; zachowano ${ref} i ${tracking}` });
    } else {
      await recordJournal(ctx, { kind: 'host-sync', task: record.task, text: `[${name}] ${branch} dostępna w klonie na Macu` });
    }
  }));
  return complete;
}

export async function fetchMacBase(ctx: Context, hostName: string, repo: ResolvedRepo): Promise<ResolvedRepo> {
  const host = ctx.config.hosts[hostName]!;
  if (!repo.base || !host.macSsh || host.sync === 'off' || !repo.localPath) return repo;
  const baseTask = /^@([^:]+)(?::(.+))?$/.exec(repo.base);
  const source = baseTask && findRecordAnywhere(ctx.config, baseTask[1]!);
  if (source && source.host) return repo;
  const sourceRepo = source && source.repos.find(r => r.path === repo.localPath || r.name === baseTask?.[2]);
  const ref = (baseTask ? sourceRepo && sourceRepo.branch : repo.base)?.replace(/^refs\/heads\//, '');
  if (!ref) return repo;
  const branch = `refs/heads/${ref}`;
  const local = await ctx.runner.exec('git', ['-C', repo.localPath, 'show-ref', '--verify', '--quiet', branch], { readOnly: true, timeoutMs });
  if (local.code !== 0) return repo;
  const remote = ctx.hosts.forHost(hostName);
  const exists = await remote.exec('git', ['-C', repo.path, 'show-ref', '--verify', '--quiet', branch], { readOnly: true, timeoutMs });
  if (exists.code === 0 && !baseTask) return repo;
  const tracking = `refs/remotes/agentctl-mac/${ref}`;
  await remote.checked('git', ['-C', repo.path, 'fetch', '--no-tags', '--no-write-fetch-head', '--', sshClone(host.macSsh, repo.localPath), `+${branch}:${tracking}`], {
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: shellLine('ssh', ssh) },
  });
  return baseTask ? { ...repo, fetchedBase: tracking } : { ...repo, base: tracking };
}
