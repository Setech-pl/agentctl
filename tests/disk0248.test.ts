import { defaultDeps } from '../src/cli.ts';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { it, type TestContext } from 'node:test';
import { closeTask } from '../src/core/close.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { collectDisk, diskStartHold } from '../src/core/disk.ts';
import { applyGc, planGc } from '../src/core/gc.ts';
import { readJournal } from '../src/core/journal.ts';
import { readTaskRecord, taskDir } from '../src/core/taskstore.ts';
import { newTasks } from '../src/core/new.ts';
import { applyAcceptedWrites, describeQueue, QueueMemory, queueTick, readQueue, registerDirectStart, retryEntry, unblockEntry } from '../src/core/queue.ts';
import { RealRunner, type ExecOptions } from '../src/core/runner.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { DiskRunner, FakeTmux, fakeWatcher, makeConfig, runCli, seedTask, useScratch } from './helpers.ts';
import { collectStatus } from '../src/core/status.ts';
import { WatchMemory, watchTick } from '../src/core/watch.ts';
import { MCP_TOOLS } from '../src/core/mcp-tools.ts';
import { mcpRequestDir, readMcpRequests, recordMcpRequest } from '../src/core/mcp-requests.ts';
import { readThread, readWall } from '../src/core/wall.ts';

const scratch = useScratch();
const sameFs = fs.statSync;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function world(name: string, yaml: (root: string) => string = () => '', payload?: Buffer) {
  const root = scratch.sub(name), repo = scratch.sub(`${name}/repo`);
  const trash = process.platform === 'darwin' ? path.join(os.homedir(), '.Trash') : path.join(os.homedir(), '.local/share/Trash/files');
  fs.mkdirSync(trash, { recursive: true });
  git(repo, 'init', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.cache/\ndist*/\nprofile/\n');
  fs.mkdirSync(path.join(repo, 'dist-tracked'));
  fs.writeFileSync(path.join(repo, 'dist-tracked', 'tracked.txt'), 'keep');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0"}}}\n');
  git(repo, 'add', '.');
  git(repo, 'add', '-f', 'dist-tracked/tracked.txt');
  git(repo, 'commit', '-m', 'fixture');
  const config = makeConfig(root, yaml(root));
  const tmux = new FakeTmux(config.session), real = new RealRunner();
  const installs: string[] = [], copies: string[][] = [], moves: string[] = [], notifications: string[] = [];
  let failClone = false;
  let interceptGit: ((args: string[]) => { code: number; stdout: string; stderr: string } | undefined) | undefined;
  class FixtureRunner extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}) {
      if (cmd === 'git') return interceptGit?.(args) ?? real.exec(cmd, args, opts);
      if (cmd === 'chmod') return real.exec(cmd, args, opts);
      if (cmd === '/sbin/mount' || cmd === 'cp' && args.includes('-x')) return real.exec(cmd, args, opts);
      if (cmd === 'sh' && args.at(-1)?.startsWith('npm ci')) {
        const worktree = opts.cwd!;
        installs.push(worktree);
        const nm = path.join(worktree, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'dependency'), 'original');
        if (payload) fs.writeFileSync(path.join(nm, 'payload'), payload);
        if (!fs.existsSync(path.join(nm, '.bin/tool'))) fs.symlinkSync('../dependency', path.join(nm, '.bin/tool'));
        return { code: 0, stdout: 'fixture install\n', stderr: '' };
      }
      if (cmd === 'cp') {
        copies.push(args);
        if (failClone) {
          fs.mkdirSync(args.at(-1)!);
          return { code: 1, stdout: '', stderr: 'fixture clone failure' };
        }
        fs.cpSync(args.at(-2)!, args.at(-1)!, { recursive: true, verbatimSymlinks: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'osascript' || cmd === 'gio') {
        const target = args.at(-1)!;
        moves.push(target);
        const destination = path.join(trash, `${moves.length}-${path.basename(target)}`);
        fs.renameSync(target, destination);
        return { code: 0, stdout: pathToFileURL(destination).href, stderr: '' };
      }
      if (cmd.endsWith('lsof')) return { code: 1, stdout: '', stderr: '' };
      if (cmd === 'ps') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'df') return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 5242880 4194304 1048576 80% /mount\n', stderr: '' };
      return super.exec(cmd, args, opts);
    }
  }
  const runner = new FixtureRunner({ dryRun: false, respond: tmux.respond.bind(tmux), startTime: Date.now() });
  const ctx = new Context(runner, config, () => {});
  const spec = (task: string, explicit = true, extra = '') => {
    const raw = splitSpecs(`---\ntask: ${task}\nagent: claude\n${extra}repos: [{path: ${repo}${explicit ? `, worktree: ${root}/${task.toLowerCase()}` : ''}}]\n---\nFixture prompt.`)[0]!;
    return { raw, spec: resolveSpec(raw, { config }) };
  };
  const notifier = { clickable: false, notify: async (_title: string, message: string) => { notifications.push(message); } };
  return { root, repo, config, ctx, runner, tmux, spec, notifier, installs, copies, moves, trash, notifications, failCopy: () => { failClone = true; }, interceptGit: (f: typeof interceptGit) => { interceptGit = f; } };
}

it('FLOW-READONLY: a stopped author lends its worktree with agent-scoped commit and push hooks', async () => {
  const w = world('readonly');
  const a = w.spec('AUTHOR').spec;
  await newTasks(w.ctx, [a], { noAgent: true });
  const worktree = a.repos[0]!.worktree;
  seedTask(w.config, a.task, { repos: a.repos, model: 'other-model' });
  const original = path.join(w.root, 'original-hooks');
  fs.mkdirSync(original);
  const originalLog = path.join(w.root, 'original.log');
  fs.writeFileSync(path.join(original, 'pre-commit'), `#!/bin/sh\necho called >> '${originalLog}'\n`, { mode: 0o700 });
  git(worktree, 'config', 'core.hooksPath', original);
  const review = w.spec('REVIEW', false, 'review_of: AUTHOR\nreview: {mode: readonly-on-author}\n').spec;
  w.tmux.add('author', 'working');
  await assert.rejects(newTasks(w.ctx, [review]), /author task is still running/);
  await closeTask(w.ctx, 'AUTHOR');
  const [started] = await newTasks(w.ctx, [review]);
  assert.deepEqual(started?.worktrees, [worktree]);
  assert.equal(readTaskRecord(w.config, review.window)?.reviewMode, 'readonly-on-author');
  await assert.rejects(newTasks(w.ctx, [a], { reuse: true }), /readonly review REVIEW is using the author worktree/);
  assert.equal(git(worktree, 'config', 'core.hooksPath'), original);
  const launcher = fs.readFileSync(path.join(taskDir(w.config, review.window), 'start.sh'), 'utf8');
  assert.match(launcher, /GIT_CONFIG_KEY_0=core\.hooksPath/);
  const evidence = path.join(w.config.cache, review.window, 'evidence');
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(evidence, 'hooks') };
  const run = (...args: string[]) => execFileSync('git', ['-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { env, stdio: 'pipe' });
  assert.throws(() => run('commit', '--allow-empty', '-m', 'refused'), /Git write refused/);
  assert.throws(() => run('commit', '--no-verify', '--allow-empty', '-m', 'also refused'), /Git write refused/);
  const bare = scratch.sub('readonly/local-remote');
  git(bare, 'init', '--bare');
  assert.throws(() => run('push', bare, 'HEAD:refs/heads/blocked'), /Git write refused/);
  assert.equal(fs.readFileSync(path.join(evidence, 'git-refused.log'), 'utf8'), 'pre-commit\nprepare-commit-msg\npre-push\n');
  await closeTask(w.ctx, 'REVIEW', { rmWorktree: true });
  git(worktree, 'commit', '--allow-empty', '-m', 'author can commit');
  assert.equal(fs.readFileSync(originalLog, 'utf8'), 'called\n');
  assert.equal(git(w.repo, 'worktree', 'list', '--porcelain').split('worktree ').length, 3);
});

it('FLOW-FRESHNESS: warns, waits for a base update, and reviews a local merge candidate', async () => {
  const w = world('freshness');
  const wt = path.join(w.root, 'author');
  git(w.repo, 'worktree', 'add', '-b', 'feature', wt);
  fs.writeFileSync(path.join(wt, 'author.txt'), 'author');
  git(wt, 'add', '.');
  git(wt, 'commit', '-m', 'feature');
  const author = git(wt, 'rev-parse', 'HEAD');
  seedTask(w.config, 'AUTHOR', { repos: [{ path: w.repo, worktree: wt, branch: 'feature' }], model: 'other-model', closed: true });
  fs.writeFileSync(path.join(w.repo, 'main.txt'), 'base');
  git(w.repo, 'add', '.');
  git(w.repo, 'commit', '-m', 'new base');
  const main = git(w.repo, 'rev-parse', 'HEAD');

  const warning = w.spec('WARN', true, 'review_of: AUTHOR\nmerge_base_check: warn\n').spec;
  await newTasks(w.ctx, [warning]);
  assert.equal(git(warning.repos[0]!.worktree, 'rev-parse', 'HEAD'), author);
  assert.match(readTaskRecord(w.config, warning.window)?.reviewFreshness ?? '', /AUTHOR .* lacks local main/);
  assert.match((await collectStatus(w.ctx)).find(row => row.task === 'WARN')?.hint ?? '', /Review freshness warning/);

  const candidate = w.spec('CANDIDATE', true, 'review_of: AUTHOR\nmerge_base_check: candidate\n').spec;
  await newTasks(w.ctx, [candidate], { noAgent: true });
  const checkout = candidate.repos[0]!.worktree;
  assert.equal(git(checkout, 'branch', '--show-current'), 'review/CANDIDATE');
  assert.equal(git(checkout, 'show', '-s', '--format=%P', 'HEAD'), `${author} ${main}`);
  assert.equal(fs.readFileSync(path.join(checkout, 'main.txt'), 'utf8'), 'base');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), author);
  assert.equal(git(w.repo, 'rev-parse', 'HEAD'), main);

  const blocked = w.spec('WAIT', true, 'review_of: AUTHOR\nmerge_base_check: block\n');
  const file = path.join(w.root, 'wait.md');
  fs.writeFileSync(file, `---\n${JSON.stringify(blocked.raw.header)}\n---\nReview.\n`);
  const result = await runCli(w.config, w.runner, ['new', file, '--no-agent']);
  assert.match(result.stdout, /WAIT: BLOCKED.*lacks local main/);
  assert.equal(describeQueue(w.config, readQueue(w.config), [])[0]?.condition.kind, 'blocked');
  const queue = new QueueMemory();
  assert.deepEqual(await queueTick(w.ctx, queue, w.notifier), []);
  git(wt, 'merge', '--no-edit', 'main');
  assert.deepEqual(await queueTick(w.ctx, queue, w.notifier), ['WAIT']);
  await queue.idle();
  assert.equal(readQueue(w.config).length, 0);
});

it('FLOW-FRESHNESS: conflicting candidates name paths and can retry without changing the author', async () => {
  const w = world('candidate-conflict');
  const wt = path.join(w.root, 'author');
  git(w.repo, 'worktree', 'add', '-b', 'feature', wt);
  for (const [root, value] of [[wt, 'author'], [w.repo, 'main']] as const) {
    fs.writeFileSync(path.join(root, 'shared file'), value);
    git(root, 'add', '.');
    git(root, 'commit', '-m', value);
  }
  const author = git(wt, 'rev-parse', 'HEAD');
  seedTask(w.config, 'AUTHOR', { repos: [{ path: w.repo, worktree: wt, branch: 'feature' }], model: 'other-model', closed: true });
  const candidate = w.spec('CONFLICT', true, 'review_of: AUTHOR\nmerge_base_check: candidate\n');
  await registerDirectStart(w.ctx, [candidate], { noAgent: true });
  const queue = new QueueMemory();
  assert.deepEqual(await queueTick(w.ctx, queue, w.notifier), ['CONFLICT']);
  await queue.idle();
  const [row] = describeQueue(w.config, readQueue(w.config), []);
  assert.equal(row?.condition.kind, 'blocked');
  assert.match(row?.condition.text ?? '', /merge conflicts .*"shared file"/);
  assert.equal(git(w.repo, 'branch', '--list', 'review/CONFLICT'), '');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), author);
  assert.equal(git(wt, 'status', '--porcelain'), '');
  git(wt, 'merge', '-s', 'ours', '--no-edit', 'main');
  await retryEntry(w.ctx, 'CONFLICT');
  assert.deepEqual(await queueTick(w.ctx, queue, w.notifier), ['CONFLICT']);
  await queue.idle();
  assert.equal(git(candidate.spec.repos[0]!.worktree, 'branch', '--show-current'), 'review/CONFLICT');
});

it('FLOW-GC: watch proposes one owner-scoped plan for a fast-forward and confirm rechecks it', async () => {
  const w = world('integration-gc', () => 'mcp: {allow: [gc]}\n');
  const task = (id: string, extra: Parameters<typeof seedTask>[2] = {}) => {
    const worktree = path.join(w.root, id.toLowerCase()), branch = `agent/${id}`;
    git(w.repo, 'worktree', 'add', '-b', branch, worktree);
    seedTask(w.config, id, { closed: true, owner: 'chat:nc', repos: [{ path: w.repo, worktree, branch, base: 'main' }], ...extra });
    return worktree;
  };
  const good = task('MERGED');
  const cancelled = task('CANCELLED', { closed: false, cancelled: true, owner: 'chat:hems' });
  const dirty = task('DIRTY'), untracked = task('UNTRACKED'), linked = task('LINKED'), pinned = task('PINNED', { pin: true });
  const unmerged = task('UNMERGED'), live = task('LIVE', { closed: false });
  w.tmux.add('live', 'working');
  fs.appendFileSync(path.join(dirty, 'package.json'), '\n');
  fs.writeFileSync(path.join(untracked, 'local.txt'), 'local');
  fs.mkdirSync(path.join(pinned, 'node_modules'));
  fs.symlinkSync(linked, path.join(pinned, 'node_modules/kept-link'));
  fs.mkdirSync(path.join(good, 'node_modules'));
  fs.writeFileSync(path.join(good, 'node_modules/ignored'), 'fixture dependency');
  git(unmerged, 'commit', '--allow-empty', '-m', 'not integrated');
  git(good, 'commit', '--allow-empty', '-m', 'integrated');

  const messages = (name: string) => readWall(w.ctx, { id: `chat:${name}`, kind: 'chat' }, { channel: name, kind: 'info' }).messages;
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.deepEqual(messages('nc'), []);
  git(w.repo, 'merge', '--ff-only', 'agent/MERGED');
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  const [message] = messages('nc');
  assert.equal(messages('nc').length, 1);
  assert.equal(messages('hems').length, 1);
  assert.equal(message?.to, 'chat:nc');
  assert.ok(message);
  const body = readThread(w.config, { id: 'chat:nc', kind: 'chat' }, message.id).message.body;
  const id = /request_id: ([a-f0-9-]{36})/.exec(body)?.[1];
  assert.ok(id);
  assert.match(body, /Worktree do odzyskania: 1, około [1-9][0-9]* B\./);
  const gc = MCP_TOOLS.find(tool => tool.name === 'gc')!;
  const deps = { context: () => w.ctx, notify: async () => {} };
  fakeWatcher(w.config);
  const preview = await gc.run(deps, { request_id: id, detail: true });
  assert.match(preview.text, /MERGED/);
  assert.doesNotMatch(preview.text, /CANCELLED|DIRTY|UNTRACKED|UNMERGED|PINNED|LINKED|LIVE/);
  assert.ok(fs.existsSync(good));
  const token = /preview_token: (\S+)/.exec(preview.text)?.[1];
  assert.ok(token, preview.text);
  fs.writeFileSync(path.join(good, 'new.txt'), 'new since preview');
  assert.match((await gc.run(deps, { preview_token: token, confirm: true })).text, /^Accepted/);
  await applyAcceptedWrites(w.ctx, w.notifier, {});
  assert.match(readMcpRequests(w.config).find(request => request.token === token)?.error ?? '', /changed preview/);
  assert.ok(fs.existsSync(good));
  fs.unlinkSync(path.join(good, 'new.txt'));
  const again = await gc.run(deps, { request_id: id });
  const newToken = /preview_token: (\S+)/.exec(again.text)?.[1];
  assert.ok(newToken);
  assert.match((await gc.run(deps, { preview_token: newToken, confirm: true })).text, /^Accepted/);
  await applyAcceptedWrites(w.ctx, w.notifier, {});
  assert.equal(readMcpRequests(w.config).find(request => request.token === newToken)?.status, 'done');
  assert.equal(fs.existsSync(good), false);
  for (const kept of [cancelled, dirty, untracked, linked, pinned, unmerged, live]) assert.ok(fs.existsSync(kept), kept);
});

it('FLOW-GC: off skips movements and propose detects a merge commit on master', async () => {
  const w = world('integration-gc-off', () => 'gc: {after_integration: off}\n');
  git(w.repo, 'branch', '-m', 'master');
  const worktree = path.join(w.root, 'author');
  git(w.repo, 'worktree', 'add', '-b', 'feature', worktree);
  seedTask(w.config, 'AUTHOR', { closed: true, owner: 'chat:nc', repos: [{ path: w.repo, worktree, branch: 'feature' }] });
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  git(worktree, 'commit', '--allow-empty', '-m', 'feature');
  git(w.repo, 'commit', '--allow-empty', '-m', 'master');
  git(w.repo, 'merge', '--no-ff', 'feature');
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.deepEqual(readMcpRequests(w.config), []);
  assert.ok(fs.existsSync(worktree));
  w.ctx.setConfig({ ...w.config, gc: { ...w.config.gc, afterIntegration: 'propose' } });
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.deepEqual(readMcpRequests(w.config), [], 're-enabling establishes a new baseline');
  git(worktree, 'commit', '--allow-empty', '-m', 'next feature');
  git(w.repo, 'commit', '--allow-empty', '-m', 'next master');
  git(w.repo, 'merge', '--no-ff', 'feature');
  await watchTick(w.ctx, new WatchMemory(), w.notifier);
  assert.deepEqual(readMcpRequests(w.config).map(request => request.label), ['repo master']);
  assert.ok(fs.existsSync(worktree));
});

it('FLOW-SETUP: task clones skip only compatible npm ci installs and keep source writes isolated', async t => {
  const payloadBytes = Number(process.env.AGENTCTL_FLOW_BENCHMARK_BYTES ?? 0);
  const w = world('from-task', () => 'mcp: {allow: [new]}\nsetup: [npm ci]\n', payloadBytes ? randomBytes(payloadBytes) : undefined);
  const a = w.spec('AUTHOR', true, 'setup: [npm ci]\n').spec;
  await newTasks(w.ctx, [a], { noAgent: true });
  seedTask(w.config, a.task, { repos: a.repos, closed: true });
  const b = w.spec('REVIEW', true, 'setup: {link-from: AUTHOR, commands: [npm ci --no-audit, echo post-setup]}\n').spec;
  assert.equal(b.setupFromTask, 'AUTHOR');
  const newTool = MCP_TOOLS.find(tool => tool.name === 'new')!;
  const deps = { context: () => w.ctx, notify: async () => {} };
  const submitted = (setup: string) => `---\ntask: MCP-REVIEW\nagent: claude\nsetup: ${setup}\nrepos: [{path: ${w.repo}, worktree: ${w.root}/mcp-review}]\n---\nReview.`;
  assert.match((await newTool.run(deps, { spec: submitted('{from_task: AUTHOR}') })).text, /copy-on-write clone from AUTHOR/);
  assert.match((await newTool.run(deps, { spec: submitted('{from_task: AUTHOR, commands: [npm ci]}') })).text, /setup.*not accepted from the chat/);
  const dependency = (spec: typeof a) => path.join(spec.repos[0]!.worktree, 'node_modules/dependency');
  const probe = path.join(w.root, 'reflink-probe');
  let reflink = true;
  if (process.platform === 'darwin') {
    const device = fs.statSync(w.root).dev;
    const mounts = execFileSync('/sbin/mount', { encoding: 'utf8' }).split('\n');
    reflink = mounts.some(line => {
      const mount = /^.+ on (.+) \(apfs(?:,|\))/.exec(line)?.[1];
      return mount && fs.statSync(mount, { throwIfNoEntry: false })?.dev === device;
    });
  } else {
    try { execFileSync('cp', ['--reflink=always', dependency(a), probe], { stdio: 'pipe' }); }
    catch { reflink = false; }
  }
  await newTasks(w.ctx, [b], { noAgent: true });
  assert.equal(w.installs.length, reflink ? 1 : 2);
  const log = fs.readFileSync(path.join(w.config.stateDir, b.window, 'setup.log'), 'utf8');
  assert.match(log, /echo post-setup/);
  assert.equal(log.includes('node_modules clone from task AUTHOR'), reflink);
  assert.equal(fs.readlinkSync(path.join(b.repos[0]!.worktree, 'node_modules/.bin/tool')), '../dependency');
  fs.writeFileSync(dependency(b), 'review edit');
  assert.equal(fs.readFileSync(dependency(a), 'utf8'), 'original');

  if (payloadBytes && reflink) {
    const samples: Record<string, number[]> = { install: [], clone: [] };
    let allocatedBytes = 0;
    for (let pair = 0; pair < 5; pair++) {
      for (const mode of pair % 2 ? ['clone', 'install'] : ['install', 'clone']) {
        const item = w.spec(`BENCH-${mode.toUpperCase()}-${pair}`, true, mode === 'clone' ? 'setup: {from_task: AUTHOR}\n' : 'setup: [npm ci]\n').spec;
        const installedBefore: number = w.installs.length;
        const start = performance.now();
        await newTasks(w.ctx, [item], { noAgent: true });
        samples[mode]!.push(performance.now() - start);
        assert.equal(w.installs.length, installedBefore + Number(mode === 'install'));
        if (mode === 'install') allocatedBytes = fs.statSync(path.join(item.repos[0]!.worktree, 'node_modules/payload')).blocks * 512;
      }
    }
    t.diagnostic(`FLOW_BENCHMARK ${JSON.stringify({ payloadBytes, allocatedBytes, samples })}`);
  }

  const prior = w.installs.length;
  fs.symlinkSync(path.join(w.root, 'reflink-probe'), path.join(a.repos[0]!.worktree, 'node_modules/escape'));
  const c = w.spec('UNSAFE', true, 'setup: {from_task: AUTHOR}\n').spec;
  await newTasks(w.ctx, [c], { noAgent: true });
  assert.equal(w.installs.length, prior + 1);
  assert.ok(!fs.existsSync(path.join(c.repos[0]!.worktree, 'node_modules/escape')));
  fs.unlinkSync(path.join(a.repos[0]!.worktree, 'node_modules/escape'));
  fs.appendFileSync(path.join(w.repo, 'package-lock.json'), '\n');
  git(w.repo, 'commit', '-am', 'new lockfile');
  const d = w.spec('STALE-LOCK', true, 'setup: {from_task: AUTHOR}\n').spec;
  await newTasks(w.ctx, [d], { noAgent: true });
  assert.equal(w.installs.length, prior + 2);
  const cloneOnly = w.spec('CLONE-ONLY', true, 'setup: {from_task: AUTHOR}\n').spec;
  delete cloneOnly.repos[0]!.setup;
  await newTasks(w.ctx, [cloneOnly], { noAgent: true });
  assert.equal(w.installs.length, prior + 2, 'a clone request alone does not introduce npm lifecycle scripts');
});

it('DISK0248-NM: same lockfile installs once, creates independent copies and exposes store bytes and counters', async () => {
  const w = world('store', () => 'setup: [npm ci]\n');
  // Set the parsed option directly so the v0.23.3 proof reaches setup and fails on repeated installs.
  Object.assign(w.config, { nodeModules: 'clone' });
  const a = w.spec('NMA').spec, b = w.spec('NMB').spec;
  await Promise.all([newTasks(w.ctx, [a], { noAgent: true }), newTasks(w.ctx, [b], { noAgent: true })]);
  assert.equal(w.installs.length, 1);
  assert.equal(w.copies.length, 2);
  assert.ok(w.copies.every(args => args.includes(process.platform === 'darwin' ? '-c' : '--reflink=auto')));
  const file = (spec: typeof a) => path.join(spec.repos[0]!.worktree, 'node_modules/dependency');
  fs.writeFileSync(file(a), 'changed');
  assert.equal(fs.readFileSync(file(b), 'utf8'), 'original');
  assert.equal(fs.readlinkSync(path.join(b.repos[0]!.worktree, 'node_modules/.bin/tool')), '../dependency');
  const disk = await collectDisk(w.ctx);
  assert.deepEqual([disk.nodeModulesStore?.hits, disk.nodeModulesStore?.misses, disk.nodeModulesStore?.entries], [1, 1, 1]);
  assert.ok(disk.nodeModulesStore!.bytes > 0);
  assert.deepEqual(readJournal(w.config).filter(event => event.nodeModules).map(event => event.nodeModules!.result), ['miss', 'hit']);

  fs.appendFileSync(path.join(w.repo, 'package-lock.json'), '\n');
  git(w.repo, 'commit', '-am', 'new lockfile');
  await newTasks(w.ctx, [w.spec('NMC').spec], { noAgent: true });
  assert.equal(w.installs.length, 2);
  assert.equal((await collectDisk(w.ctx)).nodeModulesStore?.entries, 2);
  w.failCopy();
  const d = w.spec('NMD').spec;
  await newTasks(w.ctx, [d], { noAgent: true });
  assert.equal(w.installs.length, 3);
  assert.equal(fs.readFileSync(file(d), 'utf8'), 'original');
  assert.ok(!fs.readdirSync(d.repos[0]!.worktree).some(name => name.startsWith('.agentctl-nm-')));

  await w.runner.sleep(60_000);
  const preview = await planGc(w.ctx, { olderThan: '1m' });
  const entries = preview.items.filter(item => item.kind === 'node-modules');
  assert.equal(entries.length, 2);
  assert.equal(w.moves.length, 0);
  const applied = await applyGc(w.ctx, preview);
  assert.equal(applied.failed.length, 0);
  assert.equal(w.moves.length, 0);
  assert.ok(entries.every(entry => !fs.existsSync(entry.target)));
  assert.equal(fs.readFileSync(file(b), 'utf8'), 'original');
});

it('node_modules and worktree settings support project overrides and invalid paths are rejected', () => {
  const w = world('settings', root => `worktrees: {root: ${root}/a}\nsetup: {node_modules: clone, commands: [npm ci]}\n`);
  assert.equal(w.spec('SETTINGS', false).spec.repos[0]!.worktree, `${w.root}/a/repo-settings`);
  assert.equal(w.spec('SETTINGS', false).spec.repos[0]!.nodeModules, 'clone');
  fs.writeFileSync(path.join(w.repo, '.agentctl.yaml'), `worktrees: {root: ${w.root}/b, mount: ${w.root}}\nsetup: {node_modules: off}\n`);
  const settings = w.spec('SETTINGS', false).spec.repos[0]!;
  assert.equal(settings.worktree, `${w.root}/b/repo-settings`);
  assert.equal(settings.worktreeMount, w.root);
  assert.equal(settings.nodeModules, undefined);
});

it('close cleanup config rejects paths outside the worktree', () => {
  const w = world('unsafe-close');
  fs.appendFileSync(w.config.path, 'close: {cleanup: [../escape]}\n');
  assert.throws(() => loadGlobalConfig(path.dirname(w.config.path)), /invalid|cleanup/i);
});

it('DISK0248-CLOSE: close removes ignored outputs, leaving tracked, untracked, linked and report paths', async () => {
  const w = world('close');
  Object.assign(w.config, { closeCleanup: ['.cache', 'dist*', 'profile/*', '*-dirty'] });
  const spec = w.spec('TRASH').spec;
  await newTasks(w.ctx, [spec], { noAgent: true });
  const wt = spec.repos[0]!.worktree;
  for (const name of ['.cache', 'dist-ok', 'plain-dirty', 'profile/run', 'profile/report']) {
    const dir = path.join(wt, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'item'), 'fixture');
  }
  fs.symlinkSync(w.repo, path.join(wt, 'dist-link'));
  seedTask(w.config, spec.task, { repos: spec.repos, report: path.join(wt, 'profile/report/item') });
  await closeTask(w.ctx, spec.task);
  const expected = ['.cache', 'dist-ok', 'profile/run'].map(name => path.join(wt, name));
  assert.deepEqual(w.moves, []);
  assert.ok(expected.every(target => !fs.existsSync(target)));
  for (const name of ['dist-tracked/tracked.txt', 'plain-dirty/item', 'dist-link', 'profile/report/item']) assert.ok(fs.existsSync(path.join(wt, name)), name);
  const cleanup = readJournal(w.config).find(event => event.cleanup)?.cleanup;
  assert.deepEqual(cleanup?.moved.map(item => item.path).sort(), [...expected].sort());
  assert.equal(cleanup?.bytes, 0, 'unchanged fixture volume counter');
});

function fakeMount(t: TestContext, mount: string) {
  let mounted = true;
  const stat = ((target: fs.PathLike, ...options: unknown[]) => {
    const value = Reflect.apply(sameFs, fs, [target, ...options]) as fs.Stats | undefined;
    if (!value || typeof target !== 'string' || !mounted || !(target === mount || target.startsWith(`${mount}/`))) return value;
    return Object.assign(Object.create(value), { dev: value.dev + 1 });
  }) as typeof fs.statSync;
  t.mock.method(fs, 'statSync', stat);
  return (present: boolean) => { mounted = present; };
}

it('DISK0248-VOLUME: unmounted worktree stays blocked once, then unblock checks that volume and resumes', async t => {
  const w = world('volume', () => 'disk: {min_free_start_gb: 2}\n');
  const mount = path.join(w.root, 'volume');
  fs.mkdirSync(mount);
  Object.assign(w.config, { worktreeRoot: path.join(mount, 'checkouts'), worktreeMount: mount });
  const setMounted = fakeMount(t, mount);
  setMounted(false);
  const item = w.spec('VOLUME', false);
  await registerDirectStart(w.ctx, [item], { noAgent: true });
  const memory = new QueueMemory();
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), []);
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), []);
  assert.equal(describeQueue(w.config, readQueue(w.config), [])[0]?.condition.kind, 'blocked');
  assert.equal(w.notifications.filter(msg => msg.includes('volume missing')).length, 1);
  assert.ok(!fs.existsSync(item.spec.repos[0]!.worktree));
  await assert.rejects(unblockEntry(w.ctx, 'VOLUME'), /volume missing/);
  const disk = await collectDisk(w.ctx);
  assert.equal(disk.volumes.find(volume => volume.mount === mount)?.error, 'volume missing');
  setMounted(true);
  const statfs = ((target: string) => ({ bavail: target.startsWith(mount) ? 1 : 256, bsize: 1024 ** 3 })) as unknown as typeof fs.statfsSync;
  assert.equal(diskStartHold(w.config, item.spec.repos, statfs), `wstrzymane: dysk 1 GB < 2 GB (${mount})`);
  const df = await collectDisk(w.ctx, (async () => { throw Error('fixture statfs unavailable'); }) as typeof fs.promises.statfs);
  assert.equal(df.volumes.find(volume => volume.mount === mount)?.availableBytes, 1024 ** 3);
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), [], 'mounting alone leaves the start blocked');
  await unblockEntry(w.ctx, 'VOLUME');
  assert.deepEqual(await queueTick(w.ctx, memory, w.notifier), ['VOLUME']);
  await memory.idle();
  assert.ok(fs.existsSync(path.join(item.spec.repos[0]!.worktree, '.git')));
  assert.deepEqual(readQueue(w.config), []);
});

it('DISK0248-LOCK: interrupted checkout clears only its initializing locks and preserves detached metadata on unblock', async t => {
  const w = world('lock');
  const mount = path.join(w.root, 'mount');
  fs.mkdirSync(mount);
  Object.assign(w.config, { worktreeRoot: path.join(mount, 'checkouts'), worktreeMount: mount });
  const setMounted = fakeMount(t, mount);
  const item = w.spec('LOCK', false), wt = item.spec.repos[0]!.worktree, admin = path.join(w.repo, '.git');
  const interrupted = path.join(admin, 'worktrees/fixture'), unrelated = path.join(admin, 'worktrees/unrelated');
  const simulate = (args: string[]) => {
    if (!args.includes('worktree') || !args.includes('add')) return undefined;
    for (const target of [interrupted, unrelated]) {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'gitdir'), `${target === interrupted ? wt : `${wt}-unrelated`}/.git\n`);
      fs.writeFileSync(path.join(target, 'locked'), 'initializing\n');
      fs.writeFileSync(path.join(target, 'index.lock'), 'fixture');
    }
    setMounted(false);
    return { code: 1, stdout: '', stderr: 'fixture volume unplugged' };
  };
  w.interceptGit(simulate);
  await registerDirectStart(w.ctx, [item], { noAgent: true });
  const memory = new QueueMemory();
  await queueTick(w.ctx, memory, w.notifier);
  await memory.idle();
  assert.ok(!fs.existsSync(path.join(interrupted, 'locked')));
  assert.ok(!fs.existsSync(path.join(interrupted, 'index.lock')));
  assert.ok(fs.existsSync(path.join(unrelated, 'locked')));
  assert.ok(fs.existsSync(path.join(unrelated, 'index.lock')));
  assert.equal(readQueue(w.config)[0]?.volumeBlock, mount);
  setMounted(true);
  await unblockEntry(w.ctx, 'LOCK');
  assert.ok(!fs.existsSync(interrupted));
  assert.equal(fs.readdirSync(path.join(admin, 'agentctl-interrupted-worktrees')).length, 1);
  w.interceptGit(undefined);
  await queueTick(w.ctx, memory, w.notifier);
  await memory.idle();
  assert.ok(fs.existsSync(path.join(wt, '.git')));
  assert.ok(fs.existsSync(path.join(unrelated, 'locked')));
});

it('HOTFIX0263-WATCH: stalled stage exits and the restarted watcher reconciles request and start', async () => {
  const w = world('hotfix-watch');
  const item = w.spec('INTERRUPTED');
  await newTasks(w.ctx, [item.spec], { noAgent: true });
  await registerDirectStart(w.ctx, [item], { noAgent: true, reuse: true });
  const entry = readQueue(w.config)[0]!;
  const { saveEntry } = await import('../src/core/queue.ts');
  await saveEntry(w.ctx, { ...entry, status: 'starting', startingPid: 99_999_999 });
  const { request } = await recordMcpRequest(w.ctx, { tool: 'send', args: {}, scope: null, key: 'old', label: 'interrupted' });
  fs.writeFileSync(path.join(mcpRequestDir(w.config), `${request.id}.json`), JSON.stringify({ ...request, status: 'applying' }));

  assert.match(defaultDeps().watchCommand(), /watch --supervise$/);
  const { superviseWatch } = await import('../src/core/watch-supervisor.ts');
  const controller = new AbortController();
  const memory = new WatchMemory();
  const log = path.join(w.root, 'watch-test.log');
  const step = memory.steps.run(w.ctx, log, 'fixture', () => new Promise(() => {}), {
    now: () => w.runner.now(), schedule(fn) { queueMicrotask(fn); return () => {}; },
  });
  await step;
  let runs = 0;
  await superviseWatch(w.ctx, async () => {
    if (++runs === 1) {
      for (let tick = 0; tick < 5; tick++) memory.steps.check(w.ctx, log);
      await w.runner.sleep(600_000);
      try { memory.steps.check(w.ctx, log); } catch (error) { return String(error); }
      assert.fail('stalled watch did not exit');
    }
    const next = new QueueMemory();
    await queueTick(w.ctx, next, w.notifier);
    await next.idle();
    controller.abort();
    return 'stopped';
  }, controller.signal);
  assert.equal(runs, 2);
  assert.match(fs.readFileSync(log, 'utf8'), /Watch exiting: stage "fixture" stalled/);
  assert.deepEqual(readQueue(w.config), []);
  assert.ok(fs.existsSync(path.join(item.spec.repos[0]!.worktree, '.git')));
  assert.match(readMcpRequests(w.config)[0]?.error ?? '', /preview again/);
  const events = readJournal(w.config);
  assert.equal(events.filter(e => e.kind === 'watch-stalled').length, 1);
  for (const kind of ['watch-resumed', 'mcp-failed', 'queue-retry', 'queue-start']) assert.ok(events.some(e => e.kind === kind), kind);
});

it('HOTFIX0263-TRASH: trash mode purges only recorded moves and one-off purge previews legacy ownership', async () => {
  const w = world('hotfix-trash', () => 'setup: { node_modules: clone }\nmcp: { allow: [gc] }\n');
  // Set the mode in-memory so the same scenario can exercise the older release.
  Object.assign(w.config.gc, { deleteMode: 'trash' });
  await newTasks(w.ctx, [w.spec('DEP').spec], { noAgent: true });
  await w.runner.sleep(60_000);
  const personal = path.join(w.trash, 'personal');
  fs.writeFileSync(personal, 'keep');
  const applied = await applyGc(w.ctx, await planGc(w.ctx, { olderThan: '1m' }));
  assert.deepEqual(applied.failed, []);
  assert.equal(w.moves.length, 1);
  assert.deepEqual(fs.readdirSync(w.trash), ['personal']);
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep');

  seedTask(w.config, 'LEGACY', { closed: true });
  const legacy = path.join(w.trash, 'legacy');
  fs.mkdirSync(legacy);
  fs.copyFileSync(path.join(taskDir(w.config, 'legacy'), 'TASK.md'), path.join(legacy, 'TASK.md'));
  const preview = await runCli(w.config, w.runner, ['gc', '--purge-trash', '--json']);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /legacy/);
  assert.doesNotMatch(preview.stdout, /personal/);
  assert.ok(fs.existsSync(legacy));
  const gc = MCP_TOOLS.find(tool => tool.name === 'gc')!;
  const deps = { context: () => w.ctx, notify: async () => {} };
  const scope = await gc.run(deps, { purge_trash: true });
  const token = /preview_token: ([\w-]+)/.exec(scope.text)?.[1];
  assert.ok(token, scope.text);
  const confirmed = await gc.run(deps, { confirm: true, preview_token: token });
  assert.ok(!confirmed.isError, confirmed.text);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep');
  fs.unlinkSync(personal);
});

it('HOTFIX0264-F2: integration removal receives the Git timeout without the admission lock', async () => {
  const w = world('integration-remove-timeout');
  const worktree = path.join(w.root, 'integrated');
  git(w.repo, 'worktree', 'add', '-b', 'integrated', worktree);
  seedTask(w.config, 'INTEGRATED', { closed: true, owner: 'chat:nc', repos: [{ path: w.repo, worktree, branch: 'integrated' }] });
  const head = git(w.repo, 'rev-parse', 'HEAD');
  let remaining = 0;
  let lockHeld = true;
  const { commandStageRemaining } = await import('../src/core/command-stage.ts');
  w.interceptGit(args => {
    if (args.includes('remove')) {
      remaining = commandStageRemaining();
      lockHeld = fs.existsSync(path.join(w.config.stateDir, 'start.lock'));
    }
    return undefined;
  });
  const result = await applyGc(w.ctx, {
    integration: { repo: fs.realpathSync(w.repo), branch: 'main', head, owner: 'chat:nc' },
    items: [{ kind: 'worktree', task: 'INTEGRATED', target: fs.realpathSync(worktree), bytes: 0, detail: '', head }],
    skipped: [], freeBytes: 0, olderThanMs: 0, unknownCacheDirs: 0,
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.done.length, 1);
  assert.equal(remaining, Infinity);
  assert.equal(lockHeld, false);
});


it('HOTFIX0264-F3: basename alone never purges personal Trash and marked legacy has its own section', async () => {
  const w = world('trash-markers');
  for (const task of ['PERSONAL', 'MARKED']) {
    seedTask(w.config, task, { closed: true });
    fs.mkdirSync(path.join(w.trash, task.toLowerCase()));
  }
  const marked = path.join(w.trash, 'marked');
  const marker = path.join(marked, 'TASK.md');
  fs.copyFileSync(path.join(taskDir(w.config, 'marked'), 'TASK.md'), marker);
  const plan = await planGc(w.ctx, { purgeTrash: true });
  assert.deepEqual(plan.items.map(item => item.target), [marked]);
  const preview = await runCli(w.config, w.runner, ['gc', '--purge-trash']);
  assert.match(preview.stdout, /Legacy Trash with ownership markers: 1/);
  fs.unlinkSync(marker);
  assert.equal((await applyGc(w.ctx, plan)).done.length, 0);
  assert.ok(fs.existsSync(path.join(w.trash, 'personal')));
  assert.ok(fs.existsSync(marked));
});

it('HOTFIX0264-F4: a 0.27.x config loads with one warning and ordinary settings still apply', () => {
  const config = makeConfig(scratch.sub('forward-config'), `
launch: {grace_s: 90}
placement: {default: auto}
perf: {wait_max: 20m}
limits: {claude: 4, change_policy: owner-approve, profiles: {day: {claude: 8}}, schedule: {}}
hosts:
  local: {load_threshold: 20}
  pc: {ssh: owner@pc, work_dir: ~/work, repos: {app: ~/app}, providers: [claude], sync: fetch-back, availability: {yield: stop-new}}
`);
  assert.equal(config.limits.claude, 4);
  assert.equal(config.hosts.pc?.ssh, 'owner@pc');
  assert.deepEqual(Object.keys(config.hosts), ['pc']);
  assert.equal(config.warnings?.length, 1);
  assert.match(config.warnings![0]!, /0\.27\.x.*limits\.profiles.*hosts\.local.*hosts\.pc\.availability/);
  assert.throws(() => makeConfig(scratch.sub('forward-typo'), 'placemet: {}'), /unknown key/);
});
