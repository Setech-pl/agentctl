import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { shellLine } from './util.ts';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  /** Written to the command's stdin. */
  input?: string;
  /** Pure query (no side effects): a dry run skips printing it and returns `dryResult` instead. */
  readOnly?: boolean;
  /** What a dry run pretends a read-only query returned. */
  dryResult?: Partial<ExecResult>;
  timeoutMs?: number;
  /** Hand the terminal to the command (stdin, stdout and stderr are inherited, no timeout): `tmux attach-session`. */
  interactive?: boolean;
}

/**
 * Everything agentctl does to the outside world goes through this interface:
 * external commands (tmux, git, clipboard) and file-system writes. Production uses
 * `RealRunner`; `--dry-run` and the tests use `RecordingRunner`, which only records.
 */
export interface Runner {
  readonly dryRun: boolean;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
  appendFile(file: string, content: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  /** Create `linkPath` pointing at `target`, replacing an existing symlink. */
  symlink(target: string, linkPath: string): Promise<void>;
  /** Wait `ms`; aborting `signal` ends the wait early. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** Explanatory line for dry-run output; ignored by the real runner. */
  note(message: string): void;
}

/**
 * The environment for a tmux command. tmux prints control characters (the tab in `-F '#{window_id}\t#{window_name}'`) and
 * non-ASCII window names as "_" unless a locale variable says UTF-8, and a notification click or a hook runs without any.
 */
export function tmuxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return /utf-?8/i.test(locale) ? env : { ...env, LC_ALL: 'en_US.UTF-8' };
}

export class RealRunner implements Runner {
  readonly dryRun = false;

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const env = cmd === 'tmux' ? tmuxEnv(process.env) : process.env;
    if (opts.interactive) {
      const r = spawnSync(cmd, args, { cwd: opts.cwd, stdio: 'inherit', env });
      if (r.error) return { code: (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1, stdout: '', stderr: r.error.message };
      return { code: r.status ?? 1, stdout: '', stderr: '' };
    }
    const r = spawnSync(cmd, args, {
      cwd: opts.cwd,
      env,
      input: opts.input,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) {
      const missing = (r.error as NodeJS.ErrnoException).code === 'ENOENT';
      return { code: missing ? 127 : 1, stdout: '', stderr: r.error.message };
    }
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  async mkdir(dir: string): Promise<void> {
    fs.mkdirSync(dir, { recursive: true });
  }

  async writeFile(file: string, content: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  async appendFile(file: string, content: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, content);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
    } catch {
      // nothing at linkPath yet
    }
    fs.symlinkSync(target, linkPath);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  now(): number {
    return Date.now();
  }

  note(): void {}
}

export interface RecordedCall {
  /** One-line, shell-style rendering of the call. */
  line: string;
  input?: string;
}

export interface RecordingOptions {
  /** `true` (default) for --dry-run. Tests that exercise polling pass `false`. */
  dryRun?: boolean;
  /** Scripted answers for commands; return undefined to fall back to the default (success, empty output). */
  respond?: (cmd: string, args: string[], opts: ExecOptions) => Partial<ExecResult> | undefined;
  /** Called with every printable line as it is recorded (the CLI passes console.log here). */
  emit?: (line: string) => void;
  /** Start of the fake clock, in ms. `sleep` advances it instantly. */
  startTime?: number;
}

/** Records the commands agentctl would run instead of running them. */
export class RecordingRunner implements Runner {
  readonly dryRun: boolean;
  readonly calls: RecordedCall[] = [];
  readonly queries: string[] = [];
  readonly notes: string[] = [];
  /** Content of every file the run would have written, by path. */
  readonly written = new Map<string, string>();
  /** Everything the run would have appended to files, by path. */
  readonly appended = new Map<string, string>();
  private clock: number;
  private respond: RecordingOptions['respond'];
  private emit: RecordingOptions['emit'];

  constructor(options: RecordingOptions = {}) {
    this.dryRun = options.dryRun ?? true;
    this.respond = options.respond;
    this.emit = options.emit;
    this.clock = options.startTime ?? Date.UTC(2026, 9, 31, 12, 0, 0);
  }

  /** The recorded mutating commands, one line each. */
  get commands(): string[] {
    return this.calls.map((c) => c.line);
  }

  private record(line: string, input?: string): void {
    this.calls.push(input === undefined ? { line } : { line, input });
    if (!this.emit) return;
    this.emit(line);
    if (input !== undefined) {
      this.emit(`# stdin of the command above:`);
      for (const l of input.split('\n')) this.emit(`#   ${l}`);
    }
  }

  async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const line = opts.cwd ? `(cd ${shellLine(opts.cwd, [])} && ${shellLine(cmd, args)})` : shellLine(cmd, args);
    const scripted = this.respond?.(cmd, args, opts);
    if (opts.readOnly) {
      this.queries.push(line);
      // dryResult is only the stand-in for a dry run; a scripted (test) answer always wins.
      return { code: 0, stdout: '', stderr: '', ...(this.dryRun ? opts.dryResult : undefined), ...scripted };
    }
    this.record(line, opts.input);
    return { code: 0, stdout: '', stderr: '', ...scripted };
  }

  async mkdir(dir: string): Promise<void> {
    this.record(`mkdir -p ${shellLine(dir, [])}`);
  }

  async writeFile(file: string, content: string): Promise<void> {
    this.written.set(file, content);
    this.record(`write ${shellLine(file, [])} (${Buffer.byteLength(content)} bytes)`);
  }

  async appendFile(file: string, content: string): Promise<void> {
    this.appended.set(file, (this.appended.get(file) ?? '') + content);
    this.record(`append ${shellLine(file, [])} (${Buffer.byteLength(content)} bytes)`);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    this.record(`cp ${shellLine(src, [])} ${shellLine(dest, [])}`);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.record(`ln -sfn ${shellLine(target, [])} ${shellLine(linkPath, [])}`);
  }

  async sleep(ms: number): Promise<void> {
    this.clock += ms;
  }

  now(): number {
    return this.clock;
  }

  note(message: string): void {
    this.notes.push(message);
    this.emit?.(`# ${message}`);
  }
}
