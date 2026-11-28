import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Context } from './context.ts';
import { insidePath } from './worktree-volume.ts';
import { findRecordAnywhere } from './taskstore.ts';
import type { TaskRecord } from './taskstore.ts';
import type { ResolvedSpec } from './spec.ts';
import { recordJournal } from './journal.ts';
import { AgentctlError, shellLine } from './util.ts';
import { assertHost } from './host-availability.ts';
import { safeRelative } from './perf-spec.ts';

const DISALLOWED = new Set(['.git', '.ssh', 'node_modules']);
const options = ['--recursive', '--times', '--perms', '--checksum', '--protect-args'];

async function directoryBytes(directory: string, limit: number): Promise<number> {
  if (!(await fs.promises.lstat(directory)).isDirectory()) throw new AgentctlError(`perf: expected a directory: ${directory}`);
  const stack = [directory];
  let size = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (DISALLOWED.has(path.basename(current))) throw new AgentctlError(`perf: forbidden artifact directory ${current}`);
    for await (const entry of await fs.promises.opendir(current)) {
      const item = path.join(current, entry.name);
      if (DISALLOWED.has(entry.name)) throw new AgentctlError(`perf: forbidden artifact entry ${item}`);
      const stat = await fs.promises.lstat(item);
      if (stat.isDirectory()) stack.push(item);
      else if (stat.isFile()) size += stat.size;
      else throw new AgentctlError(`perf: unsupported artifact entry ${item}`);
      if (size > limit) throw new AgentctlError('perf: artifact size exceeds perf.max_artifact_mb');
    }
  }
  return size;
}

function hostRsync(ctx: Context, name: string) {
  assertHost(ctx.config, name);
  const host = ctx.config.hosts[name]!;
  const ssh = shellLine('ssh', ['-p', String(host.port), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
    ...(host.identityFile ? ['-i', host.identityFile] : [])]);
  const run = async (from: string, to: string) => {
    const result = await ctx.runner.exec('rsync', [...options, '--max-size', String(ctx.config.perf.maxArtifactBytes), '-e', ssh, '--', from, to], { timeoutMs: ctx.config.git.timeoutS * 1000 });
    if (result.code !== 0) throw new AgentctlError(`perf: rsync failed (exit ${result.code}): ${result.stderr.trim()}`);
  };
  return { run, address: (dir: string) => `${host.ssh}:${dir}/` };
}

export async function stagePerfArtifacts(ctx: Context, spec: ResolvedSpec): Promise<string> {
  const cwd = path.posix.join(spec.remoteDir!, `perf-${randomUUID()}`);
  const remote = ctx.hosts.forHost(spec.host!);
  const cap = ctx.config.perf.maxArtifactBytes;
  const rsync = hostRsync(ctx, spec.host!);
  const artifacts: { source: string; dest: string }[] = [];
  let bytes = 0;
  for (const artifact of spec.perf!.artifacts) {
    let source = artifact.path;
    if (artifact.fromTask) {
      const record = findRecordAnywhere(ctx.config, artifact.fromTask);
      if (!record || record.host) throw new AgentctlError(`perf: ${artifact.fromTask} must have a worktree on the Mac`);
      const matches = record.repos.map(repo => ({ root: repo.worktree, dir: path.join(repo.worktree, artifact.path) })).filter(r => fs.existsSync(r.dir));
      if (matches.length !== 1) throw new AgentctlError(`perf: expected one ${artifact.path} directory in ${record.task} worktrees`);
      const match = matches[0]!;
      if (!insidePath(fs.realpathSync(match.root), fs.realpathSync(match.dir))) throw new AgentctlError(`perf: artifact escapes ${record.task}'s worktree`);
      source = match.dir;
    }
    const real = fs.realpathSync(source);
    const state = path.resolve(ctx.config.stateDir);
    if (insidePath(real, state) || insidePath(state, real) || real.split(path.sep).some(piece => DISALLOWED.has(piece))) throw new AgentctlError('perf: artifact source contains dispatcher state');
    if (spec.perf!.results && pathsOverlap(artifact.dest, spec.perf!.results)) throw new AgentctlError('perf: artifact and results directories overlap');
    bytes += await directoryBytes(source, cap - bytes);
    artifacts.push({ source, dest: path.posix.join(cwd, artifact.dest) });
  }
  if (ctx.runner.dryRun) return cwd;
  await remote.mkdir(cwd);
  try {
    for (const artifact of artifacts) {
      await remote.mkdir(artifact.dest);
      await rsync.run(`${artifact.source}/`, rsync.address(artifact.dest));
    }
    await recordJournal(ctx, { kind: 'perf-transfer', task: spec.task, text: `[${spec.host}] przesłano artefakty perf (${bytes} B)` });
  } catch (error) {
    await cleanPerfArtifacts(ctx, spec.host!, cwd, spec.perf!.artifacts.map(a => a.dest)).catch(() => undefined);
    throw error;
  }
  return cwd;
}

const pathsOverlap = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

const measure = `const fs=require('node:fs'),path=require('node:path');
const [root,rel,limit]=process.argv.slice(1),dir=path.join(root,rel),real=fs.realpathSync(dir);
if(!real.startsWith(fs.realpathSync(root)+'/')||real!==dir||!fs.lstatSync(dir).isDirectory())process.exit(1);
const stack=[dir];let bytes=0;while(stack.length){const f=stack.pop(),s=fs.lstatSync(f);
if(['.git','.ssh','node_modules'].includes(path.basename(f)))process.exit(1);
if(s.isDirectory())for(const name of fs.readdirSync(f))stack.push(path.join(f,name));
else if(s.isFile())bytes+=s.size;else process.exit(1);if(bytes>Number(limit))process.exit(1)}
console.log(bytes);`;

export async function mirrorPerfResults(ctx: Context, record: TaskRecord): Promise<void> {
  const { perf, remoteCwd, host } = record;
  if (!perf || !remoteCwd || !host) return;
  const remote = ctx.hosts.forHost(host);
  if (perf.results) {
    if (!safeRelative(perf.results)) throw new AgentctlError('perf: invalid results path');
    await remote.checked('node', ['-e', measure, remoteCwd, perf.results, String(ctx.config.perf.maxArtifactBytes)], { readOnly: true });
    const target = path.join(path.dirname(record.report), `${record.task}.results`);
    if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) throw new AgentctlError(`perf: unsafe destination ${target}`);
    await ctx.runner.mkdir(target);
    const rsync = hostRsync(ctx, host);
    await rsync.run(rsync.address(path.posix.join(remoteCwd, perf.results)), `${target}/`);
    await recordJournal(ctx, { kind: 'perf-transfer', task: record.task, text: `[${host}] wyniki w ${target}` });
  }
  await cleanPerfArtifacts(ctx, host, remoteCwd, perf.artifacts.map(a => a.dest));
}

async function cleanPerfArtifacts(ctx: Context, host: string, cwd: string, dirs: string[]): Promise<void> {
  if (!dirs.length) return;
  if (!/^perf-[a-f0-9-]{36}$/.test(path.posix.basename(cwd)) || !dirs.every(safeRelative)) throw new AgentctlError('perf: invalid artifact cleanup path');
  const script = `const fs=require('node:fs'),p=require('node:path'); const [root,...dirs]=process.argv.slice(1);
if(fs.realpathSync(root)!==root)process.exit(1);for(const dir of dirs){const target=p.join(root,dir);let parent;try{parent=fs.realpathSync(p.dirname(target));}catch(e){if(e.code==='ENOENT')continue;throw e;}
if(parent!==root&&!parent.startsWith(root+'/'))process.exit(1);fs.rmSync(target,{recursive:true,force:true});}`;
  await ctx.hosts.forHost(host).checked('node', ['-e', script, cwd, ...dirs]);
}
