import { areaKey, inspectField } from '../src/core/input-field.ts';
import { readMcpRequests } from '../src/core/mcp-requests.ts';
import { writeHostsCache } from '../src/core/hosts.ts';
import { publishMcpSnapshot } from '../src/core/mcp-tools.ts';
import { setProviderHolds } from '../src/core/provider-hold.ts';
import { adoptTask } from '../src/core/adopt.ts';
import { findResumable, planResume, resumeTasks } from '../src/core/resume.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { it } from 'node:test';
import { MCP_TOOLS, applyMcpRequest } from '../src/core/mcp-tools.ts';
import { readJournal } from '../src/core/journal.ts';
import { Context } from '../src/core/context.ts';
import { newTasks } from '../src/core/new.ts';
import { answerMenu } from '../src/core/answer.ts';
import { closeTask } from '../src/core/close.ts';
import { planCancel, cancelTasks } from '../src/core/cancel.ts';
import { interruptTask } from '../src/core/interrupt.ts';
import { peekTask } from '../src/core/peek.ts';
import { sendPrompts } from '../src/core/send.ts';
import { collectStatus } from '../src/core/status.ts';
import { liveWindows, planBatch } from '../src/core/plan.ts';
import { queuePrompt, deliverPendingPrompt } from '../src/core/prompt-delivery.ts';
import { drainPromptQueue, readPromptQueue } from '../src/core/prompt-queue.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { resolveSpec, splitSpecs } from '../src/core/spec.ts';
import { describeQueue, planQueueAdd, commitQueueAdd, queueTick, QueueMemory, readQueue } from '../src/core/queue.ts';
import { syncRemoteFiles, remoteAttachHint } from '../src/core/host-runtime.ts';
import { remoteHookScript } from '../src/core/host-task.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { loadBoard, ProgressCache, runBoardEffect } from '../src/core/board.ts';
import { DiskRunner, FakeTmux, fakeWatcher, makeConfig, seedTask, useScratch } from './helpers.ts';
import { composerFixture, CODEX_COMPOSER_BOTTOM } from './composer-fixture.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';

const scratch = useScratch();
const SHA = 'a'.repeat(40);
const TRUST = 'Trust this folder?\nDo you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
const QUESTION = 'Run this command?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel\n';
const ready = (agent = 'claude', text = '') => {
  if (agent === 'codex') return ['› ' + text.split('\n')[0], ...text.split('\n').slice(1).map(l => '  ' + l), ...CODEX_COMPOSER_BOTTOM, ''].join('\n');
  if (agent !== 'kimi') return composerFixture(`${agent === 'codex' ? '›' : '❯'} ${text}\n`);
  const screen = fs.readFileSync(new URL('./fixtures/screen-kimi-01-start.txt', import.meta.url), 'utf8');
  const row = screen.split('\n').find(line => /^\s*│ >/.test(line))!;
  const lines = text.split('\n').flatMap(line => line ? line.match(new RegExp(`.{1,${row.length - 7}}`, 'gu'))! : ['']);
  return screen.replace(row, lines.map((line, i) => `${i ? ' │   ' : ' │ > '}${line}`.padEnd(row.length - 1) + '│').join('\n'));
};

/** Shell argv parser for the quoted command produced by HostRunner (no eval). */
function words(line: string): string[] {
  const result: string[] = []; let word = '', quote = '', active = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) { if (ch === quote) quote = ''; else if (ch === '\\' && quote === '"') word += line[++i] ?? ''; else word += ch; active = true; }
    else if (ch === "'" || ch === '"') { quote = ch; active = true; }
    else if (ch === '\\') { word += line[++i] ?? ''; active = true; }
    else if (/\s/.test(ch)) { if (active) { result.push(word); word = ''; active = false; } }
    else { word += ch; active = true; }
  }
  if (active) result.push(word);
  assert.equal(quote, '', 'balanced generated shell quoting');
  return result;
}

let serial = 0;
function world(agent = 'claude', extra = '') {
  const root = scratch.sub(`remote-${serial++}`), remoteHome = path.join(root, 'remote-home'), work = path.join(remoteHome, 'work'), clone = path.join(remoteHome, 'src/app');
  fs.mkdirSync(clone, { recursive: true });
  fs.writeFileSync(path.join(clone, '.agentctl.yaml'), 'setup: ["printf remote-setup > setup-proof"]\nenv: {REMOTE_PROJECT: yes}\n');
  const config = makeConfig(root, `providers: [claude, codex, kimi, glm]\nlimits: {claude: 3, codex: 3, kimi: 3, glm: 3}\ncancel: {grace: 0}\nhosts:\n  pc:\n    ssh: owner@fake-pc\n    work_dir: ${work}\n    repos: {app: ${clone}}\n    providers: [claude, codex, kimi, glm]\n    limits: {claude: 1, codex: 1, kimi: 1, glm: 1}\n    env: {HOST_MARKER: pc}\n${extra}`);
  const tmux = new FakeTmux('agentctl-pc'), localTmux = new FakeTmux(config.session);
  tmux.newWindowScreen = TRUST;
  const commands: string[][] = [], sshCalls: string[][] = [], envs: Record<string, string>[] = [], keys: string[] = [], pastes: string[] = [];
  let branchCreated = false;
  let offline = false, buffer = '', pasted = false, baseMissing = false, reportWrites = 0;
  const remoteRecords = () => fs.existsSync(config.stateDir) ? fs.readdirSync(config.stateDir).flatMap(name => { const r = readTaskRecord(config, name); return r?.host ? [r] : []; }) : [];
  const result = (code = 0, stdout = '', stderr = ''): ExecResult => ({ code, stdout, stderr });
  class FakeSSH extends DiskRunner {
    override async exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
      if (cmd !== 'ssh') {
        if (cmd === 'tmux') return { ...result(), ...localTmux.respond(cmd, args, opts) };
        if (cmd === 'git') return result(0, SHA);
        return super.exec(cmd, args, opts);
      }
      await super.exec(cmd, args, opts);
      sshCalls.push(args);
      if (offline) return result(255, '', 'ssh: Connection refused');
      const argv = words(args.at(-1)!);
      const remoteEnv: Record<string, string> = { HOME: remoteHome, PATH: process.env.PATH! };
      while (argv[0] === 'export') {
        argv.shift(); const item = argv.shift()!.replace(/;$/, ''), at = item.indexOf('='); remoteEnv[item.slice(0, at)] = item.slice(at + 1);
      }
      let cwd: string | undefined;
      if (argv[0] === 'cd') { argv.shift(); cwd = argv.shift(); assert.equal(argv.shift(), '&&'); }
      const command = argv.shift()!;
      commands.push([command, ...argv]); envs.push(remoteEnv);
      if (command === 'git') {
        const rest = argv.slice(2);
        if (rest[0] === 'fetch') return result();
        if (rest[0] === 'worktree' && rest[1] === 'add') {
          branchCreated = true;
          const at = rest.indexOf('-b');
          const wt = at >= 0 ? rest[at + 2]! : rest[2] === '--detach' ? rest[3]! : rest[2]!;
          fs.mkdirSync(wt, { recursive: true });
          fs.copyFileSync(path.join(clone, '.agentctl.yaml'), path.join(wt, '.agentctl.yaml'));
          return result();
        }
        if (rest[0] === 'show-ref') return result(branchCreated ? 0 : 1);
        if (rest[0] === 'symbolic-ref') return rest.at(-1) === 'refs/remotes/origin/HEAD' ? result(0, 'origin/remote-default\n') : result(0, 'remote-feature\n');
        if (rest[0] === 'rev-parse') return baseMissing ? result(1) : result(0, SHA);
        if (rest[0] === 'status') return result();
        if (rest[0] === 'diff') return result();
        return result();
      }
      if (command === 'tmux') {
        const target = argv[argv.indexOf('-t') + 1] ?? '', win = tmux.find(target);
        if (argv[0] === 'set-option' && argv.includes('@agentctl-role') && win) { win.role = argv.at(-1); return result(); }
        if (argv[0] === 'load-buffer') { buffer = opts.input!; return result(); }
        if (argv[0] === 'paste-buffer') { pasted = true; pastes.push(buffer); if (win) win.screen = ready(agent, buffer); return result(); }
        if (argv[0] === 'send-keys') {
          const key = argv.at(-1)!; keys.push(key);
          if (/^[123]$/.test(key) && win) win.screen = ready(agent);
          if ((key === 'Enter' || key === 'C-m') && pasted && win) {
            pasted = false; win.screen = ready(agent).replace(/^/, 'Working (esc to interrupt)\n');
            const record = remoteRecords().find(r => r.window === win.name || r.windowId === win.id)!;
            const dir = record.remoteDir!;
            if (agent === 'claude' || agent === 'glm') execFileSync(process.execPath, [path.join(dir, 'event.cjs'), 'event', '--kind', 'user-prompt-submit'], { input: JSON.stringify({ prompt: buffer }), env: remoteEnv });
            if (agent === 'codex') {
              const folder = path.join(remoteHome, '.codex/sessions'); fs.mkdirSync(folder, { recursive: true });
              fs.writeFileSync(path.join(folder, 'rollout-test-thread-1.jsonl'), JSON.stringify({ timestamp: new Date(this.now()).toISOString(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: buffer }] } }) + '\n');
              fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify({ attempt: record.attemptId, session: { id: 'thread-1' } }));
            }
            if (agent === 'kimi') {
              const base = path.join(remoteHome, '.kimi-code/sessions/workspace/session-1'); fs.mkdirSync(path.join(base, 'agents/main'), { recursive: true });
              fs.writeFileSync(path.join(base, 'state.json'), JSON.stringify({ id: 'session-1', cwd: record.repos[0]!.worktree, createdAt: this.now() }));
              fs.writeFileSync(path.join(base, 'agents/main/wire.jsonl'), [JSON.stringify({ protocol_version: '1.5' }), JSON.stringify({ timestamp: new Date(this.now()).toISOString(), type: 'turn.prompt', data: { prompt: buffer } })].join('\n') + '\n');
            }
            return result();
          }
        }
        return { ...result(), ...tmux.respond(command, argv, opts) };
      }
      if (['claude', 'codex', 'kimi', 'claude-glm'].includes(command)) return result(0, 'fake-agent 1.0\n');
      if (command === 'node' && argv[0] === '-e' && argv[1]?.includes('statfsSync')) {
        assert.equal(argv[2], work);
        return result(0, '256\n');
      }
      try {
        const out = execFileSync(command === 'node' ? process.execPath : command, argv, { cwd, env: remoteEnv, input: opts.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        return result(0, out);
      } catch (error) { const e = error as { status: number; stdout: string; stderr: string }; return result(e.status ?? 1, String(e.stdout ?? ''), String(e.stderr ?? '')); }
    }
    override async writeFile(file: string, text: string): Promise<void> { if (file.endsWith('/R-1.md')) reportWrites++; await super.writeFile(file, text); }
  }
  const runner = new FakeSSH({ dryRun: false });
  const out: string[] = [], ctx = new Context(runner, config, s => out.push(s));
  const spec = (task = 'R-1', extra = '') => resolveSpec(splitSpecs(`---\ntask: ${task}\n${extra}\nhost: pc\nagent: ${agent}\nmodel: ${agent === 'codex' ? 'gpt-6.1-sol' : agent === 'kimi' ? 'k3' : agent === 'glm' ? 'glm-5.3' : 'opus'}\neffort: high\nrepos: [{path: app, base: origin/main, branch: remote-feature}]\n---\nRun a deterministic remote task.`)[0]!, { config });
  return { ctx, config, runner, tmux, localTmux, commands, sshCalls, envs, keys, pastes, out, work, clone, remoteHome, spec, record: () => readTaskRecord(config, 'r-1')!, offline: (v: boolean) => { offline = v; }, missingBase: () => { baseMissing = true; }, writes: () => reportWrites };
}

async function startAtTrust(w: ReturnType<typeof world>) {
  await assert.rejects(newTasks(w.ctx, [w.spec()], { waitTrust: false }), /waits for folder trust/);
  assert.equal(w.pastes.length, 0);
  assert.equal(w.record().host, 'pc');
  assert.equal(w.record().session, 'agentctl-pc');
  assert.equal((await collectStatus(w.ctx, { progress: false }))[0]!.state, 'needs-trust');
}
async function acceptTrust(w: ReturnType<typeof world>) {
  const preview = await answerMenu(w.ctx, 'r-1', 1);
  assert.equal(preview.outcome, 'ready', preview.message);
  const done = await answerMenu(w.ctx, 'r-1', 1, { token: preview.token! });
  assert.equal(done.outcome, 'answered', done.message);
  assert.equal(await deliverPendingPrompt(w.ctx, 'r-1'), 'sent', w.record().promptError ?? '');
}

for (const agent of ['claude', 'glm', 'codex', 'kimi']) it(`remote ${agent}: full lifecycle start, manual trust, verified prompt, working, mirrored report, close`, async () => {
  const w = world(agent);
  await startAtTrust(w);
  assert.ok(w.commands.some(c => c[0] === 'git' && c.includes('fetch')));
  assert.equal(fs.readFileSync(path.join(w.record().repos[0]!.worktree, 'setup-proof'), 'utf8'), 'remote-setup');
  await acceptTrust(w);
  assert.equal(w.pastes.length, 1);
  assert.match(w.pastes[0]!, new RegExp(w.record().remoteReport!));
  assert.ok(!w.pastes[0]!.includes(w.config.cache));
  assert.equal((await collectStatus(w.ctx, { progress: false }))[0]!.state, 'working');
  const text = `Werdykt: PASS\n<!-- agentctl:attempt ${w.record().attemptId} -->\n\n\`\`\`agentctl-outputs\nversion: 1\nverdict: PASS\ncommits: [{repo: app, branch: remote-feature, sha: ${SHA}}]\nintegrate: []\ndecisions: []\nactions: []\nchecks: [{name: remote, result: PASS}]\nnotes: []\n\`\`\`\n<!-- agentctl:report-end -->\n`;
  fs.writeFileSync(w.record().remoteReport!, text);
  w.tmux.windows[0]!.screen = ready(agent);
  const rows = await collectStatus(w.ctx, { progress: false });
  assert.equal(rows[0]!.state, 'report-ready');
  assert.equal(rows[0]!.outputs_valid, true);
  assert.equal(rows[0]!.host, 'pc');
  assert.equal(fs.readFileSync(w.record().report, 'utf8'), text);
  const before = w.writes(); await syncRemoteFiles(w.ctx, w.record()); assert.equal(w.writes(), before, 'unchanged content is not rewritten');
  const peek = await peekTask(w.ctx, 'R-1'); assert.equal(peek.task, 'R-1');
  const hint = remoteAttachHint(w.config, w.record())!; assert.match(hint, /ssh -t owner@fake-pc/); assert.match(hint, /agentctl-pc:@/);
  await closeTask(w.ctx, 'R-1');
  assert.equal(w.tmux.windows.length, 0);
  assert.equal(w.record().closed, true);
  assert.equal(fs.readFileSync(w.record().report, 'utf8'), text);
  w.offline(true);
  const reads = w.sshCalls.length;
  const report = await MCP_TOOLS.find(t => t.name === 'get_report')!.run({ context: out => new Context(w.runner, w.config, out), notify: async () => {} }, { task: 'R-1', detail: true, mark_pulled: false });
  assert.match(report.text, /Werdykt: PASS/);
  assert.equal(w.sshCalls.length, reads, 'get_report reads the local mirror offline');
  assert.equal(w.localTmux.seen.some(c => /kill-window|paste-buffer/.test(c)), false);
  assert.ok(w.sshCalls.every(args => args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=yes')));
});

it('remote unreachable mid-task: backoff, notification, slot retained, recovery without closing windows', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  const memory = new WatchMemory(), notices: string[] = [], notify = { notify: async (_title: string, text: string) => { notices.push(text); } };
  await watchTick(w.ctx, memory, notify);
  w.offline(true);
  await watchTick(w.ctx, memory, notify);
  const row = (await collectStatus(w.ctx, { progress: false }))[0]!;
  assert.equal(row.state, 'host-unreachable'); assert.equal(row.finished, false); assert.equal(row.window, 'alive');
  assert.ok(notices.some(n => n.includes('host pc niedostępny')));
  const count = w.sshCalls.length;
  await collectStatus(w.ctx, { progress: false }); assert.equal(w.sshCalls.length, count, 'backoff makes no SSH call');
  assert.ok((await liveWindows(w.ctx)).some(l => l.window === 'r-1' && l.host === 'pc' && l.counted !== false));
  await assert.rejects(closeTask(w.ctx, 'R-1'), /host pc unreachable/); assert.equal(w.record().closed, undefined);
  assert.equal(w.tmux.windows.length, 1);
  w.offline(false); await w.runner.sleep(300_001);
  const recovered = await watchTick(w.ctx, memory, notify);
  assert.ok(recovered.some(e => e.from === 'host-unreachable' && e.to === 'working'));
  assert.equal(w.tmux.windows.length, 1);
  assert.ok(readJournal(w.config).some(e => e.kind === 'host-recovered'));
});

it('remote send verifies exact follow-up and answer/interrupt/cancel affect only the remote window', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  w.tmux.windows[0]!.screen = ready();
  const sent = await sendPrompts(w.ctx, [{ task: 'R-1', window: 'r-1', prompt: 'A remote follow-up.' }]);
  assert.equal(sent[0]!.warning, undefined, sent[0]!.message);
  assert.equal(w.record().deliveryResult, 'delivered'); assert.equal(w.pastes.at(-1), 'A remote follow-up.');
  w.tmux.windows[0]!.screen = QUESTION;
  const menu = await answerMenu(w.ctx, 'r-1', 2); assert.equal(menu.outcome, 'ready');
  const keys = w.keys.length;
  w.tmux.windows[0]!.screen = TRUST;
  assert.equal((await answerMenu(w.ctx, 'r-1', 2, { token: menu.token! })).outcome, 'refused'); assert.equal(w.keys.length, keys);
  await interruptTask(w.ctx, 'R-1'); assert.equal(w.keys.at(-1), 'Escape');
  const plan = await planCancel(w.ctx, ['R-1']); await cancelTasks(w.ctx, plan);
  assert.equal(w.record().cancelled, true); assert.equal(w.tmux.windows.length, 0);
});

it('WALL-23: remote MCP send, send_enter, answer and interrupt preview without dispatching either pane', async () => {
  const w = world('claude', 'mcp: {allow: [send, answer, interrupt, send_enter]}\n');
  await startAtTrust(w);
  await acceptTrust(w);
  fakeWatcher(w.config);
  const deps = {
    context: () => w.ctx, notify: async () => {},
    budgetClock: { now: () => w.runner.now(), schedule: () => () => {} },
  };
  const call = (name: string, args: Record<string, unknown>) => MCP_TOOLS.find(tool => tool.name === name)!.run(deps, args);
  const task = w.record();
  const keyCount = w.keys.length, pasteCount = w.pastes.length;
  const taskBefore = fs.readFileSync(taskFile(w.config, task.window), 'utf8');
  const screen = w.tmux.windows[0]!;
  const text = ' Remote follow-up\nwith spaces. ';
  screen.screen = 'Working (esc to interrupt)\n' + ready();
  const send = await call('send', { task: task.task, text });
  assert.deepEqual(readMcpRequests(w.config), [], send.text);
  assert.match(send.text, /R-1 \(pc\)[\s\S]*working[\s\S]*queued until the turn ends/);
  assert.ok(send.text.includes(text));
  screen.screen = QUESTION;
  const answer = await call('answer', { task: task.task, option: 1 });
  assert.match(answer.text, /preview_token:/, answer.text);
  assert.match((await call('interrupt', { task: task.task })).text, /preview_token:/);
  assert.equal(w.keys.length, keyCount);
  assert.equal(w.pastes.length, pasteCount);
  assert.deepEqual(readMcpRequests(w.config), []);
  assert.deepEqual(readPromptQueue(w.ctx, task.window), []);
  assert.equal(fs.readFileSync(taskFile(w.config, task.window), 'utf8'), taskBefore);
  assert.doesNotMatch(w.localTmux.seen.join('\n'), /send-keys|paste-buffer/);
  const token = /preview_token: (\S+)/.exec(send.text)?.[1];
  assert.ok(token);
  const confirm = { confirm: true, preview_token: token };
  assert.match((await call('send', confirm)).text, /^Accepted: send/);
  assert.match((await call('send', confirm)).text, /^already accepted: send/);
  const [request, ...duplicates] = readMcpRequests(w.config);
  assert.ok(request);
  assert.deepEqual(duplicates, []);
  assert.equal(request.args.text, text);
  assert.equal(w.pastes.length, pasteCount);
  screen.screen = ready();
  await applyMcpRequest(deps, request);
  assert.equal(w.pastes.at(-1), text.trimEnd());
  const draft = 'Existing remote draft';
  screen.screen = ready('claude', draft);
  await setHeaderFields(w.runner, taskFile(w.config, task.window), {
    delivery_id: 'remote-draft', delivery_field: areaKey(inspectField(screen.screen, 'claude').area),
    delivery_result: 'not-delivered-in-field', pending_prompt: draft, prompt_delivery: 'needs-attention',
  });
  const afterSend = [w.keys.length, w.pastes.length, readMcpRequests(w.config).length];
  const enter = await call('send', { task: task.task, enter_only: true });
  assert.match(enter.text, /preview_token:/, enter.text);
  assert.ok(enter.text.includes(draft));
  assert.deepEqual([w.keys.length, w.pastes.length, readMcpRequests(w.config).length], afterSend);
  assert.doesNotMatch(w.localTmux.seen.join('\n'), /send-keys|paste-buffer/);
});

it('remote Codex send stays in FIFO until turn end and verifies from its own rollout', async () => {
  const w = world('codex'); await startAtTrust(w); await acceptTrust(w);
  const before = w.pastes.length;
  const sent = await sendPrompts(w.ctx, [{ task: 'R-1', window: 'r-1', prompt: 'Run after this turn.' }]);
  assert.equal(sent[0]!.outcome, 'queued_until_turn_end'); assert.equal(w.pastes.length, before);
  assert.equal(readPromptQueue(w.ctx, 'r-1').length, 1);
  w.tmux.windows[0]!.screen = ready('codex');
  await w.runner.sleep(1);
  await w.ctx.runner.writeFile(path.join(w.config.stateDir, 'r-1', 'event.json'), JSON.stringify({ outcome: 'turn-complete', at: new Date(w.runner.now()).toISOString() }));
  for (let i = 0; i < w.config.watch.idleConfirmTicks + 1; i++) await drainPromptQueue(w.ctx, 'r-1', 'waiting');
  assert.equal(w.pastes.at(-1), 'Run after this turn.'); assert.equal(w.record().deliveryResult, 'delivered');
});

it('remote limits enforce both provider account and host cap, including a batch and the queue', async () => {
  const w = world(); await startAtTrust(w);
  const live = await liveWindows(w.ctx); assert.equal(live[0]!.host, 'pc');
  await assert.rejects(planBatch(w.ctx, [w.spec('R-2')], { noSwitch: true }), /host pc limit reached/);
  const raws = splitSpecs('---\ntask: R-2\nhost: pc\nagent: claude\nrepos: [{path: app, base: origin/main, branch: remote-two}]\n---\nSecond task.');
  const added = await commitQueueAdd(w.ctx, (await planQueueAdd(w.ctx, raws)).items);
  assert.equal(added[0]!.host, 'pc');
  await writeHostsCache(w.runner, [{name: 'pc', state: 'reachable', probedAt: new Date(w.runner.now()).toISOString(), disk: {workDir: w.work, freeKb: 256 * 1024 ** 2, totalKb: 1024 ** 3}}]);
  assert.equal(describeQueue(w.config, added, live)[0]!.condition.kind, 'slot');
  const memory = new QueueMemory(); assert.deepEqual(await queueTick(w.ctx, memory, { notify: async () => {} }), []);
  w.config.hosts.pc!.limits!.claude = 3;
  w.config.limits.claude = 1;
  await assert.rejects(planBatch(w.ctx, [w.spec('R-2')], { noSwitch: true }), /window limit for claude reached/);
  w.config.limits.claude = 3;
  await closeTask(w.ctx, 'R-1');
  w.config.hosts.pc!.limits!.claude = 1;
  await assert.rejects(planBatch(w.ctx, [w.spec('R-2'), w.spec('R-3')], { noSwitch: true }), /host pc limit reached/);
});

it('remote missing base identifies the remote default, and never creates a worktree', async () => {
  const w = world(); w.missingBase();
  await assert.rejects(newTasks(w.ctx, [w.spec()]), /default branch is remote-default/);
  assert.equal(w.commands.some(c => c[0] === 'git' && c.includes('add')), false);
});


it('remote board refresh uses cached host windows/screens and Enter prints the SSH attach command', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  await collectStatus(w.ctx, { progress: false });
  w.localTmux.add('board', 'board');
  const before = w.sshCalls.length;
  const snapshot = await loadBoard(w.ctx, 'R-1', new ProgressCache());
  assert.equal(snapshot.rows.find(r => r.task === 'R-1')?.host, 'pc');
  assert.equal(w.sshCalls.length, before, 'board refresh does not open the network');
  const notice = await runBoardEffect(w.runner, w.config, { type: 'switch', task: 'R-1', window: 'r-1' }, { insideTmux: true });
  assert.match(notice.text, /ssh -t.*agentctl-pc:@/);
  assert.equal(w.sshCalls.length, before);
});

it('remote restart: new Context rediscovers a renamed window by task ID and updates stale window ID', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  w.tmux.windows[0]!.id = '@88'; w.tmux.windows[0]!.name = 'owner renamed window';
  const restarted = new Context(w.runner, w.config, () => {});
  const rows = await collectStatus(restarted, {progress: false});
  assert.equal(rows.find(r => r.task === 'R-1')?.window, 'alive');
  assert.equal(w.record().windowId, '@88');
  assert.equal((await findResumable(restarted)).length, 0, 'running remote window is never launched twice');
  assert.match(remoteAttachHint(w.config, w.record())!, /agentctl-pc:@88/);
});
it('remote adopt: restores missing state from the task ID on the host', async () => {
  const w = world(); const win = w.tmux.add('owner renamed', ready(), '@99'); win.role = 'adopt-1';
  const record = await adoptTask(w.ctx, 'ADOPT-1', {host: 'pc', report: path.join(w.config.cache, 'adopt-1/ADOPT-1.md'), agent: 'claude', model: 'sonnet', effort: 'high'});
  assert.equal(record.host, 'pc'); assert.equal(record.windowId, '@99'); assert.equal(record.session, 'agentctl-pc');
  assert.match(record.remoteReport!, /reports\/adopt-1\/ADOPT-1.md$/);
  assert.equal((await collectStatus(w.ctx, {progress: false})).find(r => r.task === 'ADOPT-1')?.window, 'alive');
});
it('remote resume: recreates only a missing window on its host with remote hooks and report path', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  w.tmux.windows.length = 0;
  const plan = await planResume(w.ctx, ['R-1']); assert.equal(plan.items[0]!.host, 'pc');
  w.tmux.newWindowScreen = ready();
  await resumeTasks(w.ctx, plan);
  assert.equal(w.tmux.windows.length, 1); assert.equal(w.localTmux.windows.length, 0);
  assert.ok(w.pastes.at(-1)!.includes(w.record().remoteReport!));
  assert.ok(w.commands.some(c => c[0] === 'sh' && c.join(' ').includes('start.sh')));
});
it('HOST-HOLD-OFFLINE: persisted provider quota evidence never hides SSH unreachability', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w);
  w.tmux.windows[0]!.screen = ready();
  await w.ctx.runner.writeFile(path.join(w.config.stateDir, 'r-1/event.json'), JSON.stringify({outcome: 'limited', text: 'API Error: 429 rate limit exceeded', at: new Date(w.runner.now()).toISOString()}));
  await collectStatus(w.ctx, {progress: false});
  w.offline(true);
  const rows = await collectStatus(w.ctx, {progress: false});
  assert.equal(rows[0]!.state, 'host-unreachable'); assert.equal(rows[0]!.window, 'alive');
  assert.ok((await liveWindows(w.ctx)).some(w => w.host === 'pc' && w.counted !== false));
});

it('HOST-RESUME-HOLD: an explicit remote resume keeps account/host slot checks during a queue hold', async () => {
  const w = world(); await startAtTrust(w); await acceptTrust(w); w.tmux.windows.length = 0;
  await setProviderHolds(w.ctx, {claude: new Date(w.runner.now() + 3600000).toISOString()});
  assert.equal((await planResume(w.ctx, ['R-1'])).items.length, 1);
  seedTask(w.config, 'SLOT', {host: 'pc', agent: 'claude'}); w.tmux.add('slot', ready());
  assert.ok((await planResume(w.ctx, ['R-1'])).skipped.some(s => /host pc limit/.test(s.reason)));
});

it('REL0243-DISK: remote admission probes host work_dir and fails closed before setup', async () => {
  const w = world(); w.config.disk.minFreeStartGb = 1e12;
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /wstrzymane: dysk/);
  const {freshTaskDiskStartHold, taskDiskStartHold} = await import('../src/core/disk.ts');
  const held = await freshTaskDiskStartHold(w.ctx, 'pc', ['/must/not/stat/locally']);
  assert.match(held!, /dysk \[pc\]/);
  assert.ok(w.commands.some(c => c[0] === 'node' && c.at(-1) === w.work));
  assert.match(taskDiskStartHold(w.config, 'pc', [], w.runner.now())!, /świeżego/);
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /wstrzymane: dysk/);
  assert.ok(!w.commands.some(c => c[0] === 'git' && c.includes('add')), 'no worktree mutation');
  w.offline(true);
  assert.match((await freshTaskDiskStartHold(w.ctx, 'pc', []))!, /nie można/);
  const {refreshDiskFreeSpace} = await import('../src/core/disk.ts');
  const disk = await refreshDiskFreeSpace(w.ctx, {volumes: [{host: 'pc', workDir: w.work, device: 'host:pc', paths: [w.work], availableBytes: 99, totalBytes: 100, level: 'ok'}], worktreeBytes: null, measuredAt: new Date(w.runner.now()).toISOString(), level: 'ok'});
  assert.equal(disk.volumes[0]!.availableBytes, null, 'missing host health never becomes local disk free');
  assert.equal(disk.volumes[0]!.host, 'pc');
});
it('REL0244-REMOTE-FIXTURE: remote admission uses fixture disk space independent of the test host', async () => {
  const w = world();
  w.config.disk.minFreeStartGb = 512;
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /dysk \[pc\] 256 GB < 512 GB/);
});
it('REL0243-REMOTE: peak and provider holds stop remote setup; scrolled answers and snapshots retain host identity', async () => {
  const w = world();
  await setProviderHolds(w.ctx, {claude: new Date(w.runner.now() + 60000).toISOString()});
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /provider hold:/);
  assert.equal(w.commands.length, 0);
  await setProviderHolds(w.ctx, {claude: 'off'});
  w.config.providersConfig ??= {}; w.config.providersConfig.claude = {peak: [{days: 'sun-sat', from: '00:00', to: '23:59', tz: 'UTC'}]};
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /szczyt do/);
  w.config.providersConfig ??= {}; w.config.providersConfig.claude = {peak: []};
  await startAtTrust(w); await acceptTrust(w);
  const win = w.tmux.windows.find(x => x.id === w.record().windowId)!;
  win.screen = 'Choose approach?\n❯ 1. Alpha\n  2. Beta\n  3. Gamma\nEnter to select · Esc to cancel\n';
  const preview = await answerMenu(w.ctx, 'r-1', 2);
  assert.equal(preview.outcome, 'ready', preview.message);
  win.screen = 'Choose approach?\n❯ 2. Beta\n  3. Gamma\nEnter to select · Esc to cancel\n';
  const answer = await answerMenu(w.ctx, 'r-1', 2, {token: preview.token!});
  assert.equal(answer.outcome, 'answered', answer.message);
  win.screen = 'API Error: Request rejected (429) · Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-11-21 03:12:28';
  const rows = await collectStatus(w.ctx, {progress: false});
  assert.equal(rows[0]!.state, 'limited'); assert.equal(rows[0]!.host, 'pc');
  await publishMcpSnapshot(w.ctx, rows);
  const calls = w.sshCalls.length;
  const status = MCP_TOOLS.find(t => t.name === 'status')!;
  const result = await status.run({context: () => w.ctx, notify: async () => {}}, {format: 'json'});
  assert.equal(result.isError, undefined, result.text);
  assert.ok(result.text.includes('"host": "pc"'));
  assert.equal(w.sshCalls.length, calls, 'snapshot read starts no SSH');
});

it('REL0243-PREVIEW: MCP remote queue preview uses host disk, with no SSH or local remote-path stat', async () => {
  const w = world(); w.config.disk.minFreeStartGb = 30; w.config.mcp.allow = ['queue'];
  const tool = MCP_TOOLS.find(t => t.name === 'queue')!;
  const result = await tool.run({context: () => w.ctx, notify: async () => {}}, {spec: `---\ntask: PREVIEW\nhost: pc\nagent: claude\nrepos: [{path: app}]\n---\nFake.`});
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /dysk \[pc\].*świeżego/);
  assert.equal(w.sshCalls.length, 0);
});
it('REL0243-LINKS: remote project defaults reject closed tasks and honor links: []', async () => {
  const w = world();
  seedTask(w.config, 'OLD', {host: 'pc', closed: true, repos: [{path: '/remote/backend', worktree: '/remote/backend-old'}]});
  fs.writeFileSync(path.join(w.clone, '.agentctl.yaml'), 'links: [{from: backend, to: /remote/backend-old}]\n');
  await assert.rejects(newTasks(w.ctx, [w.spec()], {waitTrust: false}), /stale project link/);
  const clean = world();
  seedTask(clean.config, 'OLD', {host: 'pc', closed: true, repos: [{path: '/remote/backend', worktree: '/remote/backend-old'}]});
  fs.writeFileSync(path.join(clean.clone, '.agentctl.yaml'), 'links: [{from: backend, to: /remote/backend-old}]\n');
  await assert.rejects(newTasks(clean.ctx, [clean.spec('R-1', 'links: []')], {waitTrust: false}), /waits for folder trust/);
  assert.ok(!clean.commands.some(c => c[0] === 'ln'));
});
