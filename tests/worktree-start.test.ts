import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { addWorktree, checkRetryWorktrees } from '../src/core/git.ts';
import { RecordingRunner } from '../src/core/runner.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';
import type { ResolvedRepo } from '../src/core/spec.ts';
import { useScratch } from './helpers.ts';
const scratch = useScratch();
function repo(name: string): ResolvedRepo {
  const root = scratch.sub(name);
  fs.mkdirSync(path.join(root, '.git'));
  return { path: root, worktree: `${root}-wt`, branch: `agent/${name}`, base: 'main' };
}
class SlowGit extends RecordingRunner {
  active = new Map<string, number>();
  max = new Map<string, number>();
  total = 0;
  maxTotal = 0;
  constructor() { super({ dryRun: false }); }
  override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (args.includes('--git-common-dir')) return { code: 0, stdout: '.git', stderr: '' };
    if (args.includes('--quiet')) return { code: 1, stdout: '', stderr: '' };
    if (args.includes('rev-parse')) return { code: 0, stdout: 'abc', stderr: '' };
    if (args.includes('add')) {
      const id = args[1]!;
      const active = (this.active.get(id) ?? 0) + 1;
      this.active.set(id, active); this.max.set(id, Math.max(active, this.max.get(id) ?? 0));
      this.total++; this.maxTotal = Math.max(this.maxTotal, this.total);
      await new Promise((r) => setTimeout(r, 40));
      this.total--; this.active.set(id, active - 1);
    }
    return super.exec(cmd, args, opts);
  }
}
describe('worktree start resilience', () => {
  it('serializes one repo, allows different repos concurrently, recovers a dead PID', async () => {
    const a = repo('lock-a'); const b = repo('lock-b');
    fs.writeFileSync(path.join(a.path, '.git/agentctl-start.lock'), '99999999');
    const runner = new SlowGit();
    await Promise.all([addWorktree(runner, a), addWorktree(runner, { ...a, worktree: `${a.worktree}-2` }), addWorktree(runner, b)]);
    assert.equal(runner.max.get(a.path), 1);
    assert.equal(runner.max.get(b.path), 1);
    assert.equal(runner.maxTotal, 2);
    assert.ok(!fs.existsSync(path.join(a.path, '.git/agentctl-start.lock')));
  });
  it('sets the configured timeout and removes only a new empty residue; branch deletion is -d', async () => {
    const r = repo('empty');
    let timeout: number | undefined;
    const runner = new RecordingRunner({ dryRun: false, respond: (_cmd, args, opts) => {
      if (args.includes('--git-common-dir')) return { stdout: '.git' };
      if (args.includes('--quiet')) return { code: 1 };
      if (args.includes('rev-parse')) return { stdout: 'abc' };
      if (args.includes('add')) { timeout = opts.timeoutMs; fs.mkdirSync(r.worktree); return { code: 1, stderr: 'spawnSync git ETIMEDOUT' }; }
      return undefined;
    } });
    await assert.rejects(addWorktree(runner, r, 2), (e: any) => /after 2s/.test(e.message) && /git.timeout_s/.test(e.hint));
    assert.equal(timeout, 2000);
    assert.ok(!fs.existsSync(r.worktree));
    assert.ok(runner.commands.some((c) => c.includes('branch -d')));
    assert.ok(!runner.commands.some((c) => /--force|branch -D/.test(c)));
  });
  it('keeps nonempty partial residue and preexisting directories and reports exact paths', async () => {
    for (const existing of [false, true]) {
      const r = repo(`partial-${existing}`);
      if (existing) fs.mkdirSync(r.worktree);
      const runner = new RecordingRunner({ dryRun: false, respond: (_cmd, args) => {
        if (args.includes('--git-common-dir')) return { stdout: '.git' };
        if (args.includes('add')) {
          fs.mkdirSync(r.worktree, { recursive: true }); fs.writeFileSync(path.join(r.worktree, 'work'), 'preserve');
          return { code: 1, stderr: 'checkout failed' };
        }
        return undefined;
      } });
      await assert.rejects(addWorktree(runner, r), (e: any) => e.message.includes(r.worktree));
      assert.equal(fs.readFileSync(path.join(r.worktree, 'work'), 'utf8'), 'preserve');
      assert.ok(!runner.commands.some((c) => /worktree remove|branch -d/.test(c)));
      await assert.rejects(checkRetryWorktrees(runner, [r]), /unsafe start residue/);
    }
  });
  it('retry accepts only registered worktrees with their own toplevel', async () => {
    const r = repo('registered'); fs.mkdirSync(r.worktree);
    const runner = new RecordingRunner({ dryRun: false, respond: (_cmd, args) => args.includes('list') ? { stdout: `worktree ${r.worktree}\n` } : { stdout: r.worktree } });
    await checkRetryWorktrees(runner, [r]);
  });
});
