import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { DEFAULT_AGENT_SETTINGS, loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { classifyScreen, taskState } from '../src/core/state.ts';
import { collectStatus } from '../src/core/status.ts';
import { lastContentLine } from '../src/core/tmux.ts';
import { listTaskRecords, migrateLegacyState, readTaskRecord, recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import { detectTransitions, watchTick, WatchMemory } from '../src/core/watch.ts';
import type { Notifier } from '../src/core/notify.ts';
import { formatLocalTime, shellLine, shellQuote } from '../src/core/util.ts';
import { renderStatusHints, renderStatusTable } from '../src/render.ts';
import { makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const { claude, codex } = DEFAULT_AGENT_SETTINGS;
type Config = ReturnType<typeof makeConfig>;

// Screens as seen in the pilot on Neon City and in the 2026-11-01 probe (Claude Code 2.1.309, Codex 0.166.0), trimmed.
const CLAUDE_FOOTER_IDLE = `● Done: the menu now autostarts.

──────────────────────────────────────────────
❯ 
──────────────────────────────────────────────
  ? for shortcuts                                ⚠ 1 warning`;
const CLAUDE_FOOTER_WORKING = `● Reading src/menu.ts

──────────────────────────────────────────────
❯ 
──────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt`;
const CODEX_FOOTER_IDLE = `• Report written to /tmp/x/AGENTCTL.md
  Worked for 41s • 08:42

› Ask Codex to do anything
  GPT-6.1-Sol low · ~/Projects/cache/x · Fix the menu
  ? for shortcuts                                                                 ⚠ 1 warning · f2 to view`;
const CODEX_QUEUED = `• Ran npm test
  └ 149 passed

• Queued follow-up inputs
  ↳ please also check the HUD
    ⇧← edit last queued message
› Ask Codex to do anything
  GPT-6.1-Sol low · ~/Projects/cache/x
  ? for shortcuts                                                                 ⚠ 1 warning · f2 to view`;
const CODEX_QUESTION = `• I'll run sleep 25, then ask whether you prefer tea or coffee.
• Ran sleep 25
? Tea or coffee?
  • Tea
  • Coffee
• Waiting for your answer.
  Worked for 33s • 08:44
› Ask Codex to do anything
  GPT-6.1-Sol low · ~/Projects/cache/agentctl-4/probe
  ? for shortcuts                                                                 ⚠ 1 warning · f2 to view`;
const TRUST = 'Quick safety check: do you trust this folder?\n❯ 1. Yes, I trust this folder';

class Machine {
  windows = new Map<string, string>();
  respond = (cmd: string, args: string[], _opts: ExecOptions): Partial<ExecResult> | undefined => {
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

/** Records like RecordingRunner and also really writes files. */
class DiskRunner extends RecordingRunner {
  override async writeFile(file: string, content: string): Promise<void> {
    await super.writeFile(file, content);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

function setup(name: string, extra = '') {
  const root = scratch.sub(name);
  const config = makeConfig(root, extra);
  const m = new Machine();
  const out: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now(), respond: m.respond });
  return { root, config, m, runner, out, ctx: new Context(runner, config, (l) => out.push(l)) };
}

function specFor(config: Config, task: string, agent = 'claude'): ResolvedSpec {
  const dir = path.dirname(config.cache);
  const model = agent === 'claude' ? 'opus' : 'gpt-6.1-sol';
  const text = `---\ntask: ${task}\nagent: ${agent}\nmodel: ${model}\neffort: high\nreport: ${config.cache}/${task.toLowerCase()}/${task}.md\nrepos:\n  - {path: ${dir}/app, worktree: ${dir}/app-${task}, branch: ${task.toLowerCase()}}\n---\nDo ${task}.\n`;
  return resolveSpec(splitSpecs(text)[0]!, { config, loadProject: () => undefined });
}

function seed(config: Config, spec: ResolvedSpec, startedMs: number): void {
  fs.mkdirSync(path.dirname(taskFile(config, spec.window)), { recursive: true });
  fs.writeFileSync(taskFile(config, spec.window), renderTaskMd(recordFromSpec(spec, config, startedMs), spec.prompt));
}

const notifier = (): Notifier & { sent: string[] } => {
  const sent: string[] = [];
  return { sent, notify: async (_t, m) => void sent.push(m) };
};

function cli(config: Config, runner: RecordingRunner, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    readStdin: () => '',
    stdinIsTTY: false,
    loadConfig: () => config,
    confirm: undefined,
    readClipboard: async () => '',
    watchCommand: () => 'agentctl watch',
    makeRunner: () => runner,
  };
  return main(argv, deps).then((code) => ({ code, stdout: out.join(''), stderr: err.join('') }));
}

describe('state_dir', () => {
  it('defaults to <config dir>/tasks, is configurable, and expands ~', () => {
    const root = scratch.sub('sd1');
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    assert.equal(loadGlobalConfig(path.join(root, 'home')).stateDir, path.join(root, 'home', 'tasks'));
    const config = makeConfig(root);
    assert.equal(config.stateDir, path.join(root, 'state'));
    assert.notEqual(config.stateDir, config.cache);
  });

  it('TASK.md and the records live in state_dir; the cache folder is not needed to see the task', () => {
    const { config } = setup('sd2');
    const spec = specFor(config, 'NC-1');
    seed(config, spec, Date.now());
    assert.equal(taskFile(config, 'nc-1'), path.join(config.stateDir, 'nc-1', 'TASK.md'));
    assert.deepEqual(listTaskRecords(config).map((r) => r.task), ['NC-1']);
    // An agent "cleans up" its folder: the report directory is gone, the task is not.
    fs.rmSync(config.cache, { recursive: true, force: true });
    assert.deepEqual(listTaskRecords(config).map((r) => r.task), ['NC-1']);
    assert.equal(readTaskRecord(config, 'nc-1')?.task, 'NC-1');
  });

  it('migration moves TASK.md and setup.log from the cache to state_dir, with a message, once', () => {
    const { config } = setup('sd3');
    const spec = specFor(config, 'NC-1');
    const legacy = path.join(config.cache, 'nc-1');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'TASK.md'), renderTaskMd(recordFromSpec(spec, config, 0), 'p'));
    fs.writeFileSync(path.join(legacy, 'setup.log'), 'log');
    fs.writeFileSync(path.join(legacy, 'NC-1.md'), 'the report');
    const messages = migrateLegacyState(config);
    assert.equal(messages.length, 1);
    assert.match(messages[0] as string, /moved TASK\.md and setup\.log of nc-1 from .*cache\/nc-1 to .*state\/nc-1/);
    assert.equal(fs.readFileSync(path.join(config.stateDir, 'nc-1', 'setup.log'), 'utf8'), 'log');
    assert.equal(readTaskRecord(config, 'nc-1')?.task, 'NC-1');
    assert.equal(fs.existsSync(path.join(legacy, 'TASK.md')), false);
    assert.equal(fs.readFileSync(path.join(legacy, 'NC-1.md'), 'utf8'), 'the report', 'the report stays');
    assert.deepEqual(migrateLegacyState(config), [], 'nothing left to migrate');
  });

  it('migration never overwrites existing state and ignores TASK.md files agentctl did not write', () => {
    const { config } = setup('sd4');
    const spec = specFor(config, 'NC-1');
    seed(config, spec, 0);
    const legacy = path.join(config.cache, 'nc-1');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'TASK.md'), renderTaskMd(recordFromSpec(spec, config, 99), 'old'));
    fs.mkdirSync(path.join(config.cache, 'foreign'), { recursive: true });
    fs.writeFileSync(path.join(config.cache, 'foreign', 'TASK.md'), '---\ntask: foreign\n---\n');
    const messages = migrateLegacyState(config);
    assert.equal(messages.length, 1);
    assert.match(messages[0] as string, /nc-1: .* already exists, left .* in place/);
    assert.ok(fs.existsSync(path.join(config.cache, 'foreign', 'TASK.md')));
    assert.match(fs.readFileSync(taskFile(config, 'nc-1'), 'utf8'), /Do NC-1/);
  });

  it('the CLI migrates at start (status shows the task) but a dry run moves nothing', async () => {
    const { config, runner } = setup('sd5');
    const spec = specFor(config, 'NC-1');
    const legacy = path.join(config.cache, 'nc-1');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'TASK.md'), renderTaskMd(recordFromSpec(spec, config, 0), 'p'));
    await cli(config, new RecordingRunner({ dryRun: true }), ['close', 'NC-9', '--dry-run']).catch(() => undefined);
    assert.ok(fs.existsSync(path.join(legacy, 'TASK.md')), 'dry run left the legacy file');
    const r = await cli(config, runner, ['status', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /migration: moved TASK\.md of nc-1/);
    assert.ok(fs.existsSync(path.join(config.stateDir, 'nc-1', 'TASK.md')));
  });

  it('`new` writes TASK.md and setup.log to state_dir and only creates the report folder in the cache', async () => {
    const { config } = setup('sd6');
    const { newTasks } = await import('../src/core/new.ts');
    const repo = path.join(path.dirname(config.cache), 'app');
    fs.mkdirSync(repo, { recursive: true });
    const spec = resolveSpec(splitSpecs(`---\ntask: NC-1\nagent: claude\nmodel: opus\neffort: high\nsetup: [echo hi]\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nGo\n`)[0]!, { config, loadProject: () => undefined });
    const runner = new DiskRunner({
      dryRun: false,
      startTime: Date.now(),
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'capture-pane' ? { stdout: 'Welcome\n❯ Try "x"' } : cmd === 'tmux' && args[0] === 'has-session' ? { code: 1 } : undefined),
    });
    await newTasks(new Context(runner, config, () => {}), [spec], { reuse: true });
    assert.ok(fs.existsSync(path.join(config.stateDir, 'nc-1', 'TASK.md')));
    assert.equal(fs.existsSync(path.join(config.cache, 'nc-1', 'TASK.md')), false);
    assert.equal(fs.existsSync(path.join(config.cache, 'nc-1', 'setup.log')), false);
    assert.ok(fs.existsSync(path.join(config.stateDir, 'nc-1', 'setup.log')));
  });
});

describe('adopt', () => {
  it('restores a lost task: agent/model/effort "unknown" by default, report and worktree recorded, status sees it again', async () => {
    const { config, m, runner, ctx } = setup('ad1');
    const report = path.join(config.cache, 'nc-5', 'NC-5.md');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, 'agent report');
    const worktree = path.join(path.dirname(config.cache), 'app-nc-5');
    fs.mkdirSync(worktree);
    m.windows.set('nc-5', 'Worked for 3s\n› Ask Codex to do anything\n  ? for shortcuts');
    const r = await cli(config, runner, ['adopt', 'NC-5', '--report', report, '--worktree', worktree]);
    assert.equal(r.code, 0, r.stderr);
    const record = readTaskRecord(config, 'nc-5');
    assert.equal(record?.task, 'NC-5');
    assert.equal(record?.agent, 'unknown');
    assert.equal(record?.model, 'unknown');
    assert.equal(record?.effort, 'unknown');
    assert.equal(record?.report, report);
    assert.equal(record?.window, 'nc-5');
    assert.deepEqual(record?.repos.map((x) => x.worktree), [worktree]);
    assert.match(r.stdout, /agent, model, effort unknown/);
    const rows = await collectStatus(ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, 'report-ready', 'the existing report counts although the start time is unknown');
    assert.equal(rows[0]?.started, '-');
    assert.equal(rows[0]?.report, 'yes');
  });

  it('takes optional --agent/--model/--effort/--window and refuses to overwrite an existing state file', async () => {
    const { config, runner } = setup('ad2');
    const report = path.join(config.cache, 'nc-6', 'NC-6.md');
    const r = await cli(config, runner, ['adopt', 'NC-6', '--report', report, '--window', 'nc-6-b', '--agent', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'medium']);
    assert.equal(r.code, 0, r.stderr);
    const record = readTaskRecord(config, 'nc-6');
    assert.deepEqual([record?.agent, record?.model, record?.effort, record?.window], ['codex', 'gpt-6.1-sol', 'medium', 'nc-6-b']);
    const again = await cli(config, runner, ['adopt', 'NC-6', '--report', report]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already has a state file/);
  });

  it('--report is required; --dry-run writes nothing; a bad task ID is an error', async () => {
    const { config, runner } = setup('ad3');
    const missing = await cli(config, runner, ['adopt', 'NC-7']);
    assert.notEqual(missing.code, 0);
    const dry = await cli(config, new RecordingRunner({ dryRun: true }), ['adopt', 'NC-7', '--report', '/tmp/x/NC-7.md', '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(fs.existsSync(taskFile(config, 'nc-7')), false);
    const bad = await cli(config, runner, ['adopt', 'not an id', '--report', '/tmp/x.md']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /not a task ID/);
  });

  it('an adopted task keeps working with close --rm-worktree lookups and interrupt (unknown agent uses the default key)', async () => {
    const { config, m, runner } = setup('ad4');
    await cli(config, runner, ['adopt', 'NC-8', '--report', path.join(config.cache, 'nc-8', 'NC-8.md')]);
    m.windows.set('nc-8', '');
    const r = await cli(config, runner, ['interrupt', 'NC-8']);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(runner.commands.includes("tmux send-keys -t '=agentctl:nc-8' Escape"));
  });
});

describe('orphan windows', () => {
  it('status lists a window without a state file as orphan with the adopt hint; the watch window is not one', async () => {
    const { config, m, ctx } = setup('or1');
    seed(config, specFor(config, 'NC-1'), Date.now());
    m.windows.set('nc-1', CODEX_FOOTER_IDLE);
    m.windows.set('nc-9', CODEX_FOOTER_IDLE);
    m.windows.set('watch', 'Watching every 15s');
    const rows = await collectStatus(ctx);
    assert.deepEqual(rows.map((r) => [r.task, r.state]), [['NC-1', 'waiting'], ['NC-9', 'orphan']]);
    const orphan = rows[1]!;
    assert.equal(orphan.window, 'alive');
    assert.equal(orphan.agent, 'unknown');
    assert.match(orphan.hint ?? '', /agentctl adopt NC-9 --report /);
    assert.match(orphan.hint ?? '', new RegExp(`${config.cache}/nc-9/NC-9\\.md`));
    assert.equal(orphan.lastLine, 'Worked for 41s • 08:42');
    assert.deepEqual(renderStatusHints(rows).length, 1);
    assert.match(renderStatusTable(rows).join('\n'), /NC-9\s+unknown\/unknown\/unknown\s+orphan/);
  });

  it('status in the CLI prints the hint under the table and does not skip the window', async () => {
    const { config, m, runner } = setup('or2');
    m.windows.set('nc-3', CLAUDE_FOOTER_IDLE);
    const r = await cli(config, runner, ['status']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /NC-3\s+unknown\/unknown\/unknown\s+orphan/);
    assert.match(r.stdout, /hint: NC-3: no state file in .*state\/nc-3: agentctl adopt NC-3 --report /);
    const json = await cli(config, runner, ['status', '--json']);
    assert.equal(JSON.parse(json.stdout)[0].state, 'orphan');
  });

  it('watch notifies once when a window becomes an orphan (also at the first tick it is only a baseline)', async () => {
    const { config, m, ctx } = setup('or3');
    seed(config, specFor(config, 'NC-1'), Date.now());
    m.windows.set('nc-1', CLAUDE_FOOTER_WORKING);
    const n = notifier();
    const memory = new WatchMemory();
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, []);
    fs.rmSync(path.join(config.stateDir, 'nc-1'), { recursive: true }); // the state file is lost
    await watchTick(ctx, memory, n);
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 1);
    assert.match(n.sent[0] as string, /^NC-1: okno bez pliku stanu \(orphan\) – agentctl adopt NC-1 --report/);
    // after adopt the orphan is a normal task again
    const { adoptTask } = await import('../src/core/adopt.ts');
    await adoptTask(ctx, 'NC-1', { report: path.join(config.cache, 'nc-1', 'NC-1.md') });
    await watchTick(ctx, memory, n);
    assert.equal(n.sent.length, 1);
  });

  it('a lost task whose window is gone cannot be seen; pull points at adopt', async () => {
    const { config, runner } = setup('or4');
    const r = await cli(config, runner, ['pull', 'NC-4']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /agentctl adopt NC-4 --report <path>/);
  });
});

describe('local time', () => {
  it('formatLocalTime renders the local clock; empty or invalid input is "-"', () => {
    const iso = '2026-10-31T23:30:00.000Z';
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    assert.equal(formatLocalTime(iso), expected);
    assert.equal(formatLocalTime(''), '-');
    assert.equal(formatLocalTime('nonsense'), '-');
  });

  it('status STARTED follows the TZ, status --json keeps ISO UTC', async () => {
    const before = process.env.TZ;
    try {
      const { config, ctx } = setup('lt1');
      seed(config, specFor(config, 'NC-1'), Date.UTC(2026, 9, 31, 23, 30));
      process.env.TZ = 'Pacific/Auckland'; // UTC+13 in November: the next day, 12:30
      let row = (await collectStatus(ctx))[0]!;
      assert.equal(row.startedLocal, '2026-11-01 12:30');
      assert.match(renderStatusTable([row])[1] as string, /2026-11-01 12:30/);
      process.env.TZ = 'America/Los_Angeles'; // UTC-7 on 31 October
      row = (await collectStatus(ctx))[0]!;
      assert.equal(row.startedLocal, '2026-10-31 16:30');
      assert.match(renderStatusTable([row])[1] as string, /2026-10-31 16:30/);
      const r = await cli(config, new RecordingRunner({ dryRun: false, respond: new Machine().respond }), ['status', '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /"started": "2026-10-31 23:30"/, 'JSON stays UTC');
      assert.equal(readTaskRecord(config, 'nc-1')?.started, '2026-10-31T23:30:00.000Z', 'the file keeps UTC');
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

describe('last line without TUI footers', () => {
  it('Claude: skips the empty input box, borders and the shortcuts / mode footers', () => {
    assert.equal(lastContentLine(CLAUDE_FOOTER_IDLE, claude.footerPatterns), '● Done: the menu now autostarts.');
    assert.equal(lastContentLine(CLAUDE_FOOTER_WORKING, claude.footerPatterns), '● Reading src/menu.ts');
  });

  it('Codex: skips the model line, "? for shortcuts … ⚠ 1 warning · f2 to view" and the empty prompt', () => {
    assert.equal(lastContentLine(CODEX_FOOTER_IDLE, codex.footerPatterns), 'Worked for 41s • 08:42');
    assert.equal(lastContentLine(CODEX_QUEUED, codex.footerPatterns), '↳ please also check the HUD');
  });

  it('a typed, unsent input line is content; an empty screen gives an empty line', () => {
    assert.equal(lastContentLine('● ok\n❯ fix the menu\n  ? for shortcuts', claude.footerPatterns), '❯ fix the menu');
    assert.equal(lastContentLine('\n  ? for shortcuts\n', claude.footerPatterns), '');
  });

  it('footer_patterns are configurable per agent and validated', () => {
    const root = scratch.sub('fp1');
    fs.mkdirSync(path.join(root, 'home'), { recursive: true });
    fs.writeFileSync(path.join(root, 'home', 'config.yaml'), 'agents:\n  codex:\n    footer_patterns: ["^custom footer"]\n');
    const config = loadGlobalConfig(path.join(root, 'home'));
    assert.deepEqual(config.agents.codex.footerPatterns, ['^custom footer']);
    assert.equal(lastContentLine('content\ncustom footer here', config.agents.codex.footerPatterns), 'content');
    fs.writeFileSync(path.join(root, 'home', 'config.yaml'), 'agents:\n  codex:\n    footer_patterns: ["("]\n');
    assert.throws(() => loadGlobalConfig(path.join(root, 'home')), /footer_patterns\[0\] is not a valid regular expression/);
  });

  it('status shows the last content line of live windows, for Claude and Codex', async () => {
    const { config, m, ctx } = setup('ll1');
    seed(config, specFor(config, 'NC-1'), Date.now());
    seed(config, specFor(config, 'NC-2', 'codex'), Date.now());
    m.windows.set('nc-1', CLAUDE_FOOTER_WORKING);
    m.windows.set('nc-2', CODEX_FOOTER_IDLE);
    const rows = await collectStatus(ctx);
    assert.deepEqual(rows.map((r) => r.lastLine), ['● Reading src/menu.ts', 'Worked for 41s • 08:42']);
  });
});

describe('needs-input', () => {
  it('Codex "Waiting for your answer" and "? N question" are needs-input; Claude AskUserQuestion too; the queued-input section alone is not', () => {
    assert.equal(classifyScreen(CODEX_QUESTION, codex), 'needs-input');
    assert.equal(classifyScreen('• Queued follow-up inputs\n  ? 1 question\n    ⇧← to answer', codex), 'needs-input');
    assert.equal(classifyScreen('Which one?\n  Enter to select · ↑/↓ to navigate · Esc to cancel', claude), 'needs-input');
    assert.equal(classifyScreen(CODEX_QUEUED, codex), 'idle');
    assert.equal(classifyScreen(CODEX_FOOTER_IDLE, codex), 'idle');
  });

  it('trust beats a question, a question beats working', () => {
    assert.equal(classifyScreen(`${TRUST}\nWaiting for your answer`, codex), 'needs-trust');
    assert.equal(classifyScreen('• Working (3s • esc to interrupt)\nWaiting for your answer.', codex), 'needs-input');
  });

  it('taskState: a question is needs-input also when a report exists', () => {
    assert.equal(taskState({ alive: true, screen: CODEX_QUESTION, settings: codex, reportReady: true }), 'needs-input');
    assert.equal(taskState({ alive: false, screen: '', settings: codex, reportReady: false }), 'dead');
  });

  it('watch notifies once on entering needs-input', async () => {
    const { config, m, ctx } = setup('ni1');
    seed(config, specFor(config, 'NC-2', 'codex'), Date.now());
    m.windows.set('nc-2', '• Working (3s • esc to interrupt)');
    const n = notifier();
    const memory = new WatchMemory();
    await watchTick(ctx, memory, n);
    m.windows.set('nc-2', CODEX_QUESTION);
    await watchTick(ctx, memory, n);
    await watchTick(ctx, memory, n);
    assert.deepEqual(n.sent, ['NC-2 zadaje pytanie i czeka na odpowiedź']);
  });

  it('detectTransitions: needs-input and orphan carry a notification text', () => {
    const memory = new WatchMemory();
    const row = (state: string) => [{ task: 'NC-1', state }] as never;
    detectTransitions(memory, row('working'), 0, 1000);
    assert.match(detectTransitions(memory, row('needs-input'), 1, 1000)[0]?.notification ?? '', /pytanie/);
    assert.match(detectTransitions(memory, row('orphan'), 2, 1000)[0]?.notification ?? '', /orphan/);
  });
});

describe('quoting tmux targets that start with "="', () => {
  it('shellQuote quotes a word starting with "=" and leaves "=" inside a word alone', () => {
    assert.equal(shellQuote('=agentctl:nc-1'), "'=agentctl:nc-1'");
    assert.equal(shellQuote('model_reasoning_effort=high'), 'model_reasoning_effort=high');
    assert.equal(shellLine('tmux', ['capture-pane', '-p', '-t', '=agentctl:x']), "tmux capture-pane -p -t '=agentctl:x'");
  });

  it('the hint of adopt names the tmux command with a quoted target', async () => {
    const { config, out, ctx } = setup('qt1');
    const { adoptTask } = await import('../src/core/adopt.ts');
    await adoptTask(ctx, 'NC-1', { report: path.join(config.cache, 'nc-1', 'NC-1.md') });
    assert.ok(out.some((l) => l.includes("tmux capture-pane -p -t '=agentctl:nc-1'")), out.join('\n'));
    assert.ok(out.every((l) => !/ -t =/.test(l)), 'no unquoted =target in any message');
  });

  it('the ready-poll note in a dry run quotes the target', async () => {
    const { waitForReady } = await import('../src/core/ready.ts');
    const { Tmux } = await import('../src/core/tmux.ts');
    const runner = new RecordingRunner({ dryRun: true });
    await waitForReady(runner, new Tmux(runner, 'agentctl'), 'nc-1', { pattern: 'x', timeoutMs: 1000 });
    assert.ok(runner.notes.some((n) => n.includes("-t '=agentctl:nc-1'")), runner.notes.join('\n'));
  });
});
