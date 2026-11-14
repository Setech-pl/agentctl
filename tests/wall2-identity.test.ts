import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { launchEnvironment } from '../src/core/safety.ts';
import { channelMessages, findMessage, OWNER_IDENTITY, postMessage } from '../src/core/wall.ts';
import { DiskRunner, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';

/*
 * WALL-1-f1 (WALL-2 item 3): `agentctl wall post/reply/status` acted as the owner wherever it ran, also in an agent's task shell, so an agent
 * could post as the owner, answer for a chat or close a decision-request. In a task shell (AGENTCTL_TASK, or a working directory inside a
 * task worktree) the CLI is task:<ID>: --as of anyone else, --as owner and --owner-confirmed are refused. Only imports that WALL-1 had, so
 * the scenario runs (and fails) against it.
 */
const scratch = useScratch();

function world(name: string) {
  const config = makeConfig(scratch.sub(name), 'mcp: {allow: [wall]}\n');
  const runner = new DiskRunner({ dryRun: false });
  const ctx = new Context(runner, config, () => {});
  const worktree = scratch.sub(`${name}/app-nc-1`);
  seedTask(config, 'NC-1', { repos: [{ path: scratch.sub(`${name}/app`), worktree }] });
  const elsewhere = scratch.sub(`${name}/owner-home`);
  const cli = (env: Record<string, string>, cwd: string, ...argv: string[]) => runCli(config, runner, ['wall', ...argv], { env, cwd: () => cwd });
  return { config, ctx, worktree, elsewhere, cli };
}

describe('WALL-1-f1: the owner identity is not usable from an agent task shell', () => {
  it('with AGENTCTL_TASK the CLI posts and replies as task:<ID>, never as the owner', async () => {
    const w = world('env');
    const task = { AGENTCTL_TASK: 'NC-1' };
    const posted = await w.cli(task, w.elsewhere, 'post', 'nc', '--kind', 'info', '--subject', 'heights v2', '--body', 'from the agent');
    assert.equal(posted.code, 0, posted.stderr);
    assert.match(posted.stdout, /Posted nc-1 in nc \(info, answered\) as task:NC-1\./);
    assert.match(posted.stderr, /agent task shell \(AGENTCTL_TASK=NC-1\): acting as task:NC-1, not as the owner/);
    assert.equal(findMessage(w.config, 'nc-1').from, 'task:NC-1');
    const q = await postMessage(w.ctx, OWNER_IDENTITY, { channel: 'nc', kind: 'question', subject: 'towers?', body: 'x' });
    const reply = await w.cli(task, w.elsewhere, 'reply', q.id, '--body', 'yes');
    assert.equal(reply.code, 0, reply.stderr);
    assert.equal(findMessage(w.config, 'nc-3').from, 'task:NC-1');
  });

  it('refuses --as owner, --as chat:<name> and --owner-confirmed there; a decision stays open', async () => {
    const w = world('refuse');
    const task = { AGENTCTL_TASK: 'NC-1' };
    const d = await postMessage(w.ctx, OWNER_IDENTITY, { channel: 'nc', kind: 'decision-request', subject: 'freeze weather API v1?', body: 'x' });
    for (const argv of [
      ['post', 'agentctl', '--kind', 'info', '--subject', 'I am the owner', '--as', 'owner'],
      ['post', 'nc', '--kind', 'info', '--subject', 'I am chat:nc', '--as', 'chat:nc'],
      ['status', d.id, 'accepted', '--as', 'chat:nc', '--owner-confirmed'],
      ['status', d.id, 'accepted', '--owner-confirmed'],
      ['status', d.id, 'accepted'],
    ]) {
      const r = await w.cli(task, w.elsewhere, ...argv);
      assert.equal(r.code, 1, `${argv.join(' ')} → ${r.stdout}`);
    }
    assert.equal(findMessage(w.config, d.id).status, 'open');
    assert.deepEqual(channelMessages(w.config, 'nc').map((m) => m.from), ['owner'], 'nothing was posted as anyone');
    assert.equal(channelMessages(w.config, 'agentctl').length, 0);
  });

  it('a working directory inside a task worktree is a task shell too; an unknown AGENTCTL_TASK only reads', async () => {
    const w = world('cwd');
    const inside = path.join(w.worktree, 'src');
    fs.mkdirSync(inside, { recursive: true });
    const posted = await w.cli({}, inside, 'post', 'nc', '--kind', 'info', '--subject', 'from the worktree');
    assert.equal(posted.code, 0, posted.stderr);
    assert.equal(findMessage(w.config, 'nc-1').from, 'task:NC-1');
    const channels = await w.cli({}, inside, 'channels');
    assert.match(channels.stdout, /WALL as task:NC-1/);
    const ghost = await w.cli({ AGENTCTL_TASK: 'GHOST-1' }, w.elsewhere, 'post', 'agentctl', '--kind', 'info', '--subject', 'x');
    assert.equal(ghost.code, 1);
    assert.match(ghost.stderr, /read-only/);
    assert.equal(channelMessages(w.config, 'agentctl').length, 0);
  });

  it('the owner\'s own shell is unchanged: owner by default, --as chat:<name> allowed', async () => {
    const w = world('owner');
    const posted = await w.cli({}, w.elsewhere, 'post', 'nc', '--kind', 'decision-request', '--subject', 'owner asks');
    assert.match(posted.stdout, /as owner\./);
    assert.equal(posted.stderr, '');
    assert.equal((await w.cli({}, w.elsewhere, 'status', 'nc-1', 'accepted')).code, 0);
    assert.equal((await w.cli({}, w.elsewhere, 'post', 'nc', '--kind', 'info', '--subject', 'for nc', '--as', 'chat:nc')).code, 0);
    assert.equal(findMessage(w.config, 'nc-2').from, 'chat:nc');
  });

  it('every task\'s launch environment names the task in AGENTCTL_TASK; the spec env cannot change it', () => {
    const config = makeConfig(scratch.sub('launch'));
    for (const agent of ['claude', 'codex'] as const) {
      const env = launchEnvironment(config, { agent, task: 'NC-1', model: 'default', effort: 'high' }, { AGENTCTL_TASK: 'OTHER', NEON: '1' });
      assert.equal(env.AGENTCTL_TASK, 'NC-1', agent);
      assert.equal(env.NEON, '1');
    }
  });
});
