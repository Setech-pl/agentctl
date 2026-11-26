import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, GlobalConfig } from './config.ts';
import { readTaskRecord, taskDir } from './taskstore.ts';
import { sameMessage } from './paste-wrapper.ts';
import { RealRunner, type ExecOptions, type ExecResult } from './runner.ts';
import { insidePath } from './worktree-volume.ts';
import { commandStageRemaining } from './command-stage.ts';

export const CANARY_PROMPT = 'No-op release safety fixture.';
const oid = 'a'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const absent = (stderr = ''): ExecResult => ({ code: 1, stdout: '', stderr });
const line = '─'.repeat(80);
const composer = (agent: string, text?: string) => agent === 'codex'
  ? `› ${text ?? 'Ask Codex to do anything'}\n  GPT low · fixture · release check\n  ? for shortcuts`
  : `${line}\n❯ ${text ?? ''}\n${line}\n? for shortcuts`;
const idle = (agent: string) => composer(agent);
const busy = 'Working (esc to interrupt)';

interface Pane { id: string; paneId: string; name: string; role: string; screen: string; paste?: string; ack?: boolean; exitCode?: number }

export class CanaryRunner extends RealRunner {
  readonly panes = new Map<string, Pane>();
  readonly worktrees = new Map<string, { repo: string; dirty: boolean; branch: string }>();
  readonly launches = new Map<string, number>();
  readonly delivered = new Set<string>();
  readonly failedChecks = new Map<string, number>();
  hungResumeWindow?: string;
  hungResumeAttempts = 0;
  tick = 0;
  private sequence = 0;
  private readonly buffers = new Map<string, string>();
  readonly root: string;
  private readonly config: GlobalConfig;
  private readonly session: string;
  private readonly slowMs: number;
  constructor(root: string, config: GlobalConfig, slowMs: number) {
    super();
    this.root = root;
    this.config = config;
    this.session = config.session;
    this.slowMs = slowMs;
  }

  addPane(name: string, agent: AgentName | 'unknown', screen = idle(agent)): Pane {
    const seq = ++this.sequence;
    const pane = { id: `@${seq}`, paneId: `%${seq}`, name, role: name, screen };
    this.panes.set(name, pane);
    return pane;
  }

  private permitted(file: string): string {
    if (!insidePath(this.root, path.resolve(file))) throw new Error('Canary path escaped its isolated directory');
    return file;
  }

  addWorktree(repo: string, directory: string, branch = 'HEAD', dirty = false): void {
    const target = this.permitted(directory);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.git'), 'fixture gitdir\n');
    if (dirty) fs.writeFileSync(path.join(target, 'only-copy'), 'Canary data that GC must protect.\n');
    this.worktrees.set(target, { repo: this.permitted(repo), dirty, branch });
  }

  override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (cmd === 'tmux') return this.tmux(args, opts);
    if (cmd === 'git') return this.git(args);
    if (['claude', 'codex', 'kimi', 'claude-glm'].includes(cmd) && args[0] === '--version') {
      const remaining = this.failedChecks.get(cmd) ?? 0;
      if (remaining) { this.failedChecks.set(cmd, remaining - 1); return absent('Canary transient version check'); }
      return ok(`${cmd} 1.0.0 (fixture)\n`);
    }
    if (cmd === 'df') return ok('Filesystem 1024-blocks Used Available Capacity Mounted on\ncanary 268435456 0 268435456 0% /\n');
    if (cmd === 'ps' || cmd === 'chmod' || cmd === '/sbin/mount') return ok();
    if (cmd.endsWith('lsof')) return absent();
    return absent(`${cmd} is unavailable in the isolated canary runner`);
  }

  private async tmux(args: string[], opts: ExecOptions): Promise<ExecResult> {
    const sub = args[0] === '-L' || args[0] === '-S' ? args[2] : args[0];
    const target = args[args.indexOf('-t') + 1] ?? '';
    const buffer = args[args.indexOf('-b') + 1] ?? '';
    const pane = [...this.panes.values()].find(p => p.id === target || p.paneId === target || `=${this.session}:${p.name}` === target);
    const format = (p: Pane) => (args[args.indexOf('-F') + 1] ?? args.at(-1) ?? '').replace(/#\{([^}]+)\}/g, (_all, field: string) => ({
      window_id: p.id, window_name: p.name, pane_id: p.paneId, pane_dead: p.exitCode === undefined ? '0' : '1', pane_dead_status: String(p.exitCode ?? ''), session_name: this.session,
      '@agentctl-role': p.role, pane_current_command: 'fixture',
    })[field] ?? '');
    switch (sub) {
      case '-V': return ok('tmux 3.5');
      case 'has-session': return this.panes.size ? ok() : absent('no server running');
      case 'list-windows': return ok([...this.panes.values()].map(format).join('\n'));
      case 'display-message': return pane ? ok(format(pane)) : absent('can\'t find pane');
      case 'new-session':
      case 'new-window': {
        const name = args[args.indexOf('-n') + 1]!;
        this.permitted(args[args.indexOf('-c') + 1]!);
        this.launches.set(name, this.tick);
        this.addPane(name, 'claude');
        return ok();
      }
      case 'rename-window': if (pane) pane.name = args.at(-1)!; return ok();
      case 'kill-window': if (pane) for (const [name, p] of this.panes) if (p === pane) this.panes.delete(name); return ok();
      case 'capture-pane': {
        if (!pane) return absent('can\'t find pane');
        if (args.includes('-J') && pane.ack) { pane.ack = false; return ok(`⏺ Fixture delivered\n• Fixture delivered\n${busy}`); }
        const agent = pane.screen.includes('›') ? 'codex' : 'claude';
        let draft = pane.paste;
        if (draft?.includes('\n')) draft = agent === 'claude' ? `[Pasted text #1 +${draft.split('\n').length - 1} lines]` : `[Pasted Content ${draft.length} chars]`;
        return ok(draft ? composer(agent, draft) : pane.screen);
      }
      case 'load-buffer': this.buffers.set(buffer, opts.input ?? ''); return ok();
      case 'paste-buffer': if (pane) { pane.paste = this.buffers.get(buffer); this.buffers.delete(buffer); } return pane ? ok() : absent('can\'t find pane');
      case 'send-keys': {
        if (!pane) return absent('can\'t find pane');
        if (pane.name === this.hungResumeWindow && args.includes('-l')) {
          if (!Number.isFinite(commandStageRemaining())) throw Error('hung resume has no command deadline');
          this.hungResumeAttempts++;
          await this.sleep(50);
          return absent('ETIMEDOUT in fixture tmux setup');
        }
        const key = args.at(-1) ?? '';
        if (key === 'Enter' && pane.paste) {
          const window = [...this.panes].find(([, current]) => current === pane)?.[0];
          if (window) {
            this.delivered.add(window);
            const record = readTaskRecord(this.config, window);
            if (record?.deliveryId && record.pendingPrompt && sameMessage(pane.paste, record.pendingPrompt, record.agent)) {
              fs.writeFileSync(this.permitted(path.join(taskDir(this.config, window), 'delivery-evidence.json')), JSON.stringify({
                accepted: true, deliveryId: record.deliveryId, at: new Date(this.now()).toISOString(),
              }));
            }
          }
          delete pane.paste;
          pane.ack = true;
        } else if (args.includes('-l') && /(?:^|\W)codex(?:\W|$)/.test(key)) pane.screen = idle('codex');
        else if (args.includes('-l') && key.startsWith('exec sh ')) {
          const script = key.slice('exec sh '.length).replace(/^'(.*)'$/, '$1');
          try { if (/\nexec codex\b/.test(fs.readFileSync(this.permitted(script), 'utf8'))) pane.screen = idle('codex'); } catch { /* inactive fake pane */ }
        }
        return ok();
      }
      default: return ok();
    }
  }

  private async git(args: string[]): Promise<ExecResult> {
    const index = args.indexOf('-C');
    if (args[0] === '--version') return ok('git version 2.49');
    if (index < 0) return absent('missing fixture git directory');
    const cwd = this.permitted(args[index + 1]!);
    const rest = args.slice(index + 2).filter(a => a !== '--literal-pathspecs');
    const checkout = this.worktrees.get(cwd);
    if (rest[0] === 'worktree') {
      if (rest[1] === 'add') {
        const detached = rest[2] === '--detach';
        this.addWorktree(cwd, rest[detached ? 3 : 2]!, detached ? 'HEAD' : rest[3]);
        return ok();
      }
      if (rest[1] === 'remove') {
        const target = this.permitted(rest.at(-1)!);
        const record = this.worktrees.get(target);
        if (record?.repo !== cwd || (record.dirty && !rest.includes('--force'))) return absent('worktree is dirty or unregistered');
        await this.remove(target);
        this.worktrees.delete(target);
        return ok();
      }
      if (rest[1] === 'list') return ok([`worktree ${cwd}\n`, ...[...this.worktrees].filter(([, r]) => r.repo === cwd).map(([dir]) => `worktree ${dir}\n`)].join('\n'));
    }
    if (rest.includes('--git-common-dir')) return ok(path.join(checkout?.repo ?? cwd, '.git'));
    if (rest.includes('--show-toplevel')) return ok(cwd);
    if (rest.includes('--git-path')) return ok('.git-index.lock');
    if (rest.includes('--abbrev-ref')) return ok(checkout?.branch ?? 'main');
    if (rest.at(-1) === '@{upstream}') return absent();
    if (rest[0] === 'rev-list') return ok('0');
    if (rest[0] === 'rev-parse' || rest[0] === 'merge-base') return ok(oid);
    if (rest[0] === 'status') {
      if (this.slowMs) await this.sleep(this.slowMs);
      return ok(checkout?.dirty ? '?? only-copy\n' : '');
    }
    if (rest[0] === 'symbolic-ref') return checkout?.branch === 'HEAD' ? absent() : ok(checkout?.branch ?? 'main');
    return ok();
  }
}
