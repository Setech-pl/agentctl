import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The harness every live test goes through (CONTRIBUTING.md, "Testing against the real tools"). It builds a sandbox under
 * ~/Projects/cache/<task>/: an isolated tmux server, its own AGENTCTL_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / HOME, and a PATH whose
 * only agents, clipboard tools and notifiers are fakes. Before anything is started it checks where `claude`, `codex` and the
 * socket of tmux really point, and refuses when the real thing would be reached. Earlier live tests started the real Claude Code
 * twice, ran the notify program of the real Codex config once and overwrote the real clipboard once.
 */

export class HarnessRefusal extends Error {
  constructor(message: string) {
    super(`live harness refuses to start: ${message}`);
    this.name = 'HarnessRefusal';
  }
}

/** Commands that must resolve to a fake in the sandbox, never to the real binary. */
export const FAKED_COMMANDS = ['claude', 'codex', 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript', 'notify-send', 'wl-copy', 'wl-paste', 'xclip'] as const;
/** Real tools the scripts under test need: linked into the fake bin directory (the real directory may hold the real agents too). */
export const LINKED_COMMANDS = ['tmux', 'git', 'node'] as const;

export interface SafetyInput {
  /** The sandbox root: everything must live under it. */
  root: string;
  /** The directory of the fakes. */
  fakeBin: string;
  /** The PATH the processes under test get. */
  pathEnv: string;
  /** What `command -v <name>` would print for that PATH; undefined: not found. */
  resolve: (name: string, pathEnv: string) => string | undefined;
  /** `#{socket_path}` of the tmux server the harness started (or would talk to); undefined: not known yet. */
  socketPath?: string | undefined;
  /** The socket of the user's own tmux server, for comparison. */
  defaultSocketPath?: string | undefined;
  agentctlHome: string;
  codexHome: string;
  /** The user's real directories, which must never be the sandbox's ones. */
  realHomes?: readonly string[];
}

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Throws HarnessRefusal when the setup could reach the user's real agents, clipboard, notifications, tmux server or config. */
export function checkHarnessSafety(input: SafetyInput): void {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  for (const name of FAKED_COMMANDS) {
    const found = input.resolve(name, input.pathEnv);
    if (found === undefined) continue;
    if (!inside(path.resolve(found), input.fakeBin)) {
      throw new HarnessRefusal(`"${name}" resolves to ${found}, outside the fake bin directory ${input.fakeBin}. Remove its directory from PATH.`);
    }
  }
  for (const name of ['claude', 'codex']) {
    if (input.resolve(name, input.pathEnv) === undefined) throw new HarnessRefusal(`the fake "${name}" is not found on PATH (${input.pathEnv})`);
  }
  for (const dir of input.pathEnv.split(path.delimiter).filter(Boolean)) {
    if (inside(path.resolve(dir), input.fakeBin)) continue;
    for (const name of ['claude', 'codex']) {
      if (fs.existsSync(path.join(dir, name))) throw new HarnessRefusal(`PATH contains ${dir}, which has a real "${name}"`);
    }
  }
  for (const [label, dir] of [['AGENTCTL_HOME', input.agentctlHome], ['CODEX_HOME', input.codexHome]] as const) {
    if (!inside(real(dir), real(input.root))) throw new HarnessRefusal(`${label} (${dir}) is not inside the sandbox ${input.root}`);
    for (const home of input.realHomes ?? []) {
      if (real(dir) === real(home)) throw new HarnessRefusal(`${label} is ${home}, the real one`);
    }
  }
  if (input.socketPath !== undefined) {
    if (input.defaultSocketPath !== undefined && path.resolve(input.socketPath) === path.resolve(input.defaultSocketPath)) {
      throw new HarnessRefusal(`the tmux socket is ${input.socketPath}, the socket of the default server`);
    }
    if (!inside(path.resolve(input.socketPath), path.resolve(input.root))) {
      throw new HarnessRefusal(`the tmux socket ${input.socketPath} is not inside the sandbox ${input.root}`);
    }
  }
}

/** `command -v name` for a PATH, without a shell: the first executable file of that name. */
export function commandV(name: string, pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

// ---- the fakes

const FAKE_AGENT = (name: 'claude' | 'codex'): string => `#!/bin/bash
# A fake ${name} for live tests: answers --version and --help, prints an idle screen, echoes what it is given. Every start is logged.
echo "${name} $*" >> "\${HARNESS_AGENT_LOG:-/dev/null}"
case "$1" in
  app-server) while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}';;
      *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"rateLimits":{}}}';;
    esac
  done; exit 0;;
  --version) echo "${name === 'claude' ? '2.1.309 (Claude Code, fake)' : 'codex-cli 0.166.0 (fake)'}"; exit 0;;
  --help) ${name === 'claude' ? `echo "  --effort <level>"; echo "  --remote-control [name]               Start an interactive session with Remote Control enabled"; echo "  --append-system-prompt <prompt>       Append a system prompt (--bare: --append-system-prompt[-file])"` : `echo "  -c, --config <key=value>"`}; exit 0;;
esac
${name === 'claude' ? `printf '❯ Try "fake"\\n'` : `printf '› Ask Codex to do anything\\n'`}
${name === 'claude' ? `case " $* " in *" --remote-control "*) printf '  /rc active\\n';; esac` : ''}
while IFS= read -r line; do
  printf '● got: %s\\n' "$line"
  ${name === 'claude' ? `printf '❯ Try "fake"\\n'` : `printf '› Ask Codex to do anything\\n'`}
done
`;

const FAKE_LOGGER = (name: string): string => `#!/bin/bash
echo "${name} $*" >> "\${HARNESS_NOTIFY_LOG:-/dev/null}"
exit 0
`;

const FAKES: Record<string, string> = {
  claude: FAKE_AGENT('claude'),
  codex: FAKE_AGENT('codex'),
  pbcopy: '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  pbpaste: '#!/bin/bash\ncat "${HARNESS_CLIPBOARD:?}" 2>/dev/null\n',
  'wl-copy': '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  'wl-paste': '#!/bin/bash\ncat "${HARNESS_CLIPBOARD:?}" 2>/dev/null\n',
  xclip: '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  'terminal-notifier': FAKE_LOGGER('terminal-notifier'),
  osascript: FAKE_LOGGER('osascript'),
  'notify-send': FAKE_LOGGER('notify-send'),
};

export const defaultCacheRoot = (task = 'agentctl-15'): string => process.env.AGENTCTL_LIVE_CACHE ?? path.join(os.homedir(), 'Projects', 'cache', task);

export interface HarnessOptions {
  /** Directory name under the cache root (one sandbox per scenario). */
  name: string;
  /** The task's cache directory; default ~/Projects/cache/agentctl-12. */
  cacheRoot?: string;
  /** Text of the sandbox's config.yaml after `cache` / `state_dir` / `usage` (which the harness always sets). */
  config?: string;
  /** The session name in the sandbox's tmux. */
  session?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class Harness {
  readonly root: string;
  readonly fakeBin: string;
  readonly home: string;
  readonly agentctlHome: string;
  readonly codexHome: string;
  readonly tmuxDir: string;
  readonly tmuxConf: string;
  readonly session: string;
  readonly agentLog: string;
  readonly notifyLog: string;
  readonly clipboard: string;
  readonly env: NodeJS.ProcessEnv;
  socketPath = '';
  private children: ChildProcess[] = [];
  private serverUp = false;

  private readonly options: HarnessOptions;
  private readonly repoRoot: string;

  constructor(options: HarnessOptions, repoRoot: string) {
    this.options = options;
    this.repoRoot = repoRoot;
    const cacheRoot = options.cacheRoot ?? defaultCacheRoot();
    this.root = path.join(cacheRoot, `live-${options.name}`);
    this.fakeBin = path.join(this.root, 'fakebin');
    this.home = path.join(this.root, 'home');
    this.agentctlHome = path.join(this.root, 'agentctl-home');
    this.codexHome = path.join(this.root, 'codex-home');
    this.tmuxDir = path.join(this.root, 'tmx');
    this.tmuxConf = path.join(this.root, 'tmux.conf');
    this.session = options.session ?? 'agentctl-test';
    this.agentLog = path.join(this.root, 'agent.log');
    this.notifyLog = path.join(this.root, 'notify.log');
    this.clipboard = path.join(this.root, 'clipboard.txt');
    const pathEnv = `${this.fakeBin}:/usr/bin:/bin`;
    this.env = {
      PATH: pathEnv,
      HOME: this.home,
      TMPDIR: path.join(this.root, 'tmp'),
      LANG: 'en_US.UTF-8',
      TERM: 'screen-256color',
      TMUX_TMPDIR: this.tmuxDir,
      AGENTCTL_HOME: this.agentctlHome,
      CODEX_HOME: this.codexHome,
      CLAUDE_CONFIG_DIR: path.join(this.root, 'claude-config'),
      GIT_CONFIG_GLOBAL: path.join(this.root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      HARNESS_AGENT_LOG: this.agentLog,
      HARNESS_NOTIFY_LOG: this.notifyLog,
      HARNESS_CLIPBOARD: this.clipboard,
    };
  }

  /** The checks of `checkHarnessSafety` on the real file system; throws HarnessRefusal. */
  check(): void {
    checkHarnessSafety({
      root: this.root,
      fakeBin: this.fakeBin,
      pathEnv: this.env.PATH as string,
      resolve: commandV,
      socketPath: this.socketPath || undefined,
      defaultSocketPath: defaultTmuxSocket(),
      agentctlHome: this.agentctlHome,
      codexHome: this.codexHome,
      realHomes: [path.join(os.homedir(), '.agentctl'), path.join(os.homedir(), '.codex')],
    });
  }

  /** Build the sandbox, check it, and start the isolated tmux server. Nothing is created in the tmux before every check passed. */
  start(): this {
    // A sandbox is made new every time (its own folder `live-<name>`, nothing else is ever removed).
    if (!/^live-[a-z0-9-]+$/.test(path.basename(this.root))) throw new HarnessRefusal(`${this.root} is not a sandbox folder`);
    fs.rmSync(this.root, { recursive: true, force: true });
    for (const dir of [this.root, this.fakeBin, this.home, this.agentctlHome, this.codexHome, this.tmuxDir, this.env.CLAUDE_CONFIG_DIR as string, this.env.TMPDIR as string]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(this.root, 'gitconfig'), '[user]\n\tname = Harness\n\temail = harness@example.invalid\n[init]\n\tdefaultBranch = main\n');
    for (const [name, body] of Object.entries(FAKES)) fs.writeFileSync(path.join(this.fakeBin, name), body, { mode: 0o755 });
    for (const name of LINKED_COMMANDS) {
      const real = commandV(name, process.env.PATH ?? '');
      if (!real) throw new HarnessRefusal(`"${name}" is not installed`);
      const link = path.join(this.fakeBin, name);
      fs.rmSync(link, { force: true });
      fs.symlinkSync(real, link);
    }
    fs.writeFileSync(
      path.join(this.agentctlHome, 'config.yaml'),
      `cache: ${path.join(this.root, 'cache')}\nstate_dir: ${path.join(this.root, 'state')}\nsession: ${this.session}\nusage:\n  claude_dir: ${path.join(this.root, 'claude-logs')}\n  codex_dir: ${this.codexHome}\n${this.options.config ?? ''}`,
    );
    fs.writeFileSync(
      this.tmuxConf,
      `set -g exit-empty off\nset -g default-command "exec env PATH=${this.env.PATH} HOME=${this.home} AGENTCTL_HOME=${this.agentctlHome} CODEX_HOME=${this.codexHome} CLAUDE_CONFIG_DIR=${this.env.CLAUDE_CONFIG_DIR} GIT_CONFIG_GLOBAL=${this.env.GIT_CONFIG_GLOBAL} HARNESS_AGENT_LOG=${this.agentLog} HARNESS_NOTIFY_LOG=${this.notifyLog} HARNESS_CLIPBOARD=${this.clipboard} bash --noprofile --norc"\n`,
    );
    this.check();
    const started = this.tmux(['-f', this.tmuxConf, 'start-server', ';', 'display-message', '-p', '#{socket_path}']);
    if (started.code !== 0) throw new HarnessRefusal(`the isolated tmux server did not start: ${started.stderr.trim()}`);
    this.socketPath = started.stdout.trim();
    this.serverUp = true;
    try {
      this.check();
    } catch (e) {
      this.killServer();
      throw e;
    }
    return this;
  }

  /** tmux on the sandbox's server only (TMUX unset, TMUX_TMPDIR set, the socket checked). */
  tmux(args: string[]): RunResult {
    const r = spawnSync('tmux', args, { env: this.env, encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** Kill the sandbox's tmux server (the resume scenario: a restart of the Mac). */
  killServer(): void {
    if (!this.serverUp) return;
    this.tmux(['kill-server']);
    this.serverUp = false;
  }

  /** Start the sandbox's tmux server again (after `killServer`). */
  restartServer(): void {
    const r = this.tmux(['-f', this.tmuxConf, 'start-server', ';', 'display-message', '-p', '#{socket_path}']);
    if (r.code !== 0) throw new HarnessRefusal(`the tmux server did not start again: ${r.stderr.trim()}`);
    this.socketPath = r.stdout.trim();
    this.serverUp = true;
    this.check();
  }

  private argv(args: string[]): string[] {
    return ['--experimental-strip-types', '--no-warnings', path.join(this.repoRoot, 'bin', 'agentctl.ts'), ...args];
  }

  /** Run `agentctl <args>` in the sandbox and wait. */
  agentctl(args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number } = {}): RunResult {
    this.check();
    const r = spawnSync(process.execPath, this.argv(args), { env: this.env, cwd: opts.cwd ?? this.root, encoding: 'utf8', input: opts.input, timeout: opts.timeoutMs ?? 60_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  /** Start `agentctl <args>` in the background (a watcher); it is stopped by `stop()`. */
  spawnAgentctl(args: string[], logFile: string): ChildProcess {
    this.check();
    const out = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, this.argv(args), { env: this.env, cwd: this.root, stdio: ['ignore', out, out] });
    this.children.push(child);
    return child;
  }

  /** Stop what this harness started: its background processes and its tmux server. Safe to call twice. */
  stop(): void {
    for (const child of this.children) if (child.exitCode === null) child.kill('SIGTERM');
    this.children = [];
    this.killServer();
  }

  /** The agent starts the fakes logged: "claude --continue …". */
  agentStarts(): string[] {
    try {
      return fs.readFileSync(this.agentLog, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

/** The socket path of the default tmux server of this user (what a tmux without TMUX_TMPDIR uses). */
export function defaultTmuxSocket(): string {
  const uid = process.getuid?.() ?? 0;
  return path.join('/private/tmp', `tmux-${uid}`, 'default');
}

/** Build, check and start a harness, run `fn`, and always clean up (the tmux server, the background processes). */
export async function withHarness<T>(options: HarnessOptions, fn: (h: Harness) => Promise<T> | T, repoRoot: string = path.resolve(import.meta.dirname, '..')): Promise<T> {
  const h = new Harness(options, repoRoot);
  try {
    h.start();
    return await fn(h);
  } finally {
    h.stop();
  }
}
