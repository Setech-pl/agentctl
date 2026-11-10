import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withHarness, installPromptAgent, defaultCacheRoot } from './live-harness.ts';
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
for (const agent of ['codex','claude'] as const) for (const mode of ['swallow-first','swallow-all','trust'] as const) {
 await withHarness({ name: `fix-${agent}-${mode}`, cacheRoot: defaultCacheRoot('agentctl-0173'), config: 'capacity: {snapshot: false, codex_refresh: false}\nwatch: {interval: 1}\ndelivery_confirm_s: 6\n' }, async h => {
  const log = path.join(h.root, 'delivery.jsonl'); installPromptAgent(h, agent, mode, log);
  const repo=path.join(h.root,'repo');fs.mkdirSync(repo);
  for(const args of [['init','-qb','main'],['commit','--allow-empty','-qm','fixture']])assert.equal(spawnSync('git',args,{cwd:repo,env:h.env}).status,0);
  const report=path.join(h.root,'cache/t1/T1.md'),spec=path.join(h.root,'spec.md');
  fs.writeFileSync(spec,`---\ntask: T1\nagent: ${agent}\nmodel: ${agent === 'codex' ? 'gpt-6-luna' : 'haiku'}\neffort: ${agent === 'codex' ? 'medium' : 'low'}\nreport: ${report}\nrepos:\n  - path: ${repo}\n    worktree: ${repo}-wt\n---\n${'Original prompt '.repeat(75)}\n`);
  const result=h.agentctl(['new',spec,'-y',...(mode==='trust'?['--no-wait-trust']:[])],{timeoutMs:30000});
  const entries=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
  if(mode==='trust') {
   check(`${agent} C: no paste into trust dialog`,!entries().some(e=>e.paste));
   const watcher=h.spawnAgentctl(['watch'],path.join(h.root,'watch.log'));
   try {h.tmux(['send-keys','-t',`=${h.session}:t1`,'-l','y']);const until=Date.now()+60000;while(!entries().some(e=>e.working)&&Date.now()<until)await new Promise(r=>setTimeout(r,150));
    check(`${agent} C: watcher sends after human trust`,entries().some(e=>e.working));await new Promise(r=>setTimeout(r,1400));
   } finally {watcher.kill('SIGTERM');await new Promise(r=>watcher.once('close',r));}
  } else {
   check(`${agent} A/P: new returns success${mode==='swallow-all'?' with pending confirmation':''}`,result.code===0 && (mode!=='swallow-all' || result.stdout.includes('dostarczenie niepotwierdzone')));
   if(mode==='swallow-all'){const watcher=h.spawnAgentctl(['watch'],path.join(h.root,'watch.log'));try{const until=Date.now()+60000;while(!h.agentctl(['status','--json']).stdout.includes('needs-attention')&&Date.now()<until)await new Promise(r=>setTimeout(r,150));}finally{watcher.kill('SIGTERM');await new Promise(r=>watcher.once('close',r));}}
  }
  check(`${agent} A/C: paste exactly once (${mode})`,entries().filter(e=>e.paste).length===1);
  check(`${agent} B: original prompt and canonical filename in delivered protocol (${mode})`,entries().some(e=>e.paste?.includes(report)&&e.paste.includes('T1.md')&&e.paste.includes('Original prompt')));
  if(mode!=='trust')check(`${agent} A: bounded Enter retries (${mode})`,entries().filter(e=>e.enter).length===(mode==='swallow-first'?2:3));
  const rows=JSON.parse(h.agentctl(['status','--json']).stdout);
  check(`${agent} A/C: visible final state (${mode})`,rows[0]?.state===(mode==='swallow-all'?'needs-attention':'working'));
  check(`${agent} C: durable TASK.md delivery marker (${mode})`,fs.readFileSync(path.join(h.root,'state/t1/TASK.md'),'utf8').includes(`prompt_delivery: ${mode==='swallow-all'?'needs-attention':'sent'}`));
 });
}
fs.writeFileSync(path.join(defaultCacheRoot('agentctl-0173'),'hotfix-fix-live-results.json'),JSON.stringify({passed:checks.length,failed:0,checks},null,2)+'\n');
console.log(`${checks.length}/${checks.length} delivery checks passed`);
