import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteFile } from './atomic-file.ts';
import { assertWorktreeVolumes, volumeMounted, WorktreeVolumeError } from './worktree-volume.ts';
import { cachedRequest } from './response-budget.ts';
import { matchesProviderCommand } from './providers/registry.ts';
import path from 'node:path';
import type { Runner } from './runner.ts';
import type { ResolvedRepo } from './spec.ts';
import { withFileLock } from './file-lock.ts';
import { AgentctlError } from './util.ts';

/** Local metadata only: never fetch or guess a default from an arbitrary feature checkout. */
export async function missingBaseFailure(runner: Runner, repo: ResolvedRepo): Promise<AgentctlError> {
  const remote = await runner.exec('git', ['-C', repo.path, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { readOnly: true });
  let branch = remote.code === 0 && remote.stdout.trim().startsWith('origin/') ? remote.stdout.trim().slice(7) : '';
  if (!branch) {
    const head = await runner.exec('git', ['-C', repo.path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true });
    if (head.code === 0 && ['main', 'master'].includes(head.stdout.trim())) branch = head.stdout.trim();
  }
  return new AgentctlError(`base ${repo.base ?? 'HEAD'} not found – default branch ${branch ? `is ${branch}` : 'is unknown (no local default metadata)'} in ${repo.path}`,
    'Correct repos[].base to an existing ref and retry; no branch is substituted automatically. / Popraw repos[].base na istniejącą referencję i ponów; gałąź nie jest podmieniana automatycznie.');
}

/** Repository identity is the common git directory, including callers in linked worktrees. */
async function commonDir(runner: Runner, repo: ResolvedRepo): Promise<string> {
  const r = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--git-common-dir'], { readOnly: true });
  if (r.code !== 0) throw gitFailure(`cannot locate git directory of ${repo.path}`, r.stderr);
  const dir = path.resolve(repo.path, r.stdout.trim() || '.git');
  try { return fs.realpathSync(dir); } catch { return dir; }
}

const startLock = (dir: string) => path.join(dir, 'agentctl-start.lock');
const checkoutReceipt = (dir: string, worktree: string) => path.join(dir, `agentctl-checkout-${createHash('sha256').update(worktree).digest('hex')}.json`);
const statEntry = (file: string) => fs.lstatSync(file, { throwIfNoEntry: false });

function registrations(dir: string, worktree: string): string[] {
  const root = path.join(dir, 'worktrees');
  if (!statEntry(root)?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).flatMap(item => {
    const registration = path.join(root, item.name), link = path.join(registration, 'gitdir');
    try {
      if (statEntry(link)?.isFile() && path.resolve(registration, fs.readFileSync(link, 'utf8').trimEnd()) === path.join(worktree, '.git')) return [registration];
    } catch { /* unrelated or incomplete Git metadata */ }
    return [];
  });
}

/** Only a newly created registration named by our receipt may lose Git's initializing locks. */
async function recoverCheckout(runner: Runner, dir: string, repo: ResolvedRepo, mounted: boolean): Promise<void> {
  const worktree = path.resolve(repo.worktree), receipt = checkoutReceipt(dir, worktree);
  if (!statEntry(receipt)?.isFile()) return;
  const evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  if (evidence.worktree !== worktree || evidence.mount !== repo.worktreeMount) throw new AgentctlError(`invalid interrupted checkout receipt for ${worktree}`);
  const matches = registrations(dir, worktree);
  if (matches.length > 1) throw new AgentctlError(`multiple Git registrations for ${worktree}; inspect them before retrying`);
  const registration = matches[0];
  if (registration) {
    const locked = path.join(registration, 'locked'), indexLock = path.join(registration, 'index.lock');
    const initializing = statEntry(locked)?.isFile() && fs.readFileSync(locked, 'utf8').trim() === 'initializing';
    const index = statEntry(indexLock);
    if (index && (initializing || !mounted)) {
      if (!index.isFile()) throw new AgentctlError(`unexpected index.lock for ${worktree}; inspect it before retrying`);
      const open = await runner.exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-t', '--', indexLock], { readOnly: true });
      if (open.code !== 1 || open.stdout.trim() || open.stderr.trim()) throw new AgentctlError(`cannot verify that index.lock is unused for ${worktree}`);
      if (statEntry(indexLock)?.ino === index.ino) fs.unlinkSync(indexLock);
    }
    if (initializing && fs.readFileSync(locked, 'utf8').trim() === 'initializing') fs.unlinkSync(locked);
    if (mounted && !statEntry(worktree) && !statEntry(locked) && !statEntry(indexLock)) {
      // Preserve the exact vanished registration for inspection. No repository-wide prune.
      const saved = path.join(dir, 'agentctl-interrupted-worktrees');
      if (!statEntry(saved)) fs.mkdirSync(saved, { mode: 0o700 });
      if (!statEntry(saved)?.isDirectory()) throw new AgentctlError(`unsafe interrupted-checkout directory: ${saved}`);
      assertWorktreeVolumes([repo]);
      if (statEntry(worktree)) throw new AgentctlError(`worktree reappeared during recovery: ${worktree}`);
      fs.renameSync(registration, path.join(saved, `${path.basename(registration)}-${randomUUID()}`));
    }
  }
  if (mounted) fs.unlinkSync(receipt);
}

export async function interruptedWorktreeVolume(runner: Runner, repos: ResolvedRepo[]): Promise<string | undefined> {
  for (const repo of repos) {
    if (repo.worktreeMount && statEntry(checkoutReceipt(await commonDir(runner, repo), path.resolve(repo.worktree)))?.isFile()) return repo.worktreeMount;
  }
  return undefined;
}

export async function recoverInterruptedWorktrees(runner: Runner, repos: ResolvedRepo[], opts: { missingOnly?: boolean } = {}): Promise<void> {
  for (const repo of repos) {
    if (!repo.worktreeMount) continue;
    const dir = await commonDir(runner, repo);
    await withFileLock(startLock(dir), async () => {
      const mounted = volumeMounted(repo.worktreeMount!);
      if (opts.missingOnly && mounted) return;
      if (!opts.missingOnly && !mounted) assertWorktreeVolumes([repo]);
      await recoverCheckout(runner, dir, repo, mounted);
    });
  }
}

/** Never reuse an arbitrary directory after a failed start. A retry may reuse only a registered worktree. */
export async function checkRetryWorktrees(runner: Runner, repos: ResolvedRepo[]): Promise<void> {
  for (const repo of repos) {
    if (!fs.existsSync(repo.worktree)) continue;
    const r = await runner.exec('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { readOnly: true });
    const listed = r.code === 0 && r.stdout.split('\n').includes(`worktree ${path.resolve(repo.worktree)}`);
    const head = await runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--show-toplevel'], { readOnly: true });
    if (!listed || head.code !== 0 || path.resolve(head.stdout.trim()) !== path.resolve(repo.worktree)) {
      throw new AgentctlError(`unsafe start residue: ${repo.worktree}`, `Inspect this directory and its git worktree registration; preserve any work, then remove only this failed start's residue before queue retry.`);
    }
    const unsafe = (reason: string): never => { throw new AgentctlError(`unsafe start residue: ${repo.worktree}: ${reason}`, 'Checkout completeness is uncertain. Preserve this directory; inspect git status, HEAD/branch and index.lock, then repair the registered checkout or remove only this failed start residue and queue retry. No agent was started.'); };
    // MCP only re-registers the entry. The worker repeats this check, including tracked files, before reuse.
    const status = cachedRequest() ? { code: 0, stdout: '' } : await runner.exec('git', ['-C', repo.worktree, 'status', '--porcelain', '--untracked-files=no'], { readOnly: true });
    if (status.code !== 0 || status.stdout.trim()) unsafe('git status failed or tracked checkout is incomplete/modified');
    const lock = await runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--git-path', 'index.lock'], { readOnly: true });
    if (lock.code !== 0 || !lock.stdout.trim()) unsafe('cannot locate index.lock');
    if (fs.existsSync(path.resolve(repo.worktree, lock.stdout.trim()))) unsafe('index.lock exists');
    const actual = await runner.exec('git', ['-C', repo.worktree, 'rev-parse', '--verify', 'HEAD'], { readOnly: true });
    const expected = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', repo.branch ?? repo.base ?? 'HEAD'], { readOnly: true });
    if (actual.code !== 0 || expected.code !== 0 || !actual.stdout.trim() || actual.stdout.trim() !== expected.stdout.trim()) unsafe('HEAD differs from expected branch/base');
    const branch = await runner.exec('git', ['-C', repo.worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true });
    if (repo.branch ? branch.code !== 0 || branch.stdout.trim() !== repo.branch : branch.code === 0) unsafe('branch/detached state differs from spec');
    const processes = await runner.exec('ps', ['-axo', 'pid=,args='], { readOnly: true });
    if (processes.code !== 0) unsafe('cannot inspect task processes');
    for (const line of processes.stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (!match || !(/(?:^|[\s/])git(?:\s|$)/.test(match[2]!) || matchesProviderCommand(match[2]!, 'args'))) continue;
      if (match[2]!.includes(repo.worktree)) unsafe('task/git process still running');
      const cwd = await runner.exec(process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof', ['-a', '-p', match[1]!, '-d', 'cwd', '-Fn'], { readOnly: true });
      if (cwd.code !== 0) {
        const alive = await runner.exec('ps', ['-p', match[1]!, '-o', 'pid='], { readOnly: true });
        if (alive.code !== 0 || !alive.stdout.trim()) continue; // The process exited between ps and lsof.
        unsafe(`cannot verify cwd of agent/git process ${match[1]}`);
      }
      const dirs = cwd.stdout.split('\n').filter(l => l.startsWith('n')).map(l => path.resolve(l.slice(1)));
      if (dirs.some(dir => dir === path.resolve(repo.worktree) || dir.startsWith(path.resolve(repo.worktree) + path.sep))) unsafe('task/git process still running in checkout');
    }

  }
}

/** Serialize checkout per repository, across CLI/new and queue processes. Recover only a dead PID. */
export async function addWorktree(runner: Runner, repo: ResolvedRepo, timeoutS = 600): Promise<void> {
  const run = async (): Promise<void> => {
    const existed = fs.existsSync(repo.worktree);
    const args = ['-C', repo.path, 'worktree', 'add'];
    let createdBranch = false;
    let baseOid = '';
    if (repo.branch) {
      const exists = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${repo.branch}`], { readOnly: true, dryResult: { code: 1 } });
      if (exists.code === 0) args.push(repo.worktree, repo.branch);
      else {
        const base = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', repo.base ?? 'HEAD'], { readOnly: true });
        if (base.code === 0) baseOid = base.stdout.trim();
        // A successful explicit creation is ownership evidence; a failed -b checkout alone is not.
        if (!baseOid && !runner.dryRun) throw await missingBaseFailure(runner, repo);
        const created = await runner.exec('git', ['-C', repo.path, 'branch', repo.branch, repo.base ?? 'HEAD'], { timeoutMs: timeoutS * 1000, async: true });
        if (created.code !== 0) throw gitFailure(`cannot create branch ${repo.branch}`, created.stderr);
        createdBranch = !runner.dryRun;
        args.push(repo.worktree, repo.branch);
      }
    } else {
      args.push('--detach', repo.worktree);
      if (repo.base) args.push(repo.base);
    }
    assertWorktreeVolumes([repo]);
    const r = await runner.exec('git', args, { timeoutMs: timeoutS * 1000, async: true });
    assertWorktreeVolumes([repo]);
    if (r.code === 0) return;
    if (!repo.branch && repo.base) {
      const base = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${repo.base}^{commit}`], { readOnly: true });
      if (base.code !== 0) throw await missingBaseFailure(runner, repo);
    }
    const residue: string[] = [];
    // Nonempty partial checkouts are kept: a failed checkout cannot prove who wrote their contents.
    if (!existed && !runner.dryRun && fs.existsSync(repo.worktree)) {
      const stat = fs.lstatSync(repo.worktree);
      if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(repo.worktree).length === 0) fs.rmdirSync(repo.worktree);
      else residue.push(`directory ${repo.worktree} (kept: contents cannot safely be attributed)`);
    }
    if (createdBranch && fs.existsSync(repo.worktree)) residue.push(`branch ${repo.branch} (kept with worktree residue)`);
    if (createdBranch && baseOid && !fs.existsSync(repo.worktree)) {
      const current = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', `refs/heads/${repo.branch}`], { readOnly: true });
      if (current.code === 0 && current.stdout.trim() === baseOid && !['main', 'master'].includes(repo.branch!)) {
        const removed = await runner.exec('git', ['-C', repo.path, 'branch', '-d', repo.branch!]);
        if (removed.code !== 0) residue.push(`branch ${repo.branch}: ${removed.stderr.trim()}`);
      } else if (current.code === 0) residue.push(`branch ${repo.branch} (kept: changed since start)`);
    }
    const listing = await runner.exec('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { readOnly: true });
    if (listing.stdout.split('\n').includes(`worktree ${path.resolve(repo.worktree)}`)) residue.push(`worktree registration ${repo.worktree}`);
    const timedOut = /ETIMEDOUT|timed? out/i.test(r.stderr);
    throw gitFailure(`git worktree add failed for ${repo.worktree}${timedOut ? ` after ${timeoutS}s (git.timeout_s)` : ''}`, r.stderr,
      `${timedOut ? 'Check disk space and I/O load; increase git.timeout_s if needed. ' : ''}${residue.length ? `Remaining: ${residue.join('; ')}. Inspect and preserve any work before removing these exact paths/registrations and retrying.` : 'No directory from this attempt remains; retry after fixing the cause.'}`);
  };
  if (runner.dryRun) return run();
  const dir = await commonDir(runner, repo);
  return withFileLock(startLock(dir), async () => {
    const mount = repo.worktreeMount;
    if (!mount) return run();
    assertWorktreeVolumes([repo]);
    const worktree = path.resolve(repo.worktree), receipt = checkoutReceipt(dir, worktree);
    if (statEntry(receipt)) throw new WorktreeVolumeError(mount);
    // A registration which predates this operation, or an existing directory, is never ours to repair.
    if (statEntry(worktree) || registrations(dir, worktree).length) return run();
    atomicWriteFile(receipt, JSON.stringify({ worktree, mount }));
    let added = false;
    try {
      await run();
      added = true;
    } finally {
      if (!volumeMounted(mount)) {
        await recoverCheckout(runner, dir, repo, false).catch(() => undefined);
        throw new WorktreeVolumeError(mount);
      }
      if (added || !registrations(dir, worktree).some(registration => statEntry(path.join(registration, 'locked')) || statEntry(path.join(registration, 'index.lock')))) fs.unlinkSync(receipt);
    }
  }, timeoutS * 1000 + 60_000);
}

export function gitFailure(message: string, stderr: string, hint?: string): AgentctlError {
  const detail = stderr.trim();
  return new AgentctlError(detail ? `${message}: ${detail}` : message, hint ?? 'Fix the cause above (branch name, base ref, repo path) and run the command again.');
}
