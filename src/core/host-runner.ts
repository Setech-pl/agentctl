import fs from 'node:fs';
import path from 'node:path';
import type { HostConfig } from './hosts.ts';
import { runOnHost, sshSocketPath, SSH_COMMAND_TIMEOUT_MS } from './host-ssh.ts';
import type { ExecOptions, ExecResult, Runner } from './runner.ts';
import { AgentctlError, shellLine, shellQuote } from './util.ts';

export class HostUnreachable extends AgentctlError {
  readonly host: string;
  constructor(host: string, detail: string) { super(`host ${host} unreachable: ${detail}`); this.host = host; }
}

/** Remote commands and files only. Dispatcher state always uses the original local runner. */
export class HostRunner implements Runner {
  readonly dryRun: boolean;
  readonly local: Runner;
  readonly name: string;
  readonly host: HostConfig;
  readonly onConnection?: (up: boolean, detail: string) => void | Promise<void>;
  constructor(local: Runner, name: string, host: HostConfig, onConnection?: (up: boolean, detail: string) => void | Promise<void>) {
    this.local = local; this.name = name; this.host = host; this.onConnection = onConnection;
    this.dryRun = local.dryRun;
  }
  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const env = { ...this.host.env, ...opts.env };
    const exports = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new AgentctlError(`Invalid host environment key: ${key}`);
      return `export ${key}=${shellQuote(value)};`;
    }).join(' ');
    const command = `${exports}${opts.cwd ? ` cd ${shellQuote(opts.cwd)} &&` : ''} ${shellLine(cmd, args)}`.trim();
    if (!this.dryRun) await this.local.mkdir(path.dirname(sshSocketPath(this.name)));
    const result = await runOnHost(this.local, this.name, this.host, command, opts.timeoutMs ?? SSH_COMMAND_TIMEOUT_MS, process.env, { input: opts.input, readOnly: opts.readOnly, dryResult: opts.dryResult });
    if (result.state !== 'reachable') {
      const detail = `${result.state}: ${result.stderr.trim()}`;
      await this.onConnection?.(false, detail);
      throw new HostUnreachable(this.name, detail);
    }
    await this.onConnection?.(true, '');
    return result;
  }
  async checked(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.exec(cmd, args, opts);
    if (r.code !== 0) throw new AgentctlError(`host ${this.name}: ${cmd} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r;
  }
  async mkdir(dir: string): Promise<void> { await this.checked('mkdir', ['-p', '--', dir]); }
  async writeFile(file: string, content: string): Promise<void> {
    await this.checked('sh', ['-c', `umask 077; mkdir -p -- ${shellQuote(path.posix.dirname(file))} || exit; f=${shellQuote(file)}; t="$f.agentctl-$$"; cat > "$t" && mv -f -- "$t" "$f"`], { input: content });
  }
  async appendFile(file: string, content: string): Promise<void> { await this.checked('sh', ['-c', `umask 077; cat >> ${shellQuote(file)}`], { input: content }); }
  async copyFile(src: string, dest: string): Promise<void> { await this.writeFile(dest, fs.readFileSync(src, 'utf8')); }
  async rename(from: string, to: string): Promise<void> { await this.checked('mv', ['--', from, to]); }
  async remove(): Promise<void> { throw new AgentctlError('Generic remote deletion is disabled; use owner-confirmed gc or explicit git worktree remove'); }
  async symlink(target: string, link: string): Promise<void> { await this.checked('ln', ['-sfn', '--', target, link]); }
  sleep(ms: number, signal?: AbortSignal): Promise<void> { return this.local.sleep(ms, signal); }
  now(): number { return this.local.now(); }
  note(message: string): void { this.local.note(`[${this.name}] ${message}`); }
}
