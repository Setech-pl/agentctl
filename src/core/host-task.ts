import { parseKimiConfigText, kimiConfigProblem, configuredModel } from './providers/kimi-config.ts';
import { matrixKimiModels } from './matrix.ts';
import path from 'node:path';
import { resolveTaskBases } from './base-ref.ts';
import type { Context } from './context.ts';
import type { ResolvedSpec } from './spec.ts';
import { parseProjectConfigText } from './config.ts';
import { missingBaseFailure } from './git.ts';
import { buildClaudeSettings } from './providers/claude-events.ts';
import { parseTomlNotify, tomlArray } from './providers/codex-events.ts';
import type { TaskRecord } from './taskstore.ts';
import { AgentctlError, fillPlaceholders } from './util.ts';

/** Resolve remote HOME on the host; never expand it with the dispatcher's home directory. */
export function remotePath(value: string, home: string, root = home): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.posix.join(home, value.slice(2)) : value;
  return path.posix.resolve(root, expanded);
}

/** Fetch-only synchronization and registered worktrees. A failed setup keeps its checkout for inspection. */
export async function prepareRemoteTask(ctx: Context, spec: ResolvedSpec, reuse = false): Promise<ResolvedSpec> {
  if (spec.review) throw new AgentctlError(`${spec.task}: remote automatic review is not supported yet; set review: false and order a separate review task`);
  const host = ctx.config.hosts[spec.host!]!;
  if (!host.providers.includes(spec.agent)) throw new AgentctlError(`host ${spec.host} has no ${spec.agent} provider`);
  const runner = ctx.hosts.forHost(spec.host!);
  const homeResult = await runner.checked('sh', ['-c', 'printf "%s" "$HOME"'], { readOnly: true, dryResult: { stdout: '/home/remote' } });
  const home = homeResult.stdout.trim();
  if (!path.posix.isAbsolute(home)) throw new AgentctlError(`host ${spec.host}: could not resolve remote HOME`);
  if (spec.agent === 'kimi' && !runner.dryRun) {
    const kimiHome = remotePath(spec.env.KIMI_CODE_HOME ?? host.env?.KIMI_CODE_HOME ?? ctx.config.agents.kimi.env?.KIMI_CODE_HOME ?? '~/.kimi-code', home);
    const file = path.posix.join(kimiHome, 'config.toml');
    const source = await runner.checked('sh', ['-c', 'if [ -f "$1" ]; then cat "$1"; fi', 'agentctl-kimi', file], { readOnly: true });
    const config = parseKimiConfigText(source.stdout, file), problem = kimiConfigProblem(config);
    if (problem) throw new AgentctlError(`host ${spec.host}: ${problem}`);
    const bare = spec.model.replace(/^kimi-code\//, '');
    const known = new Set([...matrixKimiModels(), ...config.models.map(m => m.id.replace(/^kimi-code\//, ''))]);
    if (bare.includes('-highspeed') || spec.model !== 'default' && !known.has(bare)) throw new AgentctlError(`host ${spec.host}: unsupported Kimi model ${spec.model}`);
    const model = configuredModel(config, spec.model);
    if (model?.efforts.length && !model.efforts.includes(spec.effort)) throw new AgentctlError(`host ${spec.host}: Kimi ${spec.model} has no effort ${spec.effort}`);
    spec = { ...spec, env: { ...spec.env, KIMI_CODE_HOME: kimiHome, ...(model?.efforts.includes(spec.effort) ? { KIMI_MODEL_THINKING_EFFORT: spec.effort } : {}) } };
  }
  const root = remotePath(host.workDir, home);
  const dir = path.posix.join(root, '.agentctl', spec.window);
  const report = path.posix.join(root, 'reports', spec.window, `${spec.task}.md`);
  const repos: ResolvedSpec['repos'] = [];
  let projectEnv: Record<string, string> = {};
  const links = [...spec.links];
  for (const [index, raw] of spec.repos.entries()) {
    let repo = { ...raw, path: remotePath(raw.path, home), worktree: remotePath(raw.worktree, home, root) };
    if (repo.worktree === repo.path || repo.worktree === root || !repo.worktree.startsWith(`${root}/`)) throw new AgentctlError(`${spec.task}: remote worktree must be a separate directory inside hosts.${spec.host}.work_dir (${root})`);
    await runner.checked('git', ['-C', repo.path, 'fetch', '--prune', 'origin'], { timeoutMs: ctx.config.git.timeoutS * 1000 });
    repo = (await resolveTaskBases(ctx, { ...spec, repos: [repo] })).repos[0]!;
    const branch = repo.branch ? await runner.exec('git', ['-C', repo.path, 'show-ref', '--verify', '--quiet', `refs/heads/${repo.branch}`], { readOnly: true, dryResult: { code: 1 } }) : { code: 1 };
    if (branch.code !== 0) {
      const base = await runner.exec('git', ['-C', repo.path, 'rev-parse', '--verify', '--end-of-options', `${repo.base ?? 'HEAD'}^{commit}`], { readOnly: true });
      if (base.code !== 0) throw await missingBaseFailure(runner, repo);
    }
    const exists = await runner.exec('test', ['-e', repo.worktree], { readOnly: true, dryResult: { code: 1 } });
    if (exists.code === 0) {
      const list = await runner.checked('git', ['-C', repo.path, 'worktree', 'list', '--porcelain'], { readOnly: true });
      const head = await runner.exec('git', ['-C', repo.worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true });
      if (!reuse || !list.stdout.split('\n').includes(`worktree ${repo.worktree}`) || (repo.branch ? head.stdout.trim() !== repo.branch : head.code === 0)) throw new AgentctlError(`${spec.task}: remote worktree ${repo.worktree} already exists or does not match the requested registered checkout; inspect it before --reuse`);
    } else {
      await runner.mkdir(path.posix.dirname(repo.worktree));
      await runner.checked('git', ['-C', repo.path, 'worktree', 'add', ...(repo.branch ? branch.code === 0 ? [repo.worktree, repo.branch] : ['-b', repo.branch, repo.worktree, repo.base ?? 'HEAD'] : ['--detach', repo.worktree, repo.base ?? 'HEAD'])], { timeoutMs: ctx.config.git.timeoutS * 1000 });
    }
    const file = path.posix.join(repo.worktree, '.agentctl.yaml');
    const configFile = await runner.exec('sh', ['-c', 'if [ -f "$1" ]; then cat -- "$1"; fi', 'agentctl-project', file], { readOnly: true });
    if (configFile.code !== 0) throw new AgentctlError(`host ${spec.host}: cannot read ${file}: ${configFile.stderr}`);
    if (configFile.stdout.trim()) {
      const project = parseProjectConfigText(configFile.stdout, file);
      if (!spec.readOnly && !repo.setupExplicit && project.setup) repo.setup = project.setup;
      if (index === 0) {
        projectEnv = project.env ?? {};
        for (const link of (spec.readOnly ? [] : project.links) ?? []) if (!links.some(l => l.from === link.from)) links.push(link);
      }
    }
    const fill = (s: string) => fillPlaceholders(s, { task: spec.task, cache: path.posix.join(root, 'reports') }).replaceAll('{worktree}', repo.worktree);
    repo.setup = repo.setup?.map(fill);
    repos.push(repo);
  }
  await runner.mkdir(dir);
  await runner.mkdir(path.posix.dirname(report));
  return { ...spec, repos, env: Object.fromEntries(Object.entries({ ...host.env, ...projectEnv, ...spec.env }).map(([k, v]) => [k, v === '~' || v.startsWith('~/') ? remotePath(v, home) : v])), links: links.map(l => ({ from: l.from, to: remotePath(l.to, home, repos[0]!.worktree) })), remoteReport: report, remoteDir: dir };
}

/** Task-owned settings merge with the owner's settings; repeated installs overwrite only our own files. */
export async function installRemoteHooks(ctx: Context, spec: ResolvedSpec, record: TaskRecord): Promise<string[]> {
  const runner = ctx.hosts.forHost(spec.host!);
  const script = path.posix.join(spec.remoteDir!, 'event.cjs');
  await runner.writeFile(script, remoteHookScript(spec.remoteDir!, record.attemptId!, spec.agent));
  if (spec.agent === 'claude' || spec.agent === 'glm') {
    const file = path.posix.join(spec.remoteDir!, `${spec.agent}-settings.json`);
    await runner.writeFile(file, `${JSON.stringify(buildClaudeSettings(spec.task, ['node', script], undefined, record.attemptId, spec.agent), null, 2)}\n`);
    ctx.info(`${spec.task}: [${spec.host}] task-owned Claude hooks/settings installed idempotently in ${file} (owner account; existing user/project settings preserved)`);
    return ['--settings', file];
  }
  if (spec.agent === 'codex') {
    // Preserve an owner's notify just as local wiring does.
    const source = await runner.exec('sh', ['-c', 'f="${CODEX_HOME:-$HOME/.codex}/config.toml"; if [ -f "$f" ]; then cat "$f"; fi'], { readOnly: true });
    const forward = parseTomlNotify(source.stdout);
    return ['-c', `notify=${tomlArray(['node', script, 'event', ...(forward ? ['--forward', JSON.stringify(forward)] : [])])}`];
  }
  return [];
}

/** A small remote receipt sink needs Node (already required by the supported agent CLIs), not an agentctl installation. */
export function remoteHookScript(dir: string, attempt: string, agent: string): string {
  return `const fs=require('fs'), cp=require('child_process');
const dir=${JSON.stringify(dir)}, attempt=${JSON.stringify(attempt)}, agent=${JSON.stringify(agent)};
const args=process.argv.slice(2), kind=args[args.indexOf('--kind')+1];
const write=(file,data)=>{const t=file+'.'+process.pid;fs.writeFileSync(t,JSON.stringify(data),{mode:0o600});fs.renameSync(t,file)};
let data;try{data=JSON.parse(args.at(-1).startsWith('{')?args.at(-1):fs.readFileSync(0,'utf8'))}catch{process.exit(0)};
let receipt={attempt};try{const old=JSON.parse(fs.readFileSync(dir+'/receipt.json','utf8'));if(old.attempt===attempt)receipt=old}catch{}
const at=new Date().toISOString();
const norm=s=>typeof s==='string'?s.replace(/\\r\\n?/g,'\\n').trim():'';
let delivery;try{delivery=JSON.parse(fs.readFileSync(dir+'/delivery.json','utf8'))}catch{}
if(typeof data.session_id==='string')receipt.session={id:data.session_id,file:data.transcript_path};
if(typeof data['thread-id']==='string')receipt.session={id:data['thread-id']};
const submitted=kind==='user-prompt-submit'?data.prompt:undefined;
if(delivery?.attempt===attempt && submitted!==undefined && norm(submitted)===norm(delivery.prompt))receipt.evidence={deliveryId:delivery.id,accepted:true,at};
let outcome=kind==='stop'||data.type==='agent-turn-complete'?'turn-complete':kind==='notification'&&/permission_prompt|elicitation|agent_needs_input|worker_permission_prompt/.test(data.notification_type||'')?'needs-input':kind==='stop-failure'?(/overloaded/.test(data.error||'')?'overloaded':/rate_limit|billing_error/.test(data.error||'')?'limited':'error'):null;
if(outcome)receipt.event={outcome,at,type:kind||data.type,text:String(data.message||data.last_assistant_message||data['last-assistant-message']||data.error_details||'').slice(0,200)};
write(dir+'/receipt.json',receipt);
const f=args.indexOf('--forward');if(f>=0){try{const [cmd,...argv]=JSON.parse(args[f+1]);cp.spawnSync(cmd,[...argv,JSON.stringify(data)],{stdio:'ignore'})}catch{}}
`;
}
