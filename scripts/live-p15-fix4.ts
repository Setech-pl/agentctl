import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import type { Harness } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { RealRunner } from '../src/core/runner.ts';
import { seedTask } from '../tests/helpers.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { deliverPendingPrompt, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { agentHomes, claudeProjectName } from '../src/core/usage-sources.ts';

// REV3 new-live.json: real tmux + fake TUI only, no real inference CLI.
const cache = defaultCacheRoot('p15-f4'), results: { name: string; ok: boolean; evidence: unknown }[] = [];
const pause = (n: number) => new Promise(r => setTimeout(r, n));
class R extends RealRunner {
  readonly h: Harness;
  constructor(h: Harness) { super(); this.h = h; }
  override exec(c: string, a: string[], o = {}) { this.h.check(); return super.exec(c, a, { ...o, env: this.h.env }); }
}
await withHarness({ name: 'r', cacheRoot: cache, config: 'capacity: {snapshot: false, codex_refresh: false}\n' }, async h => {
  const state = path.join(h.root, 'input.json'), log = path.join(h.root, 'keys.jsonl'), program = path.join(h.root, 'tui.mjs');
  const write = (field: string) => fs.writeFileSync(state, JSON.stringify({ field, seq: Date.now() + Math.random() })); write('');
  fs.writeFileSync(program, `import fs from 'node:fs';const file=${JSON.stringify(state)},log=${JSON.stringify(log)};let field='',seq=0,stream='';
const draw=()=>process.stdout.write('\\x1b[2J\\x1b[HWorking (esc to interrupt)\\r\\n────────────────────\\r\\n❯ '+field.replace(/\\n/g,'\\r\\n  ')+'\\r\\n────────────────────\\r\\n');
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[?2004h');setInterval(()=>{const s=JSON.parse(fs.readFileSync(file,'utf8'));if(s.seq!==seq){seq=s.seq;field=s.field;draw();}},20);
process.stdin.on('data',data=>{stream+=data.toString();for(;;){if(stream.startsWith('\\x1b[200~')){const end=stream.indexOf('\\x1b[201~');if(end<0)return;field=stream.slice(6,end).replace(/\\r\\n?/g,'\\n');stream=stream.slice(end+6);fs.appendFileSync(log,JSON.stringify({paste:field})+'\\n');draw();continue;}if(!stream.length)return;if(stream.startsWith('\\x1b')&&stream.length<6)return;const c=stream[0];stream=stream.slice(1);if(c==='\\r'||c==='\\n'){fs.appendFileSync(log,JSON.stringify({enter:true,field})+'\\n');draw();}}});`);
  h.tmux(['new-session', '-d', '-s', h.session, '-n', 't1', `${process.execPath} ${program}`]);
  h.tmux(['resize-window', '-t', h.session + ':t1', '-x', '200', '-y', '50']); await pause(300);
  const config = loadGlobalConfig(h.agentctlHome), runner = new R(h), ctx = new Context(runner, config, () => {});
  const id = h.tmux(['display-message', '-p', '-t', h.session + ':t1', '#{window_id}']).stdout.trim();
  const wt = path.join(h.root, 'wt');
  seedTask(config, 'T1', { agent: 'claude', windowId: id, repos: [{ path: wt, worktree: wt, branch: 'x' }] as never });
  const rec = () => readTaskRecord(config, 't1')!;
  const entries = (): { enter?: boolean; field?: string; paste?: string }[] => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const capture = () => h.tmux(['capture-pane', '-p', '-J', '-t', h.session + ':t1']).stdout;
  const check = (name: string, ok: boolean, evidence: unknown) => { results.push({ name, ok, evidence }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  await queuePrompt(ctx, rec(), 'ORIGINAL', 'pending', { kind: 'followup' }); await deliverPendingPrompt(ctx, 't1');
  const preview = await submitDraft(ctx, 't1'); assert.equal(preview.outcome, 'ready');
  write('ORIGINAL\n? for shortcuts\nUSER ADDED SECRET'); await pause(120); const screen = capture(), n = entries().length;
  const done = await submitDraft(ctx, 't1', { token: preview.token }); const keys = entries().slice(n);
  check('N3 live token confirm refuses body hidden behind footer', done.outcome === 'refused' && !keys.some(e => e.enter), { preview, done, keys, screen, record: rec() });
  write(''); await pause(120); await queuePrompt(ctx, rec(), 'FIRST LINE\n? for shortcuts\nORIGINAL BODY', 'pending', { kind: 'followup' });
  const before = entries().length, pending = deliverPendingPrompt(ctx, 't1');
  let end = Date.now() + 3000; while (!entries().slice(before).some(e => e.paste) && Date.now() < end) await pause(10);
  write('FIRST LINE\n? for shortcuts\nUSER REPLACED BODY'); await pending;
  const firstKeys = entries().slice(before);
  check('N3 live paste call refuses changed body before all three Enters', !firstKeys.some(e => e.enter), { keys: firstKeys, screen: capture(), record: rec() });
  write(''); await pause(120); await queuePrompt(ctx, rec(), 'OTHER TASK MESSAGE', 'pending', { kind: 'followup' }); const started = Date.now() - 500;
  await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(started).toISOString() });
  seedTask(config, 'T2', { agent: 'claude', windowId: '@999', repos: [{ path: wt, worktree: wt, branch: 'x' }] as never });
  const dir = path.join(agentHomes(config).claude, 'projects', claudeProjectName(wt)); fs.mkdirSync(dir, { recursive: true });
  const tx = path.join(dir, 'foreign-session.jsonl'); fs.writeFileSync(tx, JSON.stringify({ type: 'user', timestamp: new Date(started + 100).toISOString(), message: { role: 'user', content: 'OTHER TASK MESSAGE' } }) + '\n');
  await rememberSession(runner, config, 't2', 'claude', { id: 'foreign-session', transcript: tx }); const count = entries().length;
  const outcome = await deliverPendingPrompt(ctx, 't1');
  check('N1 live foreign T2 transcript cannot confirm T1', outcome !== 'sent' && rec().pendingPrompt === 'OTHER TASK MESSAGE' && entries().length === count, { outcome, keys: entries().slice(count), record: rec(), transcript: fs.readFileSync(tx, 'utf8') });
});
fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, 'fix4-live-results.json'), JSON.stringify(results, null, 2) + '\n');
assert.ok(results.every(r => r.ok), 'FIX4 live regressions failed');
console.log(`${results.length}/${results.length} FIX4 live regressions passed`);
