import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { remoteMirrorScript } from '../src/core/host-mirror.ts';
import { HostRuntime } from '../src/core/host-runtime.ts';
import { Context } from '../src/core/context.ts';
import { liveWindows } from '../src/core/plan.ts';
import { collectStatus } from '../src/core/status.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

const scratch = useScratch();
it('HOST-LOCAL-IO: a local-only host router and slot read never scan the task inventory', async () => {
  const config = makeConfig(scratch.sub('local-only'));
  seedTask(config, 'LOCAL');
  const runner = new DiskRunner({ dryRun: false, respond: () => ({ code: 1 }) });
  const ctx = new Context(runner, config, () => {});
  assert.ok(ctx.hosts instanceof HostRuntime);
  const readdir = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = ((dir: fs.PathLike, ...args: unknown[]) => {
    if (String(dir) === config.stateDir) scans++;
    return Reflect.apply(readdir, fs, [dir, ...args]);
  }) as typeof readdir;
  try {
    assert.deepEqual(await ctx.hosts.windows(), []);
    await liveWindows(ctx);
    assert.equal(scans, 0, 'local-only windows/slots must not add host inventory scans');
  } finally { fs.readdirSync = readdir; }
});

it('HOST-LOCAL-IO: removing the host config retains unreachable task state and its provider slot', async () => {
  const config = makeConfig(scratch.sub('removed'), 'hosts: {pc: {ssh: owner@fake, work_dir: /work, repos: {}, providers: [claude]}}\n');
  const runner = new DiskRunner({ dryRun: false, respond: () => ({ code: 1 }) });
  const before = new Context(runner, config, () => {});
  await before.hosts.trackHost('pc');
  seedTask(config, 'REMOTE', { host: 'pc', remoteDir: '/work/.agentctl/remote', remoteReport: '/work/reports/REMOTE.md' });
  const removed = new Context(runner, { ...config, hosts: {} }, () => {});
  const rows = await collectStatus(removed, { progress: false });
  assert.equal(rows[0]?.state, 'host-unreachable');
  assert.ok((await liveWindows(removed)).some(w => w.window === 'remote' && w.agent === 'claude' && w.counted !== false));
});


it('HOST-MIRROR-ENV: mirror command carries session-home paths without copying launch secrets into SSH argv', () => {
  const config = makeConfig(scratch.sub('mirror-env'));
  const record = seedTask(config, 'SECRET', { host: 'pc', remoteDir: '/work/.agentctl/secret', remoteReport: '/work/reports/SECRET.md', env: { APP_SECRET: 'private-launch-value', CODEX_HOME: '/remote/codex', KIMI_CODE_HOME: '/remote/kimi' } });
  const script = remoteMirrorScript(record);
  assert.ok(!script.includes('private-launch-value'));
  assert.ok(!script.includes('APP_SECRET'));
  assert.ok(script.includes('/remote/codex') && script.includes('/remote/kimi'));
});


it('HOST-TMUX-WRAP: saved facade methods remain stable when capture, paste or windows are wrapped', async () => {
  const config = makeConfig(scratch.sub('wrap'));
  const runner = new DiskRunner({ dryRun: false, respond: (cmd, args) => cmd === 'tmux' && args.includes('list-windows') ? { stdout: '@1\tlocal\ttask' } : { stdout: 'captured' } });
  const ctx = new Context(runner, config, () => {});
  for (const key of ['capture', 'pasteText', 'windows'] as const) {
    const original = ctx.tmux[key].bind(ctx.tmux) as (...args: unknown[]) => Promise<unknown>;
    let calls = 0;
    const replacement = async (...args: unknown[]) => {
      if (++calls > 1) return undefined; // Bound a broken router's recursion deterministically.
      return original(...args);
    };
    Reflect.set(ctx.tmux, key, replacement);
    await (ctx.tmux[key] as (...args: unknown[]) => Promise<unknown>)('local', 'text');
    assert.equal(calls, 1, `${key} recursed through its own wrapper`);
  }
});
