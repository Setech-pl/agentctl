import path from 'node:path';
import type { HostConfig, HostState } from './hosts.ts';
import { sshSocketDir } from './hosts.ts';
import type { ExecResult, Runner } from './runner.ts';

/*
 * The SSH transport to a remote host. One multiplexed connection per host: OpenSSH ControlMaster with a
 * control socket under ~/.agentctl/ssh/<host>.sock; after the first connect, later commands reuse it
 * (ControlPersist keeps it open). The configured host name is handed to ssh verbatim on every call: ssh
 * resolves it each time, and agentctl never caches an IP (the owner's WSL box may get a new IP after a
 * reboot — then the config value is updated once, and nothing else remembers the old address).
 *
 * Security posture (fixed, not configurable):
 * - BatchMode=yes: ssh never prompts for a password or a passphrase; a key or the agent must cover it.
 * - StrictHostKeyChecking=yes: a changed host key fails loudly (state host-key-changed) and is never
 *   auto-accepted. A first-time key also fails (state host-key-unknown): the owner accepts it by running
 *   the exact command doctor prints, once, in their own terminal.
 */

export const SSH_CONNECT_TIMEOUT_S = 8;
/** Default ceiling for one remote command including connection setup. */
export const SSH_COMMAND_TIMEOUT_MS = 20_000;

export function sshSocketPath(hostName: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sshSocketDir(env), `${hostName}.sock`);
}

/** The fixed ssh options; `command` (one string) runs in the login shell of the remote user. */
export function sshArgs(hostName: string, host: HostConfig, command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const args = [
    '-p', String(host.port),
    ...(host.identityFile ? ['-i', host.identityFile] : []),
    '-S', sshSocketPath(hostName, env),
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=120',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_S}`,
    host.ssh,
  ];
  if (command !== '') args.push(command);
  return args;
}

export interface HostRunResult extends ExecResult {
  state: HostState;
  /** True when the local timeout fired (as opposed to ssh's own ConnectTimeout). */
  timedOut: boolean;
}

/**
 * What an ssh failure means. Order matters: a changed key is reported before the generic host-key line,
 * and auth failures before generic "connection" wording (sshd may say "Connection closed by …" after
 * denying the key).
 */
export function classifySshFailure(stderr: string, timedOut: boolean): HostState {
  const text = stderr.toLowerCase();
  if (text.includes('remote host identification has changed')) return 'host-key-changed';
  if (text.includes('host key verification failed')) return 'host-key-unknown';
  if (text.includes('permission denied') || text.includes('too many authentication failures')) return 'auth-failed';
  return 'unreachable';
}

/**
 * Run one command on the host through the multiplexed connection. The state classifies the outcome:
 * `reachable` (exit code is whatever the remote command returned, in `code`), or one of the failure states,
 * where `code` is ssh's exit code (255 for ssh-level failures) and `stderr` carries the diagnostic.
 */
export async function runOnHost(runner: Runner, hostName: string, host: HostConfig, command: string, timeoutMs: number = SSH_COMMAND_TIMEOUT_MS, env: NodeJS.ProcessEnv = process.env): Promise<HostRunResult> {
  const result = await runner.exec('ssh', sshArgs(hostName, host, command, env), { timeoutMs, readOnly: false });
  const timedOut = /ETIMEDOUT after \d+ms/.test(result.stderr);
  if (result.code === 0 && !timedOut) return { ...result, state: 'reachable', timedOut: false };
  return { ...result, state: classifySshFailure(result.stderr, timedOut), timedOut };
}

/** Exit the multiplex master of one host (the socket lingers at most ControlPersist seconds more). */
export async function closeHostConnection(runner: Runner, hostName: string, host: HostConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const target = host.ssh;
  const args = sshArgs(hostName, host, '', env);
  await runner.exec('ssh', [...args.slice(0, args.length - 1), '-O', 'exit', target], { readOnly: false });
}
