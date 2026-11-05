import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Context } from '../src/core/context.ts';
import { readJournal } from '../src/core/journal.ts';
import { sameMessage, storedForm } from '../src/core/paste-wrapper.ts';
import { deliveryProof, deliverPendingPrompt, queuePrompt } from '../src/core/prompt-delivery.ts';
import { claudeMessages, codexMessages } from '../src/core/transcript.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { rememberSession } from '../src/core/usage-tap.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import type { AgentName } from '../src/core/config.ts';

/*
 * P15-FIX3: the new delivery contract. The transcripts of the two agents are the exact source next to the hook; their shapes below were recorded on
 * 2026-11-05 from Claude Code 2.1.311 and codex-cli 0.166.0 (tests/fixtures/claude-transcript-queue.jsonl, codex-rollout-steer.jsonl, anonymised).
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('the transcript of Claude Code', () => {
  const rows = claudeMessages(fx('claude-transcript-queue.jsonl'));
  it('holds the messages of the human: typed, queued at submit time (queue-operation), injected later (promptSource queued); not tool results, not meta', () => {
    assert.deepEqual(rows.map(r => [r.kind, r.at, r.text.slice(0, 12)]), [
      ['user', Date.parse('2026-11-05T06:54:18.072Z'), 'Write the En'],
      ['queued', Date.parse('2026-11-05T06:54:29.637Z'), 'QUEUED-B1: w'],
      ['queued', Date.parse('2026-11-05T06:54:33.203Z'), '<pasted_cont'],
      ['user', Date.parse('2026-11-05T06:54:42.926Z'), 'QUEUED-B1: w'],
      ['user', Date.parse('2026-11-05T06:54:42.927Z'), '<pasted_cont'],
      ['user', Date.parse('2026-11-05T06:55:43.414Z'), '\n\n<pasted_co'],
    ]);
  });
  it('the queued message is there at the moment it is submitted, 13 seconds before the turn took it up', () => {
    const enqueue = rows.find(r => r.kind === 'queued')!, injected = rows.filter(r => r.kind === 'user')[1]!;
    assert.ok(injected.at - enqueue.at > 13_000);
  });
});

describe('the rollout of Codex', () => {
  it('holds the messages of the user as response_item, item_completed (UserMessage) and, in older versions, user_message', () => {
    const texts = codexMessages(fx('codex-rollout-steer.jsonl')).map(r => r.text.slice(0, 12));
    assert.ok(texts.includes('QUEUED-B1: w'));
    assert.ok(texts.includes('QUEUED-B2 li'));
    assert.ok(texts.includes('older Codex:'));
    assert.equal(texts.filter(t => t === 'QUEUED-B1: w').length, 2, 'both records of one message');
  });
});

describe('the same message: line ends are the only normalisation, nothing inside is squeezed', () => {
  const wrap = (id: string, text: string) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
  it('what the agent drops or adds around the message is not part of it', () => {
    assert.ok(sameMessage('text', 'text\n'), 'trailing newline dropped');
    assert.ok(sameMessage('text', 'text   '), 'trailing spaces dropped');
    assert.ok(sameMessage(`\n\n${wrap('d7ee', 'a\nb')}\n`, 'a\nb'), 'the padding of the wrapper at rest');
    assert.ok(sameMessage(wrap('c996', 'a\nb'), 'a\r\nb'), 'queued: no padding; CRLF of the pending prompt');
    assert.ok(sameMessage('   leading spaces kept', '   leading spaces kept'));
  });
  it('a space, a blank line, a tab or a letter inside is a different message', () => {
    assert.ok(!sameMessage('Use key "ABCD"', 'Use key "AB CD"'));
    assert.ok(!sameMessage('a  b', 'a b'));
    assert.ok(!sameMessage('a\nb', 'a\n\nb'));
    assert.ok(!sameMessage('a\tb', 'a    b', 'codex'));
    assert.ok(!sameMessage('  a', 'a'), 'leading white space is part of the message');
    assert.ok(!sameMessage('', ''));
  });
  it('Claude Code stores a tab as four spaces; Codex keeps it', () => {
    assert.ok(sameMessage('a    b', 'a\tb', 'claude'));
    assert.ok(!sameMessage('a    b', 'a\tb', 'codex'));
    assert.ok(sameMessage('a\tb', 'a\tb', 'codex'));
    assert.equal(storedForm('a\tb\r\n', 'claude'), 'a    b');
  });
});

/** A task whose delivery began 2 s ago and awaits an exact source; the agent's transcript directory is the task's own. */
async function world(name: string, agent: AgentName, pending: string, options: { link?: 'session' | 'none'; worktree?: boolean } = {}) {
  const root = scratch.sub(name), claudeDir = path.join(root, 'agent-claude'), codexDir = path.join(root, 'agent-codex');
  const config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nusage: {claude_dir: ${claudeDir}, codex_dir: ${codexDir}}\n`);
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args) => cmd !== 'tmux' ? undefined : args[0] === 'list-windows' ? { stdout: '@1\tt1\ttask' } : args[0] === 'capture-pane' ? { stdout: agent === 'claude' ? '❯ \n' : '› Ask Codex to do anything\n' } : {} });
  const ctx = new Context(runner, config, () => {});
  const worktree = path.join(root, 'wt');
  seedTask(config, 'T1', { agent, windowId: '@1', repos: [{ path: worktree, worktree, branch: 'x' }] as never });
  await queuePrompt(ctx, readTaskRecord(config, 't1')!, pending, 'pending', { kind: 'followup' });
  const started = runner.now() - 2000;
  await setHeaderFields(runner, taskFile(config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(started).toISOString() });
  const claudeFile = path.join(claudeDir, 'projects', 'p', 'sess-1.jsonl'), codexFile = path.join(codexDir, 'sessions', ...new Date(started).toLocaleDateString('sv').split('-'), 'rollout-2026-11-05T07-56-48-sess-1.jsonl');
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true }); fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  if (options.link !== 'none') await rememberSession(runner, config, 't1', agent, agent === 'claude' ? { id: 'sess-1', transcript: claudeFile } : { id: 'sess-1' });
  const iso = (ms: number) => new Date(ms).toISOString();
  const write = (rows: object[], file = agent === 'claude' ? claudeFile : codexFile) => fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const claudeUser = (text: string, at: number, extra: object = {}) => ({ type: 'user', timestamp: iso(at), message: { role: 'user', content: text }, ...extra });
  const claudeEnqueue = (text: string, at: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(at), content: text });
  const codexItem = (text: string, at: number) => ({ timestamp: iso(at), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
  return { config, runner, ctx, started, claudeFile, codexFile, write, claudeUser, claudeEnqueue, codexItem, root, worktree, record: () => readTaskRecord(config, 't1')! };
}

describe('delivered from the transcript of the task', () => {
  it('Claude: the queue-operation of the queued message (written at submit time) confirms it, with its source in the journal', async () => {
    const w = await world('tx-queue', 'claude', 'QUEUED-B1: also reply ACK-B1.\tTabbed  and  double spaced   ');
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming', 'nothing in the transcript yet');
    w.write([w.claudeEnqueue('QUEUED-B1: also reply ACK-B1.    Tabbed  and  double spaced', w.started + 500)]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
    assert.equal(w.record().deliveryResult, 'delivered'); assert.equal(w.record().deliverySource, 'transcript-queue'); assert.equal(w.record().pendingPrompt, undefined);
    const entry = readJournal(w.config).find(e => e.kind === 'delivery')!;
    assert.match(entry.text, /dostarczono – agent przyjął wiadomość \(transkrypt sesji: agent zapisał wiadomość w swojej kolejce\)/); assert.match(entry.text, /\[dostawa [0-9a-f]{8}\]/);
  });
  it('Claude: a typed message (a collapsed paste with its padding) confirms it', async () => {
    const text = 'Reply with exactly ACK-C1.\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n';
    const w = await world('tx-typed', 'claude', text);
    w.write([w.claudeUser('\n\n<pasted_content id="d7ee">\nReply with exactly ACK-C1.\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n</pasted_content id="d7ee">\n', w.started + 800, { promptSource: 'typed' })]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().deliverySource, 'transcript');
  });
  it('Codex: the item of the steered message (item_completed) confirms it, tabs as they are', async () => {
    const w = await world('tx-codex', 'codex', 'QUEUED-B1: reply ACK-B1.\tTabbed  and  double spaced\n');
    w.write([w.codexItem('QUEUED-B1: reply ACK-B1.\tTabbed  and  double spaced', w.started + 400)]);
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent'); assert.equal(w.record().deliverySource, 'transcript');
  });
  it('Codex: found by the id the notify hook recorded, or by the working directory when exactly one new rollout belongs to the worktree', async () => {
    const w = await world('tx-codex-cwd', 'codex', 'steer me', { link: 'none' });
    fs.writeFileSync(w.codexFile.replace('sess-1', 'other'), [{ timestamp: new Date(w.started).toISOString(), type: 'session_meta', payload: { cwd: w.worktree } }, w.codexItem('steer me', w.started + 300)].map(r => JSON.stringify(r)).join('\n') + '\n');
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent');
  });
});

describe('not delivered from a transcript', () => {
  const cases: [string, string, (w: Awaited<ReturnType<typeof world>>) => object[]][] = [
    ['a message from before the delivery began', 'old news', w => [w.claudeUser('old news', w.started - 5000)]],
    ['a message that differs by one space', 'Use key "AB CD"', w => [w.claudeUser('Use key "ABCD"', w.started + 300)]],
    ['a longer message with the same start', 'FIRST LINE', w => [w.claudeUser('FIRST LINE\nand more', w.started + 300)]],
    ['a tool result that holds the text', 'quoted text', w => [{ type: 'user', timestamp: new Date(w.started + 300).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'quoted text' }] } }]],
    ['a meta record', 'meta text', w => [w.claudeUser('meta text', w.started + 300, { isMeta: true })]],
    ['a message of a subagent', 'sidechain text', w => [w.claudeUser('sidechain text', w.started + 300, { isSidechain: true })]],
  ];
  for (const [name, pending, rows] of cases) it(`Claude: ${name}`, async () => {
    const w = await world(`tx-no-${name.replace(/\W+/g, '-')}`, 'claude', pending);
    w.write(rows(w));
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming');
    assert.equal(w.record().deliveryResult, undefined); assert.equal(w.record().pendingPrompt, pending);
  });
  it('Claude: a transcript that is not of this task is not read (no session recorded, two transcripts in the worktree)', async () => {
    const w = await world('tx-foreign', 'claude', 'secret of another session', { link: 'none' });
    const dir = path.join(w.root, 'agent-claude', 'projects', w.worktree.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ['one', 'two']) fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify(w.claudeUser('secret of another session', w.started + 300)) + '\n');
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming');
    fs.unlinkSync(path.join(dir, 'two.jsonl'));
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'sent', 'exactly one new transcript in the worktree of the task');
  });
  it('Claude: a transcript of the session recorded for ANOTHER task is not read', async () => {
    const w = await world('tx-other-task', 'claude', 'only for the other task', { link: 'none' });
    fs.writeFileSync(w.claudeFile, JSON.stringify(w.claudeUser('only for the other task', w.started + 300)) + '\n');
    assert.equal(await deliverPendingPrompt(w.ctx, 't1'), 'confirming');
  });
  it('the screen alone never confirms: an echo or a queue sign of a busy delivery leaves the message pending', async () => {
    const w = await world('tx-screen', 'claude', 'Use key "AB CD"');
    const record = { ...w.record(), deliveryWasBusy: true };
    assert.equal(deliveryProof(w.ctx, record, '❯ Use key "AB CD"\n\n❯ \n'), null);
    assert.equal(deliveryProof(w.ctx, record, '  ctrl+x ctrl+s to send now\n❯ Press up to edit queued messages\n'), null);
  });
});

describe('the paste goes in with plain line ends', () => {
  it('CRLF in a prompt is pasted as LF (tmux turns each CR into an Enter: CRLF would be two)', async () => {
    const config = makeConfig(scratch.sub('crlf'), 'capacity: {snapshot: false, codex_refresh: false}\n');
    let payload = '';
    const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: (cmd, args, opts) => { if (cmd !== 'tmux') return undefined; if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' }; if (args[0] === 'load-buffer') payload = opts?.input ?? ''; if (args[0] === 'capture-pane') return { stdout: '❯ \n' }; return {}; } });
    const ctx = new Context(runner, config, () => {});
    seedTask(config, 'T1', { agent: 'claude', windowId: '@1' });
    await queuePrompt(ctx, readTaskRecord(config, 't1')!, 'line 1\r\nline 2\r\n');
    await deliverPendingPrompt(ctx, 't1');
    assert.equal(payload, 'line 1\nline 2\n');
  });
});
