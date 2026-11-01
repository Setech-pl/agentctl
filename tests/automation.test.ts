import assert from 'node:assert/strict';
import { formatLocalTime } from '../src/core/util.ts';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { closeTasks, planClose } from '../src/core/close.ts';
import { confirmAction, readClipboard, specFromClipboard } from '../src/core/clipboard.ts';
import { DesktopNotifier } from '../src/core/notify.ts';
import type { Notifier } from '../src/core/notify.ts';
import { pullReady } from '../src/core/pull.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { RecordingOptions } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { collectStatus, statusMarkdown } from '../src/core/status.ts';
import { readTaskRecord, recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { ensureWatchWindow, runWatch, WatchMemory, watchLogPath, watchTick } from '../src/core/watch.ts';
import { makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();

/** Records like RecordingRunner and also really writes files, so TASK.md edits can be read back. The clock starts at the real time, like file mtimes. */
class DiskRunner extends RecordingRunner {
  override async writeFile(file: string, content: string): Promise<void> {
    await super.writeFile(file, content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function makeContext(config: Config, options: RecordingOptions = {}, confirm?: (q: string) => Promise<boolean>) {
  const out: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), ...options });
  return { ctx: new Context(runner, config, (l) => out.push(l), confirm), runner, out };
}
type Config = ReturnType<typeof makeConfig>;
type Respond = (cmd: string, args: string[], opts: ExecOptions) => Partial<ExecResult> | undefined;

const IDLE = 'Welcome\n❯ Try "x"';
const WORKING = 'Thinking…\nesc to interrupt';
const TRUST = 'Quick safety check: do you trust this folder?\n❯ 1. Yes, I trust this folder';

/** A fake machine: tmux windows with screens, plus clipboard tools. */
class Machine {
  windows = new Map<string, string>();
  clipboard = '';
  tools = new Set(['pbcopy', 'pbpaste']);
  copied: string[] = [];
  respond: Respond = (cmd, args, opts) => {
    if (cmd === 'sh' && String(args[1]).startsWith('command -v')) return { code: this.tools.has(args.at(-1) as string) ? 0 : 1 };
    if (cmd === 'pbpaste') return { stdout: this.clipboard };
    if (cmd === 'pbcopy') {
      this.copied.push(opts.input ?? '');
      return undefined;
    }
    if (cmd !== 'tmux') return undefined;
    if (args[0] === 'list-windows') return this.windows.size ? { stdout: [...this.windows.keys()].join('\n') } : { code: 1 };
    if (args[0] === 'has-session') return { code: this.windows.size ? 0 : 1 };
    if (args[0] === 'capture-pane') {
      const window = (args[args.indexOf('-t') + 1] as string).split(':')[1] as string;
      return this.windows.has(window) ? { stdout: this.windows.get(window) as string } : { code: 1 };
    }
    return undefined;
  };
}

function specFor(config: Config, task: string, extra = '', agent = 'claude', model = 'opus'): ResolvedSpec {
  const dir = path.dirname(config.cache);
  const text = `---\ntask: ${task}\nagent: ${agent}\nmodel: ${model}\neffort: high\nreport: ${dir}/${task}.md\n${extra}repos:\n  - {path: ${dir}/app, worktree: ${dir}/app-${task}, branch: ${task.toLowerCase()}}\n---\nDo ${task}.\n`;
  return resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined });
}

function seed(config: Config, spec: ResolvedSpec, startedMs: number): void {
  fs.mkdirSync(path.dirname(taskFile(config, spec.window)), { recursive: true });
  fs.writeFileSync(taskFile(config, spec.window), renderTaskMd(recordFromSpec(spec, config, startedMs), spec.prompt));
}

const writeReport = (spec: ResolvedSpec, text: string): void => fs.writeFileSync(spec.report, text);

describe('clipboard input', () => {
  it('reads pbpaste on macOS and falls back from wl-paste to xclip on Linux', async () => {
    const m = new Machine();
    m.clipboard = 'hello';
    const { runner } = makeContext(makeConfig(scratch.sub('clip1')), { respond: m.respond });
    assert.equal(await readClipboard(runner, 'darwin'), 'hello');
    m.tools = new Set(['xclip']);
    m.respond = ((orig) => (cmd: string, args: string[], opts: ExecOptions) => (cmd === 'xclip' ? { stdout: 'from xclip' } : orig(cmd, args, opts)))(m.respond);
    const linux = makeContext(makeConfig(scratch.sub('clip1b')), { respond: m.respond });
    assert.equal(await readClipboard(linux.runner, 'linux'), 'from xclip');
    assert.ok(linux.runner.queries.includes('xclip -selection clipboard -o'));
  });

  it('says so when there is no clipboard tool', async () => {
    const m = new Machine();
    m.tools.clear();
    const { runner } = makeContext(makeConfig(scratch.sub('clip2')), { respond: m.respond });
    await assert.rejects(readClipboard(runner, 'darwin'), /no clipboard tool found/);
  });

  it('accepts a spec, also inside a code fence, and normalises line endings', () => {
    const spec = '---\ntask: NC-1\n---\nDo it.';
    assert.equal(specFromClipboard(`\n${spec}\n\n`), `${spec}\n`);
    assert.equal(specFromClipboard('```markdown\n---\r\ntask: NC-1\r\n---\r\nDo it.\n```'), `${spec}\n`);
  });

  it('gives readable errors for an empty clipboard and for text without a YAML header', () => {
    assert.throws(() => specFromClipboard('  \n'), /clipboard is empty/);
    assert.throws(() => specFromClipboard('Just some chat text'), /does not start with a YAML header/);
  });
});

describe('y/N confirmation', () => {
  const ask = (answer: boolean | undefined) => {
    const out: string[] = [];
    const asked: string[] = [];
    const ctx = {
      out: (l: string) => out.push(l),
      confirm: answer === undefined ? undefined : async (q: string) => (asked.push(q), answer),
    };
    return { ctx, out, asked };
  };

  it('prints the summary and asks; y goes on, anything else aborts', async () => {
    const yes = ask(true);
    assert.equal(await confirmAction(yes.ctx, ['NC-1 claude'], 'Start?', false), true);
    assert.deepEqual(yes.out, ['NC-1 claude']);
    assert.deepEqual(yes.asked, ['Start? [y/N] ']);
    const no = ask(false);
    assert.equal(await confirmAction(no.ctx, ['NC-1'], 'Start?', false), false);
    assert.match(no.out.at(-1) as string, /Aborted/);
  });

  it('-y skips the question, and without a terminal and without -y it refuses', async () => {
    const skip = ask(false);
    assert.equal(await confirmAction(skip.ctx, ['x'], 'Start?', true), true);
    assert.deepEqual(skip.asked, []);
    await assert.rejects(confirmAction(ask(undefined).ctx, ['x'], 'Start?', false), /no terminal to ask on/);
  });
});

describe('new --clip / send --clip through the CLI', () => {
  const root = scratch.sub('cli');
  scratch.sub('cli/app');
  scratch.sub('cli/x');
  const config = makeConfig(root);
  const specText = `---\ntask: NC-1\nagent: claude\nmodel: opus\neffort: medium\nsetup: [npm ci]\nlinks:\n  - {from: node_modules/x, to: ${root}/x}\nrepos:\n  - {path: ${root}/app, worktree: ${root}/app-wt, base: main, branch: nc-1}\n---\nBody.\n`;

  function run(argv: string[], clipboard: string, answer: boolean | undefined, runner = new RecordingRunner({ dryRun: false })) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const asked: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => stdout.push(t),
      stderr: (t) => stderr.push(t),
      readStdin: () => '',
      stdinIsTTY: false,
      loadConfig: () => config,
      confirm: answer === undefined ? undefined : async (q) => (asked.push(q), answer),
      readClipboard: async () => clipboard,
      watchCommand: () => 'agentctl watch',
      makeRunner: () => runner,
    };
    return main(argv, deps).then((code) => ({ code, stdout: stdout.join(''), stderr: stderr.join(''), asked, runner }));
  }

  it('new --clip prints the summary (task, agent/model/effort, worktree, branch, setup, links) and does nothing on N', async () => {
    const r = await run(['new', '--clip'], specText, false);
    assert.equal(r.code, 0);
    for (const part of ['NC-1  claude/opus/medium', `worktree: ${root}/app-wt`, 'branch:   nc-1  from main', 'setup:    npm ci', `links:    node_modules/x -> ${root}/x`]) {
      assert.ok(r.stdout.includes(part), `missing "${part}" in:\n${r.stdout}`);
    }
    assert.deepEqual(r.asked, ['Start? [y/N] ']);
    assert.deepEqual(r.runner.commands, []);
  });

  it('new --clip -y starts without asking; the spec ends up in TASK.md like with a file', async () => {
    const m = new Machine();
    m.windows.clear();
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args, o) => (cmd === 'tmux' && args[0] === 'capture-pane' ? { stdout: IDLE } : cmd === 'git' && args.includes('--verify') ? { code: 1 } : m.respond(cmd, args, o)) });
    const r = await run(['new', '--clip', '-y'], specText, undefined, runner);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.asked, []);
    const taskMd = runner.written.get(path.join(config.stateDir, 'nc-1', 'TASK.md'));
    assert.match(taskMd ?? '', /task: NC-1[\s\S]*---\n\nBody\./);
    assert.ok(runner.commands.some((c) => c.startsWith('git -C')));
  });

  it('an empty clipboard, text without a header, and --clip with a file are readable errors', async () => {
    const empty = await run(['new', '--clip', '-y'], '  ', undefined);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /error: the clipboard is empty/);
    const chat = await run(['send', '--clip', '-y'], 'no header here', undefined);
    assert.match(chat.stderr, /does not start with a YAML header/);
    const both = await run(['new', '--clip', 'spec.md'], specText, true);
    assert.match(both.stderr, /exclude each other/);
  });

  it('without a terminal and without -y it refuses to start', async () => {
    const r = await run(['new', '--clip'], specText, undefined);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no terminal to ask on/);
    assert.deepEqual(r.runner.commands, []);
  });

  it('send --clip asks, then pastes the prompt (-y skips the question)', async () => {
    const send = `---\ntask: NC-1\n---\nFollow up please.\n`;
    const respond: Respond = (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-1\n' } : undefined);
    const declined = await run(['send', '--clip'], send, false, new RecordingRunner({ dryRun: false, respond }));
    assert.deepEqual(declined.runner.commands, []);
    assert.match(declined.stdout, /NC-1  ->  window agentctl:nc-1, 17 characters: Follow up please\./);
    const yes = await run(['send', '--clip', '-y'], send, undefined, new RecordingRunner({ dryRun: false, respond }));
    assert.equal(yes.code, 0, yes.stderr);
    assert.ok(yes.runner.commands.some((c) => c.startsWith('tmux paste-buffer')));
  });
});

describe('watch', () => {
  const notifier = (): Notifier & { sent: string[] } => {
    const sent: string[] = [];
    return { sent, notify: async (_t, m) => void sent.push(m) };
  };
  const setup = (name: string, extra = '') => {
    const root = scratch.sub(name);
    const config = makeConfig(root, extra);
    const m = new Machine();
    const { ctx, runner, out } = makeContext(config, { respond: m.respond });
    return { config, m, ctx, runner, out, root };
  };

  it('notifies once per transition: report-ready, needs-trust, dead; the first tick is only a baseline', async () => {
    const { config, m, ctx, runner } = setup('watch1');
    const [a, b, c] = ['NC-1', 'NC-2', 'NC-3'].map((t) => specFor(config, t)) as [ResolvedSpec, ResolvedSpec, ResolvedSpec];
    for (const s of [a, b, c]) seed(config, s, runner.now() - 1000);
    m.windows.set('nc-1', WORKING);
    m.windows.set('nc-2', WORKING);
    m.windows.set('nc-3', WORKING);
    const n = notifier();
    const memory = new WatchMemory();

    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, []);

    writeReport(a, 'done');
    m.windows.set('nc-1', IDLE);
    m.windows.set('nc-2', TRUST);
    m.windows.delete('nc-3');
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent.sort(), ['NC-1: raport gotowy', 'NC-2 czeka na zaufanie folderu (trust)', 'NC-3: okno zniknęło bez raportu'].sort());

    // nothing changed: no new notifications
    await watchTick(ctx, memory, n);
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 3);

    // leaving and re-entering a state is a new transition
    m.windows.set('nc-2', WORKING);
    await watchTick(ctx, memory, n);
    m.windows.set('nc-2', TRUST);
    await watchTick(ctx, memory, n);
    assert.equal((n.sent as string[]).filter((s) => s.startsWith('NC-2')).length, 2);
  });

  it('"waits for you" fires once after waiting_after, not before, and again only after a new stay', async () => {
    const { config, m, ctx, runner } = setup('watch2', 'watch: {waiting_after: 120}\n');
    const a = specFor(config, 'NC-1');
    seed(config, a, runner.now() - 1000);
    m.windows.set('nc-1', WORKING);
    const n = notifier();
    const memory = new WatchMemory();
    await watchTick(ctx, memory, n);
    m.windows.set('nc-1', IDLE);
    await watchTick(ctx, memory, n); // enters waiting at t0
    await runner.sleep(119_000);
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, []);
    await runner.sleep(1_000);
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, ['NC-1 czeka na Ciebie']);
    await runner.sleep(600_000);
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 1);

    m.windows.set('nc-1', WORKING);
    await watchTick(ctx, memory, n);
    m.windows.set('nc-1', IDLE);
    await watchTick(ctx, memory, n);
    await runner.sleep(121_000);
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 2);
  });

  it('a task that appears while watching and already needs trust is notified; a quick working/waiting flicker is not', async () => {
    const { config, m, ctx, runner } = setup('watch3');
    const n = notifier();
    const memory = new WatchMemory();
    await watchTick(ctx, memory, n);
    const a = specFor(config, 'NC-1');
    seed(config, a, runner.now());
    m.windows.set('nc-1', TRUST);
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, ['NC-1 czeka na zaufanie folderu (trust)']);
    m.windows.set('nc-1', WORKING);
    await watchTick(ctx, memory, n);
    m.windows.set('nc-1', IDLE);
    await watchTick(ctx, memory, n);
    m.windows.set('nc-1', WORKING);
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 1);
  });

  it('runWatch ticks every watch.interval seconds on the fake clock and writes the log', async () => {
    const { config, m, ctx, runner } = setup('watch4', 'watch: {interval: 20}\n');
    const a = specFor(config, 'NC-1');
    seed(config, a, runner.now());
    m.windows.set('nc-1', WORKING);
    const n = notifier();
    const start = runner.now();
    let ticks = 0;
    const real = ctx.tmux.capture.bind(ctx.tmux);
    ctx.tmux.capture = async (w, l) => {
      if (++ticks === 3) {
        writeReport(a, 'done');
        m.windows.set('nc-1', IDLE);
      }
      return real(w, l);
    };
    await runWatch(ctx, n, { maxTicks: 4 });
    assert.equal(runner.now() - start, 3 * 20_000);
    assert.deepEqual(n.sent, ['NC-1: raport gotowy']);
    const log = runner.appended.get(watchLogPath(ctx)) ?? '';
    assert.equal(watchLogPath(ctx), path.join(config.cache, 'agentctl-watch.log'));
    assert.match(log, /NC-1 {2}baseline working\n/);
    assert.match(log, /NC-1 {2}\w+ -> report-ready {2}\[notified: NC-1: raport gotowy\]\n/);
  });

  it('config: defaults 15 s / 120 s, overridable, validated', () => {
    const root = scratch.sub('watchcfg');
    assert.deepEqual(makeConfig(root).watch, { interval: 15, waitingAfter: 120 });
    assert.deepEqual(makeConfig(root, 'watch: {interval: 5, waiting_after: 30}\n').watch, { interval: 5, waitingAfter: 30 });
    assert.throws(() => makeConfig(root, 'watch: {interval: 0}\n'), /watch.interval must be a positive number/);
    assert.throws(() => makeConfig(root, 'watch: {every: 3}\n'), /unknown key "every"/);
  });

  it('DesktopNotifier: osascript with sound on macOS (quotes escaped), notify-send on Linux', async () => {
    const { runner } = makeContext(makeConfig(scratch.sub('notif')));
    await new DesktopNotifier(runner, 'darwin').notify('agentctl', 'NC-1: "raport" gotowy');
    await new DesktopNotifier(runner, 'linux').notify('agentctl', 'NC-1: raport gotowy');
    assert.equal(
      runner.commands[0],
      `osascript -e 'display notification "NC-1: \\"raport\\" gotowy" with title "agentctl" sound name "Glass"'`,
    );
    assert.equal(runner.commands[1], 'notify-send agentctl \'NC-1: raport gotowy\'');
  });

  it('--tmux creates window "watch" (and the session if needed) and never a second one', async () => {
    const { ctx, runner, m } = setup('watchtmux');
    assert.equal(await ensureWatchWindow(ctx, 'agentctl watch', '/work'), 'session-created');
    assert.deepEqual(runner.commands.slice(0, 1), ['tmux new-session -d -s agentctl -n watch -c /work']);
    assert.ok(runner.commands.includes('tmux send-keys -t \'=agentctl:watch\' -l -- \'agentctl watch\''));
    m.windows.set('other', '');
    assert.equal(await ensureWatchWindow(ctx, 'agentctl watch', '/work'), 'created');
    assert.ok(runner.commands.some((c) => c.startsWith(`tmux new-window -d -t '=agentctl:' -n watch`)));
    m.windows.set('watch', '');
    const before = runner.commands.length;
    assert.equal(await ensureWatchWindow(ctx, 'agentctl watch', '/work'), 'exists');
    assert.equal(runner.commands.length, before);
  });
});

describe('pull --ready', () => {
  function fleet(name: string) {
    const root = scratch.sub(name);
    const config = makeConfig(root);
    const m = new Machine();
    const made = makeContext(config, { respond: m.respond });
    const specs = [specFor(config, 'NC-1'), specFor(config, 'NC-2', '', 'codex', 'gpt-6'), specFor(config, 'NC-3')];
    for (const s of specs) seed(config, s, made.runner.now() - 10_000);
    return { config, m, specs, ...made };
  }

  it('joins only report-ready reports with headers, copies them, marks them pulled and lists them with the total size', async () => {
    const { config, m, specs, ctx, out, runner } = fleet('pull1');
    writeReport(specs[0]!, '# NC-1 report\nAll good.\n');
    writeReport(specs[1]!, 'NC-2 text');
    m.windows.set('nc-1', IDLE);
    m.windows.set('nc-2', IDLE);
    m.windows.set('nc-3', WORKING); // no report
    await runner.sleep(5_000); // the agent finished a moment ago
    const result = await pullReady(ctx, {}, 'darwin');
    assert.equal(m.copied.length, 1);
    assert.equal(m.copied[0], '=== NC-1 (claude opus/high) ===\n# NC-1 report\nAll good.\n\n=== NC-2 (codex gpt-6/high) ===\nNC-2 text\n');
    assert.deepEqual(result.pulled.map((p) => p.task), ['NC-1', 'NC-2']);
    assert.equal(result.totalBytes, Buffer.byteLength(m.copied[0]!));
    assert.match(out.join('\n'), /Copied 2 reports to the clipboard \(pbcopy\), \d+ B:\n\s+NC-1 {2}claude opus\/high[\s\S]*NC-2 {2}codex gpt-6\/high/);
    for (const t of ['nc-1', 'nc-2']) assert.equal(readTaskRecord(config, t)?.pulled, new Date(runner.now()).toISOString());
    assert.equal(readTaskRecord(config, 'nc-3')?.pulled, undefined);
    // the prompt and the rest of the header survive the rewrite
    assert.match(fs.readFileSync(taskFile(config, 'nc-1'), 'utf8'), /^---\nagentctl: 1\ntask: NC-1[\s\S]*pulled: [^\n]+\n---\n\nDo NC-1\.\n$/);
  });

  it('does not take a report twice; --all does; a newer report counts as new', async () => {
    const { m, specs, ctx, out, runner } = fleet('pull2');
    writeReport(specs[0]!, 'first');
    m.windows.set('nc-1', IDLE);
    await runner.sleep(5_000);
    await pullReady(ctx, {}, 'darwin');
    assert.equal(m.copied.length, 1);

    out.length = 0;
    const again = await pullReady(ctx, {}, 'darwin');
    assert.equal(again.pulled.length, 0);
    assert.equal(m.copied.length, 1);
    assert.match(out.join('\n'), /No new reports \(1 already pulled; --all takes them again\)/);

    const all = await pullReady(ctx, { all: true }, 'darwin');
    assert.equal(all.pulled.length, 1);
    assert.equal(m.copied.length, 2);

    // the agent writes a newer report after the pull
    await runner.sleep(5_000);
    const future = new Date(runner.now() + 60_000);
    fs.writeFileSync(specs[0]!.report, 'second');
    fs.utimesSync(specs[0]!.report, future, future);
    const fresh = await pullReady(ctx, {}, 'darwin');
    assert.equal(fresh.pulled.length, 1);
    assert.match(m.copied.at(-1) as string, /second/);
  });

  it('warns above 100 KB and still copies', async () => {
    const { m, specs, ctx, out } = fleet('pull3');
    writeReport(specs[0]!, 'x'.repeat(101 * 1024));
    m.windows.set('nc-1', IDLE);
    const result = await pullReady(ctx, {}, 'darwin');
    assert.equal(result.warnedLarge, true);
    assert.equal(m.copied.length, 1);
    assert.match(out.join('\n'), /warning: 101\.\d KB is more than 100 KB/);
  });

  it('is quiet below the limit, and marks nothing when the clipboard fails', async () => {
    const { config, m, specs, ctx, out } = fleet('pull4');
    writeReport(specs[0]!, 'small');
    m.windows.set('nc-1', IDLE);
    assert.equal((await pullReady(ctx, {}, 'darwin')).warnedLarge, false);
    assert.doesNotMatch(out.join('\n'), /warning/);

    const bad = fleet('pull4b');
    writeReport(bad.specs[1]!, 'text');
    bad.m.windows.set('nc-2', IDLE);
    bad.m.tools.clear();
    const result = await pullReady(bad.ctx, {}, 'darwin');
    assert.equal(result.copied, false);
    assert.equal(readTaskRecord(bad.config, 'nc-2')?.pulled, undefined);
    assert.match(bad.out.join('\n'), /no clipboard tool found.*nothing was marked as pulled/);
    void config;
  });

  it('pull --ready through the CLI; --all alone and a task together with --ready are errors', async () => {
    const { config, m, specs } = fleet('pull5');
    writeReport(specs[0]!, 'cli');
    m.windows.set('nc-1', IDLE);
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
      confirm: undefined, readClipboard: async () => '', watchCommand: () => '', makeRunner: () => new RecordingRunner({ dryRun: false, respond: m.respond }),
    };
    assert.equal(await main(['pull', '--ready'], deps), 0);
    assert.match(out.join(''), /Copied 1 report/);
    assert.equal(await main(['pull', '--all'], deps), 1);
    assert.equal(await main(['pull', 'NC-1', '--ready'], deps), 1);
    assert.equal(await main(['pull'], deps), 1);
  });
});

describe('close with several tasks', () => {
  function fleet(name: string) {
    const root = scratch.sub(name);
    const config = makeConfig(root);
    const m = new Machine();
    const made = makeContext(config, { respond: m.respond });
    const specs = [specFor(config, 'NC-1'), specFor(config, 'NC-2'), specFor(config, 'NC-3')];
    for (const s of specs) seed(config, s, made.runner.now() - 10_000);
    for (const w of ['nc-1', 'nc-2', 'nc-3']) m.windows.set(w, IDLE);
    return { config, m, specs, root, ...made };
  }

  it('lists the tasks, flags the one without a report, and kills every window', async () => {
    const { specs, ctx, runner } = fleet('close1');
    writeReport(specs[0]!, 'r1');
    writeReport(specs[2]!, 'r3');
    const plan = await planClose(ctx, ['NC-1', 'nc-2', 'NC-3', 'NC-1']);
    assert.deepEqual(plan.map((p) => p.line), ['NC-1', 'NC-2  (WARNING: no report yet)', 'NC-3']);
    assert.deepEqual(runner.commands, []);
    await closeTasks(ctx, plan.map((p) => p.task));
    assert.deepEqual(runner.commands, ['tmux kill-window -t \'=agentctl:nc-1\'', 'tmux kill-window -t \'=agentctl:nc-2\'', 'tmux kill-window -t \'=agentctl:nc-3\'']);
  });

  it('marks unknown tasks, and with --rm-worktree refuses the whole list before closing anything', async () => {
    const { ctx, runner } = fleet('close2');
    const plan = await planClose(ctx, ['NC-1', 'NC-99']);
    assert.match(plan[1]!.line, /NC-99 {2}\(unknown task \(no TASK\.md\)/);
    await assert.rejects(planClose(ctx, ['NC-1', 'NC-99'], { rmWorktree: true }), /NC-99: no TASK\.md/);
    assert.deepEqual(runner.commands, []);
  });

  it('a failing task does not stop the others, and is reported at the end', async () => {
    const { root, m, specs } = fleet('close3');
    const made = makeContext(makeConfig(root), {
      respond: (cmd, args, o) => {
        if (cmd === 'git' && args.includes('rev-parse')) return { stdout: 'nc-x\n' };
        if (cmd === 'git' && args.includes('remove') && args.includes(specs[0]!.repos[0]!.worktree)) return { code: 1, stderr: 'has untracked files' };
        return m.respond(cmd, args, o);
      },
    });
    for (const s of specs) fs.mkdirSync(s.repos[0]!.worktree, { recursive: true });
    await assert.rejects(closeTasks(made.ctx, ['NC-1', 'NC-2', 'NC-3'], { rmWorktree: true }), /1 of 3 tasks could not be closed completely:\n\s+- NC-1: .*untracked/);
    assert.equal(made.runner.commands.filter((c) => c.startsWith('tmux kill-window')).length, 3);
    assert.equal(made.runner.commands.filter((c) => / worktree remove /.test(c)).length, 3);
  });

  it('through the CLI: asks y/N, -y skips, N does nothing', async () => {
    const { config, m } = fleet('close4');
    const run = async (argv: string[], answer: boolean | undefined) => {
      const out: string[] = [];
      const err: string[] = [];
      const asked: string[] = [];
      const runner = new RecordingRunner({ dryRun: false, respond: m.respond });
      const deps: CliDeps = {
        stdout: (t) => out.push(t), stderr: (t) => err.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
        confirm: answer === undefined ? undefined : async (q) => (asked.push(q), answer), readClipboard: async () => '', watchCommand: () => '', makeRunner: () => runner,
      };
      const code = await main(argv, deps);
      return { code, out: out.join(''), err: err.join(''), asked, runner };
    };
    const no = await run(['close', 'NC-1', 'NC-2'], false);
    assert.deepEqual(no.runner.commands, []);
    assert.match(no.out, /Close 2 tasks:\n {2}NC-1 {2}\(WARNING: no report yet\)\n {2}NC-2/);
    assert.deepEqual(no.asked, ['Go ahead? [y/N] ']);
    const yes = await run(['close', 'NC-1', 'NC-2'], true);
    assert.equal(yes.runner.commands.length, 2);
    const forced = await run(['close', '-y', 'NC-3'], undefined);
    assert.equal(forced.code, 0);
    assert.deepEqual(forced.runner.commands, ['tmux kill-window -t \'=agentctl:nc-3\'']);
    const noTerm = await run(['close', 'NC-3'], undefined);
    assert.equal(noTerm.code, 1);
    assert.match(noTerm.err, /no terminal to ask on/);
  });
});

describe('status --clip', () => {
  it('copies a compact Markdown table: task, agent/model/effort, state, time, report, pulled?', async () => {
    const root = scratch.sub('statusclip');
    const config = makeConfig(root);
    const m = new Machine();
    const { ctx, runner } = makeContext(config, { respond: m.respond });
    const [a, b, c] = [specFor(config, 'NC-1'), specFor(config, 'NC-2', '', 'codex', 'gpt-6'), specFor(config, 'NC-3')] as [ResolvedSpec, ResolvedSpec, ResolvedSpec];
    seed(config, a, runner.now() - 3_725_000);
    seed(config, b, runner.now() - 65_000);
    seed(config, c, runner.now() - 1_000);
    writeReport(a, 'r');
    m.windows.set('nc-1', IDLE);
    m.windows.set('nc-2', WORKING);
    await runner.sleep(5_000);
    await pullReady(ctx, {}, 'darwin'); // marks NC-1
    const rows = await collectStatus(ctx);
    assert.equal(statusMarkdown(rows), [
      '| task | agent/model/effort | state | time | progress | report | pulled? |',
      '|---|---|---|---|---|---|---|',
      `| NC-1 | claude/opus/high | report-ready | 1h 02m | ?c 0f | yes | yes (${formatLocalTime(new Date(runner.now()).toISOString())}) |`,
      '| NC-2 | codex/gpt-6/high | working | 1m 10s | ?c 0f | missing | - |',
      '| NC-3 | claude/opus/high | dead | - | ?c 0f | missing | - |',
      '',
    ].join('\n'));

    const out: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t), stderr: (t) => out.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
      confirm: undefined, readClipboard: async () => '', watchCommand: () => '', makeRunner: () => runner,
    };
    m.copied.length = 0;
    assert.equal(await main(['status', '--clip'], deps), 0);
    assert.match(m.copied[0] as string, /^\| task \| agent\/model\/effort \| state \| time \| progress \| report \| pulled\? \|\n/);
    assert.match(out.join(''), /Copied the status of 3 tasks to the clipboard \(pbcopy\)/);
  });
});
