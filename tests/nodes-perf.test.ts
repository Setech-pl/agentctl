import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Context } from '../src/core/context.ts';
import { hostAvailability, setHostPause } from '../src/core/host-availability.ts';
import { fetchRemoteBranches } from '../src/core/host-branches.ts';
import { readJournal } from '../src/core/journal.ts';
import { mirrorPerfResults, stagePerfArtifacts } from '../src/core/perf-transfer.ts';
import { perfScheduleHold } from '../src/core/perf-queue.ts';
import { checkHostLimit } from '../src/core/host-limits.ts';
import { RealRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import type { StatusRow } from '../src/core/status.ts';
import { recordFromSpec } from '../src/core/taskstore.ts';
import { DiskRunner, makeConfig, useScratch } from './helpers.ts';

const scratch = useScratch();
const configFor = (dir: string) => makeConfig(dir, `hosts:
  pc: {ssh: owner@fake-wsl, port: 2222, work_dir: /wsl/work, repos: {app: /wsl/app}, providers: [claude, codex], max_total: 2, fetch_remote: pc}
perf: {wait_max: 8m, max_artifact_mb: 1}
`);

test('fetch-back creates a Mac branch and keeps both heads when they diverge', async () => {
  const dir = scratch.sub('refs'), config = configFor(dir);
  const runner = new RealRunner();
  const ctx = new Context(runner, config, () => {});
  const mac = path.join(dir, 'mac'), pc = path.join(dir, 'pc');
  fs.mkdirSync(mac);
  const git = async (cwd: string, ...args: string[]) => {
    const r = await runner.exec('git', ['-C', cwd, ...args]);
    assert.equal(r.code, 0, r.stderr);
    return r.stdout.trim();
  };
  await git(mac, 'init', '-b', 'main');
  await git(mac, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  await git(mac, 'clone', '--no-local', '--', mac, pc);
  await git(pc, 'switch', '-c', 'work');
  const commit = (dir: string, message: string) => git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', message);
  await commit(pc, 'worker');
  await git(mac, 'remote', 'add', 'pc', pc);
  const spec = resolveSpec(splitSpecs(`---\ntask: WSL-GIT\nagent: claude\nhost: pc\nrepos: [{path: app, branch: work}]\n---\nWorker changes.`)[0]!, {config});
  spec.repos[0]!.localPath = mac;
  const record = recordFromSpec(spec, config, runner.now());
  assert.equal(await fetchRemoteBranches(ctx, record), true);
  assert.equal(await git(mac, 'rev-parse', 'work'), await git(pc, 'rev-parse', 'work'));
  await git(mac, 'switch', 'work');
  await commit(mac, 'dispatcher change');
  const macSha = await git(mac, 'rev-parse', 'work');
  await git(mac, 'switch', 'main');
  await commit(pc, 'worker follow-up');
  const pcSha = await git(pc, 'rev-parse', 'work');
  assert.equal(await fetchRemoteBranches(ctx, record), true);
  assert.equal(await git(mac, 'rev-parse', 'work'), macSha);
  assert.equal(await git(mac, 'rev-parse', 'refs/remotes/pc/work'), pcSha);
  assert.ok(readJournal(config, 10).some(e => e.kind === 'host-sync' && e.text.includes('konflikt')));
});

test('perf workspace stages and mirrors rsync artifacts without a repository', async () => {
  const dir = scratch.sub('perf'), config = configFor(dir);
  class Transport extends DiskRunner {
    transportCalls: string[][] = [];
    override async exec(cmd: string, argv: string[], _opts: ExecOptions = {}): Promise<ExecResult> {
      this.transportCalls.push([cmd, ...argv]);
      return { code: 0, stdout: '', stderr: '' };
    }
  }
  const runner = new Transport({ dryRun: false });
  const ctx = new Context(runner, config, () => {});
  const build = path.join(dir, 'build');
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, 'dist.js'), '17 bytes of build');
  const spec = resolveSpec(splitSpecs(`---
task: PERF-RUN
agent: codex
host: pc
class: perf
repos: []
at: "03:00"
on_pass: INTEGRATION-*
artifacts: [{path: "${build}", dest: dist}]
results: results
---
Measure Windows.`)[0]!, {config});
  spec.remoteDir = '/wsl/work/.agentctl/perf-run';
  spec.remoteCwd = await stagePerfArtifacts(ctx, spec);
  const record = { ...recordFromSpec(spec, config, runner.now()), remoteCwd: spec.remoteCwd };
  await mirrorPerfResults(ctx, record);
  const transfers = runner.transportCalls.filter(args => args[0] === 'rsync');
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every(args => args.includes('--checksum') && args.includes('--max-size')));
  assert.equal(transfers[0]!.at(-2), `${build}/`);
  assert.equal(transfers[0]!.at(-1), `owner@fake-wsl:${spec.remoteCwd}/dist/`);
  assert.equal(transfers[1]!.at(-2), `owner@fake-wsl:${spec.remoteCwd}/results/`);
  assert.match(transfers[1]!.at(-1)!, /PERF-RUN\.results\/$/);
  assert.ok(runner.transportCalls.some(args => args[0] === 'ssh' && args.at(-1)!.includes('fs.rmSync')));
  fs.writeFileSync(path.join(build, 'large'), Buffer.alloc(1024 ** 2 + 1));
  await assert.rejects(stagePerfArtifacts(ctx, spec), /size exceeds/);
  const activePerf = { host: 'pc', agent: 'codex' as const, perf: true };
  assert.match(checkHostLimit(config, { host: 'pc', agent: 'claude' }, [activePerf]) ?? '', /exclusive perf/);
  assert.equal(checkHostLimit(config, {agent: 'claude'}, [activePerf]), undefined);
  assert.match(checkHostLimit(config, activePerf, [{host: 'pc', agent: 'claude'}]) ?? '', /perf waiting/);
  assert.equal(checkHostLimit(config, {host: 'pc', agent: 'claude'}, [{...activePerf, reportReady: true}]), undefined);
  await setHostPause(ctx, 'pc', true, '3h');
  const queued = new Date(2026, 10, 25, 23).getTime();
  const order = { perf: true, queuedAt: new Date(queued).toISOString(), dailyAt: '03:00', onPass: 'INTEGRATION-*' };
  const morning = new Date(2026, 10, 26, 3).getTime();
  assert.match(perfScheduleHold(order, [], morning - 1) ?? '', /start po/);
  assert.match(perfScheduleHold(order, [], morning) ?? '', /integration PASS/);
  assert.equal(perfScheduleHold(order, [{task: 'INTEGRATION-1', integration: true, verdict: 'PASS'} as StatusRow], morning), undefined);
});

test('owner availability evaluates overnight windows, process names, GPU and pause expiry', async () => {
  const config = makeConfig(scratch.sub('availability'), `hosts:
  local:
    availability: {windows: ["sun 23:00-02:00"]}
  pc:
    ssh: owner@fake-wsl
    work_dir: /work
    repos: {}
    providers: [codex]
    availability: {processes: [ComfyUI.exe], gpu_busy_pct: 70, yield: stop-new}
`);
  let now = new Date(2026, 10, 29, 23, 30).getTime();
  class Clock extends DiskRunner { override now(): number { return now; } }
  const ctx = new Context(new Clock({dryRun: false}), config, () => {});
  assert.equal(hostAvailability(config, 'local', undefined, now), undefined);
  const gpu = {name: 'fake RTX', totalMiB: 16_384, usedMiB: 500, utilizationPct: 25};
  const pc = {name: 'pc', state: 'reachable' as const, probedAt: new Date(now).toISOString(), gpu, processes: []};
  assert.equal(hostAvailability(config, 'pc', pc, now), undefined);
  assert.match(hostAvailability(config, 'pc', {...pc, processes: ['comfyui']}, now) ?? '', /zajęty przez właściciela/);
  assert.match(hostAvailability(config, 'pc', {...pc, gpu: {...gpu, utilizationPct: 71}}, now) ?? '', /GPU 71%/);
  await setHostPause(ctx, 'local', true, '1h');
  assert.match(hostAvailability(config, 'local', undefined, now) ?? '', /zajęty przez właściciela/);
  now += 60 * 60_000;
  assert.equal(hostAvailability(config, 'local', undefined, now), undefined);
  now += 2 * 60 * 60_000;
  assert.match(hostAvailability(config, 'local', undefined, now) ?? '', /poza oknem/);
  assert.match(hostAvailability(config, 'pc', pc, now) ?? '', /brak aktualnej próbki/);
});
