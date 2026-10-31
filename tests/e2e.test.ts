import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.ts';
import type { CliDeps } from '../src/cli.ts';
import { EXAMPLE_SPEC } from '../src/core/example.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { splitSpecs } from '../src/core/spec.ts';
import { REPO_ROOT, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const BIN = path.join(REPO_ROOT, 'bin', 'agentctl.ts');

function agentctl(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    cwd: REPO_ROOT,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('agentctl new --dry-run (the real binary)', () => {
  const root = scratch.sub('e2e');
  const config = makeConfig(root, 'limits: {claude: 5}\n');
  const home = path.join(root, 'home');
  const repo = path.join(root, 'no-such-repo');
  const wtDir = path.join(root, 'wt', 'app-nc-1');
  const specFile = path.join(root, 'spec.md');
  fs.writeFileSync(
    specFile,
    `---
task: NC-1
agent: claude
model: opus
effort: high
repos:
  - {path: ${repo}, worktree: ${wtDir}, base: main, branch: nc-1}
env: {NEON_CITY_TASK: NC-1}
---
Line one.
Line two.
---
task: NC-2
agent: codex
model: gpt-6.1-sol
review_of: NC-1
repos:
  - {path: ${repo}, worktree: ${path.join(root, 'wt', 'app-nc-2')}}
---
Review NC-1.
`,
  );

  it('prints every command it would run and executes none of them', () => {
    const r = agentctl(['new', '--dry-run', specFile], { AGENTCTL_HOME: home });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const commands = lines.filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/^(write \S+) \(\d+ bytes\)$/, '$1'));
    assert.deepEqual(commands, [
      `git -C ${repo} worktree add -b nc-1 ${wtDir} main`,
      `mkdir -p ${config.cache}/nc-1`,
      `write ${config.cache}/nc-1/TASK.md`,
      `tmux new-session -d -s agentctl -n nc-1 -c ${wtDir} -e NEON_CITY_TASK=NC-1`,
      `tmux send-keys -t =agentctl:nc-1 -l -- 'claude --model opus --effort high'`,
      'tmux send-keys -t =agentctl:nc-1 Enter',
      'tmux load-buffer -b agentctl-nc-1 -',
      'tmux paste-buffer -p -d -b agentctl-nc-1 -t =agentctl:nc-1',
      'tmux send-keys -t =agentctl:nc-1 Enter',
      `git -C ${repo} worktree add --detach ${path.join(root, 'wt', 'app-nc-2')}`,
      `mkdir -p ${config.cache}/nc-2`,
      `write ${config.cache}/nc-2/TASK.md`,
      `tmux new-window -d -t =agentctl: -n nc-2 -c ${path.join(root, 'wt', 'app-nc-2')}`,
      `tmux send-keys -t =agentctl:nc-2 -l -- 'codex --sandbox danger-full-access -m gpt-6.1-sol -c model_reasoning_effort=high'`,
      'tmux send-keys -t =agentctl:nc-2 Enter',
      'tmux load-buffer -b agentctl-nc-2 -',
      'tmux paste-buffer -p -d -b agentctl-nc-2 -t =agentctl:nc-2',
      'tmux send-keys -t =agentctl:nc-2 Enter',
    ]);
    assert.ok(lines.includes('#   Model: opus · effort high'), 'the prompt is shown with its header line');

    assert.equal(fs.existsSync(wtDir), false, 'no worktree directory');
    assert.equal(fs.existsSync(path.join(config.cache, 'nc-1')), false, 'no cache directory');
  });

  it('exits non-zero with a short error and hint for an invalid spec', () => {
    const bad = path.join(root, 'bad.md');
    fs.writeFileSync(bad, '---\ntask: nc-1\nagent: gemini\n---\nHi\n');
    const r = agentctl(['new', '--dry-run', bad], { AGENTCTL_HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: Spec #1 \(nc-1\) is invalid:/);
    assert.match(r.stderr, /hint: Run "agentctl spec example"/);
    assert.equal(r.stdout, '');
  });

  it('rejects a same-agent-and-model review before running anything', () => {
    const f = path.join(root, 'review.md');
    fs.writeFileSync(
      f,
      `---\ntask: NC-1\nagent: claude\nmodel: opus\nrepos:\n  - {path: ${repo}, worktree: ${wtDir}}\n---\nA\n---\ntask: NC-2\nagent: claude\nmodel: opus\nreview_of: NC-1\nrepos:\n  - {path: ${repo}, worktree: ${wtDir}2}\n---\nB\n`,
    );
    const r = agentctl(['new', '--dry-run', f], { AGENTCTL_HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /NC-2 reviews NC-1 but uses the same agent and model \(claude, opus\)/);
    assert.equal(r.stdout, '');
  });

  it('reads the spec from stdin with "-"', () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, 'new', '--dry-run', '-'], {
      encoding: 'utf8',
      input: fs.readFileSync(specFile, 'utf8'),
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', AGENTCTL_HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /tmux new-session -d -s agentctl -n nc-1/);
  });
});

describe('spec example', () => {
  it('prints the example, which parses cleanly and matches the README', () => {
    const r = agentctl(['spec', 'example'], { AGENTCTL_HOME: path.join(scratch.dir, 'none') });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, EXAMPLE_SPEC);
    assert.equal(splitSpecs(EXAMPLE_SPEC)[0]?.header.task, 'NC-42');
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes(EXAMPLE_SPEC), 'README must contain the example spec verbatim (see src/example.ts)');
  });

  it('the example on codex: new --dry-run --agent codex translates opus/high to gpt-6-astra/medium', () => {
    const f = path.join(scratch.dir, 'example-codex.md');
    fs.writeFileSync(f, EXAMPLE_SPEC);
    const none = path.join(scratch.dir, 'none');
    const r = agentctl(['new', '--dry-run', '--agent', 'codex', f], { AGENTCTL_HOME: none });
    assert.equal(r.code, 0, r.stderr);
    const commands = r.stdout.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/^(write \S+) \(\d+ bytes\)$/, '$1'));
    assert.ok(commands.includes("tmux send-keys -t =agentctl:nc-42 -l -- 'codex --sandbox danger-full-access -m gpt-6-astra -c model_reasoning_effort=medium'"));
    assert.ok(!commands.some((c) => c.includes('claude')));
    assert.ok(r.stdout.includes('#   Model: gpt-6-astra · effort medium'));
    assert.ok(commands.some((c) => c.startsWith('git -C ') && c.includes('worktree add -b nc-42-tram-bell')));

    const bad = agentctl(['new', '--dry-run', '--agent', 'gemini', f], { AGENTCTL_HOME: none });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Allowed choices are claude, codex/);
  });

  it('the example runs through new --dry-run', () => {
    const f = path.join(scratch.dir, 'example.md');
    fs.writeFileSync(f, EXAMPLE_SPEC);
    const r = agentctl(['new', '--dry-run', f], { AGENTCTL_HOME: path.join(scratch.dir, 'none') });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /git -C \S+neon-city worktree add -b nc-42-tram-bell \S+neon-city-nc-42 master/);
  });
});

describe('interrupt --dry-run (the real binary)', () => {
  it('prints the one key it would send', () => {
    const root = scratch.sub('e2e-interrupt');
    const config = makeConfig(root);
    const repo = scratch.sub('e2e-interrupt/app');
    fs.mkdirSync(path.join(config.cache, 'nc-1'), { recursive: true });
    fs.writeFileSync(
      path.join(config.cache, 'nc-1', 'TASK.md'),
      `---\nagentctl: 1\ntask: NC-1\nwindow: nc-1\nsession: agentctl\nagent: codex\nmodel: default\neffort: high\nrepos: []\nstarted: 2026-10-31T10:00:00.000Z\n---\nGo\n`,
    );
    const r = agentctl(['interrupt', 'NC-1', '--dry-run'], { AGENTCTL_HOME: path.join(root, 'home') });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^tmux send-keys -t =agentctl:nc-1 Escape$/m);
    void repo;
  });
});

describe('main() with injected dependencies', () => {
  it('status --json works with a mocked tmux and an empty cache', async () => {
    const config = makeConfig(scratch.sub('status-json'));
    const out: string[] = [];
    const deps: CliDeps = {
      stdout: (t) => out.push(t),
      stderr: (t) => out.push(t),
      readStdin: () => '',
      stdinIsTTY: true,
      loadConfig: () => config,
      confirm: undefined,
      makeRunner: () => new RecordingRunner({ dryRun: false }),
    };
    assert.equal(await main(['status', '--json'], deps), 0);
    assert.equal(out.join('').trim(), '[]');
    out.length = 0;
    assert.equal(await main(['new'], deps), 1);
    assert.match(out.join(''), /error: no spec given/);
  });
});
