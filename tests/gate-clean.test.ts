import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanLiveCache, CleanRefusal, dirSize } from '../scripts/gate-clean.ts';
import { useScratch } from './helpers.ts';

const scratch = useScratch();

/** A fake cache root with gate-made and human-made content; returns the paths the assertions use. */
function fakeCache(name: string) {
  const root = scratch.sub(name);
  const made = (rel: string, bytes = 100): string => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x'.repeat(bytes));
    return p;
  };
  made('gate-work-101/tmp/file');
  made('gate-work-202/tests/test-abc/out');
  made('live-smoke/npm-cache/pkg.tgz', 300);
  made('live-board/prefix/bin/agentctl');
  fs.mkdirSync(path.join(root, 'live-board/tmx', `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
  fs.writeFileSync(path.join(root, 'live-board/tmx', `tmux-${process.getuid?.() ?? 0}`, 'default'), '');
  const keptLog = made('gate-results/abc123/quick.json');
  const keptReport = made('review2/reproductions.log');
  return { root, keptLog, keptReport };
}

it('removes only what the gate made, stops sandbox tmux servers, keeps logs and gate-results, reports sizes', () => {
  const { root, keptLog, keptReport } = fakeCache('happy');
  const killed: string[] = [];
  const summary = cleanLiveCache(root, { killServer: (socket) => killed.push(socket) });
  assert.ok(!fs.existsSync(path.join(root, 'gate-work-101')));
  assert.ok(!fs.existsSync(path.join(root, 'gate-work-202')));
  assert.ok(!fs.existsSync(path.join(root, 'live-smoke')));
  assert.ok(!fs.existsSync(path.join(root, 'live-board')));
  assert.ok(fs.existsSync(keptLog), 'gate-results stay');
  assert.ok(fs.existsSync(keptReport), 'reports and logs stay');
  assert.deepEqual(killed, [path.join(root, 'live-board/tmx', `tmux-${process.getuid?.() ?? 0}`, 'default')], 'the leftover sandbox tmux server was stopped before removal');
  assert.deepEqual(summary.stoppedServers, killed);
  assert.ok(summary.removed.sort().join(' ') === 'gate-work-101 gate-work-202 live-board live-smoke');
  assert.ok(summary.kept.includes('gate-results') && summary.kept.includes('review2'));
  assert.ok(summary.before > summary.after, 'before/after sizes are reported');
  assert.equal(summary.after, dirSize(root));
});

it('refuses a symlink that escapes the cache root and deletes nothing (P54)', () => {
  const root = scratch.sub('escape');
  const outside = scratch.sub('escape-outside');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'precious');
  fs.mkdirSync(path.join(root, 'gate-results'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'live-evil'));
  assert.throws(() => cleanLiveCache(root, { killServer: () => assert.fail('no server may be stopped') }), (e: Error) => e instanceof CleanRefusal && /symlink/.test(e.message) && /escapes|outside/.test(e.message));
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'precious');
  assert.ok(fs.existsSync(path.join(root, 'live-evil')), 'the escaping symlink itself is left alone');
});

it('refuses a dangling symlink whose target would be outside; one pointing inside is unlinked, not followed', () => {
  const root = scratch.sub('dangling');
  fs.mkdirSync(path.join(root, 'inside-target'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inside-target', 'f'), 'x');
  fs.symlinkSync(path.join(root, 'inside-target'), path.join(root, 'live-in'));
  fs.symlinkSync(path.join(scratch.dir, 'gone-outside'), path.join(root, 'gate-work-303'));
  assert.throws(() => cleanLiveCache(root), CleanRefusal);
  fs.rmSync(path.join(root, 'gate-work-303'));
  const summary = cleanLiveCache(root);
  assert.deepEqual(summary.removed, ['live-in']);
  assert.ok(fs.existsSync(path.join(root, 'inside-target', 'f')), 'an internal symlink is unlinked, never followed');
});

it('refuses a missing or relative cache root and leaves a clean cache untouched', () => {
  assert.throws(() => cleanLiveCache(path.join(scratch.dir, 'absent')), CleanRefusal);
  const root = scratch.sub('untouched');
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  const summary = cleanLiveCache(root);
  assert.deepEqual(summary.removed, []);
  assert.ok(summary.before === summary.after);
});

it('npm run gate -- clean wires the CLI to the cache root and prints before/after', () => {
  const { root } = fakeCache('cli');
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/gate.ts', 'clean'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8' });
  const ok = run({ AGENTCTL_LIVE_CACHE: root });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /before .+ after /);
  assert.ok(!fs.existsSync(path.join(root, 'gate-work-101')));
  assert.ok(fs.existsSync(path.join(root, 'gate-results', 'abc123', 'quick.json')));
  const refused = run({ AGENTCTL_LIVE_CACHE: '' });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /AGENTCTL_LIVE_CACHE/);
});
