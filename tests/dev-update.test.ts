import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const updater = fileURLToPath(new URL('../bin/agentctl-dev-update', import.meta.url));

function fixture(devName = 'devtest') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'dev-update-'));
  const repo = path.join(root, 'repo');
  const dev = path.join(root, devName);
  const home = path.join(root, 'dev-home');
  const bin = path.join(root, 'fakebin');
  const log = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  const env = {
    ...process.env, PATH: `${bin}:/usr/bin:/bin`, AGENTCTL_REPO: repo, AGENTCTL_DEV_DIR: dev,
    AGENTCTL_DEV_HOME: home, UPDATE_LOG: log, UPDATE_REAL_NODE: process.execPath,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nprintf "npm %s\\n" "$*" >> "$UPDATE_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
if [ "$1" = -p ]; then exec "$UPDATE_REAL_NODE" "$@"; fi
test "$AGENTCTL_HOME" = "$AGENTCTL_DEV_HOME" || exit 1
shift
printf 'node %s\n' "$*" >> "$UPDATE_LOG"
`, { mode: 0o755 });
  const git = (...args: string[]) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();
  const commit = (version: string) => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }));
    git('-C', repo, 'add', 'package.json');
    git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', version);
    return git('-C', repo, 'rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'release-candidate', repo);
  const old = commit('0.23.0');
  const head = () => git('-C', dev, 'rev-parse', 'HEAD');
  const run = (...args: string[]) => spawnSync('/bin/bash', [updater, ...args], { env, encoding: 'utf8' });
  const update = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n');
  const state = () => fs.readFileSync(path.join(home, 'dev-update.state'), 'utf8');
  return { repo, dev, git, old, commit, update, run, head, calls, state };
}

test('dev updater rebuilds a tagged worktree, reports status and rolls back after a repeat build', () => {
  const f = fixture();
  f.git('-C', f.repo, 'worktree', 'add', '-q', '--detach', f.dev, f.old);
  const next = f.commit('0.23.1');
  f.git('-C', f.repo, 'tag', 'v0.23.1');

  assert.match(f.update('v0.23.1'), /GOTOWE: dev @ .* = 0\.23\.1/);
  assert.equal(f.head(), next);
  assert.deepEqual(f.calls(), ['npm ci --no-audit --no-fund', 'npm run build', 'node doctor', 'node watch --tmux --restart', 'node board --tmux --restart']);
  const before = f.state();
  assert.ok(before.startsWith(f.old));
  const status = f.update('--status');
  assert.match(status, /package 0\.23\.1/);
  assert.match(status, new RegExp(`poprzedni: ${f.old}`));
  const previousCalls = f.calls().length;
  f.update(next, '--no-restart', '--skip-ci');
  assert.deepEqual(f.calls().slice(previousCalls), ['npm run build', 'node doctor']);
  assert.equal(f.state(), before);
  f.update('--rollback', '--no-restart', '--skip-ci');
  assert.equal(f.head(), f.old);
});

test('dev updater resolves a branch from the source repo even when the dev clone has a stale local branch', () => {
  const f = fixture();
  f.git('clone', '-q', f.repo, f.dev);
  const next = f.commit('0.23.1');
  f.update('release-candidate', '--no-restart', '--skip-ci');
  assert.equal(f.head(), next);
  assert.equal(f.git('-C', f.dev, 'rev-parse', 'release-candidate'), f.old);

  fs.writeFileSync(path.join(f.dev, 'package.json'), '{}');
  const before = f.calls();
  const denied = f.run('--rollback');
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /niezacommitowane zmiany/);
  assert.equal(f.head(), next);
  assert.deepEqual(f.calls(), before);
});

test('dev updater reads the package version in a worktree path containing an apostrophe', () => {
  const f = fixture("Marcin's dev test");
  f.git('-C', f.repo, 'worktree', 'add', '-q', '--detach', f.dev, f.old);
  assert.match(f.update('--status'), /package 0\.23\.0/);
  assert.match(f.update(f.commit('0.23.1'), '--no-restart', '--skip-ci'), /GOTOWE: dev @ .* = 0\.23\.1/);
});
