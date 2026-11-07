import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, installPromptAgent, defaultCacheRoot } from './live-harness.ts';
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const [agent, mode] of [['claude','claude-spinner'],['claude','hook'],['codex','hook'],['claude','silent'],['codex','silent']] as const) {
 await withHarness({ name: `p-${agent}-${mode}`, cacheRoot: defaultCacheRoot('agentctl-0173'), config: 'capacity: {snapshot: false, codex_refresh: false}\nwatch: {interval: 1}\ndelivery_confirm_s: 5\ncohort: {done_grace_s: 0}\nmcp: {allow: [new, send]}\n' }, async h => {
  const log = path.join(h.root, 'delivery.jsonl'); installPromptAgent(h, agent, mode, log);
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  for (const args of [['init','-qb','main'],['commit','--allow-empty','-qm','fixture']]) assert.equal(spawnSync('git',args,{cwd:repo,env:h.env}).status,0);
  const report = path.join(h.root,'cache/t1/T1.md');
  const spec = `---\ntask: T1\nagent: ${agent}\nmodel: ${agent === 'claude' ? 'haiku' : 'gpt-6-luna'}\neffort: low\ncohort: P\nreport: ${report}\nrepos:\n  - {path: ${repo}, worktree: ${repo}-wt}\n---\nOriginal prompt\n`;
  const client = new Client({ name: 'fix2-p', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types','--no-warnings',path.resolve(import.meta.dirname,'../bin/agentctl.ts'),'mcp'], env: h.env as Record<string,string>, cwd: '/', stderr: 'pipe' }));
  const call = async (name: string, args: Record<string,unknown> = {}) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError, text: (r.content as {text:string}[]).map(c=>c.text).join('\n') }; };
  const entries = () => fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
  const taskFile = path.join(h.root,'state/t1/TASK.md');
  const sent = () => fs.readFileSync(taskFile,'utf8').includes('prompt_delivery: sent');
  // P34: every chat start goes through the watcher; MCP confirm only registers. Start it before `new` and wait for the heartbeat.
  const watcher = h.spawnAgentctl(['watch'],path.join(h.root,'watch.log'));
  try {
   const beat = path.join(h.root,'state','queue-worker.json'), beatEnd = Date.now()+10000;
   while (!fs.existsSync(beat) && Date.now()<beatEnd) await pause(150);
   await call('new', {spec}); const started = await call('new', {spec, confirm:true});
   check(`P ${agent}/${mode}: MCP new succeeds without duplicate-order error`,!started.error && started.text.includes('Registered: T1'));
   if(mode === 'claude-spinner') {
    const up=Date.now()+25000;while(!(JSON.parse(h.agentctl(['status','--json']).stdout)[0]?.state === 'working' && sent())&&Date.now()<up)await pause(200);
    check('P Claude exact spinner is working without esc hint',JSON.parse(h.agentctl(['status','--json']).stdout)[0]?.state === 'working' && sent());
    check('P Claude spinner requires one paste and one Enter',entries().filter(e=>e.paste).length===1 && entries().filter(e=>e.enter).length===1);
   } else {
    // Delivery is asynchronous now: the uncertainty hint opens when the watcher delivers and closes on the hook or delivery_confirm_s.
    const early=Date.now()+8000;let uncertainty=false,earlyAttention=false;
    while(Date.now()<early){const row=JSON.parse(h.agentctl(['status','--json']).stdout)[0];if((row?.hint??'').includes('dostarczenie niepotwierdzone')){uncertainty=true;break;}if(sent())break;if(fs.readFileSync(taskFile,'utf8').includes('prompt_delivery: needs-attention')){earlyAttention=true;break;}await pause(150);}
    check(`P ${agent}/${mode}: uncertainty warning, no immediate attention`,(uncertainty||sent())&&!earlyAttention);
    if(mode==='hook') {
     const until=Date.now()+25000;while((!sent()||!entries().some(e=>e.hook===0))&&Date.now()<until)await pause(150);
     check(`P ${agent}: actual generated hook/notify confirms in watch`,sent()&&entries().some(e=>e.hook===0));
     const follow=await call('send',{task:'T1',text:'Follow-up prompt'});
     check(`P ${agent}: send succeeds while acknowledgement pending`,!follow.error);
     const end=Date.now()+25000;while((!sent()||entries().filter(e=>e.hook===0).length<2)&&Date.now()<end)await pause(150);
     check(`P ${agent}: send acknowledged once by current hook/notify`,sent()&&entries().filter(e=>e.paste).length===2 && entries().filter(e=>e.hook===0).length===2);
    } else {
     const until=Date.now()+25000;while(!fs.readFileSync(taskFile,'utf8').includes('prompt_delivery: needs-attention')&&Date.now()<until)await pause(150);
     check(`P ${agent}: watch resolves no evidence to attention`,JSON.parse(h.agentctl(['status','--json']).stdout)[0]?.state==='needs-attention');
     fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
     const end=Date.now()+15000;while(!sent()&&Date.now()<end)await pause(150);
     check(`P ${agent}: late canonical report clears durable attention`,sent()&&JSON.parse(h.agentctl(['status','--json']).stdout)[0]?.state==='report-ready');
     check(`P ${agent}: late report reaches pull_ready`,(await call('pull_ready')).text.includes('Werdykt: PASS'));
     let events='';const journalDeadline=Date.now()+15000;while(Date.now()<journalDeadline){events=(await call('events_since',{since:'1h',peek:true})).text;if(events.includes('RAPORT  T1  Werdykt: PASS')&&events.includes('wszystkie raporty gotowe'))break;await pause(150);}
     check(`P ${agent}: late report reaches events and cohort-done`,events.includes('RAPORT  T1  Werdykt: PASS')&&events.includes('wszystkie raporty gotowe'));
     check(`P ${agent}: no repeated paste during resolution`,entries().filter(e=>e.paste).length===1);
    }
   }
  } finally { if(watcher){watcher.kill('SIGTERM');await new Promise(resolve=>watcher!.once('close',resolve));} await client.close(); }
 });
}
fs.writeFileSync(path.join(defaultCacheRoot('agentctl-0173'),'p-live-results.json'),JSON.stringify({passed:checks.length,failed:0,checks},null,2)+'\n');
console.log(`${checks.length}/${checks.length} FIX2 P checks passed`);
