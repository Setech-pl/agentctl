import { HarnessRefusal, liveCacheRoot } from './live-cache.ts';
export { HarnessRefusal } from './live-cache.ts';
import { DEFAULT_PROVIDERS, PROVIDER_IDS } from '../src/core/providers/types.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The harness every live test goes through (CONTRIBUTING.md, "Testing against the real tools"). It builds a sandbox under
 * the explicit AGENTCTL_LIVE_CACHE root: an isolated tmux server, its own AGENTCTL_HOME / CODEX_HOME / CLAUDE_CONFIG_DIR / HOME, and a PATH whose
 * only agents, clipboard tools and notifiers are fakes. Before anything is started it checks where `claude`, `codex` and the
 * socket of tmux really point, and refuses when the real thing would be reached. Earlier live tests started the real Claude Code
 * twice, ran the notify program of the real Codex config once and overwrote the real clipboard once.
 */

/** Commands that must resolve to a fake in the sandbox, never to the real binary. */
const SAFETY_AGENTS = [...new Set<string>([...PROVIDER_IDS, 'kimi'])];
export const FAKED_COMMANDS = [...SAFETY_AGENTS, 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript', 'notify-send', 'wl-copy', 'wl-paste', 'xclip'] as const;
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
  kimiHome?: string;
  claudeConfigDir?: string;
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
  for (const name of DEFAULT_PROVIDERS) {
    if (input.resolve(name, input.pathEnv) === undefined) throw new HarnessRefusal(`the fake "${name}" is not found on PATH (${input.pathEnv})`);
  }
  for (const dir of input.pathEnv.split(path.delimiter).filter(Boolean)) {
    if (inside(path.resolve(dir), input.fakeBin)) continue;
    for (const name of SAFETY_AGENTS) {
      if (fs.existsSync(path.join(dir, name))) throw new HarnessRefusal(`PATH contains ${dir}, which has a real "${name}"`);
    }
  }
  for (const [label, dir] of [['AGENTCTL_HOME', input.agentctlHome], ['CODEX_HOME', input.codexHome], ['KIMI_CODE_HOME', input.kimiHome], ['CLAUDE_CONFIG_DIR', input.claudeConfigDir]] as const) {
    if (dir === undefined) continue;
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

const FAKE_AGENT = (name: 'claude' | 'codex' | 'kimi'): string => `#!/bin/bash
# A fake ${name} for live tests: answers --version and --help, prints an idle screen, echoes what it is given. Every start is logged.
echo "${name} $*" >> "\${HARNESS_AGENT_LOG:-/dev/null}"
case "$1" in
  app-server) while IFS= read -r line; do
    case "$line" in
      *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}';;
      *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"rateLimits":{}}}';;
    esac
  done; exit 0;;
  --version) echo "${name === 'claude' ? '2.1.309 (Claude Code, fake)' : name === 'kimi' ? 'kimi 2.5.0 (fake)' : 'codex-cli 0.166.0 (fake)'}"; exit 0;;
  --help) ${name === 'claude' ? `echo "  --effort <level>"; echo "  --remote-control [name]               Start an interactive session with Remote Control enabled"; echo "  --append-system-prompt <prompt>       Append a system prompt (--bare: --append-system-prompt[-file])"` : `echo "  -c, --config <key=value>"`}; exit 0;;
esac
${name === 'claude' ? `printf '────────────────────\\n❯ Try "fake"\\n────────────────────\\n'` : `printf '› Ask Codex to do anything\\n  GPT-6.1-Sol low · ~/fake\\n  ? for shortcuts\\n'`}
${name === 'claude' ? `case " $* " in *" --remote-control "*) printf '  /rc active\\n';; esac` : ''}
while IFS= read -r line; do
  printf '● got: %s\\n' "$line"
  ${name === 'claude' ? `printf '────────────────────\\n❯ Try "fake"\\n────────────────────\\n'` : `printf '› Ask Codex to do anything\\n  GPT-6.1-Sol low · ~/fake\\n  ? for shortcuts\\n'`}
done
`;

const FAKE_LOGGER = (name: string): string => `#!/bin/bash
echo "${name} $*" >> "\${HARNESS_NOTIFY_LOG:-/dev/null}"
exit 0
`;

const FAKES: Record<string, string> = {
  claude: FAKE_AGENT('claude'),
  codex: FAKE_AGENT('codex'),
  kimi: FAKE_AGENT('kimi'),
  pbcopy: '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  pbpaste: '#!/bin/bash\ncat "${HARNESS_CLIPBOARD:?}" 2>/dev/null\n',
  'wl-copy': '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  'wl-paste': '#!/bin/bash\ncat "${HARNESS_CLIPBOARD:?}" 2>/dev/null\n',
  xclip: '#!/bin/bash\ncat > "${HARNESS_CLIPBOARD:?}"\n',
  'terminal-notifier': FAKE_LOGGER('terminal-notifier'),
  osascript: FAKE_LOGGER('osascript'),
  'notify-send': FAKE_LOGGER('notify-send'),
};

export const defaultCacheRoot = (_task?: string): string => liveCacheRoot();

export interface HarnessOptions {
  /** Directory name under the cache root (one sandbox per scenario). */
  name: string;
  /** A directory inside the required AGENTCTL_LIVE_CACHE root; defaults to that root. */
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
    const cacheRoot = liveCacheRoot(options.cacheRoot);
    if (!/^[a-z0-9-]+$/.test(options.name)) throw new HarnessRefusal(`invalid sandbox name: ${options.name}`);
    const socketAt = (root: string) => path.join(root, 'tmx', `tmux-${process.getuid?.() ?? 0}`, 'default');
    const namedRoot = path.join(cacheRoot, `live-${options.name}`);
    // Keep long task-owned roots usable without escaping to a shared /tmp socket.
    this.root = Buffer.byteLength(socketAt(namedRoot)) <= 100 ? namedRoot
      : path.join(cacheRoot, `live-${createHash('sha256').update(options.name).digest('hex').slice(0, 9)}`);
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
      KIMI_CODE_HOME: path.join(this.root, 'kimi-home'),
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
      kimiHome: this.env.KIMI_CODE_HOME,
      claudeConfigDir: this.env.CLAUDE_CONFIG_DIR,
      realHomes: [path.join(os.homedir(), '.agentctl'), path.join(os.homedir(), '.codex'), path.join(os.homedir(), '.claude'), path.join(os.homedir(), '.kimi-code')],
    });
  }

  /** Build the sandbox, check it, and start the isolated tmux server. Nothing is created in the tmux before every check passed. */
  start(): this {
    // Recheck before any reset: the environment or a symlink may have changed since construction.
    liveCacheRoot(this.root);
    // A sandbox is made new every time (its own folder `live-<name>`, nothing else is ever removed).
    if (!/^live-[a-z0-9-]+$/.test(path.basename(this.root))) throw new HarnessRefusal(`${this.root} is not a sandbox folder`);
    const socket = path.join(this.tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default');
    if (Buffer.byteLength(socket) > 100) throw new HarnessRefusal(`task-owned tmux socket path is too long: ${socket}`);
    fs.rmSync(this.root, { recursive: true, force: true });
    for (const dir of [this.root, this.fakeBin, this.home, this.agentctlHome, this.codexHome, this.tmuxDir, this.env.CLAUDE_CONFIG_DIR as string, this.env.KIMI_CODE_HOME as string, this.env.TMPDIR as string]) fs.mkdirSync(dir, { recursive: true });
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
      `set -g exit-empty off\nset -g default-command "exec env PATH=${this.env.PATH} HOME=${this.home} AGENTCTL_HOME=${this.agentctlHome} CODEX_HOME=${this.codexHome} CLAUDE_CONFIG_DIR=${this.env.CLAUDE_CONFIG_DIR} KIMI_CODE_HOME=${this.env.KIMI_CODE_HOME} TMPDIR=${this.env.TMPDIR} GIT_CONFIG_GLOBAL=${this.env.GIT_CONFIG_GLOBAL} HARNESS_AGENT_LOG=${this.agentLog} HARNESS_NOTIFY_LOG=${this.notifyLog} HARNESS_CLIPBOARD=${this.clipboard} bash --noprofile --norc"\n`,
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

/** Raw-TTY double for paste acknowledgements; replaces only a fake inside this harness. */
export function installPromptAgent(h: Harness, agent: 'claude' | 'codex' | 'kimi', mode: 'swallow-first' | 'swallow-all' | 'trust' | 'claude-spinner' | 'hook' | 'silent' | 'idle' | 'working' | 'approval' | 'question' | 'question-submit' | 'background' | 'complete' | 'limit' | 'overloaded' | 'interrupted' | 'auth' | 'usage', log: string): void {
  h.check();
  if (agent === 'kimi') {
    const source = fs.readFileSync(new URL('./fake-kimi.ts', import.meta.url), 'utf8').replace("'__KIMI_LOG__'", JSON.stringify(log)).replace("'__KIMI_MODE__'", JSON.stringify(mode));
    fs.writeFileSync(path.join(h.fakeBin, 'kimi'), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    return;
  }
  const program = `#!${process.execPath}
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('${agent} ${agent === 'claude' ? '2.1.311' : '0.166.0'} (fake)');process.exit(0);}
if(args.includes('--help')){console.log('--effort --remote-control --append-system-prompt');process.exit(0);}
let trusted=${mode !== 'trust'}, pasted='', stream='', enters=0, submitted=false;
const log=${JSON.stringify(log)};
const note=(value)=>fs.appendFileSync(log,JSON.stringify(value)+'\\n');
const acknowledge=(prompt)=>{
 if(${JSON.stringify(mode)}!=='hook')return;
 setTimeout(()=>{
  const payload=${agent === 'claude' ? "{prompt}" : "{type:'agent-turn-complete','last-assistant-message':'Done','input-messages':[prompt]}"};
  let result;
  if(${JSON.stringify(agent)}==='claude'){const i=args.indexOf('--settings');const settings=JSON.parse(fs.readFileSync(args[i+1],'utf8'));result=spawnSync(settings.hooks.UserPromptSubmit[0].hooks[0].command,{shell:true,input:JSON.stringify(payload),encoding:'utf8'});}
  else {const notify=JSON.parse(args.find(a=>a.startsWith('notify=')).slice(7));result=spawnSync(notify[0],[...notify.slice(1),JSON.stringify(payload)],{encoding:'utf8'});}
  note({hook:result.status,stderr:result.stderr});
 },2200);
};
const composer=s=>{const lines=s.trimEnd().split('\\n'),at=lines.findLastIndex(l=>/^[❯›](?:\\s|$)/.test(l));if(at<0)return s;
 if(${JSON.stringify(agent)}==='claude'){if(at>0&&/^[─]{3,}$/.test(lines[at-1])&&lines.slice(at+1).some(l=>l===lines[at-1]))return s;return [...lines.slice(0,at),'────────────────────',...lines.slice(at),'────────────────────'].join('\\n')+'\\n';}
 if(lines.some(l=>/^  [\\w.-]+ (?:low|medium|high|xhigh) · /.test(l)))return s;return s.trimEnd()+'\\n  GPT-6.1-Sol low · ~/fake\\n  ? for shortcuts\\n';};
const draw=()=>process.stdout.write('\\x1b[2J\\x1b[H'+(!trusted?'Do you trust this folder?\\n❯ No, exit\\nYes, I trust this folder\\n':submitted?${JSON.stringify(mode === 'claude-spinner' ? '✶ Transmogrifying… (5s · ↓ 816 tokens · thinking with low effort)\n\n❯ \n○ low · /effort\npaste again to expand\n' : mode === 'hook' || mode === 'silent' ? (agent === 'claude' ? '❯ \n' : '› \n') : 'Working (esc to interrupt)\n')}:composer('Heads up, you have less than 25% of your weekly limit left\\n${agent === 'codex' ? '›' : '❯'} '+(pasted?'[Pasted Content '+pasted.length+' chars]':'${agent === 'codex' ? 'Ask Codex to do anything' : 'Try "fake"'}')+'\\n')));
process.stdout.write('\\x1b[?2004h');process.stdin.setRawMode(true);process.stdin.resume();
process.stdin.on('data',data=>{stream+=data.toString();for(;;){
 if(stream.startsWith('\\x1b[200~')){const end=stream.indexOf('\\x1b[201~');if(end<0)return;pasted=stream.slice(6,end);stream=stream.slice(end+6);submitted=false;note({paste:pasted});draw();continue;}
 if(!stream.length)return;
 if(stream.startsWith('\\x1b') && stream.length<6)return;
 const c=stream[0];stream=stream.slice(1);
 if(!trusted){if(c==='y'){trusted=true;note({trusted:true});draw();}continue;}
 if(c==='\\r'||c==='\\n'){enters++;note({enter:enters});if(${JSON.stringify(mode)}!=='swallow-all' && (enters>1 || !['swallow-first','swallow-all'].includes(${JSON.stringify(mode)}))){submitted=true;acknowledge(pasted);pasted='';note({working:true});}draw();}
}});draw();
`;
  fs.writeFileSync(path.join(h.fakeBin, agent), program, { mode: 0o755 });
}

export interface ReplaySpec {
  agent: 'claude' | 'codex';
  /** Recorded screens (tests/fixtures/screen-*): ready, busy (a turn runs), pasted (the paste stands in the field), accepted (Enter was taken), question. */
  screens: Record<'ready' | 'busy' | 'pasted' | 'accepted' | 'question', string>;
  /** The state to show now; the double redraws when it changes. */
  state: 'ready' | 'busy' | 'question';
  /** How many Enter presses after a paste it ignores (the swallowed Enter of P15). */
  swallow: number;
  /** Claude: run the UserPromptSubmit hook of --settings with the payload Claude Code really sends (a collapsed paste wrapped in <pasted_content>). */
  hook: boolean;
  /** Show the paste whole in the field (all its lines) instead of a placeholder: a human can then change one line of it. */
  plain?: boolean;
  /**
   * Write the message into the session transcript the way the real CLI does (P15-FIX3, recorded 2026-11-05): Claude `queue-operation`/`enqueue` while a turn runs
   * (else a `user` line) under `<claudeLogs>/projects/<cwd>/<id>.jsonl`; Codex `response_item` + `item_completed` in a rollout under `<codexHome>/sessions/Y/M/D/`.
   * `delayMs`: after that long (the screen shows the message first and the transcript later).
   */
  transcript?: { claudeLogs: string; codexHome: string; delayMs: number; injectionDelayMs?: number };
}

/**
 * A fake agent that replays RECORDED screens in the real tmux of the harness and logs every paste and Enter to `log`. It reads `<root>/replay-spec.json`
 * on every action, so a scenario can change what it does between steps (`writeReplaySpec`). Replaces only a fake inside this harness.
 */
export function installReplayAgent(h: Harness, agent: 'claude' | 'codex', log: string): void {
  h.check();
  const program = `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('${agent} ${agent === 'claude' ? '2.1.311' : '0.166.0'} (replay)');process.exit(0);}
if(args.includes('--help')){console.log('--effort --remote-control --append-system-prompt');process.exit(0);}
const SPEC=${JSON.stringify(path.join(h.root, 'replay-spec.json'))}, LOG=${JSON.stringify(log)};
const spec=()=>JSON.parse(fs.readFileSync(SPEC,'utf8')), note=v=>fs.appendFileSync(LOG,JSON.stringify(v)+'\\n');
let state=spec().state, field='', pasted='', enters=0, count=0, stream='', shown='';
const PLACEHOLDER=/^(❯|›)(\\s)(?:\\[Pasted text #\\d+(?: \\+\\d+ lines)?\\]|Press up to edit queued messages)\\s*$/m;
const out=t=>process.stdout.write(t.replace(/\\n/g,'\\r\\n'));
const composer=s=>{const lines=s.trimEnd().split('\\n'),at=lines.findLastIndex(l=>/^[❯›](?:\\s|$)/.test(l));if(at<0)return s;
 if(${JSON.stringify(agent)}==='claude'){if(at>0&&/^[─]{3,}$/.test(lines[at-1])&&lines.slice(at+1).some(l=>l===lines[at-1]))return s;return [...lines.slice(0,at),'────────────────────',...lines.slice(at),'────────────────────'].join('\\n')+'\\n';}
 if(lines.some(l=>/^  [\\w.-]+ (?:low|medium|high|xhigh) · /.test(l)))return s;return s.trimEnd()+'\\n  GPT-6.1-Sol low · ~/fake\\n  ? for shortcuts\\n';};
const draw=name=>{let s=spec().screens[name];const marker='${agent === 'claude' ? '❯' : '›'}';
 const text=name==='pasted'||name==='ready'?field:'';
 if(name==='pasted')s=s.replace(PLACEHOLDER,(_m,mk)=>mk+'\\u00a0'+text);
 if(name==='ready')s=s+(text?marker+' '+text+'\\n':'');
 shown=name;out('\\x1b[2J\\x1b[H'+composer(s));};
const label=()=>{if(spec().plain)return pasted.replace(/\\r\\n?/g,'\\n');const lines=pasted.split('\\n').length;return lines>1?'[Pasted text #'+count+' +'+lines+' lines]':pasted.length>200?'[Pasted text #'+count+']':pasted;};
const hook=text=>{if(!spec().hook||${JSON.stringify(agent)}!=='claude')return;const i=args.indexOf('--settings');if(i<0)return;
 const settings=JSON.parse(fs.readFileSync(args[i+1],'utf8')),prompt=text.split('\\n').length>1||text.length>200?'<pasted_content id="80b3">\\n'+text+'\\n</pasted_content id="80b3">':text;
 const child=spawn(settings.hooks.UserPromptSubmit[0].hooks[0].command,{shell:true,stdio:['pipe','ignore','ignore']});child.stdin.end(JSON.stringify({hook_event_name:'UserPromptSubmit',prompt}));};
const sid='replay-'+process.pid;
const sessionKnown=file=>{let child;if(${JSON.stringify(agent)}==='claude'){const i=args.indexOf('--settings');if(i<0)return;const settings=JSON.parse(fs.readFileSync(args[i+1],'utf8'));child=spawn(settings.hooks.Notification[0].hooks[0].command,{shell:true,stdio:['pipe','ignore','ignore']});child.stdin.end(JSON.stringify({session_id:sid,transcript_path:file,notification_type:'idle_prompt'}));}
 else{const raw=args.find(a=>a.startsWith('notify='));if(!raw)return;const notify=JSON.parse(raw.slice(7));spawn(notify[0],[...notify.slice(1),JSON.stringify({type:'session-known','thread-id':sid})],{stdio:'ignore'});}};
const wrapped=text=>text.split('\\n').length>1||text.length>200?'<pasted_content id="c996">\\n'+text+'\\n</pasted_content id="c996">':text;
const transcript=(text,busy)=>{const t=spec().transcript;if(!t)return;setTimeout(()=>{const stored=text.replace(/\\r\\n?/g,'\\n').replace(/\\t/g,${JSON.stringify(agent)}==='claude'?'    ':'\\t').replace(/\\s+$/,''),now=()=>new Date().toISOString();
 if(${JSON.stringify(agent)}==='claude'){const dir=t.claudeLogs+'/projects/'+process.cwd().replace(/[^A-Za-z0-9]/g,'-');fs.mkdirSync(dir,{recursive:true});
  const row=busy?{type:'queue-operation',operation:'enqueue',timestamp:now(),sessionId:sid,content:wrapped(stored)}:{type:'user',timestamp:now(),message:{role:'user',content:wrapped(stored)},promptSource:'typed',sessionId:sid};
  const file=dir+'/'+sid+'.jsonl';fs.appendFileSync(file,JSON.stringify(row)+'\\n');sessionKnown(file);
  if(busy&&t.injectionDelayMs!==undefined)setTimeout(()=>{fs.appendFileSync(file,JSON.stringify({type:'user',timestamp:now(),message:{role:'user',content:wrapped(stored)},promptSource:'queued',sessionId:sid})+'\\n');},t.injectionDelayMs);}
 else{const d=new Date(),dir=t.codexHome+'/sessions/'+d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0'),file=dir+'/rollout-replay-'+sid+'.jsonl';fs.mkdirSync(dir,{recursive:true});
  if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({timestamp:now(),type:'session_meta',payload:{id:sid,cwd:process.cwd()}})+'\\n');
  fs.appendFileSync(file,JSON.stringify({timestamp:now(),type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:stored}]}})+'\\n'+JSON.stringify({timestamp:now(),type:'event_msg',payload:{type:'item_completed',item:{type:'UserMessage',content:[{type:'text',text:stored}]}}})+'\\n');sessionKnown(file);}
 },t.delayMs);};
process.stdout.write('\\x1b[?2004h');process.stdin.setRawMode(true);process.stdin.resume();draw(state);
let seenSpec=spec().state;setInterval(()=>{const s=spec().state;if(s!==seenSpec){seenSpec=s;state=s;draw(state==='ready'?'ready':state==='busy'?'busy':'question');}},100);
process.stdin.on('data',data=>{stream+=data.toString();for(;;){
 if(stream.startsWith('\\x1b[200~')){const end=stream.indexOf('\\x1b[201~');if(end<0)return;pasted=stream.slice(6,end);stream=stream.slice(end+6);count++;enters=0;note({paste:pasted,state});
  if(state==='question')continue;field=label();draw(state==='ready'?'ready':'pasted');continue;}
 if(!stream.length)return;
 if(stream.startsWith('\\x1b') && stream.length<6)return;
 const c=stream[0];stream=stream.slice(1);
 if(c==='\\r'||c==='\\n'){if(!field||state==='question')continue;enters++;note({enter:enters,state});
  if(state==='ready'){field='';state='busy';draw('busy');hook(pasted);transcript(pasted,false);continue;}
  if(enters<=spec().swallow){draw('pasted');continue;}
  field='';draw('accepted');note({accepted:true});hook(pasted);transcript(pasted,true);continue;}
 if(state!=='question'){if(c==='\\x7f'){field=field.slice(0,-1);note({backspace:true});}else{field+=c;note({typed:c});}draw(state==='ready'?'ready':'pasted');}
}});
`;
  fs.writeFileSync(path.join(h.fakeBin, agent), program, { mode: 0o755 });
}

/** (Re)write the spec of the replay agent; it picks the change up within 100 ms. */
export function writeReplaySpec(h: Harness, spec: ReplaySpec): void {
  fs.writeFileSync(path.join(h.root, 'replay-spec.json'), JSON.stringify(spec));
}
