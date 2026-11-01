import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, useScratch } from './helpers.ts';

const scratch = useScratch();
const SCRIPT = path.join(REPO_ROOT, 'bin', 'agentctl-update');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Every mocked command that was called, one line each. */
  calls: string[];
}

/**
 * Run the script with fake git, npm and tmux in front of PATH: they only log their arguments (and fake a few answers),
 * so no real git, npm or tmux is involved. A `worktree add` creates the stable dir with a fake bin/agentctl.ts.
 */
function runUpdate(name: string, args: string[], env: Record<string, string> = {}, opts: { stableExists?: boolean; dirty?: boolean; windows?: string; doctorRc?: number; script?: string } = {}): Run & { dir: string; stable: string } {
  const dir = scratch.sub(name);
  const bin = path.join(dir, 'fakebin');
  const log = path.join(dir, 'calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const stable = path.join(dir, 'stable');
  const fakeAgentctl = (_target: string): string => `#!/bin/sh\necho "agentctl $*" >> ${log}\nexit ${opts.doctorRc ?? 0}\n`;
  const write = (file: string, text: string): void => {
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o755);
  };
  write(
    path.join(bin, 'git'),
    `#!/bin/sh
echo "git $*" >> ${log}
case "$*" in
  *"worktree add"*) mkdir -p "$6/bin" ; cp ${path.join(dir, 'fake-agentctl')} "$6/bin/agentctl.ts" ;;
  *"status --porcelain"*) ${opts.dirty ? 'echo " M src/cli.ts"' : 'true'} ;;
  *"log -1"*) echo "abc1234 Some commit title" ;;
esac
exit 0
`,
  );
  write(path.join(bin, 'npm'), `#!/bin/sh\necho "npm $* (cwd $(pwd -P))" >> ${log}\nexit 0\n`);
  write(
    path.join(bin, 'tmux'),
    `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  list-windows) printf '${opts.windows ?? 'watch\\nnc-1\\n'}' ; exit 0 ;;
  *) echo "tmux $*" >> ${log} ;;
esac
exit 0
`,
  );
  write(path.join(dir, 'fake-agentctl'), fakeAgentctl(stable));
  if (opts.stableExists) {
    fs.mkdirSync(path.join(stable, 'bin'), { recursive: true });
    write(path.join(stable, 'bin', 'agentctl.ts'), fakeAgentctl(stable));
  }
  const r = spawnSync('bash', [opts.script ?? SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(dir, 'home'), AGENTCTL_REPO: path.join(dir, 'repo'), AGENTCTL_STABLE_DIR: stable, ...env },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls, dir, stable };
}

describe('agentctl-update: paths', () => {
  it('uses AGENTCTL_REPO and AGENTCTL_STABLE_DIR, and defaults the ref to origin/main', () => {
    const r = runUpdate('up1', ['--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^repo:   ${r.dir}/repo$`, 'm'));
    assert.match(r.stdout, new RegExp(`^stable: ${r.stable}$`, 'm'));
    assert.match(r.stdout, /^ref:    origin\/main$/m);
  });

  it('defaults the stable copy to ~/Projects/agentctl-stable', () => {
    const r = runUpdate('up2', ['--dry-run'], { AGENTCTL_STABLE_DIR: '' });
    assert.equal(r.code, 0, r.stderr);
    // an empty variable counts as unset only for ${VAR:-}; the script uses ${VAR:-default}
    assert.match(r.stdout, new RegExp(`^stable: ${r.dir}/home/Projects/agentctl-stable$`, 'm'));
  });

  it('without AGENTCTL_REPO the repo is the parent of the script directory, symlinks resolved', () => {
    const dir = scratch.sub('up3');
    const real = path.join(dir, 'checkout', 'bin');
    fs.mkdirSync(real, { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(real, 'agentctl-update'));
    fs.mkdirSync(path.join(dir, 'global'), { recursive: true });
    fs.symlinkSync(path.join(real, 'agentctl-update'), path.join(dir, 'global', 'agentctl-update'));
    const viaLink = runUpdate('up3b', ['--dry-run'], { AGENTCTL_REPO: '' }, { script: path.join(dir, 'global', 'agentctl-update') });
    assert.equal(viaLink.code, 0, viaLink.stderr);
    assert.match(viaLink.stdout, new RegExp(`^repo:   ${fs.realpathSync(path.join(dir, 'checkout'))}$`, 'm'));
  });

  it('--ref and --ref=<ref> choose what is installed; --help and unknown flags', () => {
    assert.match(runUpdate('up4', ['--dry-run', '--ref', 'pilot-fixes']).stdout, /^ref:    pilot-fixes$/m);
    assert.match(runUpdate('up4b', ['--dry-run', '--ref=v1.2']).stdout, /worktree add --detach \S+ v1\.2$/m);
    const help = runUpdate('up4c', ['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--ref <ref>/);
    assert.deepEqual(help.calls, []);
    const bad = runUpdate('up4d', ['--nope']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown argument: --nope/);
  });
});

describe('agentctl-update: --dry-run', () => {
  it('prints every command, runs none (no git/npm/tmux call is made), and quotes the tmux target', () => {
    const r = runUpdate('dr1', ['--dry-run']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.calls, [], 'the mocks were not called');
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('+ '));
    assert.deepEqual(lines, [
      `+ git -C ${r.dir}/repo fetch origin`,
      `+ git -C ${r.dir}/repo worktree add --detach ${r.stable} origin/main`,
      `+ (cd ${r.stable} && npm ci)`,
      `+ (cd ${r.stable} && npm link)`,
      `+ ${r.stable}/bin/agentctl.ts doctor`,
      "+ tmux kill-window -t '=agentctl:watch'",
      `+ ${r.stable}/bin/agentctl.ts watch --tmux`,
    ]);
    assert.equal(fs.existsSync(r.stable), false);
    assert.match(r.stdout, /^watch restarted: yes \(dry run: would be\)$/m);
  });

  it('an existing stable copy gets a checkout --detach, not a worktree add', () => {
    const r = runUpdate('dr2', ['--dry-run', '--ref', 'abc'], {}, { stableExists: true });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^\\+ git -C ${r.stable} checkout --detach abc$`, 'm'));
    assert.doesNotMatch(r.stdout, /worktree add/);
    assert.match(r.stdout, /^previous: abc1234 Some commit title$/m);
  });

  it('--no-watch and --no-link drop their steps; without a "watch" window nothing is restarted', () => {
    const r = runUpdate('dr3', ['--dry-run', '--no-watch', '--no-link']);
    assert.doesNotMatch(r.stdout, /^\+ .*(npm link|kill-window|watch --tmux)/m);
    assert.match(r.stdout, /--no-link: npm link skipped/);
    assert.match(r.stdout, /^watch restarted: no \(--no-watch\)$/m);
    const noWindow = runUpdate('dr3b', ['--dry-run'], {}, { windows: 'nc-1\\n' });
    assert.doesNotMatch(noWindow.stdout, /kill-window/);
    assert.match(noWindow.stdout, /^watch restarted: no \(no window "watch" in session "agentctl"\)$/m);
  });
});

describe('agentctl-update: a real run against mocked git, npm and tmux', () => {
  it('first install: fetch, worktree add --detach, npm ci, npm link, doctor, restarts only the watch window', () => {
    const r = runUpdate('rn1', []);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.filter((c) => !c.includes(' log -1 ')),
      [
        `git -C ${r.dir}/repo fetch origin`,
        `git -C ${r.dir}/repo worktree add --detach ${r.stable} origin/main`,
        `npm ci (cwd ${fs.realpathSync(r.stable)})`,
        `npm link (cwd ${fs.realpathSync(r.stable)})`,
        'agentctl doctor',
        'tmux kill-window -t =agentctl:watch',
        'agentctl watch --tmux',
      ],
    );
    assert.match(r.stdout, /^previous: \(none\)$/m);
    assert.match(r.stdout, /^new:      abc1234 Some commit title$/m);
    assert.match(r.stdout, /^watch restarted: yes$/m);
  });

  it('refuses a stable copy with local changes and does nothing to it', () => {
    const r = runUpdate('rn2', [], {}, { stableExists: true, dirty: true });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /has local changes; refusing to touch it/);
    assert.ok(!r.calls.some((c) => c.includes('checkout') || c.startsWith('npm') || c.startsWith('tmux')), r.calls.join('\n'));
  });

  it('a clean existing copy: checkout --detach <ref>; --no-watch leaves tmux alone', () => {
    const r = runUpdate('rn3', ['--no-watch', '--no-link', '--ref', 'pilot-fixes'], {}, { stableExists: true });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.calls.includes(`git -C ${r.stable} checkout --detach pilot-fixes`));
    assert.ok(r.calls.some((c) => c.startsWith('npm ci')));
    assert.ok(!r.calls.some((c) => c.startsWith('npm link') || c.startsWith('tmux')));
  });

  it('a failing doctor gives a non-zero exit code and leaves the old watcher running', () => {
    const r = runUpdate('rn4', [], {}, { stableExists: true, doctorRc: 1 });
    assert.equal(r.code, 1);
    assert.ok(!r.calls.some((c) => c.startsWith('tmux kill-window')), r.calls.join('\n'));
    assert.match(r.stdout, /^watch restarted: no \(doctor failed/m);
  });
});

describe('agentctl-update: packaging', () => {
  it('is executable, strict bash, and listed in package.json bin', () => {
    assert.ok(fs.statSync(SCRIPT).mode & 0o111, 'executable');
    const text = fs.readFileSync(SCRIPT, 'utf8');
    assert.match(text, /^#!\/usr\/bin\/env bash\n/);
    assert.match(text, /^set -euo pipefail$/m);
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> };
    assert.equal(pkg.bin['agentctl-update'], 'bin/agentctl-update');
    assert.equal(pkg.bin['agentctl'], 'bin/agentctl.ts');
  });
});
