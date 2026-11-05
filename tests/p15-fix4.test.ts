import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Alerts } from '../src/core/alert.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { Context } from '../src/core/context.ts';
import { deliveryNote, deliverPendingPrompt, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { fieldArea, fieldText } from '../src/core/input-field.ts';
import { claudeProjectName } from '../src/core/usage-sources.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { readJournal } from '../src/core/journal.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';

// REV3 N1-N3, with the same no-Enter / no-false-ACK assertions as REPRO3.
const scratch = useScratch();
let serial = 0;
const pane = (field: string) => `Working (esc to interrupt)\n────────────\n❯ ${field.replace(/\n/g, '\n  ')}\n────────────\n`;
async function world(agent: 'claude' | 'codex' = 'claude', prompt = 'SAME MESSAGE') {
  const root = scratch.sub(String(++serial)), claude = path.join(root, 'claude'), codex = path.join(root, 'codex'), wt = path.join(root, 'wt');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {claude_dir: ${claude}, codex_dir: ${codex}}\n`);
  let field = '', shown = prompt;
  const keys: string[] = [];
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() - 1000, respond: (cmd, args) => {
    if (cmd !== 'tmux') return {};
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'capture-pane') return { stdout: field ? pane(field) : agent === 'claude' ? '❯ \n' : '› Ask Codex to do anything\n' };
    if (args[0] === 'paste-buffer') field = shown;
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') keys.push(field);
    return {};
  } });
  const ctx = new Context(runner, config, () => {});
  for (const task of ['T1', 'T2']) seedTask(config, task, { agent, windowId: task === 'T1' ? '@1' : '@2', repos: [{ path: wt, worktree: wt, branch: 'x' }] as never });
  const record = () => readTaskRecord(config, 't1')!;
  await queuePrompt(ctx, record(), prompt, 'pending', { kind: 'followup' });
  const started = runner.now();
  const awaiting = () => setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(started).toISOString() });
  const d = new Date(started), dir = agent === 'claude' ? path.join(claude, 'projects', claudeProjectName(wt)) : path.join(codex, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = (id: string) => path.join(dir, agent === 'claude' ? `${id}.jsonl` : `rollout-fix4-${id}.jsonl`);
  const write = (id: string, rows: object[]) => fs.writeFileSync(file(id), [...(agent === 'codex' ? [{ type: 'session_meta', payload: { id, cwd: wt } }] : []), ...rows].map(r => JSON.stringify(r)).join('\n') + '\n');
  const link = async (task: string, id: string) => { await rememberSession(runner, config, task, agent, agent === 'claude' ? { id, transcript: file(id) } : { id }); };
  const user = (text: string, at: number, extra: object = {}) => agent === 'claude' ? { type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: text }, ...extra } : { type: 'response_item', timestamp: new Date(at).toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } };
  const enqueue = (at: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(at).toISOString(), content: prompt });
  return { ctx, config, runner, record, started, awaiting, file, write, link, user, enqueue, keys, set: (v: string) => { field = v; }, show: (v: string) => { shown = v; } };
}

describe('FIX4 N1: only the session of this task and attempt', () => {
  for (const agent of ['claude', 'codex'] as const) for (const mode of ['foreign-sole', 'missing-known-file', 'rotated-known-file']) it(`${agent} ${mode}: T2 never confirms T1`, async () => {
    const w = await world(agent); await w.awaiting();
    if (mode === 'rotated-known-file') w.write('ours', [w.user('UNRELATED', w.started + 20)]);
    if (mode !== 'foreign-sole') await w.link('t1', 'ours');
    if (mode === 'rotated-known-file') { await deliverPendingPrompt(w.ctx, 't1'); fs.unlinkSync(w.file('ours')); }
    await w.link('t2', 'foreign'); w.write('foreign', [w.user('SAME MESSAGE', w.started + 100)]);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
    assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
  });
  for (const agent of ['claude', 'codex'] as const) it(`${agent}: a known file replaced at the same path is not the selected file`, async () => {
    const w = await world(agent); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting(); await deliverPendingPrompt(w.ctx, 't1');
    fs.renameSync(w.file('ours'), w.file('archived')); w.write('ours', [w.user('SAME MESSAGE', w.started + 100)]);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
  });
  it('a session selected for an earlier attempt cannot confirm a new attempt', async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours');
    await setHeaderFields(w.runner, taskFile(w.config, 't1'), { attempt_id: 'new-attempt', attempt_started: new Date(w.started).toISOString() });
    await w.awaiting(); w.write('ours', [w.user('SAME MESSAGE', w.started + 100)]);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
  });
  for (const agent of ['claude', 'codex'] as const) it(`${agent}: the exact selected file can confirm`, async () => {
    const w = await world(agent); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting(); w.write('ours', [w.user('SAME MESSAGE', w.started + 100)]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().deliverySource, 'transcript');
  });
});

describe('FIX4 attempt callbacks', () => {
  it('a delayed callback from the old attempt neither selects a session nor ACKs', async () => {
    const w = await world(); await setHeaderFields(w.runner, taskFile(w.config, 't1'), { attempt_id: 'new-attempt' }); await w.awaiting();
    w.write('old', [w.user('SAME MESSAGE', w.started + 100)]);
    await handleEvent(w.ctx, new Alerts(w.ctx, { notify: async () => {} }), { task: 'T1', agent: 'claude', kind: 'user-prompt-submit', attempt: 'old-attempt', payload: { session_id: 'old', transcript_path: w.file('old'), prompt: 'SAME MESSAGE' } });
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
  });
});

describe('FIX4 N2: correlate queued injection, retain confirmed queue', () => {
  for (const swallowed of [false, true]) it(`old manual enqueue and late injection cannot ACK new delivery${swallowed ? ' after 3 swallowed Enters' : ''}`, async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours');
    if (swallowed) { await deliverPendingPrompt(w.ctx, 't1'); assert.equal(w.keys.length, 3); w.set(''); } else await w.awaiting();
    w.write('ours', [w.enqueue(w.started - 5000), w.user('SAME MESSAGE', w.started + 200, { promptSource: 'queued' })]);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
  });
  it('our enqueue is confirmed-queued, keeps pending past the turn and timeout; injection then delivers', async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting();
    w.write('ours', [w.enqueue(w.started + 100)]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming'); assert.equal(w.record().deliveryResult, 'queued-in-agent-confirmed'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
    assert.match(deliveryNote(w.record()) ?? '', /w kolejce agenta – potwierdzone/);
    await setHeaderFields(w.runner, taskFile(w.config, 't1'), { turn_ended_at: new Date(w.started + 200).toISOString() }); await w.runner.sleep(120000);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming'); assert.equal(w.record().deliveryResult, 'queued-in-agent-confirmed'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE');
    assert.match(deliveryNote(w.record()) ?? '', /tura.*zakończona/);
    w.write('ours', [w.enqueue(w.started + 100), w.user('SAME MESSAGE', w.started + 300, { promptSource: 'queued' })]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().deliverySource, 'transcript');
    assert.ok(readJournal(w.config).some(r => /potwierdzone/.test(r.text)));
  });
  it('a matching hook can deliver a confirmed-queued message without waiting for injection', async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting(); w.write('ours', [w.enqueue(w.started + 100)]);
    await deliverPendingPrompt(w.ctx, 't1'); assert.equal(w.record().deliveryResult, 'queued-in-agent-confirmed');
    await handleEvent(w.ctx, new Alerts(w.ctx, { notify: async () => {} }), { task: 'T1', agent: 'claude', kind: 'user-prompt-submit', payload: { prompt: 'SAME MESSAGE' } });
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().deliverySource, 'hook');
  });
  for (const mode of ['missing-enqueue', 'ambiguous-old-and-new']) it(`no ACK for ${mode}`, async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting();
    w.write('ours', [...(mode === 'missing-enqueue' ? [] : [w.enqueue(w.started - 5000), w.enqueue(w.started + 100)]), w.user('SAME MESSAGE', w.started + 200, { promptSource: 'queued' })]);
    assert.notEqual(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().pendingPrompt, 'SAME MESSAGE'); assert.notEqual(w.record().deliveryResult, 'queued-in-agent-confirmed');
  });
  it('an earlier injection consumes its enqueue before the next delivery', async () => {
    const w = await world(); w.write('ours', []); await w.link('t1', 'ours'); await w.awaiting();
    w.write('ours', [w.enqueue(w.started - 5000), w.user('SAME MESSAGE', w.started - 4000, { promptSource: 'queued' }), w.enqueue(w.started + 100), w.user('SAME MESSAGE', w.started + 200, { promptSource: 'queued' })]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
  });
});

describe('FIX4 N3: structural composer boundary, all interior lines are content', () => {
  it('token confirm with body hidden behind footer: no key', async () => {
    const w = await world('claude', 'ORIGINAL'); await deliverPendingPrompt(w.ctx, 't1'); const preview = await submitDraft(w.ctx, 't1'); assert.equal(preview.outcome, 'ready');
    const n = w.keys.length; w.set('ORIGINAL\n? for shortcuts\nUSER ADDED SECRET');
    const done = await submitDraft(w.ctx, 't1', { token: preview.token }); assert.equal(done.outcome, 'refused'); assert.equal(w.keys.length, n);
  });
  it('three Enter window: footer-like line cannot hide replaced body', async () => {
    const w = await world('claude', 'FIRST LINE\n? for shortcuts\nORIGINAL BODY'); w.show('FIRST LINE\n? for shortcuts\nUSER REPLACED BODY');
    await deliverPendingPrompt(w.ctx, 't1'); assert.deepEqual(w.keys, []); assert.equal(w.record().deliveryResult, 'not-delivered-in-field');
  });
  it('preview preserves footer-like and working-like content inside the border', async () => {
    const prompt = 'FIRST\n? for shortcuts\nesc to interrupt\nLAST', w = await world('claude', prompt); await deliverPendingPrompt(w.ctx, 't1');
    const preview = await submitDraft(w.ctx, 't1'); assert.equal(preview.outcome, 'ready'); assert.deepEqual(preview.field, prompt.split('\n'));
  });
  it('unknown unframed input is refused without an Enter', async () => {
    const w = await world('claude', 'ORIGINAL'); await deliverPendingPrompt(w.ctx, 't1'); const preview = await submitDraft(w.ctx, 't1'); const n = w.keys.length;
    const exec = w.runner.exec.bind(w.runner); w.runner.exec = async (c, a, o) => c === 'tmux' && a[0] === 'capture-pane' ? { code: 0, stdout: 'Working (esc to interrupt)\n❯ ORIGINAL\n', stderr: '' } : exec(c, a, o);
    const done = await submitDraft(w.ctx, 't1', { token: preview.token }); assert.equal(done.outcome, 'refused'); assert.equal(w.keys.length, n); assert.match(done.message, /granic|struktur/);
  });
  for (const name of ['screen-claude-busy-paste.txt', 'screen-codex-busy-steered.txt']) it(`real fixture lower boundary: ${name}`, () => {
    const screen = fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').replace(/^› Ask Codex to do anything$/m, '› ORIGINAL'); const area = fieldArea(screen);
    assert.ok(area.length); assert.ok(!fieldText(area).includes('? for shortcuts')); assert.ok(!fieldText(area).includes('GPT-6.1-Sol'));
    if (name.includes('claude')) assert.match(fieldText(area), /^\[Pasted text/);
  });
});
