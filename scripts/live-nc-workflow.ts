import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import YAML from 'yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withHarness, defaultCacheRoot } from './live-harness.ts';
import type { Harness } from './live-harness.ts';
import { loadGlobalConfig } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { RealRunner } from '../src/core/runner.ts';
import type { ExecOptions } from '../src/core/runner.ts';
import { readTaskRecord, renderTaskMd, taskFile } from '../src/core/taskstore.ts';
import type { TaskRecord } from '../src/core/taskstore.ts';
import { readOutputs } from '../src/core/outputs.ts';
import { collectStatus } from '../src/core/status.ts';
import { readQueue, validateAccepted } from '../src/core/queue.ts';
import { readJournal } from '../src/core/journal.ts';
import { cohortTick } from '../src/core/cohort.ts';
import { limitedTick } from '../src/core/limited.ts';
import { readHistory } from '../src/core/history.ts';
import { applyNavigation } from '../src/core/navigation.ts';
import { sendPrompts } from '../src/core/send.ts';
import { queuePrompt, deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import { setHeaderFields } from '../src/core/taskstore.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Alerts } from '../src/core/alert.ts';
import { mcpWriteNotice } from '../src/core/mcp-notify.ts';
import { recordStaleCapacity } from '../src/core/capacity-events.ts';
import type { PlanState } from '../src/core/usage.ts';

const cache = defaultCacheRoot('agentctl-0174'), results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { results.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); assert.ok(ok, name); };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Wait for a condition instead of a fixed sleep: PTY clients attach and keys arrive later on a loaded machine. */
const until = async (condition: () => boolean, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (condition()) return true; await pause(50); } return condition(); };
class SandboxRunner extends RealRunner {
  readonly harness: Harness;
  constructor(harness: Harness) { super(); this.harness = harness; }
  override exec(cmd: string, args: string[], opts: ExecOptions = {}) { this.harness.check(); return super.exec(cmd, args, { ...opts, env: this.harness.env }); }
}
const plan = (now: number, used = 100, reset: number | null = now + 60000) => Object.fromEntries(['claude', 'codex'].map(provider => [provider, { provider, available: true, readAt: now, planType: null, windows: [{ kind: 'session', label: '5h', minutes: 300, usedPercent: used, resetsAt: reset }], maxPercent: used, note: '', stale: false }])) as Record<'claude' | 'codex', PlanState>;

await withHarness({ name: 'nc-workflow', cacheRoot: cache, config: 'watch: {interval: 1}\nreport: {settle_s: 0}\nqueue: {enabled: false}\ncohort: {done_grace_s: 0}\ncapacity: {snapshot: false, codex_refresh: false}\noverload: {retry_after: 1, max_retries: 2, give_up_after: 30}\ndelivery_confirm_s: 1\nmcp: {max_response_kb: 8, allow: [new, queue, queue_rm, send, mark, close, hide, unhide, cohort_add, cohort_remove, cohort_note, unblock, notify_test, adopt, archive, gc]}\n' }, async h => {
  const config = loadGlobalConfig(h.agentctlHome), runner = new SandboxRunner(h), ctx = new Context(runner, config, () => {}), notices: string[] = [];
  const notifier = { notify: async (_title: string, text: string) => { notices.push(text); } };
  const repo = path.join(h.root, 'repo'); fs.mkdirSync(repo);
  const git = (cwd: string, args: string[]) => { const r = spawnSync('git', args, { cwd, env: h.env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git(repo, ['init', '-qb', 'main']); git(repo, ['commit', '--allow-empty', '-qm', 'baseline']); const base = git(repo, ['rev-parse', 'HEAD']);
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', path.resolve(import.meta.dirname, '../bin/agentctl.ts'), 'mcp'], env: h.env as Record<string, string>, stderr: 'pipe' });
  const client = new Client({ name: 'nc-workflow', version: '1' }); await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }); let text = (response.content as { text: string }[]).map(c => c.text).join('\n');
    const wire = JSON.stringify(response); check(`bounded MCP ${name}`, Buffer.byteLength(wire) <= 8192);
    if (text.startsWith('{"response_id"')) {
      let page = JSON.parse(text), all = page.fragment;
      while (page.has_more) { const r = await client.callTool({ name: 'response_page', arguments: { response_id: page.response_id, response_offset: page.next_response_offset } }); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 8192); page = JSON.parse((r.content as { text: string }[])[0]!.text); all += page.fragment; }
      text = all;
    }
    return { text, error: response.isError };
  };
  const spec = (task: string, header: Record<string, unknown> = {}) => `---\n${YAML.stringify({ task, agent: 'claude', model: 'claude-sonnet-5-5', effort: 'medium', cohort: 'NC', repos: [{ path: repo, worktree: path.join(h.root, 'wt', task.toLowerCase()), branch: task.toLowerCase(), base: 'main' }], ...header })}---\nFake work ${task}.\n`;
  const record = (task: string) => readTaskRecord(config, task.toLowerCase())!;
  const writeReport = (task: string, sha: string, changes: Record<string, unknown> = {}) => {
    const r = record(task); fs.mkdirSync(path.dirname(r.report), { recursive: true });
    fs.writeFileSync(r.report, 'Werdykt: ' + String(changes.verdict ?? 'PASS') + '\n```agentctl-outputs\n' + YAML.stringify({ version: 1, verdict: 'PASS', commits: [{ repo: 'repo', branch: 'author', sha }], integrate: [{ repo: 'repo', branch: 'author', sha, note: 'proposed' }], decisions: ['Choose deployment time'], actions: [{ title: 'Deploy', shell: 'echo never executed' }], checks: ['fixture: PASS'], ...changes }) + '```\n<!-- agentctl:report-end -->\n');
  };
  const attached: ReturnType<typeof spawn>[] = [];
  try {
    // P34: MCP confirm only registers with the watcher and this sandbox drives ticks in process with the queue off; starts use the in-place CLI new.
    const order = spec('AUTHOR', { review: { rerun: true } }); await call('new', { spec: order }); const started = h.agentctl(['new', '-', '--json'], { input: order }); check('author with auto review starts on fake agent', started.code === 0 && JSON.parse(started.stdout).results.some((r: { task: string; agentStarted: boolean }) => r.task === 'AUTHOR' && r.agentStarted));
    check('author TASK.md freezes initial base before work', record('AUTHOR').repos[0]?.base === base);
    const wt = record('AUTHOR').repos[0]!.worktree; git(wt, ['commit', '--allow-empty', '-qm', 'author result']); const first = git(wt, ['rev-parse', 'HEAD']); writeReport('AUTHOR', first);
    const event = h.agentctl(['event', '--task', 'AUTHOR', '--agent', 'claude', '--kind', 'stop'], { input: '{}' }); check('real hook creates automatic review', event.code === 0 && readQueue(config).some(e => e.task === 'AUTHOR-REV'));
    const rev = readQueue(config).find(e => e.task === 'AUTHOR-REV')!; const parsed = splitHeader(rev.spec); const reviewRepo = (parsed.repos as { branch?: string; worktree: string; base: string }[])[0]!; check('review provider differs, own detached checkout (no author branch), cohort and dependency match author', rev.agent === 'codex' && rev.cohort === 'NC' && rev.after[0] === 'AUTHOR' && reviewRepo.branch === undefined && /-author-rev$/.test(reviewRepo.worktree) && !rev.reuse);
    check('same report hook does not duplicate review', h.agentctl(['event', '--task', 'AUTHOR', '--agent', 'claude', '--kind', 'stop'], { input: '{}' }).code === 0 && readQueue(config).length === 1);
    const status = JSON.parse((await call('status', { format: 'json', all: true })).text); check('status counts report decisions/actions', status.tasks.find((r: { task: string }) => r.task === 'AUTHOR').decisions === 1);
    // Concise by default: the summary renders the validated outputs (verdict/decisions/actions/SHA); the outputs_valid flag is behind detail.
    const outputs = await call('pull_ready'); check('pull_ready includes validated structured outputs', outputs.text.includes('verdict: PASS') && outputs.text.includes('decisions: Choose deployment time') && outputs.text.includes('actions: Deploy') && outputs.text.includes(first));
    // Before the whole-file get_report marks AUTHOR pulled (P71 omits pulled outputs from needYou).
    const events1 = await call('events_since', { format: 'json' }); const events2 = await call('events_since', { format: 'json' }); check('new decisions/actions appear once per report in needYou', events1.text.includes('decision: Choose deployment time') && !events2.text.includes('decision: Choose deployment time'));
    const get = await call('get_report', { task: 'AUTHOR', detail: true }); check('get_report includes outputs validity', get.text.includes('"outputs_valid":true'));
    const cohort = JSON.parse((await call('cohort_show', { cohort: 'nc', format: 'json' })).text); check('cohort aggregates proposed integration/actions with source IDs', cohort.integrate[0].task === 'AUTHOR' && cohort.actions[0].task === 'AUTHOR');
    fs.writeFileSync(path.join(cache, 'nc-example-outputs.json'), JSON.stringify({ ...await readOutputs(ctx, record('AUTHOR')), cohort_show: cohort }, null, 2));
    const dependent = spec('DEPENDENT', { after: [{ task: 'AUTHOR', verdict: 'FAIL' }] }); await call('queue', { spec: dependent }); await call('queue', { spec: dependent, confirm: true });
    // P93: the confirm records the spec as accepted; the watcher's tick validates it (this sandbox drives that half in process, the queue is off).
    await validateAccepted(ctx, notifier);
    check('verdict condition blocks despite a complete author report', (await call('queue_list')).text.includes('verdict PASS'));
    const unblock = await call('unblock', { task: 'DEPENDENT' }); check('unblock preview states blocked and exact dependency', !unblock.error && unblock.text.includes('"state": "blocked"') && unblock.text.includes('AUTHOR'));
    const baseSpec = spec('FROM-AUTHOR', { repos: [{ path: repo, worktree: path.join(h.root, 'wt/from-author'), branch: 'from-author', base: '@AUTHOR:repo' }] }); const basePreview = await call('new', { spec: baseSpec }); check('base reference preview resolves exact output commit', basePreview.text.includes(first) && basePreview.text.includes('@AUTHOR:repo'));
    check('base reference start succeeds', h.agentctl(['new', '-', '--json'], { input: baseSpec }).code === 0); check('base reference saved in TASK.md', record('FROM-AUTHOR').repos[0]?.base === first);
    git(wt, ['commit', '--allow-empty', '-qm', 'author followup']); const second = git(wt, ['rev-parse', 'HEAD']); writeReport('AUTHOR', second, { notes: ['second report'] }); h.agentctl(['event', '--task', 'AUTHOR', '--agent', 'claude', '--kind', 'stop'], { input: '{}' });
    const rev2 = readQueue(config).find(e => e.task === 'AUTHOR-REV2'); check('new report queues REV2 with previous review SHA as delta base', rev2?.spec.includes(first) && rev2.spec.includes(second));
    const p1 = await call('hide', { tasks: ['AUTHOR'] }), p2 = await call('hide', { tasks: ['FROM-AUTHOR'] });
    check('independent preview one confirmed after preview two', !(await call('hide', { tasks: ['AUTHOR'], preview_token: /preview_token: ([\da-f-]+)/.exec(p1.text)![1], confirm: true })).error);
    check('independent preview two remains valid', !(await call('hide', { tasks: ['FROM-AUTHOR'], preview_token: /preview_token: ([\da-f-]+)/.exec(p2.text)![1], confirm: true })).error);
    check('missing state hide fails in preview', (await call('hide', { tasks: ['MISSING'] })).error);
    const mark = await call('mark', { cohort: 'NC', result: 'ok' }); check('batch mark preview is exact author/base task range', mark.text.includes('AUTHOR') && mark.text.includes('FROM-AUTHOR') && !mark.text.includes('DEPENDENT'));
    check('batch mark confirmed records two user marks only', !(await call('mark', { cohort: 'NC', result: 'ok', confirm: true })).error && readHistory(config).filter(r => r.event === 'mark').length === 2);
    const gc = await call('gc_preview', { cohort: 'NC' }); check('GC permission description allows chat cleanup and keeps foreign paths out', !gc.text.includes('chat cannot clean up'));
    for (const e of readQueue(config)) { await call('queue_rm', { task: e.task }); await call('queue_rm', { task: e.task, confirm: true }); }
    await cohortTick(ctx, notifier, await collectStatus(ctx, { archived: true })); // the cohort is seen open first: only cohorts closing afterwards get a suggestion
    await call('close', { cohort: 'NC' }); await call('close', { cohort: 'NC', confirm: true });
    // Under gate load the confirm can return a budget partial while the close is still applying; wait for the records before the tick.
    const closedEnd = Date.now() + 15000;
    while (Date.now() < closedEnd && (await collectStatus(ctx, { archived: true })).some(r => r.cohort === 'NC' && !r.closed && !r.cancelled)) await pause(200);
    await cohortTick(ctx, notifier, await collectStatus(ctx, { archived: true })); await cohortTick(ctx, notifier, await collectStatus(ctx, { archived: true }));
    check('closed cohort suggests GC once and never deletes automatically', readJournal(config).filter(e => e.kind === 'gc_suggest').length === 1 && fs.existsSync(wt));
    const foreign = path.join(h.root, 'foreign-checkout'); git(repo, ['worktree', 'add', '--detach', foreign, 'main']); const scoped = await call('gc_preview', { cohort: 'NC' }); check('scoped GC reports foreign worktrees by count only', scoped.text.includes('foreignWorktrees') && !scoped.text.includes(foreign));
    await call('gc', { cohort: 'NC' }); const cleaned = await call('gc', { cohort: 'NC', confirm: true }); check('confirmed GC returns results without repeating plan', !cleaned.error && !cleaned.text.includes('"plan"') && cleaned.text.includes('"done"'));

    // Two real sessions on the same isolated server share the root dispatcher binding.
    h.tmux(['new-session', '-d', '-s', 'second-dev', '-n', 'board']); h.tmux(['new-window', '-t', 'second-dev', '-n', 'task']);
    if (h.tmux(['has-session', '-t', h.session]).code !== 0) h.tmux(['new-session', '-d', '-s', h.session, '-n', 'board']);
    else if (!h.tmux(['list-windows', '-t', h.session, '-F', '#{window_name}']).stdout.includes('board')) h.tmux(['new-window', '-t', h.session, '-n', 'board']);
    h.tmux(['bind-key', '-n', 'F12', 'if-shell', '-F', `#{==:#{session_name},${h.session}}`, `select-window -t '=${h.session}:board'`, 'send-keys F12']);
    const devConfig = { ...config, session: 'second-dev' }; await applyNavigation(new Context(runner, devConfig, () => {}));
    const binding = h.tmux(['list-keys', '-T', 'root', 'F12']).stdout;
    check('F12 shared binding dispatches on per-session option without production collision', binding.includes('@agentctl-return-key') && !h.tmux(['show-option', '-qv', '-t', h.session, '@agentctl-return-key']).stdout.trim() && h.tmux(['show-option', '-v', '-t', 'second-dev', '@agentctl-return-key']).stdout.trim() === 'F12');
    h.tmux(['new-window', '-t', h.session, '-n', 'navigation-task']);
    for (const session of [h.session, 'second-dev']) {
      h.tmux(['select-window', '-t', `=${session}:${session === h.session ? 'navigation-task' : 'task'}`]);
      const terminal = spawn('/usr/bin/python3', ['-c', "import os,pty,select,sys,fcntl,termios,struct,signal\npid,fd=pty.fork()\nif pid==0: os.execv(sys.argv[1],[sys.argv[1],'attach-session','-t',sys.argv[2]])\nfcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',32,160,0,0))\ntry:\n while True:\n  for source in select.select([0,fd],[],[])[0]:\n   data=os.read(source,65536)\n   if not data: raise EOFError()\n   if source==0: os.write(fd,data)\nexcept (EOFError,OSError): pass\nfinally:\n os.close(fd)\n try: os.kill(pid,signal.SIGTERM)\n except ProcessLookupError: pass\n os.waitpid(pid,0)\n", path.join(h.fakeBin, 'tmux'), `=${session}`], { env: h.env, stdio: ['pipe', 'ignore', 'ignore'] });
      attached.push(terminal);
      check(`PTY client attached to ${session}`, await until(() => h.tmux(['list-clients', '-t', `=${session}`, '-F', '#{client_name}']).stdout.trim() !== ''));
    }
    const windowOf = (session: string) => h.tmux(['display-message', '-p', '-t', `=${session}:`, '#{window_name}']).stdout.trim();
    attached[0]!.stdin!.write('\x1b[24~'); await until(() => windowOf(h.session) === 'board');
    check('actual F12 in first client selects only its board', h.tmux(['display-message', '-p', '-t', `=${h.session}:`, '#{window_name}']).stdout.trim() === 'board' && h.tmux(['display-message', '-p', '-t', '=second-dev:', '#{window_name}']).stdout.trim() === 'task');
    attached[1]!.stdin!.write('\x1b[24~'); await until(() => windowOf('second-dev') === 'board');
    check('actual F12 in second client selects second board', h.tmux(['display-message', '-p', '-t', '=second-dev:', '#{window_name}']).stdout.trim() === 'board');
    const mode = path.join(h.root, 'pane-mode'), inputLog = path.join(h.root, 'pane-input.log'), fake = path.join(h.root, 'pane.mjs'); fs.writeFileSync(mode, 'limited');
    const composerBorder = fs.readFileSync(path.resolve(import.meta.dirname, '../tests/fixtures/screen-claude-busy-paste.txt'), 'utf8').split('\n').find(line => /^─+$/.test(line))!;
    fs.writeFileSync(fake, `import fs from 'node:fs';let mode='',draft='',stream='',queued='',working=false;const file=${JSON.stringify(mode)},log=${JSON.stringify(inputLog)};const draw=()=>{const m=fs.readFileSync(file,'utf8');mode=m;process.stdout.write('\\x1b[2J\\x1b[H'+(m==='limited'?"You've hit your session limit\\n":m==='busy'?'Working (esc to interrupt)\\n':'')+(queued?'Queued follow-up inputs\\n'+queued+'\\n':'')+${JSON.stringify(composerBorder)}+'\\n❯ '+(m==='draft'?'unsent draft':draft)+'\\n'+${JSON.stringify(composerBorder)}+'\\n');};process.stdout.write('\\x1b[?2004h');process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',b=>{stream+=b.toString();for(;;){if(stream.startsWith('\\x1b[200~')){const end=stream.indexOf('\\x1b[201~');if(end<0)return;draft=stream.slice(6,end);stream=stream.slice(end+6);fs.appendFileSync(log,JSON.stringify({paste:draft})+'\\n');draw();continue;}if(!stream.length)return;if(stream.startsWith('\\x1b')&&stream.length<6)return;const c=stream[0];stream=stream.slice(1);if(c==='\\r'||c==='\\n'){fs.appendFileSync(log,JSON.stringify({enter:true})+'\\n');if(mode!=='stuck'){queued=draft;draft='';}draw();}}});setInterval(()=>{const m=fs.readFileSync(file,'utf8');if(m!==mode){draft='';queued='';draw();}},80);draw();`);
    h.tmux(['new-window', '-t', h.session, '-n', 'limited-live', `${process.execPath} ${fake}`]); await pause(300);
    const pane = (await ctx.tmux.windows()).find(w => w.plain === 'limited-live')!;
    const seed: TaskRecord = { task: 'LIMITED-LIVE', window: 'limited-live', windowId: pane.id, session: h.session, agent: 'claude', model: 'sonnet', effort: 'medium', repos: [], links: [], env: {}, report: path.join(config.cache, 'LIMITED-LIVE.md'), started: new Date(Date.now() - 60000).toISOString(), requested: { agent: 'claude', model: 'sonnet', effort: 'medium' } };
    fs.mkdirSync(path.dirname(taskFile(config, seed.window)), { recursive: true }); fs.writeFileSync(taskFile(config, seed.window), renderTaskMd(seed, 'Fake original'));
    let reading = plan(Date.now()); await limitedTick(ctx, await collectStatus(ctx), notifier, reading); await limitedTick(ctx, await collectStatus(ctx), notifier, reading); check('limit notice once per real-window episode', notices.filter(n => n.startsWith('claude: limit wyczerpany')).length === 1);
    fs.writeFileSync(mode, 'draft'); await pause(200); await limitedTick(ctx, await collectStatus(ctx), notifier, plan(Date.now(), 90)); check('limit resume protects human draft', !fs.existsSync(inputLog));
    fs.writeFileSync(mode, 'limited'); await pause(200); await limitedTick(ctx, await collectStatus(ctx), notifier, plan(Date.now(), 90)); check('limit recovery pastes continue into same provider/model', fs.readFileSync(inputLog, 'utf8').includes('kontynuuj') && readTaskRecord(config, seed.window)?.model === 'sonnet');
    fs.writeFileSync(mode, 'busy'); await pause(200); const sent = await sendPrompts(ctx, [{ task: seed.task, window: seed.window, prompt: 'Followup while working' }]); check('busy followup is pasted immediately; real queue echo leaves it unconfirmed', Boolean(sent[0]?.warning) && Boolean(sent[0]?.message.includes('wklejono')) && readTaskRecord(config, seed.window)?.pendingPrompt === 'Followup while working');
    await handleEvent(ctx, new Alerts(ctx, notifier), { task: seed.task, agent: 'claude', kind: 'user-prompt-submit', payload: { prompt: 'Followup while working' } });
    check('busy followup is confirmed by the current matching hook', await deliverPendingPrompt(ctx, seed.window) === 'sent');
    const before = fs.readFileSync(inputLog, 'utf8').split('\n').filter(l => l.includes('paste')).length; await sendPrompts(ctx, [{ task: seed.task, window: seed.window, prompt: 'Second busy followup' }]); check('second busy followup accepted without rejection/duplicate paste', fs.readFileSync(inputLog, 'utf8').split('\n').filter(l => l.includes('paste')).length === before + 1);
    fs.writeFileSync(mode, 'stuck'); await pause(200); await queuePrompt(ctx, readTaskRecord(config, seed.window)!, 'Stuck message'); await deliverPendingPrompt(ctx, seed.window); await handleEvent(ctx, new Alerts(ctx, notifier), { task: seed.task, agent: 'claude', kind: 'notification', payload: { notification_type: 'idle_prompt' } }); await pause(1100); check('idle_prompt never confirms stuck real composer', await deliverPendingPrompt(ctx, seed.window) === 'needs-attention');
    config.notify.mcpWritesIntervalS = 1; const notifications: string[] = [], notice = async (text: string) => { notifications.push(text); }; await mcpWriteNotice(ctx, notice, 'one'); await mcpWriteNotice(ctx, notice, 'two'); await mcpWriteNotice(ctx, notice, 'three'); await pause(1100); await mcpWriteNotice(ctx, notice); check('MCP notifications aggregate while preserving writes', notifications.length === 2 && notifications[1]?.includes('two; three'));
    const stalePlans = plan(Date.now() - 3600000); await recordStaleCapacity(ctx, stalePlans); await recordStaleCapacity(ctx, stalePlans); check('stale plan event once per reading with live task', readJournal(config).filter(e => e.text.includes('claude: plan reading stale')).length === 1);
    // N1 (live, real tmux): a review record is resumed only through the one door - refused while it shares the author's checkout/report, in its own checkout otherwise.
    {
      const authorWt = path.join(h.root, 'wt', 'iso-author'), ownWt = path.join(h.root, 'wt', 'iso-author-rev'); git(repo, ['worktree', 'add', '-q', '-b', 'iso-author', authorWt]); git(repo, ['worktree', 'add', '-q', '--detach', ownWt]);
      const stamp = new Date(Date.now() - 60000).toISOString(), reportOf = (t: string) => path.join(config.cache, t.toLowerCase(), `${t}.md`);
      const mk = (over: Partial<TaskRecord> & { task: string; window: string }): TaskRecord => ({ session: h.session, agent: 'claude', model: 'sonnet', effort: 'medium', repos: [{ path: repo, worktree: authorWt, branch: 'iso-author', base }], links: [], env: {}, report: reportOf(over.task), started: stamp, requested: { agent: 'claude', model: 'sonnet', effort: 'medium' }, ...over });
      const put = (r: TaskRecord) => { fs.mkdirSync(path.dirname(taskFile(config, r.window)), { recursive: true }); fs.writeFileSync(taskFile(config, r.window), renderTaskMd(r, `Prompt of ${r.task}`)); };
      const author = mk({ task: 'ISO-AUTHOR', window: 'iso-author', closed: true, closedAt: stamp }); put(author); fs.mkdirSync(path.dirname(author.report), { recursive: true }); fs.writeFileSync(author.report, 'Werdykt: PASS\n<!-- agentctl:report-end -->\n');
      const authorBytes = fs.readFileSync(author.report, 'utf8');
      put(mk({ task: 'ISO-AUTHOR-REV', window: 'iso-author-rev', agent: 'codex', model: 'gpt-6-astra', reviewOf: 'ISO-AUTHOR', report: author.report }));
      const refused = h.agentctl(['resume', 'ISO-AUTHOR-REV', '--yes']);
      check('legacy review record: resume refused before any window', refused.code !== 0 && /stary rekord przeglądu/.test(`${refused.stdout}${refused.stderr}`) && h.tmux(['list-windows', '-t', h.session, '-F', '#{window_name}']).stdout.split('\n').every(w => !w.includes('iso-author-rev')));
      check('refused resume leaves the author report and the record untouched', fs.readFileSync(author.report, 'utf8') === authorBytes && readTaskRecord(config, 'iso-author-rev')?.report === author.report);
      put(mk({ task: 'ISO-AUTHOR-REV', window: 'iso-author-rev', agent: 'codex', model: 'gpt-6-astra', reviewOf: 'ISO-AUTHOR', repos: [{ path: repo, worktree: ownWt, base }] }));
      const resumed = h.agentctl(['resume', 'ISO-AUTHOR-REV', '--yes']);
      const cwd = h.tmux(['display-message', '-p', '-t', `=${h.session}:iso-author-rev`, '#{pane_current_path}']).stdout.trim();
      check('review record with its own checkout resumes there (pane cwd is not the author worktree)', resumed.code === 0 && fs.realpathSync(cwd) === fs.realpathSync(ownWt) && fs.realpathSync(cwd) !== fs.realpathSync(authorWt));
    }
    // E1 (live, real tmux): Claude Code's dim suggestion in the empty field is not a draft; text somebody typed is. The screens are recorded from Claude Code 2.1.311, replayed with their colours.
    {
      const fixtures = path.resolve(import.meta.dirname, '../tests/fixtures'), stamp = new Date(Date.now() - 60000).toISOString();
      for (const [task, file] of [['SUGGEST', 'screen-claude-suggestion-ansi.txt'], ['TYPED', 'screen-claude-draft-ansi.txt']] as const) {
        const window = task.toLowerCase();
        h.tmux(['new-window', '-d', '-t', h.session, '-n', window, `sh -c 'cat ${path.join(fixtures, file)}; sleep 600'`]);
        const pane = (await ctx.tmux.windows()).find(w => w.plain === window)!;
        const seed: TaskRecord = { task, window, windowId: pane.id, session: h.session, agent: 'claude', model: 'haiku', effort: 'low', repos: [], links: [], env: {}, report: path.join(config.cache, `${task}.md`), started: stamp, requested: { agent: 'claude', model: 'haiku', effort: 'low' } };
        fs.mkdirSync(path.dirname(taskFile(config, window)), { recursive: true }); fs.writeFileSync(taskFile(config, window), renderTaskMd(seed, `Fixture ${task}`));
      }
      await pause(500);
      const rows = await collectStatus(ctx, { progress: false });
      check('real tmux: dim suggestion in the field is not a draft', rows.find(r => r.task === 'SUGGEST')?.draft_input === null);
      check('real tmux: text typed into the field is a draft', rows.find(r => r.task === 'TYPED')?.draft_input === 'my real draft');
    }
    const timed = path.join(h.root, 'timed.md'); fs.writeFileSync(timed, spec('TIMED', { cohort: 'Timing', setup: ['sleep 2'] }));
    const timedResult = h.agentctl(['new', timed, '-y']); const timedRecord = record('TIMED');
    check('real setup time is included before the agent starts', timedResult.code === 0 && Date.now() - Date.parse(timedRecord.started) >= 2000);
    fs.writeFileSync(path.join(cache, 'nc-live-journal.json'), JSON.stringify(readJournal(config), null, 2));
  } finally { for (const terminal of attached) { terminal.stdin?.write('\x02d'); terminal.stdin?.end(); } await client.close(); }
});
fs.writeFileSync(path.join(cache, 'nc-live-results.json'), JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, null, 2));
console.log(`${results.length}/${results.length} NC workflow live checks passed`);
function splitHeader(spec: string): Record<string, unknown> { return YAML.parse(spec.split('---')[1]!); }
