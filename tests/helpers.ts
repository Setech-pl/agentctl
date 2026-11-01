import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import type { GlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult, RecordingOptions, Runner } from '../src/core/runner.ts';
import { renderTaskMd, taskDir, taskFile } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCRATCH = path.join(REPO_ROOT, '.cache');

/** Per-file scratch directory under the repo's own .cache/ (git-ignored); removed after the file's tests. */
export function useScratch(): { dir: string; sub: (name: string) => string } {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    sub(name: string): string {
      const p = path.join(dir, name);
      fs.mkdirSync(p, { recursive: true });
      return p;
    },
  };
}

/** Write `<root>/home/config.yaml` (cache = <root>/cache, state_dir = <root>/state) and load it. */
export function makeConfig(root: string, extraYaml = ''): GlobalConfig {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), `cache: ${path.join(root, 'cache')}\nstate_dir: ${path.join(root, 'state')}\n${extraYaml}`);
  return loadGlobalConfig(home);
}

export function makeContext(
  config: GlobalConfig,
  options: RecordingOptions = {},
  confirm?: (question: string) => Promise<boolean>,
): { ctx: Context; runner: RecordingRunner; out: string[] } {
  const out: string[] = [];
  const runner = new RecordingRunner({ dryRun: false, ...options });
  return { ctx: new Context(runner, config, (l) => out.push(l), confirm), runner, out };
}

/** A spec file text for tests. */
export function specText(header: Record<string, string>, repoPath: string, prompt = 'Do the thing.'): string {
  const lines = Object.entries(header).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\nrepos:\n  - path: ${repoPath}\n    worktree: ${repoPath}-wt\n---\n${prompt}\n`;
}

/** Write a minimal TASK.md for a task and return its record. */
export function seedTask(config: GlobalConfig, task: string, extra: Partial<TaskRecord> = {}): TaskRecord {
  const record: TaskRecord = {
    task,
    window: task.toLowerCase(),
    session: config.session,
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    repos: [],
    links: [],
    env: {},
    report: path.join(config.cache, task.toLowerCase(), `${task}.md`),
    started: new Date(Date.UTC(2026, 9, 31, 11, 0, 0)).toISOString(),
    requested: { agent: 'claude', model: 'opus', effort: 'high' },
    ...extra,
  };
  fs.mkdirSync(taskDir(config, record.window), { recursive: true });
  fs.writeFileSync(taskFile(config, record.window), renderTaskMd(record, `Do ${task}.`));
  return record;
}

export interface FakeWindow {
  id: string;
  name: string;
  screen: string;
}

/**
 * A scripted tmux server for RecordingRunner's `respond`: windows with ids, names (which may carry an icon prefix) and
 * screens. Targets resolve like tmux does: "@id", or "=session:name" with an exact name match.
 */
export class FakeTmux {
  windows: FakeWindow[] = [];
  readonly session: string;
  private nextId = 1;
  /** The screen of windows created by new-window and new-session: an idle Claude prompt. */
  newWindowScreen = '❯ \n';
  /** Every tmux command seen, as "subcommand target". */
  readonly seen: string[] = [];
  /** Clients attached to the session (`list-clients`): name and last activity. */
  clients: { name: string; activity: number }[] = [];
  /** `TERM_PROGRAM` of the tmux server's global environment; undefined: not set. */
  termProgram: string | undefined;
  /** `switch-client -c <client>` calls: the client names. */
  readonly switched: string[] = [];

  constructor(session = 'agentctl') {
    this.session = session;
  }

  add(name: string, screen = '', id?: string): FakeWindow {
    const w = { id: id ?? `@${this.nextId++}`, name, screen };
    this.windows.push(w);
    return w;
  }

  find(target: string): FakeWindow | undefined {
    if (target.startsWith('@')) return this.windows.find((w) => w.id === target);
    const prefix = `=${this.session}:`;
    return target.startsWith(prefix) ? this.windows.find((w) => w.name === target.slice(prefix.length)) : undefined;
  }

  respond = (cmd: string, args: string[], _opts?: ExecOptions): Partial<ExecResult> | undefined => {
    if (cmd !== 'tmux') return undefined;
    const sub = args[0] as string;
    const target = args.includes('-t') ? (args[args.indexOf('-t') + 1] as string) : '';
    this.seen.push(`${sub} ${target}`.trim());
    switch (sub) {
      case 'list-windows': {
        if (this.windows.length === 0) return { code: 1 };
        const format = args[args.indexOf('-F') + 1] ?? '#{window_name}';
        return { stdout: this.windows.map((w) => format.replace('#{window_id}', w.id).replace('#{window_name}', w.name)).join('\n') };
      }
      case 'has-session':
        return { code: this.windows.length ? 0 : 1 };
      case 'list-clients':
        return this.windows.length ? { stdout: this.clients.map((c) => `${c.activity}\t${c.name}`).join('\n') } : { code: 1 };
      case 'show-environment':
        return this.termProgram ? { stdout: `TERM_PROGRAM=${this.termProgram}\n` } : { code: 1 };
      case 'switch-client':
        this.switched.push(args[args.indexOf('-c') + 1] ?? '');
        return {};
      case 'capture-pane': {
        const w = this.find(target);
        return w ? { stdout: w.screen } : { code: 1, stderr: `can't find window: ${target}` };
      }
      case 'rename-window': {
        const w = this.find(target);
        if (!w) return { code: 1, stderr: `can't find window: ${target}` };
        w.name = args[args.length - 1] as string;
        return {};
      }
      case 'kill-window': {
        const w = this.find(target);
        if (!w) return { code: 1, stderr: `can't find window: ${target}` };
        this.windows = this.windows.filter((x) => x !== w);
        return {};
      }
      case 'new-window':
      case 'new-session': {
        const name = args[args.indexOf('-n') + 1] as string;
        this.add(name, this.newWindowScreen);
        return {};
      }
      case 'select-window':
      case 'send-keys':
      case 'paste-buffer':
        return this.find(target) ? {} : { code: 1, stderr: `can't find window: ${target}` };
      default:
        return undefined;
    }
  };
}

/** Records like RecordingRunner and also really writes files, for code that reads back what it wrote (TASK.md, logs). */
export class DiskRunner extends RecordingRunner {
  override async writeFile(file: string, content: string): Promise<void> {
    await super.writeFile(file, content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  override async appendFile(file: string, content: string): Promise<void> {
    await super.appendFile(file, content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, content);
  }

  override async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
}

/** Run the CLI with `runner` for every command; returns the exit code and what was printed. */
export async function runCli(config: GlobalConfig, runner: Runner, argv: string[], extra: Partial<CliDeps> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
    confirm: undefined, readClipboard: async () => '', watchCommand: () => 'agentctl watch', boardCommand: () => 'agentctl board', makeRunner: () => runner, ...extra,
  };
  const code = await main(argv, deps);
  return { code, stdout: out.join(''), stderr: err.join('') };
}
