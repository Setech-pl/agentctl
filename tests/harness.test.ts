import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkHarnessSafety, commandV, Harness, HarnessRefusal } from '../scripts/live-harness.ts';
import type { SafetyInput } from '../scripts/live-harness.ts';
import { REPO_ROOT, useScratch } from './helpers.ts';

const scratch = useScratch();

/** A sandbox on disk with fakes in fakeBin and a resolver that finds only what the test says. */
function input(name: string, over: Partial<SafetyInput> & { found?: Record<string, string> } = {}): SafetyInput {
  const root = scratch.sub(name);
  const fakeBin = path.join(root, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const found: Record<string, string> = over.found ?? Object.fromEntries(['claude', 'codex', 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript'].map((n) => [n, path.join(fakeBin, n)]));
  return {
    root, fakeBin, pathEnv: `${fakeBin}:/usr/bin:/bin`, resolve: (n) => found[n],
    agentctlHome: path.join(root, 'ah'), codexHome: path.join(root, 'ch'), ...over,
  };
}

describe('live harness: refusals', () => {
  it('a sandbox of fakes passes', () => {
    checkHarnessSafety(input('ok', { socketPath: undefined }));
  });

  it('refuses when claude or codex resolve to a real binary', () => {
    for (const name of ['claude', 'codex']) {
      const base = input(`real-${name}`);
      const found = { claude: path.join(base.fakeBin, 'claude'), codex: path.join(base.fakeBin, 'codex'), [name]: `/opt/homebrew/bin/${name}` };
      assert.throws(() => checkHarnessSafety({ ...base, resolve: (n) => found[n] }), (e: Error) => e instanceof HarnessRefusal && e.message.includes(`"${name}" resolves to /opt/homebrew/bin/${name}`));
    }
  });

  it('refuses when the clipboard tools or the notifiers are the real ones', () => {
    for (const name of ['pbcopy', 'pbpaste', 'osascript', 'terminal-notifier']) {
      const base = input(`real-${name}`);
      const found = { claude: path.join(base.fakeBin, 'claude'), codex: path.join(base.fakeBin, 'codex'), [name]: `/usr/bin/${name}` };
      assert.throws(() => checkHarnessSafety({ ...base, resolve: (n) => found[n] }), /resolves to \/usr\/bin\//);
    }
  });

  it('refuses a PATH that holds a directory with a real claude', () => {
    const dir = scratch.sub('realdir');
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n');
    const base = input('path');
    assert.throws(() => checkHarnessSafety({ ...base, pathEnv: `${base.fakeBin}:${dir}` }), /has a real "claude"/);
  });

  it('refuses when a fake agent is missing from the PATH', () => {
    const base = input('missing', { found: {} });
    assert.throws(() => checkHarnessSafety(base), /fake "claude" is not found/);
  });

  it('refuses the default tmux server and any socket outside the sandbox', () => {
    const base = input('socket');
    const def = '/private/tmp/tmux-501/default';
    assert.throws(() => checkHarnessSafety({ ...base, socketPath: def, defaultSocketPath: def }), /socket of the default server/);
    assert.throws(() => checkHarnessSafety({ ...base, socketPath: '/private/tmp/tmux-501/other', defaultSocketPath: def }), /not inside the sandbox/);
    checkHarnessSafety({ ...base, socketPath: path.join(base.root, 'tmx', 'tmux-501', 'default'), defaultSocketPath: def });
  });

  it('refuses the real AGENTCTL_HOME and CODEX_HOME, and homes outside the sandbox', () => {
    const base = input('homes');
    assert.throws(() => checkHarnessSafety({ ...base, agentctlHome: '/Users/someone/.agentctl' }), /AGENTCTL_HOME .* not inside the sandbox/);
    assert.throws(() => checkHarnessSafety({ ...base, codexHome: '/Users/someone/.codex' }), /CODEX_HOME .* not inside the sandbox/);
  });

  it('commandV finds the first executable of a PATH and ignores directories', () => {
    const dir = scratch.sub('cv');
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, 'dirtool'));
    assert.equal(commandV('tool', dir), path.join(dir, 'tool'));
    assert.equal(commandV('dirtool', dir), undefined);
    assert.equal(commandV('nothing', dir), undefined);
  });

  it('a harness built on disk puts fakes first and checks out, without starting tmux', () => {
    const h = new Harness({ name: 'unit', cacheRoot: scratch.sub('hroot') }, REPO_ROOT);
    // start() would also start tmux; the pieces that decide safety are the same without it:
    fs.mkdirSync(h.fakeBin, { recursive: true });
    for (const n of ['claude', 'codex', 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript']) fs.writeFileSync(path.join(h.fakeBin, n), '#!/bin/sh\n', { mode: 0o755 });
    h.check();
    assert.equal(h.env.PATH?.startsWith(h.fakeBin), true);
    assert.equal(h.env.TMUX, undefined);
    assert.ok(!h.env.PATH?.includes('/opt/homebrew'), 'the real agents live there');
  });
});

// Kimi safety is required even before the adapter becomes available.
it('refuses a real kimi resolver and any PATH directory containing a real kimi', () => {
  const base = input('kimi-safety');
  assert.throws(() => checkHarnessSafety({ ...base, resolve: (name, env) => name === 'kimi' ? '/opt/homebrew/bin/kimi' : base.resolve(name, env) }), /"kimi" resolves to \/opt\/homebrew\/bin\/kimi/);
  const directory = scratch.sub('real-kimi-directory');
  fs.writeFileSync(path.join(directory, 'kimi'), '#!/bin/sh\n', { mode: 0o755 });
  assert.throws(() => checkHarnessSafety({ ...base, pathEnv: `${base.fakeBin}:${directory}` }), /has a real "kimi"/);
});
it('refuses KIMI_CODE_HOME outside the live sandbox', () => {
  const base = input('kimi-home-safety');
  assert.throws(() => checkHarnessSafety({ ...base, kimiHome: '/outside/kimi-home' }), /KIMI_CODE_HOME .* not inside the sandbox/);
});
