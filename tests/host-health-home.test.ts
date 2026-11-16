import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import { healthScript, parseHealthOutput } from '../src/core/host-health.ts';
import { makeConfig, useScratch } from './helpers.ts';
const scratch = useScratch();
it('HOST-DISK-PROBE: remote HOME, host PATH and POSIX df columns produce real disk health', () => {
  const root = scratch.sub('remote home'), bin = path.join(root, 'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(root, 'work'));
  for (const [name, text] of [['tmux', 'echo "tmux 3.8"'], ['claude', 'echo "fake-cli 1.0"'], ['git', 'printf "path:%s\\n" "$2"']]) fs.writeFileSync(path.join(bin, name!), '#!/bin/sh\n' + text + '\n', {mode: 0o700});
  const config = makeConfig(scratch.sub('config'));
  const host = {ssh: 'fake@host', port: 22, workDir: '~/work', repos: {app: '~/src/app'}, providers: ['claude'] as const, env: {PATH: `${bin}:/usr/bin:/bin`}};
  const stdout = execFileSync('sh', ['-c', healthScript({...host, providers: [...host.providers]}, config)], {encoding: 'utf8', env: {HOME: root, PATH: '/usr/bin:/bin'}});
  const health = parseHealthOutput('pc', stdout, 0, new Date().toISOString());
  assert.ok(health.disk && health.disk.totalKb > health.disk.freeKb && health.disk.freeKb > 0);
  assert.equal(health.clis?.[0]?.present, true); assert.equal(health.tmux?.present, true);
  assert.ok(stdout.includes(`path:${root}/src/app`));
});
