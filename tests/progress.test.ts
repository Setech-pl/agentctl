import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { formatProgress, repoProgress, taskProgress } from '../src/core/progress.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecResult } from '../src/core/runner.ts';
import { collectStatus } from '../src/core/status.ts';
import { renderStatusTable } from '../src/render.ts';
import { FakeTmux, makeConfig, makeContext, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();

interface GitFixture {
  /** `git status --porcelain` lines. */
  status?: string[];
  /** `git diff --name-only <base>...HEAD`. */
  diff?: string[];
  /** `git rev-list --count <base>..HEAD`. */
  count?: number;
  /** Refs that exist. */
  refs?: string[];
  /** The worktree is gone: every git command fails. */
  gone?: boolean;
}

/** A mock git: answers the four read-only queries from fixtures per worktree. */
function mockGit(fixtures: Record<string, GitFixture>): (cmd: string, args: string[]) => Partial<ExecResult> | undefined {
  return (cmd, args) => {
    if (cmd !== 'git' || args[0] !== '-C') return undefined;
    const fx = fixtures[args[1] as string];
    if (!fx || fx.gone) return { code: 128, stderr: 'fatal: not a git repository' };
    const [sub, ...rest] = args.slice(2) as [string, ...string[]];
    const lines = (l: string[] = []): Partial<ExecResult> => ({ stdout: l.length ? `${l.join('\n')}\n` : '' });
    if (sub === 'status') return lines(fx.status);
    if (sub === 'rev-parse') return (fx.refs ?? ['main']).some((r) => rest.includes(`${r}^{commit}`)) ? { stdout: 'abc123\n' } : { code: 1 };
    if (sub === 'rev-list') return { stdout: `${fx.count ?? 0}\n` };
    if (sub === 'diff') return lines(fx.diff);
    return undefined;
  };
}

describe('repoProgress', () => {
  it('counts commits over the base and changed files, committed and uncommitted, each file once', async () => {
    const runner = new RecordingRunner({
      dryRun: false,
      respond: mockGit({ '/wt/a': { count: 2, diff: ['src/a.ts', 'src/c.ts', 'README.md'], status: [' M src/a.ts', '?? notes.txt', 'R  old.ts -> src/b.ts'] } }),
    });
    const p = await repoProgress(runner, { path: '/repo', worktree: '/wt/a' });
    assert.deepEqual(p, { worktree: '/wt/a', base: 'main', commits: 2, files: 5 });
    assert.equal(formatProgress(p!.commits, p!.files), '2c 5f');
  });

  it('uses the base from the spec, with three dots for files and two for commits', async () => {
    const runner = new RecordingRunner({ dryRun: false, respond: mockGit({ '/wt/a': { refs: ['release/1.2'], count: 1 } }) });
    const p = await repoProgress(runner, { path: '/repo', worktree: '/wt/a', base: 'release/1.2' });
    assert.equal(p?.base, 'release/1.2');
    assert.ok(runner.queries.some((q) => q.endsWith('rev-list --count release/1.2..HEAD')), runner.queries.join('\n'));
    assert.ok(runner.queries.some((q) => q.endsWith('diff --name-only release/1.2...HEAD')));
  });

  it('without a base in the spec: main, else master, else unknown commits but still the uncommitted files', async () => {
    const onMaster = new RecordingRunner({ dryRun: false, respond: mockGit({ '/wt/a': { refs: ['master'], count: 3 } }) });
    assert.equal((await repoProgress(onMaster, { path: '/r', worktree: '/wt/a' }))?.base, 'master');
    const none = new RecordingRunner({ dryRun: false, respond: mockGit({ '/wt/a': { refs: [], status: [' M a.ts', ' M b.ts'] } }) });
    const p = await repoProgress(none, { path: '/r', worktree: '/wt/a' });
    assert.deepEqual(p, { worktree: '/wt/a', base: null, commits: null, files: 2 });
    assert.equal(formatProgress(p!.commits, p!.files), '?c 2f');
  });

  it('a worktree git cannot read is null; a clean fresh worktree is 0c 0f', async () => {
    const runner = new RecordingRunner({ dryRun: false, respond: mockGit({ '/wt/gone': { gone: true }, '/wt/new': {} }) });
    assert.equal(await repoProgress(runner, { path: '/r', worktree: '/wt/gone' }), null);
    const fresh = await repoProgress(runner, { path: '/r', worktree: '/wt/new' });
    assert.equal(formatProgress(fresh!.commits, fresh!.files), '0c 0f');
  });
});

describe('taskProgress', () => {
  it('adds up several worktrees and skips the unreadable ones', async () => {
    const runner = new RecordingRunner({
      dryRun: false,
      respond: mockGit({ '/wt/a': { count: 2, diff: ['a'] }, '/wt/b': { count: 1, status: [' M x', ' M y'] }, '/wt/c': { gone: true } }),
    });
    const p = await taskProgress(runner, [
      { path: '/r', worktree: '/wt/a' },
      { path: '/r', worktree: '/wt/b' },
      { path: '/r', worktree: '/wt/c' },
    ]);
    assert.equal(p?.text, '3c 3f');
    assert.equal(p?.repos.length, 2);
    assert.equal(await taskProgress(runner, [{ path: '/r', worktree: '/wt/c' }]), null);
    assert.equal(await taskProgress(runner, []), null);
  });

  it('one worktree without a base makes the commit total unknown', async () => {
    const runner = new RecordingRunner({ dryRun: false, respond: mockGit({ '/wt/a': { count: 2 }, '/wt/b': { refs: [], status: [' M x'] } }) });
    const p = await taskProgress(runner, [{ path: '/r', worktree: '/wt/a' }, { path: '/r', worktree: '/wt/b' }]);
    assert.equal(p?.text, '?c 1f');
  });
});

describe('PROGRESS in status', () => {
  function setup(name: string) {
    const config = makeConfig(scratch.sub(name));
    seedTask(config, 'NC-1', { repos: [{ path: '/repo', worktree: '/wt/a', base: 'main' }] });
    seedTask(config, 'NC-2', { repos: [] });
    const tmux = new FakeTmux();
    tmux.add('nc-1', '');
    const git = mockGit({ '/wt/a': { count: 2, diff: ['a.ts', 'b.ts'], status: [' M b.ts', ' M c.ts'] } });
    return { config, tmux, ...makeContext(config, { respond: (cmd, args, opts) => tmux.respond(cmd, args, opts) ?? git(cmd, args) }) };
  }

  it('rows carry the progress; the table has a PROGRESS column', async () => {
    const { ctx } = setup('ps1');
    const rows = await collectStatus(ctx);
    assert.equal(rows[0]?.progress?.text, '2c 3f');
    assert.equal(rows[1]?.progress, null);
    const table = renderStatusTable(rows);
    assert.match(table[0] as string, /DURATION\s+PROGRESS\s+REPORT/);
    assert.match(table[1] as string, /\s2c 3f\s/);
    assert.match(table[2] as string, /\s-\s+missing/);
  });

  it('progress: false asks git nothing', async () => {
    const { ctx, runner } = setup('ps2');
    const rows = await collectStatus(ctx, { progress: false });
    assert.equal(rows[0]?.progress, null);
    assert.ok(!runner.queries.some((q) => q.startsWith('git')), runner.queries.join('\n'));
  });

  it('status --json and status --clip carry it', async () => {
    const { config, tmux } = setup('ps3');
    const git = mockGit({ '/wt/a': { count: 2, diff: ['a.ts'], status: [' M b.ts'] } });
    const runner = new RecordingRunner({ dryRun: false, respond: (cmd, args, opts) => tmux.respond(cmd, args, opts) ?? git(cmd, args) });
    const out: string[] = [];
    const copied: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t), stderr: (t) => out.push(t), readStdin: () => '', stdinIsTTY: false, loadConfig: () => config,
      confirm: undefined, readClipboard: async () => '', watchCommand: () => '', makeRunner: () => runner,
    };
    assert.equal(await main(['status', '--json'], deps), 0);
    const rows = JSON.parse(out.join('')) as { task: string; progress: { commits: number; files: number; text: string } | null }[];
    assert.deepEqual(rows[0]?.progress && { commits: rows[0].progress.commits, files: rows[0].progress.files, text: rows[0].progress.text }, { commits: 2, files: 2, text: '2c 2f' });
    assert.equal(rows[1]?.progress, null);

    out.length = 0;
    const clipRunner = new RecordingRunner({
      dryRun: false,
      respond: (cmd, args, opts) => {
        if (cmd === 'sh' && args.at(-1) === 'pbcopy') return { code: 0 };
        return tmux.respond(cmd, args, opts) ?? git(cmd, args) ?? (cmd === 'pbcopy' ? (copied.push(opts.input ?? ''), {}) : undefined);
      },
    });
    assert.equal(await main(['status', '--clip'], { ...deps, makeRunner: () => clipRunner }), 0);
    assert.match(copied[0] ?? out.join(''), /\| progress \|[\s\S]*\| NC-1 \|.*\| 2c 2f \|/);
  });
});
