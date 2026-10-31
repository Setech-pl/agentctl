import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { closeTask } from '../src/core/close.ts';
import { newTasks } from '../src/core/new.ts';
import { pullTask } from '../src/core/pull.ts';
import { sendPrompts } from '../src/core/send.ts';
import { interruptTask } from '../src/core/interrupt.ts';
import { collectStatus } from '../src/core/status.ts';
import { renderStatusTable } from '../src/render.ts';
import { resolveSendSpec, resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { ResolvedSpec } from '../src/core/spec.ts';
import { recordFromSpec, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { makeConfig, makeContext, useScratch } from './helpers.ts';

const scratch = useScratch();

const resolveAll = (config: ReturnType<typeof makeConfig>, text: string): ResolvedSpec[] =>
  splitSpecs(text).map((raw) => resolveSpec(raw, { config, loadProject: () => undefined }));

function seedTask(config: ReturnType<typeof makeConfig>, spec: ResolvedSpec, startedMs: number): void {
  fs.mkdirSync(path.dirname(taskFile(config, spec.window)), { recursive: true });
  fs.writeFileSync(taskFile(config, spec.window), renderTaskMd(recordFromSpec(spec, config, startedMs), spec.prompt));
}

type Respond = (cmd: string, args: string[], opts: ExecOptions) => Partial<ExecResult> | undefined;

/** Screens returned by successive `tmux capture-pane` calls; the last one repeats. */
const screens = (...list: string[]): Respond => {
  let i = 0;
  return (cmd, args) => {
    if (cmd !== 'tmux' || args[0] !== 'capture-pane') return undefined;
    return { stdout: list[Math.min(i++, list.length - 1)] as string };
  };
};

/** A fresh machine: no tmux session, no existing branch; screens come from `capture-pane`. */
const freshMachine = (...list: string[]): Respond => {
  const capture = screens(...list);
  return (cmd, args, opts) => {
    if (cmd === 'tmux' && (args[0] === 'has-session' || args[0] === 'list-windows')) return { code: 1 };
    if (cmd === 'git' && args.includes('--verify')) return { code: 1 };
    return capture(cmd, args, opts);
  };
};

describe('new: generated commands', () => {
  const root = scratch.sub('new');
  const repoA = scratch.sub('new/app');
  const repoB = scratch.sub('new/api');
  const pkgs = scratch.sub('new/backend/packages');
  for (const name of ['protocol', 'sim']) scratch.sub(`new/backend/packages/${name}`);
  const config = makeConfig(root, 'agents:\n  claude:\n    flags: [--verbose]\n');
  const wt = (n: string): string => `${repoA}-wt${n}`;

  it('creates worktree, links, TASK.md, a new session, starts the agent and pastes the prompt', async () => {
    const text = `---
task: NC-1
agent: claude
model: opus
effort: medium
repos:
  - {path: ${repoA}, worktree: ${wt('1')}, base: main, branch: nc-1}
  - {path: ${repoB}, worktree: ${repoB}-wt1}
links:
  - {from: "node_modules/@nc/*", to: "${pkgs}/*"}
env: {NEON_CITY_TASK: NC-1}
---
First line.
Second line.
`;
    const { ctx, runner } = makeContext(config, { respond: freshMachine('loading...', 'Welcome\n❯ Try "x"') });
    await newTasks(ctx, resolveAll(config, text));

    const cache = path.join(config.cache, 'nc-1');
    const taskMd = runner.commands.find((c) => c.startsWith('write '));
    assert.match(taskMd ?? '', new RegExp(`^write ${cache}/TASK.md \\(\\d+ bytes\\)$`));
    assert.deepEqual(
      runner.commands.filter((c) => !c.startsWith('write ')),
      [
        `git -C ${repoA} worktree add -b nc-1 ${wt('1')} main`,
        `git -C ${repoB} worktree add --detach ${repoB}-wt1`,
        `ln -sfn ${pkgs}/protocol ${wt('1')}/node_modules/@nc/protocol`,
        `ln -sfn ${pkgs}/sim ${wt('1')}/node_modules/@nc/sim`,
        `mkdir -p ${cache}`,
        `tmux new-session -d -s agentctl -n nc-1 -c ${wt('1')} -e NEON_CITY_TASK=NC-1`,
        `tmux send-keys -t =agentctl:nc-1 -l -- 'claude --model opus --effort medium --verbose'`,
        'tmux send-keys -t =agentctl:nc-1 Enter',
        'tmux load-buffer -b agentctl-nc-1 -',
        'tmux paste-buffer -p -d -b agentctl-nc-1 -t =agentctl:nc-1',
        'tmux send-keys -t =agentctl:nc-1 Enter',
      ],
    );
    const paste = runner.calls.find((c) => c.line.startsWith('tmux load-buffer'));
    assert.equal(paste?.input, 'Model: opus · effort medium\n\nFirst line.\nSecond line.');

    const record = fs.existsSync(path.join(cache, 'TASK.md'));
    assert.equal(record, false, 'a recording runner must not write files');
  });

  it('adds a window to an existing session and starts codex with its flags', async () => {
    const text = `---
task: NC-2
agent: codex
model: gpt-6.1-sol
effort: high
repos:
  - {path: ${repoA}, worktree: ${wt('2')}, branch: nc-2}
---
Go.
---
task: NC-3
agent: codex
repos:
  - {path: ${repoA}, worktree: ${wt('3')}}
---
Go too.
`;
    const { ctx, runner } = makeContext(config, {
      respond: (cmd, args, opts) => {
        if (cmd === 'tmux' && args[0] === 'has-session') return { code: 0 };
        if (cmd === 'tmux' && args[0] === 'list-windows') return { stdout: 'other\n' };
        if (cmd === 'git' && args.includes('--verify')) return { code: 0 }; // nc-2 branch already exists
        return screens('› Ask Codex to do anything')(cmd, args, opts);
      },
    });
    await newTasks(ctx, resolveAll(config, text));
    const c = runner.commands.filter((l) => !l.startsWith('write ') && !l.startsWith('mkdir'));
    assert.equal(c[0], `git -C ${repoA} worktree add ${wt('2')} nc-2`);
    assert.ok(c.includes(`tmux new-window -d -t =agentctl: -n nc-2 -c ${wt('2')}`));
    assert.ok(c.includes(`tmux send-keys -t =agentctl:nc-2 -l -- 'codex --sandbox danger-full-access -m gpt-6.1-sol -c model_reasoning_effort=high'`));
    // default model: no -m
    assert.ok(c.includes(`tmux send-keys -t =agentctl:nc-3 -l -- 'codex --sandbox danger-full-access -c model_reasoning_effort=high'`));
    assert.ok(!c.some((l) => l.includes('new-session')));
  });

  it('fails when a worktree exists unless --reuse is given', async () => {
    const text = `---\ntask: NC-4\nagent: claude\nrepos:\n  - {path: ${repoA}, worktree: ${repoB}}\n---\nGo.\n`;
    const { ctx, runner } = makeContext(config, { respond: freshMachine('❯ Try "x"') });
    await assert.rejects(newTasks(ctx, resolveAll(config, text)), /worktree .* already exists \(pass --reuse/);
    assert.equal(runner.commands.length, 0);

    await newTasks(ctx, resolveAll(config, text), { reuse: true });
    assert.ok(!runner.commands.some((l) => l.includes('worktree add')));
    assert.ok(runner.commands.some((l) => l.startsWith('tmux new-session')));
  });

  it('refuses to replace a real directory with a link', async () => {
    const wtDir = scratch.sub('new/real-wt');
    scratch.sub('new/real-wt/node_modules/@nc/protocol'); // a real directory, not a symlink
    const text = `---\ntask: NC-5\nagent: claude\nrepos:\n  - {path: ${repoA}, worktree: ${wtDir}}\nlinks:\n  - {from: "node_modules/@nc/*", to: "${pkgs}/*"}\n---\nGo.\n`;
    const { ctx } = makeContext(config, { respond: freshMachine('❯ Try "x"') });
    await assert.rejects(newTasks(ctx, resolveAll(config, text), { reuse: true }), /is not a symlink/);
  });

  it('reports a missing tool with install instructions', async () => {
    const text = `---\ntask: NC-6\nagent: codex\nrepos:\n  - {path: ${repoA}, worktree: ${wt('6')}}\n---\nGo.\n`;
    const { ctx } = makeContext(config, { respond: (cmd) => (cmd === 'tmux' ? { code: 127 } : undefined) });
    await assert.rejects(newTasks(ctx, resolveAll(config, text)), (e: Error & { hint?: string }) => {
      assert.match(e.message, /tmux not found/);
      assert.match(e.hint ?? '', /brew install tmux/);
      return true;
    });
  });

  it('leaves the window open and explains when the agent never becomes ready', async () => {
    const text = `---\ntask: NC-7\nagent: claude\nrepos:\n  - {path: ${repoA}, worktree: ${wt('7')}}\n---\nGo.\n`;
    const { ctx, runner } = makeContext(config, { respond: freshMachine('Do you trust this folder?') });
    await assert.rejects(newTasks(ctx, resolveAll(config, text)), (e: Error & { hint?: string }) => {
      assert.match(e.message, /did not show its input prompt within 60s/);
      assert.match(e.hint ?? '', /tmux attach -t agentctl/);
      return true;
    });
    assert.ok(!runner.commands.some((l) => l.includes('load-buffer')), 'the prompt must not be pasted');
    assert.ok(!runner.commands.some((l) => l.includes('kill-window')));
  });
});

describe('send', () => {
  const root = scratch.sub('send');
  const repo = scratch.sub('send/app');
  const config = makeConfig(root);
  const item = resolveSendSpec(splitSpecs('---\ntask: NC-1\n---\nPlease also add a test.\n')[0]!);

  it('pastes into the existing window and appends the prompt to TASK.md', async () => {
    const [spec] = resolveAll(config, `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nOriginal.\n`);
    seedTask(config, spec!, 0);
    const { ctx, runner } = makeContext(config, {
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-1\n' } : undefined),
    });
    await sendPrompts(ctx, [item]);
    assert.deepEqual(runner.commands, [
      'tmux load-buffer -b agentctl-nc-1 -',
      'tmux paste-buffer -p -d -b agentctl-nc-1 -t =agentctl:nc-1',
      'tmux send-keys -t =agentctl:nc-1 Enter',
      `append ${taskFile(config, 'nc-1')} (${Buffer.byteLength(`\n\n## Follow-up sent 2026-10-31T12:00:00.300Z\n\nPlease also add a test.\n`)} bytes)`,
    ]);
    assert.equal(runner.calls[0]?.input, 'Please also add a test.');
  });

  it('fails when the window does not exist', async () => {
    const { ctx, runner } = makeContext(config, { respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'other\n' } : undefined) });
    await assert.rejects(sendPrompts(ctx, [item]), /no tmux window "nc-1" in session "agentctl"/);
    assert.deepEqual(runner.commands, []);
  });
});

describe('close', () => {
  const root = scratch.sub('close');
  const repo = scratch.sub('close/app');
  const wtDir = scratch.sub('close/app-wt');
  const config = makeConfig(root);
  const [spec] = resolveAll(config, `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${wtDir}, branch: nc-1}\n---\nOriginal.\n`);
  seedTask(config, spec!, 0);
  const windows = (stdout: string): Respond => (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout } : undefined);

  it('kills the window and nothing else by default', async () => {
    const { ctx, runner } = makeContext(config, { respond: windows('nc-1\n') });
    await closeTask(ctx, 'nc-1');
    assert.deepEqual(runner.commands, ['tmux kill-window -t =agentctl:nc-1']);
  });

  it('removes the worktree with --rm-worktree, never touching branches', async () => {
    const { ctx, runner } = makeContext(config, {
      respond: (cmd, args, opts) => (cmd === 'git' && args.includes('--abbrev-ref') ? { stdout: 'nc-1\n' } : windows('nc-1\n')(cmd, args, opts)),
    });
    await closeTask(ctx, 'NC-1', { rmWorktree: true });
    assert.deepEqual(runner.commands, ['tmux kill-window -t =agentctl:nc-1', `git -C ${repo} worktree remove ${wtDir}`]);
    for (const line of runner.commands) assert.doesNotMatch(line, /--force|branch|merge|rebase|push|reset/);
  });

  it('refuses to remove a worktree that has main or master checked out', async () => {
    for (const branch of ['main', 'master']) {
      const { ctx, runner } = makeContext(config, {
        respond: (cmd, args, opts) => (cmd === 'git' && args.includes('--abbrev-ref') ? { stdout: `${branch}\n` } : windows('nc-1\n')(cmd, args, opts)),
      });
      await assert.rejects(closeTask(ctx, 'NC-1', { rmWorktree: true }), new RegExp(`has "${branch}" checked out`));
      assert.ok(!runner.commands.some((l) => l.includes('worktree remove')));
    }
  });

  it('surfaces git refusing to remove a dirty worktree, without --force', async () => {
    const { ctx } = makeContext(config, {
      respond: (cmd, args, opts) => {
        if (cmd === 'git' && args.includes('--abbrev-ref')) return { stdout: 'nc-1\n' };
        if (cmd === 'git' && args.includes('remove')) return { code: 1, stderr: 'contains modified or untracked files' };
        return windows('nc-1\n')(cmd, args, opts);
      },
    });
    await assert.rejects(closeTask(ctx, 'NC-1', { rmWorktree: true }), (e: Error & { hint?: string }) => {
      assert.match(e.message, /contains modified or untracked files/);
      assert.match(e.hint ?? '', /never uses --force/);
      return true;
    });
  });

  it('copes with a window that is already gone; --rm-worktree needs a TASK.md', async () => {
    const { ctx, runner, out } = makeContext(config, { respond: windows('other\n') });
    await closeTask(ctx, 'NC-1');
    assert.deepEqual(runner.commands, []);
    assert.match(out.join('\n'), /already closed/);
    await assert.rejects(closeTask(ctx, 'NC-99', { rmWorktree: true }), /no TASK.md/);
  });
});

describe('status', () => {
  const root = scratch.sub('status');
  const repo = scratch.sub('status/app');
  const config = makeConfig(root);
  const start = Date.UTC(2026, 9, 31, 10, 0, 0);

  it('builds a table from TASK.md files and mocked tmux output', async () => {
    const report = path.join(root, 'r2.md');
    const specs = resolveAll(
      config,
      `---\ntask: NC-1\nagent: claude\nmodel: opus\neffort: high\nrepos:\n  - {path: ${repo}, worktree: ${repo}-1}\n---\nA\n---\ntask: NC-2\nagent: codex\nreport: ${report}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-2}\n---\nB\n`,
    );
    for (const s of specs) seedTask(config, s, start);
    fs.mkdirSync(path.join(config.cache, 'not-agentctl'), { recursive: true });
    fs.writeFileSync(path.join(config.cache, 'not-agentctl', 'TASK.md'), '---\ntask: foreign\n---\n');
    fs.writeFileSync(report, 'done');
    fs.utimesSync(report, new Date(start + 90 * 60_000), new Date(start + 90 * 60_000));

    const { ctx } = makeContext(config, {
      startTime: start + 125 * 60_000,
      respond: (cmd, args) => {
        if (cmd !== 'tmux') return undefined;
        if (args[0] === 'list-windows') return { stdout: 'nc-1\n' };
        if (args[0] === 'capture-pane') return { stdout: 'Working on it\n  Reading src/a.ts  \n\n\n' };
        return undefined;
      },
    });
    const rows = await collectStatus(ctx);
    assert.deepEqual(
      rows.map((r) => [r.task, r.state, r.window, r.duration, r.report, r.lastLine]),
      [
        ['NC-1', 'waiting', 'alive', '2h 05m', 'missing', 'Reading src/a.ts'],
        ['NC-2', 'report-ready', 'gone', '1h 30m', 'yes', ''],
      ],
    );
    const table = renderStatusTable(rows);
    assert.match(table[0] as string, /^TASK\s+AGENT\/MODEL\/EFFORT\s+STATE\s+WINDOW\s+STARTED\s+DURATION\s+REPORT\s+LAST LINE$/);
    assert.match(table[1] as string, /^NC-1\s+claude\/opus\/high\s+waiting\s+alive\s+2026-10-31 10:00\s+2h 05m\s+missing\s+Reading src\/a\.ts$/);
    assert.equal(table.length, 3);
  });
});

describe('pull', () => {
  const root = scratch.sub('pull');
  const repo = scratch.sub('pull/app');
  const config = makeConfig(root);
  const report = path.join(root, 'REPORT.md');
  const [spec] = resolveAll(config, `---\ntask: NC-1\nagent: claude\nreport: ${report}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-1}\n---\nA\n`);
  seedTask(config, spec!, 0);
  const hasClipboard = (name: string): Respond => (cmd, args) => (cmd === 'sh' && args.at(-1) === name ? { code: 0 } : cmd === 'sh' ? { code: 1 } : undefined);

  it('copies the report to the clipboard (pbcopy on macOS) and prints the path', async () => {
    fs.writeFileSync(report, '# Report\nAll good.\n');
    const { ctx, runner, out } = makeContext(config, { respond: hasClipboard('pbcopy') });
    await pullTask(ctx, 'nc-1', 'darwin');
    assert.deepEqual(runner.commands, ['pbcopy']);
    assert.equal(runner.calls[0]?.input, '# Report\nAll good.\n');
    assert.equal(out.at(-1), report);
  });

  it('uses wl-copy or xclip on Linux', async () => {
    const { ctx, runner } = makeContext(config, { respond: hasClipboard('xclip') });
    await pullTask(ctx, 'NC-1', 'linux');
    assert.deepEqual(runner.commands, ['xclip -selection clipboard']);
  });

  it('without a report prints the last 40 lines of the window', async () => {
    fs.rmSync(report);
    const lines = Array.from({ length: 100 }, (_v, i) => `line ${i + 1}`).join('\n');
    const { ctx, runner, out } = makeContext(config, {
      respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'capture-pane' ? { stdout: lines } : undefined),
    });
    await pullTask(ctx, 'NC-1', 'darwin');
    assert.deepEqual(runner.commands, []);
    assert.match(out[0] as string, /No report at .*last 40 lines/);
    assert.equal(out.length, 41);
    assert.equal(out[1], 'line 61');
    assert.equal(out.at(-1), 'line 100');
    assert.ok(runner.queries.some((q) => q === 'tmux capture-pane -p -t =agentctl:nc-1 -S -40'));
  });

  it('rejects an unknown task', async () => {
    const { ctx } = makeContext(config);
    await assert.rejects(pullTask(ctx, 'NC-404', 'darwin'), /unknown task NC-404/);
  });
});

describe('interrupt', () => {
  const root = scratch.sub('interrupt');
  const repo = scratch.sub('interrupt/app');
  const config = makeConfig(root, 'agents:\n  codex:\n    interrupt_key: C-c\n');
  const [claude, codex] = resolveAll(
    config,
    `---\ntask: NC-1\nagent: claude\nrepos:\n  - {path: ${repo}, worktree: ${repo}-1}\n---\nA\n---\ntask: NC-2\nagent: codex\nrepos:\n  - {path: ${repo}, worktree: ${repo}-2}\n---\nB\n`,
  );
  seedTask(config, claude!, 0);
  seedTask(config, codex!, 0);
  const alive = (cmd: string, args: string[]) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'nc-1\nnc-2\n' } : undefined);

  it('sends one Escape to a Claude window by default and does not close anything', async () => {
    const { ctx, runner } = makeContext(config, { respond: alive });
    const result = await interruptTask(ctx, 'NC-1');
    assert.deepEqual(runner.commands, ['tmux send-keys -t =agentctl:nc-1 Escape']);
    assert.deepEqual(result, { task: 'NC-1', window: 'nc-1', key: 'Escape' });
  });

  it('uses the interrupt key configured for the agent', async () => {
    const { ctx, runner } = makeContext(config, { respond: alive });
    await interruptTask(ctx, 'nc-2');
    assert.deepEqual(runner.commands, ['tmux send-keys -t =agentctl:nc-2 C-c']);
  });

  it('--dry-run only records the command', async () => {
    const { ctx, runner } = makeContext(config, { dryRun: true });
    await interruptTask(ctx, 'NC-1');
    assert.deepEqual(runner.commands, ['tmux send-keys -t =agentctl:nc-1 Escape']);
  });

  it('fails clearly for a dead window and for an unknown task', async () => {
    const { ctx, runner } = makeContext(config, { respond: (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'other\n' } : undefined) });
    await assert.rejects(interruptTask(ctx, 'NC-1'), /no tmux window "nc-1"/);
    await assert.rejects(interruptTask(ctx, 'NC-404'), /unknown task NC-404/);
    assert.deepEqual(runner.commands, []);
  });
});
