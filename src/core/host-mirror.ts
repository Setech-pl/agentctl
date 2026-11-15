import path from 'node:path';
import type { TaskRecord } from './taskstore.ts';

/** Remote reads stay bounded and select only this task's session, never a provider's other conversations. */
export function remoteMirrorScript(record: TaskRecord): string {
  const files = { report: record.remoteReport, receipt: path.posix.join(record.remoteDir!, 'receipt.json') };
  return `const fs=require('fs'),path=require('path'),os=require('os');
const record=${JSON.stringify({ agent: record.agent, env: record.env, repos: record.repos.map(r => r.worktree), attempt: record.attemptId, started: record.attemptStarted ?? record.started, dir: record.remoteDir })};
const files=${JSON.stringify(files)},out={};
const read=(f,max=16*1024*1024)=>{try{const st=fs.lstatSync(f);if(st.isFile()&&!st.isSymbolicLink()&&st.size<=max)return fs.readFileSync(f,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}};
for(const [key,file] of Object.entries(files)){const text=read(file);if(text!==undefined)out[key]=text}
let receipt;try{receipt=JSON.parse(out.receipt)}catch{}
const tail=file=>{const fd=fs.openSync(file,'r');try{const size=fs.fstatSync(fd).size,start=Math.max(0,size-4*1024*1024),buf=Buffer.alloc(size-start);fs.readSync(fd,buf,0,buf.length,start);const text=buf.toString('utf8');return start?text.slice(text.indexOf('\\n')+1):text}finally{fs.closeSync(fd)}};
const list=dir=>{try{return fs.readdirSync(dir,{withFileTypes:true})}catch{return []}};
if(receipt?.attempt===record.attempt && record.agent==='codex' && /^[a-zA-Z0-9-]+$/.test(receipt.session?.id||'')){
 const matches=[],root=path.join(record.env.CODEX_HOME||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions');
 const walk=(dir,depth)=>{if(depth>3)return;for(const e of list(dir)){const f=path.join(dir,e.name);if(e.isDirectory())walk(f,depth+1);else if(e.isFile()&&e.name.startsWith('rollout-')&&e.name.endsWith('-'+receipt.session.id+'.jsonl'))matches.push(f)}};walk(root,0);
 if(matches.length===1)out.transcript=tail(matches[0]);
}
if(record.agent==='kimi'){
 const home=record.env.KIMI_CODE_HOME||process.env.KIMI_CODE_HOME||path.join(os.homedir(),'.kimi-code'),root=path.join(home,'sessions'),matches=[];
 for(const workspace of list(root).filter(e=>e.isDirectory()))for(const session of list(path.join(root,workspace.name)).filter(e=>e.isDirectory())){
  const base=path.join(root,workspace.name,session.name);let meta;try{meta=JSON.parse(read(path.join(base,'state.json'),1024*1024))}catch{continue}
  if(meta.id!==session.name||!record.repos.includes(meta.cwd)||!Number.isFinite(meta.createdAt)||meta.createdAt<Date.parse(record.started)-60000)continue;
  const file=path.join(base,'agents/main/wire.jsonl');if(!fs.existsSync(file))continue;matches.push({file,id:meta.id});
 }
 const pin=path.join(record.dir,'wire-source.json');let selected;try{selected=JSON.parse(read(pin))}catch{}
 if(selected){if(!matches.some(m=>m.file===selected.file&&m.id===selected.id))selected=undefined}
 else if(matches.length===1){selected=matches[0];fs.writeFileSync(pin,JSON.stringify(selected),{mode:0o600})}
 if(selected){const header=read(selected.file,4*1024*1024);if(header!==undefined)out.wire=header;else{const fd=fs.openSync(selected.file,'r');try{const buf=Buffer.alloc(4096);const n=fs.readSync(fd,buf,0,buf.length,0);out.wire=buf.subarray(0,n).toString('utf8').split('\\n')[0]+'\\n'+tail(selected.file)}finally{fs.closeSync(fd)}}}
}
process.stdout.write(JSON.stringify(out));`;
}
