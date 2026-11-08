import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { AgentctlError, resolvePath, safeCwd } from '../src/core/util.ts';
import { FakeTmux, makeConfig, makeContext, runCli, seedTask, useScratch } from './helpers.ts';

/*
 * P68 (prod 08.11): the shell's cwd was deleted (gc removed the worktree it pointed into) and every CLI command crashed
 * with a stack trace ("ENOENT: process.cwd failed … uv_cwd") — resolvePath asked for the cwd even for absolute and ~
 * paths. Now the cwd is consulted only for a relative path, and when it is needed but gone the command says one line.
 */
const scratch = useScratch();
const GONE = 'current directory no longer exists (removed by gc?) – cd elsewhere, e.g. cd ~';

it('resolvePath consults the cwd only for a relative path; a missing cwd is a user-facing error, not a stack trace', () => {
  const cwd = process.cwd;
  process.cwd = (() => { throw new Error('ENOENT: no such file or directory, uv_cwd'); }) as typeof process.cwd;
  try {
    assert.equal(resolvePath('/tmp/x'), '/tmp/x');
    assert.equal(resolvePath('~'), os.homedir());
    assert.equal(resolvePath('~/x'), path.join(os.homedir(), 'x'));
    assert.equal(resolvePath('rel', '/base'), path.join('/base', 'rel'));
    assert.throws(() => resolvePath('rel'), (e: unknown) => e instanceof AgentctlError && e.message === GONE);
    assert.throws(() => safeCwd(), (e: unknown) => e instanceof AgentctlError && e.message === GONE);
  } finally { process.cwd = cwd; }
});

it('P68: from a deleted cwd a command that needs no cwd still works; one that needs it prints one line, exit non-zero, no stack trace', async () => {
  const config = makeConfig(scratch.sub('gone'));
  const tmux = new FakeTmux();
  const { runner } = makeContext(config, { dryRun: false, respond: tmux.respond });
  seedTask(config, 'G-1');
  tmux.add('g-1', '❯ ');
  const doomed = scratch.sub('doomed');
  const back = process.cwd();
  process.chdir(doomed);
  fs.rmdirSync(doomed);
  try {
    assert.throws(() => process.cwd(), /uv_cwd/, 'the cwd is really gone');
    const ok = await runCli(config, runner, ['status']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.doesNotMatch(`${ok.stdout}${ok.stderr}`, /uv_cwd|process\.cwd failed/);
    const bad = await runCli(config, runner, ['new', 'relative-spec.yaml']);
    assert.equal(bad.code, 1);
    const lines = bad.stderr.trim().split('\n');
    assert.deepEqual(lines, [`error: ${GONE}`], 'one line, no hint, no stack trace');
  } finally { process.chdir(back); }
});
