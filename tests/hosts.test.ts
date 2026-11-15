import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadGlobalConfig } from '../src/core/config.ts';
import { classifySshFailure, runOnHost, sshArgs, sshSocketPath } from '../src/core/host-ssh.ts';
import { healthScript, hostsViewLines, parseHealthOutput, probeHost, probeHosts, renderHostsHealth } from '../src/core/host-health.ts';
import { firstConnectCommand, readHostsCache, summarizeHosts, writeHostsCache } from '../src/core/hosts.ts';
import type { HostConfig, HostHealth } from '../src/core/hosts.ts';
import { newTasks } from '../src/core/new.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import { AgentctlError } from '../src/core/util.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { applySnapshot, handleKey, initialBoardState, loadViewLines } from '../src/core/board.ts';
import { Context } from '../src/core/context.ts';
import { DiskRunner, makeConfig, makeContext, useScratch } from './helpers.ts';
import type { GlobalConfig } from '../src/core/config.ts';

const scratch = useScratch();

const HOST_YAML = `hosts:
  gpu-pc:
    ssh: krzet@192.168.2.64
    port: 2222
    work_dir: ~/work
    repos: {app: ~/src/app}
    providers: [claude]
    limits: {claude: 1}
    env: {CUDA_VISIBLE_DEVICES: "0"}
`;

function hostConfig(extraYaml = HOST_YAML, name = 'gpu-pc'): { config: GlobalConfig; host: HostConfig } {
  const config = makeConfig(scratch.sub(`cfg-${Math.random().toString(36).slice(2)}`), extraYaml);
  return { config, host: config.hosts[name]! };
}

/** A fake ssh: the target is the arg carrying user@host; the script (when present) is the last arg. */
function fakeSsh(answers: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
  return (cmd: string, args: string[], _opts: unknown) => {
    if (cmd !== 'ssh') return undefined;
    const target = args.find((a) => /^[^-].*@/.test(a));
    const answer = target ? answers[target] : undefined;
    if (!answer) return { code: 255, stderr: `fake-ssh: no answer for ${target}` };
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
  };
}

const HEALTHY = `==df==
976562500 451171875
==gpu==
NVIDIA GeForce RTX 5080, 16384 MiB, 2048 MiB
==tmux==
tmux 3.4a
==cli== claude claude
/usr/local/bin/claude
1.0.55 (Claude Code)
==auth== claude
in
==repo== app
a1b2c3d4e5f6a7b8
git@github.com:me/app.git
`;

describe('hosts config', () => {
  it('parses a full host entry with defaults and expansions', () => {
    const { config, host } = hostConfig(`hosts:
  gpu-pc:
    ssh: krzet@host
    identity_file: ~/keys/wsl
    work_dir: /work
    repos: {app: /src/app}
    providers: [claude, codex]
`);
    assert.equal(host.ssh, 'krzet@host');
    assert.equal(host.port, 22);
    assert.equal(host.identityFile, path.join(os.homedir(), 'keys/wsl'));
    assert.deepEqual(host.repos, { app: '/src/app' });
    assert.deepEqual(host.providers, ['claude', 'codex']);
    assert.equal(config.hosts['gpu-pc']?.limits, undefined);
  });

  it('rejects bad entries, all problems at once', () => {
    const root = scratch.sub('bad-cfg');
    fs.writeFileSync(path.join(root, 'config.yaml'), `hosts:
  "Bad Name":
    ssh: no-at-sign
    port: 70000
    work_dir: ""
    repos: {app: 1}
    providers: [claude, claude, vander]
    limits: {claude: 0}
    env:
      ok: {a: 1}
    typo_key: true
  other: {ssh: u@h, work_dir: /w, repos: {a: /a}, providers: []}
`);
    let error: unknown;
    try { loadGlobalConfig(root); } catch (e) { error = e; }
    assert.ok(error instanceof Error, 'expected loadGlobalConfig to throw');
    const text = error instanceof Error ? error.message : String(error);
    for (const expected of ['"Bad Name" is not a valid host name', 'config.hosts.Bad Name.ssh must be exactly "user@host"', 'port must be an integer from 1 to 65535', 'work_dir must be a non-empty path', 'repos must map repository names', 'unknown provider', 'listed twice', 'limits.claude must be a positive integer', 'env.ok', 'unknown key "typo_key"', 'providers must list at least one provider']) {
      assert.ok(text.includes(expected), `missing: ${expected}\n${text}`);
    }
  });

  it('rejects hosts: that is not a mapping', () => {
    const root = scratch.sub('bad-hosts-shape');
    fs.writeFileSync(path.join(root, 'config.yaml'), 'hosts: [gpu-pc]\n');
    assert.throws(() => loadGlobalConfig(root), /config\.hosts must be a mapping/);
  });

  it('config has no hosts by default', () => {
    const config = makeConfig(scratch.sub('no-hosts'));
    assert.deepEqual(config.hosts, {});
  });
});

describe('ssh transport', () => {
  it('builds one multiplexed connection per host with a fixed security posture', () => {
    const { host } = hostConfig();
    const args = sshArgs('gpu-pc', host, 'echo hi', { AGENTCTL_HOME: '/tmp/agentctl-test' });
    assert.ok(args.includes('ControlMaster=auto'));
    assert.ok(args.includes('ControlPersist=120'));
    assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('ConnectTimeout=8'));
    assert.deepEqual(args.slice(0, 2), ['-p', '2222']);
    assert.equal(args[args.length - 2], 'krzet@192.168.2.64');
    assert.equal(args[args.length - 1], 'echo hi');
    assert.ok(args[args.indexOf('-S') + 1].startsWith(path.join('/tmp/agentctl-test', 'ssh', 'gpu-pc')));
    assert.equal(sshSocketPath('gpu-pc', { AGENTCTL_HOME: '/x' }), path.join('/x', 'ssh', 'gpu-pc.sock'));
  });

  it('classifies the failure states, changed key before the generic host-key line', () => {
    assert.equal(classifySshFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', false), 'host-key-changed');
    assert.equal(classifySshFailure('Host key verification failed.', false), 'host-key-unknown');
    assert.equal(classifySshFailure('krzet@host: Permission denied (publickey).', false), 'auth-failed');
    assert.equal(classifySshFailure('krzet@host: Too many authentication failures', false), 'auth-failed');
    assert.equal(classifySshFailure('ssh: connect to host 192.168.2.64 port 2222: Operation timed out', false), 'unreachable');
    assert.equal(classifySshFailure('ssh: connect to host x port 22: Connection refused', false), 'unreachable');
    assert.equal(classifySshFailure('ssh: Could not resolve hostname box: nodename nor servname provided', false), 'unreachable');
    assert.equal(classifySshFailure('ETIMEDOUT after 20000ms', true), 'unreachable');
  });

  it('runOnHost returns the remote exit code when reachable and the state otherwise', async () => {
    const { host } = hostConfig();
    const runner = new RecordingRunner({ respond: fakeSsh({ 'krzet@192.168.2.64': { code: 0, stdout: 'ok' } }) });
    const ok = await runOnHost(runner, 'gpu-pc', host, 'true');
    assert.equal(ok.state, 'reachable');
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'ok');
    const denied = new RecordingRunner({ respond: fakeSsh({ 'krzet@192.168.2.64': { code: 255, stderr: 'Permission denied (publickey).' } }) });
    const fail = await runOnHost(denied, 'gpu-pc', host, 'true');
    assert.equal(fail.state, 'auth-failed');
    assert.equal(fail.code, 255);
  });

  it('firstConnectCommand is the exact one-off command doctor prints', () => {
    const { host } = hostConfig();
    assert.equal(firstConnectCommand(host), 'ssh -p 2222 krzet@192.168.2.64');
    const withKey = hostConfig(`hosts: {gpu: {ssh: u@h, identity_file: "/k 2", work_dir: /w, repos: {a: /a}, providers: [claude]}}`, 'gpu');
    assert.equal(firstConnectCommand(withKey.host), `ssh -i '/k 2' u@h`);
  });
});

describe('host health probe', () => {
  it('collects and parses everything in one ssh call', async () => {
    const { config, host } = hostConfig();
    const runner = new RecordingRunner({ respond: fakeSsh({ 'krzet@192.168.2.64': { stdout: HEALTHY } }) });
    const health = await probeHost(runner, 'gpu-pc', host, config);
    assert.equal(health.state, 'reachable');
    assert.deepEqual(health.disk, { workDir: '~/work', freeKb: 451171875, totalKb: 976562500 });
    assert.deepEqual(health.gpu, { name: 'NVIDIA GeForce RTX 5080', totalMiB: 16384, usedMiB: 2048 });
    assert.deepEqual(health.tmux, { present: true, version: '3.4a' });
    assert.deepEqual(health.clis, [{ id: 'claude', command: 'claude', present: true, version: '1.0.55 (Claude Code)', loggedIn: 'in' }]);
    assert.deepEqual(health.repos, [{ name: 'app', path: '~/src/app', present: true, head: 'a1b2c3d4e5f6a7b8', remoteUrl: 'git@github.com:me/app.git' }]);
    // Exactly one ssh invocation carried the whole probe.
    assert.equal(runner.calls.filter((c) => c.line.startsWith('ssh ')).length, 1);
  });

  it('absent GPU, missing CLI and logged-out are data, not errors', async () => {
    const { config, host } = hostConfig(`hosts:
  gpu-pc:
    ssh: krzet@box
    work_dir: /work
    repos: {}
    providers: [claude, codex]
`);
    const stdout = `==df==
100 50
==gpu==
none
==tmux==
none
==cli== claude claude
none

==auth== claude
out
==cli== codex codex
/usr/bin/codex
codex-cli 0.42.0
==auth== codex
unknown
`;
    const runner = new RecordingRunner({ respond: fakeSsh({ 'krzet@box': { stdout } }) });
    const health = await probeHost(runner, 'gpu-pc', host, config);
    assert.equal(health.state, 'reachable');
    assert.equal(health.gpu, null);
    assert.deepEqual(health.tmux, { present: false });
    assert.deepEqual(health.clis, [
      { id: 'claude', command: 'claude', present: false, loggedIn: 'out' },
      { id: 'codex', command: 'codex', present: true, version: 'codex-cli 0.42.0', loggedIn: 'unknown' },
    ]);
  });

  it('classifies ssh failures as probe states with the diagnostic', async () => {
    const { config, host } = hostConfig();
    const cases: [string, string, string][] = [
      ['krzet@192.168.2.64', 'Host key verification failed.', 'host-key-unknown'],
      ['krzet@192.168.2.64', 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!', 'host-key-changed'],
      ['krzet@192.168.2.64', 'Permission denied (publickey).', 'auth-failed'],
      ['krzet@192.168.2.64', 'ssh: connect to host 192.168.2.64 port 2222: Operation timed out', 'unreachable'],
    ];
    for (const [target, stderr, state] of cases) {
      const runner = new RecordingRunner({ respond: fakeSsh({ [target]: { code: 255, stderr } }) });
      const health = await probeHost(runner, 'gpu-pc', host, config);
      assert.equal(health.state, state);
      assert.ok(health.detail?.includes(stderr.split('\n')[0]!.slice(0, 20)), `${state}: ${health.detail}`);
      assert.equal(health.gpu, undefined);
    }
  });

  it('probes hosts in parallel, each with its own answer', async () => {
    const config = makeConfig(scratch.sub('two-hosts'), `hosts:
  a: {ssh: u@a, work_dir: /w, repos: {}, providers: [claude]}
  b: {ssh: u@b, work_dir: /w, repos: {}, providers: [claude]}
`);
    const runner = new RecordingRunner({ respond: fakeSsh({ 'u@a': { stdout: HEALTHY }, 'u@b': { code: 255, stderr: 'Connection refused' } }) });
    const health = await probeHosts(runner, config.hosts, config);
    assert.deepEqual(health.map((h) => h.name).sort(), ['a', 'b']);
    assert.equal(health.find((h) => h.name === 'a')?.state, 'reachable');
    assert.equal(health.find((h) => h.name === 'b')?.state, 'unreachable');
  });

  it('renders CLI lines and the board view lines', () => {
    const parsed = parseHealthOutput('gpu-pc', HEALTHY, 23, '2026-11-15T12:00:00Z', ['~/src/app']);
    const health: HostHealth = { ...parsed, state: 'reachable', disk: { ...parsed.disk!, workDir: '~/work' } };
    const lines = renderHostsHealth([health]);
    assert.ok(lines[0]!.startsWith('gpu-pc  reachable'));
    assert.ok(lines.some((l) => l.includes('NVIDIA GeForce RTX 5080 2048/16384 MiB')));
    assert.ok(lines.some((l) => l.includes('claude 1.0.55 (Claude Code) (logged in)')));
    assert.ok(lines.some((l) => l.includes('HEAD a1b2c3d4e5f6a7b8')));
    const view = hostsViewLines([health], '2026-11-15T12:00:00Z');
    assert.ok(view[0]!.startsWith('Cached'));
    assert.ok(view.some((l) => l.includes('free 430G/931G')));
    assert.deepEqual(hostsViewLines(undefined, undefined), ['No hosts configured: see the README "Hosts" section.']);
  });

  it('healthScript tags one section per provider and repo', () => {
    const { config, host } = hostConfig(`hosts:
  gpu-pc:
    ssh: krzet@box
    work_dir: /work
    repos: {app: '/src/my app', lib: /src/lib}
    providers: [claude, codex]
`);
    const script = healthScript(host, config);
    assert.equal((script.match(/==cli==/g) ?? []).length, 2);
    assert.equal((script.match(/==repo==/g) ?? []).length, 2);
    assert.ok(script.includes(`git -C '/src/my app' rev-parse`));
    assert.ok(script.includes(`[ -f "$HOME/.claude/.credentials.json" ]`));
    assert.ok(script.includes(`[ -f "$HOME/.codex/auth.json" ]`));
  });
});

describe('hosts health cache', () => {
  it('round-trips through the config directory and honors freshness', async () => {
    const env = { AGENTCTL_HOME: scratch.sub('cache-home') };
    const runner = new DiskRunner();
    const health: HostHealth[] = [{ name: 'gpu-pc', state: 'reachable', probedAt: '2026-11-15T12:00:00Z' }];
    const before = Date.now();
    await writeHostsCache(runner, health, env);
    assert.deepEqual(readHostsCache(env, before + 30_000, 60_000)?.hosts, health);
    assert.equal(readHostsCache(env, before + 300_000, 60_000), undefined);
    assert.equal(readHostsCache({ AGENTCTL_HOME: scratch.sub('empty') }), undefined);
  });

  it('summarizes hosts for the board header', () => {
    const cache = { writtenAt: '2026-11-15T12:00:00Z', hosts: [{ name: 'gpu-pc', state: 'reachable' as const, probedAt: '2026-11-15T12:00:00Z', gpu: { name: 'RTX 5080', totalMiB: 16384, usedMiB: 2048 }, disk: { workDir: '/w', freeKb: 2 * 1024 * 1024, totalKb: 4 * 1024 * 1024 } }] };
    assert.deepEqual(summarizeHosts(cache, ['gpu-pc', 'mini']), [
      { name: 'gpu-pc', state: 'reachable', gpu: 'RTX 5080', diskFreeGb: 2 },
      { name: 'mini', state: 'unreachable' },
    ]);
    assert.deepEqual(summarizeHosts(undefined, []), []);
  });
});

describe('spec host: key', () => {
  const SPEC = `---
task: NC-1
agent: claude
host: gpu-pc
repos: [{path: app}]
---
Do the thing.
`;

  it('is accepted and stored when the host exists and has the provider', () => {
    const { config } = hostConfig();
    const [raw] = splitSpecs(SPEC);
    const spec = resolveSpec(raw!, { config, loadProject: () => undefined });
    assert.equal(spec.host, 'gpu-pc');
  });

  it('an unknown host is a validation error', () => {
    const { config } = hostConfig();
    const [raw] = splitSpecs(SPEC.replace('host: gpu-pc', 'host: no-such-box'));
    assert.throws(() => resolveSpec(raw!, { config, loadProject: () => undefined }), /unknown host "no-such-box"/);
  });

  it('a provider the host does not have is a validation error', () => {
    const { config } = hostConfig();
    const [raw] = splitSpecs(SPEC.replace('agent: claude', 'agent: codex'));
    assert.throws(() => resolveSpec(raw!, { config, loadProject: () => undefined }), /host "gpu-pc" has no codex CLI/);
  });

  it('a dry run plans remote worktrees and uses SSH instead of the part-A refusal', async () => {
    const { config } = hostConfig();
    const spec = resolveSpec(splitSpecs(SPEC)[0]!, { config });
    const { ctx, runner } = makeContext(config, { dryRun: true });
    const result = await newTasks(ctx, [spec]);
    assert.equal(result[0]?.agentStarted, true);
    assert.ok(runner.commands.some(c => c.includes('ssh') && c.includes('worktree')));
  });
});

describe('board hosts', () => {
  it('H opens the hosts view and the effect loads cached lines without network', async () => {
    const config = makeConfig(scratch.sub('board-hosts'), `hosts: {gpu-pc: {ssh: u@h, work_dir: /w, repos: {}, providers: [claude]}}\n`);
    await writeHostsCache(new DiskRunner(), [{ name: 'gpu-pc', state: 'reachable', gpu: { name: 'RTX 5080', totalMiB: 16384, usedMiB: 0 }, disk: { workDir: '/w', freeKb: 1024, totalKb: 2048 }, probedAt: '2026-11-15T12:00:00Z' }]);
    const state = initialBoardState(120, 40);
    const result = handleKey(state, 'H', {});
    assert.equal(result.state.mode.kind, 'view');
    assert.deepEqual(result.effects, [{ type: 'view', what: 'hosts' }]);
    const lines = await loadViewLines(new Context(new RecordingRunner(), config, () => {}), 'hosts');
    assert.ok(lines.some((l) => l.includes('gpu-pc')));
    assert.ok(lines.some((l) => l.includes('RTX 5080')));
  });

  it('applySnapshot carries host summaries into the state', () => {
    const state = initialBoardState(120, 40);
    const snap = { rows: [], preview: null, refreshedAt: '12:00:00', hosts: [{ name: 'gpu-pc', state: 'reachable' as const, gpu: 'RTX 5080', diskFreeGb: 412 }] };
    const next = applySnapshot(state, snap);
    assert.deepEqual(next.hosts, snap.hosts);
    // A snapshot without hosts (older producer) keeps what the state had.
    const kept = applySnapshot(next, { rows: [], preview: null, refreshedAt: '12:00:01' });
    assert.deepEqual(kept.hosts, snap.hosts);
  });
});
