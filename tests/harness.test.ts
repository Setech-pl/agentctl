import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkHarnessSafety, commandV, Harness, HarnessRefusal, maskSystemBins } from '../scripts/live-harness.ts';
import { liveCacheRoot, historicalCacheRoots } from '../scripts/live-cache.ts';
import type { SafetyInput } from '../scripts/live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { automaticProviderHold, providerHolds, readProviderHoldState, setProviderHolds } from '../src/core/provider-hold.ts';
import { readReservations, reservePlaces } from '../src/core/limits.ts';
import { DiskRunner, REPO_ROOT, useScratch } from './helpers.ts';

const scratch = useScratch();
let liveCache: string | undefined;
beforeEach(() => { liveCache = process.env.AGENTCTL_LIVE_CACHE; process.env.AGENTCTL_LIVE_CACHE = scratch.dir; });
afterEach(() => {
  if (liveCache === undefined) delete process.env.AGENTCTL_LIVE_CACHE;
  else process.env.AGENTCTL_LIVE_CACHE = liveCache;
});

it('REL0244-CASE-ISOLATION: a successor sees no provider state from the prior case', async t => {
  const providers = ['claude', 'codex', 'kimi', 'glm'] as const;
  const baseline = 'providers: [claude, codex, kimi, glm]\n';
  const mutated = `${baseline}limits: {claude: 31, codex: 32, kimi: 33, glm: 34}\nusage: {queue_hold: {claude: 81, codex: 82, kimi: 83, glm: 84}}\n`;
  // Exercise real case allocation with a filesystem-only start and the product's hold and reservation stores.
  t.mock.method(Harness.prototype, 'start', function (this: Harness) {
    fs.mkdirSync(this.agentctlHome, { recursive: true });
    fs.writeFileSync(path.join(this.agentctlHome, 'config.yaml'), baseline, { flag: 'wx' });
    return this;
  });
  const suite = new Harness({ name: 'provider-state' }, REPO_ROOT);
  const runner = new DiskRunner({ dryRun: false });
  const reset = new Date(runner.now() + 3600_000).toISOString();
  const prior = await suite.runCase('first', async h => {
    const first = loadGlobalConfig(h.agentctlHome);
    fs.writeFileSync(first.path, mutated);
    const dirty = loadGlobalConfig(h.agentctlHome), ctx = new Context(runner, dirty, () => {});
    await reservePlaces(ctx, Object.fromEntries(providers.map(agent => [agent, 1])));
    await setProviderHolds(ctx, Object.fromEntries(providers.map(agent => [agent, reset])));
    for (const [i, agent] of providers.entries()) {
      assert.equal(providerHolds(dirty, runner.now())[agent]?.source, 'manual', agent);
      assert.equal(dirty.limits[agent], 31 + i);
      assert.equal(dirty.usage.queueHold[agent], 81 + i);
      assert.equal(readReservations(dirty)[agent]?.count, 1);
      await runner.writeFile(path.join(h.agentctlHome, 'usage', `${agent}-plan.json`), '{}');
    }
    return { home: h.agentctlHome, defaults: first.limits, dirty };
  });
  const checkClean = (h: Harness, previousHome: string) => {
    assert.notEqual(h.agentctlHome, previousHome);
    assert.equal(h.env.AGENTCTL_HOME, h.agentctlHome);
    const next = loadGlobalConfig(h.agentctlHome);
    assert.deepEqual(next.limits, prior.defaults);
    assert.deepEqual(next.usage.queueHold, {});
    assert.deepEqual(readReservations(next), {});
    assert.deepEqual(readProviderHoldState(next), { holds: {}, seen: {} });
    for (const agent of providers) {
      assert.equal(providerHolds(next, runner.now())[agent], undefined, agent);
      assert.ok(!fs.existsSync(path.join(h.agentctlHome, 'usage', `${agent}-plan.json`)), agent);
    }
    return next;
  };
  const automatic = await suite.runCase('second', async h => {
    const next = checkClean(h, prior.home), ctx = new Context(runner, next, () => {});
    for (const agent of providers) {
      assert.equal(providerHolds(prior.dirty, runner.now())[agent]?.source, 'manual', agent);
      await automaticProviderHold(ctx, agent, `SECOND-${agent}:quota`, 'fixture quota');
      assert.equal(providerHolds(next, runner.now())[agent]?.source, 'automatic', agent);
    }
    return { home: h.agentctlHome, config: next };
  });
  await suite.runCase('third', h => {
    checkClean(h, automatic.home);
    for (const agent of providers) assert.equal(providerHolds(automatic.config, runner.now())[agent]?.source, 'automatic', agent);
  });
});

it('CONSULT-f1: compacts the digest to fit a task-owned socket at the 100-byte boundary', () => {
  const suffix = Buffer.byteLength(`/live-123456789/tmx/tmux-${process.getuid?.() ?? 0}/default`);
  // A virtual, nonexistent root: constructor/path assertions only; no filesystem writes or tmux.
  const cacheRoot = '/' + 'x'.repeat(100 - suffix);
  process.env.AGENTCTL_LIVE_CACHE = cacheRoot;
  const h = new Harness({ name: 'long-consultation-harness-name', cacheRoot }, REPO_ROOT);
  assert.equal(path.dirname(h.root), cacheRoot);
  assert.equal(Buffer.byteLength(path.join(h.tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')), 100);
});

it('FIELD0230-SOCKET: a 66-byte task cache keeps isolated tmux within the socket limit', () => {
  const root = '/' + 'x'.repeat(65);
  process.env.AGENTCTL_LIVE_CACHE = root;
  const h = new Harness({name: 'p19-stdio', cacheRoot: root}, REPO_ROOT);
  assert.equal(path.dirname(h.root), root);
  assert.ok(Buffer.byteLength(path.join(h.tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')) <= 100);
});

it('NOTIFY0251-SOCKET: a 67-byte task cache keeps isolated tmux within the socket limit', () => {
  // 67 bytes for a 3-digit uid (501, the field case); one byte shorter per extra uid digit, so the boundary is the same on every host.
  const root = '/' + 'x'.repeat(100 - Buffer.byteLength(`/live-123456/tmx/tmux-${process.getuid?.() ?? 0}/default`) - 1);
  process.env.AGENTCTL_LIVE_CACHE = root;
  const h = new Harness({name: 'p19-stdio', cacheRoot: root}, REPO_ROOT);
  const other = new Harness({name: 'p19-setup', cacheRoot: root}, REPO_ROOT);
  assert.equal(path.dirname(h.root), root);
  assert.notEqual(h.root, other.root);
  assert.ok(Buffer.byteLength(path.join(h.tmuxDir, `tmux-${process.getuid?.() ?? 0}/default`)) <= 100);
});

it('shortens long sandbox names inside the requested root and refuses an oversized root before reset', () => {
  const cacheRoot = '/Users/marcinkrzetowski/Projects/cache-dev/agentctl-0181/e2/x';
  process.env.AGENTCTL_LIVE_CACHE = cacheRoot;
  const name = 'fix-claude-swallow-first';
  const h = new Harness({ name, cacheRoot }, REPO_ROOT);
  assert.equal(path.dirname(h.root), cacheRoot);
  assert.equal(h.root, new Harness({ name, cacheRoot }, REPO_ROOT).root);
  assert.notEqual(h.root, new Harness({ name: `${name}-other`, cacheRoot }, REPO_ROOT).root);
  assert.ok(Buffer.byteLength(path.join(h.tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')) <= 100);
  assert.throws(() => new Harness({ name: '../escape', cacheRoot }, REPO_ROOT), /invalid sandbox name/);
  const oversized = scratch.sub('oversized-' + 'x'.repeat(100));
  process.env.AGENTCTL_LIVE_CACHE = oversized;
  const refused = new Harness({ name, cacheRoot: oversized }, REPO_ROOT);
  fs.mkdirSync(refused.root);
  const sentinel = path.join(refused.root, 'sentinel'); fs.writeFileSync(sentinel, 'keep');
  assert.throws(() => refused.start(), /socket path is too long/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

it('keeps package smoke sockets inside the required dataset root within the limit', () => {
  const root = '/Users/marcinkrzetowski/Projects/cache-dev/agentctl-0181/dataset';
  process.env.AGENTCTL_LIVE_CACHE = root;
  const h = new Harness({ name: 'smoke-node22', cacheRoot: root }, REPO_ROOT);
  assert.equal(path.dirname(h.root), root);
  assert.ok(Buffer.byteLength(path.join(h.tmuxDir, `tmux-${process.getuid?.() ?? 0}`, 'default')) <= 100);
});

/** A sandbox on disk with fakes in fakeBin and a resolver that finds only what the test says. */
function input(name: string, over: Partial<SafetyInput> & { found?: Record<string, string> } = {}): SafetyInput {
  const root = scratch.sub(name);
  const fakeBin = path.join(root, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const found: Record<string, string> = over.found ?? Object.fromEntries(['claude', 'codex', 'pbcopy', 'pbpaste', 'terminal-notifier', 'osascript'].map((n) => [n, path.join(fakeBin, n)]));
  // A system directory of the sandbox: the host's /usr/bin may hold a real agent (Linux), which these unit checks do not depend on.
  const sysBin = path.join(root, 'sysbin');
  fs.mkdirSync(sysBin, { recursive: true });
  return {
    root, fakeBin, pathEnv: `${fakeBin}:${sysBin}`, resolve: (n) => found[n],
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
    if (h.sysBin) maskSystemBins(h.sysBin);
    h.check();
    assert.equal(h.env.PATH?.startsWith(h.fakeBin), true);
    assert.equal(h.env.TMUX, undefined);
    assert.ok(!h.env.PATH?.includes('/opt/homebrew'), 'the real agents live there');
  });
});

it('HARNESS-SYSBIN: a system directory with real agents is replaced by a masked copy that keeps the other tools', () => {
  const usr = scratch.sub('sys-usr-bin'), bin = scratch.sub('sys-bin');
  for (const name of ['claude', 'codex', 'kimi', 'ls', 'bash']) fs.writeFileSync(path.join(usr, name), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(usr, 'claude'), path.join(usr, 'claude-code'));
  fs.writeFileSync(path.join(bin, 'sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ls'), '#!/bin/sh\n', { mode: 0o755 });
  const base = input('sysbin');
  const sysBin = path.join(base.root, 'masked');
  maskSystemBins(sysBin, [usr, bin]);
  assert.deepEqual(fs.readdirSync(sysBin).sort(), ['bash', 'ls', 'sh']);
  assert.equal(fs.readlinkSync(path.join(sysBin, 'ls')), path.join(usr, 'ls'), 'the first directory wins, as on PATH');
  checkHarnessSafety({ ...base, pathEnv: `${base.fakeBin}:${sysBin}` });
  assert.equal(commandV("claude", sysBin), undefined);
  assert.throws(() => checkHarnessSafety({ ...base, pathEnv: `${base.fakeBin}:${usr}` }), /has a real "claude"/);
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


describe('live cache root fails closed before filesystem changes', () => {
  it('refuses unset, empty, relative and historical roots without creating anything', (t) => {
    const writes: string[] = [];
    for (const method of ['mkdirSync', 'rmSync', 'writeFileSync'] as const) {
      t.mock.method(fs, method, () => { writes.push(method); throw new Error(`unexpected filesystem mutation: ${method}`); });
    }
    const before = fs.readdirSync(scratch.dir);
    for (const root of [undefined, '', 'relative/task', ...historicalCacheRoots(), ...historicalCacheRoots().map(p => path.join(p, 'nested'))]) {
      if (root === undefined) delete process.env.AGENTCTL_LIVE_CACHE;
      else process.env.AGENTCTL_LIVE_CACHE = root;
      assert.throws(() => liveCacheRoot(), /AGENTCTL_LIVE_CACHE.*Example:/);
      assert.throws(() => new Harness({ name: 'refused', cacheRoot: scratch.dir }, REPO_ROOT), HarnessRefusal);
      assert.deepEqual(fs.readdirSync(scratch.dir), before);
      assert.deepEqual(writes, [], 'refusal must not attempt any filesystem mutation');
    }
  });

  it('accepts an explicit absolute root without creating it and confines cacheRoot', () => {
    const root = path.join(scratch.dir, 'absent');
    process.env.AGENTCTL_LIVE_CACHE = root;
    assert.equal(liveCacheRoot(), root);
    const h = new Harness({ name: 'valid' }, REPO_ROOT);
    assert.equal(path.dirname(h.root), root);
    assert.equal(fs.existsSync(root), false);
    assert.throws(() => new Harness({ name: 'escape', cacheRoot: scratch.dir }, REPO_ROOT), /inside/);
    assert.throws(() => liveCacheRoot('relative'), /absolute/);
    assert.equal(fs.existsSync(root), false);
  });

  it('resolves dangling symlinks before checking containment without creating their target', () => {
    const root = scratch.sub('dangling-confined');
    const target = path.join(scratch.dir, 'missing-outside');
    const alias = path.join(root, 'alias');
    fs.symlinkSync(target, alias);
    process.env.AGENTCTL_LIVE_CACHE = root;
    assert.throws(() => liveCacheRoot(alias), /inside/);
    assert.equal(fs.existsSync(target), false);
  });

  it('rejects historical aliases and parents and symlink escapes before reset', () => {
    for (const historical of historicalCacheRoots()) {
      const alias = path.join(scratch.dir, 'historical-alias');
      fs.symlinkSync(historical, alias);
      process.env.AGENTCTL_LIVE_CACHE = alias;
      assert.throws(() => liveCacheRoot(), /historical shared sandbox/);
      fs.unlinkSync(alias);
      process.env.AGENTCTL_LIVE_CACHE = path.dirname(historical);
      assert.throws(() => liveCacheRoot(), /historical shared sandbox/);
    }
    process.env.AGENTCTL_LIVE_CACHE = scratch.sub('confined');
    const h = new Harness({ name: 'escape' }, REPO_ROOT);
    const outside = scratch.sub('outside');
    const sentinel = path.join(outside, 'sentinel'); fs.writeFileSync(sentinel, 'keep');
    fs.symlinkSync(outside, h.root);
    assert.throws(() => h.start(), /inside/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  });
});
