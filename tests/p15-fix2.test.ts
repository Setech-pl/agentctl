import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Alerts } from '../src/core/alert.ts';
import { collectEvents } from '../src/core/chat-events.ts';
import { DEFAULT_AGENT_SETTINGS } from '../src/core/config.ts';
import { Context } from '../src/core/context.ts';
import { handleEvent } from '../src/core/event-command.ts';
import { readJournal } from '../src/core/journal.ts';
import { auditPath } from '../src/core/mcp-tools.ts';
import { deliveryNote, deliveryProof, deliverPendingPrompt, echoLines, queuePrompt, submitDraft } from '../src/core/prompt-delivery.ts';
import { sendPrompts } from '../src/core/send.ts';
import { classifyScreen } from '../src/core/state.ts';
import { readTaskRecord, setHeaderFields, taskFile } from '../src/core/taskstore.ts';
import { watchTick, WatchMemory } from '../src/core/watch.ts';
import { buildMcpServer } from '../src/mcp/server.ts';
import { DiskRunner, makeConfig, seedTask, useScratch } from './helpers.ts';
import type { AgentName } from '../src/core/config.ts';
import type { McpDeps } from '../src/core/mcp-tools.ts';
import type { ExecOptions, ExecResult } from '../src/core/runner.ts';

/*
 * P15-FIX2: the counterexamples E1-E10 of the cross review (AGENTCTL-P15-REV.md). Each test was red on e539375 and is green after the fix; the few
 * that are not red on e539375 are positive controls and say so. Only the API that e539375 already had is used, so the file runs on both.
 * The panes are scripted: they show what Claude Code 2.1.311 / codex-cli 0.166.0 showed in the recordings under tests/fixtures.
 *
 * P15-FIX3 changed the contract in two places, and the tests that pinned the old contract say so where they changed: (1) watch never presses Enter
 * again (the "4th Enter" controls and E10 now expect no key and needs-attention with the way out); (2) the screen (queue sign, echo of Codex) only
 * classifies, so the controls that expected "delivered / sent" from the screen expect "confirming, queued-in-agent" and a hook for "delivered";
 * `send --enter-only` is a preview with the exact text and a token, then a confirm (`enterOnly` below).
 */
const scratch = useScratch();
const fx = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

/** Claude Code while it works: transcript, spinner, the input box between two borders (field lines indented), footer. */
const claude = (field: string[], above = '✻ Cooking… (3s · ↓ 10 tokens)') => ['⏺ Working on it', above, '────────────────', `❯ ${field[0] ?? ''}`.trimEnd(), ...field.slice(1).map(l => `  ${l}`), '────────────────', '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt'].join('\n') + '\n';
/** Codex while it works: echoes of earlier messages, the status line, the field (no border), the footer. */
const codex = (field: string[], echoes: string[] = []) => [...echoes, '• Working (3s • esc to interrupt)', `› ${field[0] ?? 'Ask Codex to do anything'}`, ...field.slice(1).map(l => `  ${l}`), '  GPT-6.1-Sol low · ~/work/sandbox', '  ? for shortcuts'].join('\n') + '\n';
const QUEUED_SCREEN = ['⏺ Working on it', '  FOLLOWUP', '  ctrl+x ctrl+s to send now', '✻ Cooking… (3s · ↓ 10 tokens)', '────────────────', '❯ Press up to edit queued messages', '────────────────', '  esc to interrupt'].join('\n') + '\n';

interface Model { screen: () => string; styled?: () => string | undefined; paste?: (payload: string) => void; enter?: (n: number) => void }
function pane(model: Model) {
  const seen = { pastes: 0, enters: 0, captures: 0, payload: '' };
  const respond = (cmd: string, args: string[], opts?: ExecOptions): Partial<ExecResult> | undefined => {
    if (cmd !== 'tmux') return undefined;
    if (args[0] === 'list-windows') return { stdout: '@1\tt1\ttask' };
    if (args[0] === 'load-buffer') { seen.payload = opts?.input ?? ''; return {}; }
    if (args[0] === 'paste-buffer') { seen.pastes++; model.paste?.(seen.payload); return {}; }
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') { seen.enters++; model.enter?.(seen.enters); return {}; }
    if (args[0] === 'capture-pane') { if (!args.includes('-e')) seen.captures++; return { stdout: args.includes('-e') ? (model.styled?.() ?? model.screen()) : model.screen() }; }
    return {};
  };
  return { seen, respond };
}

function fixture(name: string, model: Model, agent: AgentName = 'claude', allow = 'send, send_enter') {
  const root = scratch.sub(name), config = makeConfig(root, `capacity: {snapshot: false, codex_refresh: false}\nmcp: {allow: [${allow}]}\n`);
  config.notify.mcpWrites = 'all';
  const p = pane(model);
  const runner = new DiskRunner({ dryRun: false, startTime: Date.now() + 1000, respond: p.respond });
  const notices: string[] = [];
  const ctx = new Context(runner, config, () => {});
  seedTask(config, 'T1', { agent, windowId: '@1' });
  const record = () => readTaskRecord(config, 't1')!;
  const deps: McpDeps = { context: (out) => new Context(runner, config, out), notify: async (m) => void notices.push(m) };
  return { root, config, runner, ctx, seen: p.seen, record, deps, notices };
}
type Fixture = ReturnType<typeof fixture>;
const followup = (f: Fixture, text: string) => queuePrompt(f.ctx, f.record(), text, 'pending', { kind: 'followup' });
const confirming = (f: Fixture, extra: Record<string, unknown> = {}) => setHeaderFields(f.runner, taskFile(f.config, 't1'), { prompt_delivery: 'confirming', delivery_was_busy: true, delivery_started_at: new Date(f.runner.now() - 1000).toISOString(), ...extra });
const retryPause = (f: Fixture) => f.runner.sleep(8100);
/** `send --enter-only` since P15-FIX3: a preview (exact text, token), then the confirm with that token. A refused preview ends it. */
const enterOnly = async (f: Fixture) => {
  const preview = await submitDraft(f.ctx, 't1');
  return preview.outcome === 'ready' ? submitDraft(f.ctx, 't1', { token: preview.token! }) : preview;
};

/** A delivery whose Enter is swallowed: the paste stands in the field, three Enter presses went in. `shown` is what the field shows after the paste. */
async function swallowed(name: string, text: string, shown: string[]) {
  let field: string[] = [];
  const f = fixture(name, { screen: () => claude(field), paste: () => { field = shown; } });
  await followup(f, text);
  assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
  assert.equal(f.seen.enters, 3, 'the three Enter presses right after the paste');
  assert.equal(f.record().deliveryResult, 'not-delivered-in-field');
  return { f, show: (lines: string[]) => { field = lines; } };
}

describe('E1 / R1: watch presses Enter again only while the whole field is exactly our paste', () => {
  const text = 'FIRST LINE\nORIGINAL BODY';
  it('E1 a changed second line gets no Enter', async () => {
    const { f, show } = await swallowed('e1-changed', text, ['FIRST LINE', 'ORIGINAL BODY']);
    show(['FIRST LINE', 'USER REPLACED BODY']);
    await retryPause(f);
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3);
    assert.equal(f.record().deliveryResult, 'not-delivered-in-field');
  });
  it('E1 a partial paste (the second line is gone) gets no Enter', async () => {
    const { f, show } = await swallowed('e1-partial', text, ['FIRST LINE', 'ORIGINAL BODY']);
    show(['FIRST LINE']);
    await retryPause(f);
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3);
  });
  it('E1 a line added behind the paste placeholder gets no Enter', async () => {
    const { f, show } = await swallowed('e1-added', text, ['[Pasted text #2 +1 lines]']);
    show(['[Pasted text #2 +1 lines]', 'USER ADDED NEXT LINE']);
    await retryPause(f);
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3);
  });
  it('E1 a placeholder with another number is not our paste', async () => {
    const { f, show } = await swallowed('e1-number', text, ['[Pasted text #2 +1 lines]']);
    show(['[Pasted text #3 +1 lines]']);
    await retryPause(f);
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3);
  });
  it('E1 the field is edited between the look and the key: the last look before the key decides', async () => {
    let mode: 'empty' | 'ours' | 'edited' = 'empty';
    const f = fixture('e1-race', { screen: () => claude(mode === 'empty' ? [] : mode === 'edited' ? ['[Pasted text #2 +1 lines]', 'TYPED AT THE LAST MOMENT'] : ['[Pasted text #2 +1 lines]']), paste: () => { mode = 'ours'; } });
    await followup(f, text);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
    await retryPause(f);
    const before = f.seen.captures;
    // The first capture of the next call still shows our paste, every later one the edited field.
    const orig = f.runner.exec.bind(f.runner);
    f.runner.exec = (async (cmd: string, args: string[], opts?: ExecOptions) => { if (cmd === 'tmux' && args[0] === 'capture-pane' && !args.includes('-e') && f.seen.captures >= before + 1) mode = 'edited'; return orig(cmd, args, opts); }) as typeof f.runner.exec;
    await deliverPendingPrompt(f.ctx, 't1');
    assert.equal(f.seen.enters, 3, 'no Enter into the edited field');
  });
  it('E1 control (P15-FIX3: was "the unchanged field still gets the 4th Enter"): even the unchanged field gets no Enter from watch; it is reported with the way out', async () => {
    const { f } = await swallowed('e1-control', text, ['FIRST LINE', 'ORIGINAL BODY']);
    await retryPause(f);
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    assert.equal(f.seen.enters, 3); assert.equal(f.seen.pastes, 1);
    assert.match(f.record().promptError!, /^nie dostarczono – tekst w polu wpisywania/); assert.match(f.record().promptError!, /send --enter-only T1/);
  });
});

describe('E2 / R2: send --enter-only needs the origin and the whole field', () => {
  const stuck = async (name: string, pending: string, field: string[]) => {
    const f = fixture(name, { screen: () => claude(field) });
    await followup(f, pending);
    return f;
  };
  it('E2 the start of the pending text, typed by a human, is not ours', async () => {
    const f = await stuck('e2-prefix', 'A sufficiently long prefix AND A MISSING SUFFIX', ['A sufficiently long prefix']);
    const done = await enterOnly(f);
    assert.notEqual(done.outcome, 'submitted'); assert.notEqual(done.outcome, 'pending');
    assert.equal(f.seen.enters, 0);
  });
  it('E2 a text equal to the pending one that agentctl never pasted is not ours', async () => {
    const f = await stuck('e2-never-pasted', 'exact pending message', ['exact pending message']);
    await enterOnly(f);
    assert.equal(f.seen.enters, 0);
  });
  it('E2 our own paste, changed afterwards, is refused', async () => {
    const { f, show } = await swallowed('e2-changed', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    show(['FIRST LINE', 'ORIGINAL BODY', 'AND MORE']);
    await enterOnly(f);
    assert.equal(f.seen.enters, 3);
  });
  it('E2 control: our own unchanged paste is submitted', async () => {
    const { f } = await swallowed('e2-control', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    const done = await enterOnly(f);
    assert.equal(done.outcome, 'not-delivered'); assert.equal(done.keySent, true);
    assert.equal(f.seen.enters, 4);
  });
});

describe('E3 / R3: the queue sign of Claude is not an acknowledgement by itself', () => {
  const state = async (name: string, text = 'THIS MESSAGE WAS NEVER SENT') => {
    const f = fixture(name, { screen: () => claude([]) });
    await followup(f, text); await confirming(f);
    return f;
  };
  it('E3 an old queue (the queued message with ctrl+x ctrl+s) does not confirm the next message', async () => {
    const f = await state('e3-old');
    assert.equal(deliveryProof(f.ctx, f.record(), QUEUED_SCREEN.replace(/^❯.*$/m, '❯')), null);
  });
  it('E3 the dim "Press up to edit queued messages" of a message sent by hand does not confirm it', async () => {
    const f = await state('e3-dim');
    assert.equal(deliveryProof(f.ctx, f.record(), claude([]), 'Press up to edit queued messages'), null);
  });
  it('E3 the phrase inside an answer does not confirm it', async () => {
    const f = await state('e3-quoted');
    assert.equal(deliveryProof(f.ctx, f.record(), '● Documentation: ctrl+x ctrl+s to send now\n❯\n'), null);
  });
  it('E3 a second pending message with the old sign on the screen and no new Enter is not sent', async () => {
    const f = fixture('e3-second', { screen: () => QUEUED_SCREEN.replace(/^❯.*$/m, '❯'), styled: () => QUEUED_SCREEN });
    await followup(f, 'NEVER SENT SECOND MESSAGE'); await confirming(f);
    const result = await deliverPendingPrompt(f.ctx, 't1');
    assert.notEqual(result, 'sent'); assert.equal(f.record().deliveryResult, undefined);
    assert.equal(f.seen.enters, 0);
  });
  it('E3 control (P15-FIX3: was "confirms queued-in-agent / sent"): the sign that appears after our own Enter classifies queued-in-agent and the delivery stays unconfirmed', async () => {
    let state: 'before' | 'field' | 'queued' = 'before';
    const f = fixture('e3-control', { screen: () => state === 'before' ? claude([]) : state === 'field' ? claude(['[Pasted text #2 +1 lines]']) : QUEUED_SCREEN.replace(/^❯.*$/m, '❯'), paste: () => { state = 'field'; }, enter: () => { state = 'queued'; } });
    await followup(f, 'FIRST LINE\nORIGINAL BODY');
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'confirming');
    assert.equal(f.record().deliveryResult, 'queued-in-agent'); assert.equal(f.record().pendingPrompt, 'FIRST LINE\nORIGINAL BODY');
  });
});

describe('E4 / R4: the echo of Codex is the whole message', () => {
  const echoOf = async (pending: string, echo: string[], agent: AgentName = 'codex') => {
    const f = fixture(`e4-${pending.length}-${echo.length}`, { screen: () => codex([], echo) }, agent);
    await followup(f, pending); await confirming(f);
    // P15-FIX3: the screen echo confirms nothing; what the tests ask is whether it is read as exactly this message (echoLines), and that deliveryProof stays null.
    assert.equal(deliveryProof(f.ctx, f.record(), codex([], echo)), null);
    return echoLines(codex([], echo), '›', pending, 'codex') > 0 ? 'delivered' : null;
  };
  it('E4 "ok" is not "okay, do something else"', async () => assert.equal(await echoOf('ok', ['› okay, do something else']), null));
  it('E4 two messages with the same first 60 characters are two messages', async () => {
    const common = 'a'.repeat(60);
    assert.equal(await echoOf(`${common} ORIGINAL`, [`› ${common} DIFFERENT`]), null);
  });
  it('E4 only the start of a longer message is not the message', async () => {
    const text = 'Please add a test for the empty case and then run the whole suite once more, reporting every failure by name and cause.';
    assert.equal(await echoOf(text, [`› ${text.slice(0, 70)}`]), null);
  });
  it('E4 control: a long message wrapped by the TUI over several lines is found whole', async () => {
    const text = 'Please add a test for the empty case and then run the whole suite once more, reporting every failure by name and cause.';
    // The TUI wraps at a space and swallows that space (P15-FIX3: a cut in the middle of white space is no longer read back, white space is not squeezed).
    const rows: string[] = []; for (const word of text.split(' ')) { if (rows.length && rows.at(-1)!.length + 1 + word.length <= 50) rows[rows.length - 1] += ` ${word}`; else rows.push(word); }
    assert.ok(rows.length >= 3);
    assert.equal(await echoOf(text, rows.map((row, i) => i === 0 ? `› ${row}` : `  ${row}`)), 'delivered');
  });
  it('E4 control: a short message is found as it is', async () => assert.equal(await echoOf('ok', ['› ok']), 'delivered'));
});

describe('E5 / R5: the hook text is decoded, the pending prompt is compared as written', () => {
  const hooked = async (pending: string, submitted: string) => {
    const f = fixture('e5', { screen: () => claude([]) });
    await followup(f, pending); await confirming(f);
    await handleEvent(f.ctx, new Alerts(f.ctx, { notify: async () => {} }), { task: 'T1', agent: 'claude', kind: 'user-prompt-submit', payload: { prompt: submitted } });
    return deliveryProof(f.ctx, f.record(), '');
  };
  it('E5 a pending prompt that holds the tags itself is not confirmed by the text inside them', async () => assert.equal(await hooked('<pasted_content id="a">\nLITERAL\n</pasted_content id="a">', 'LITERAL'), null));
  it('E5 a closing tag with another id is not a wrapper', async () => assert.equal(await hooked('one', '<pasted_content id="a">\none\n</pasted_content id="b">'), null));
  it('E5 a wrapper around literal tags is ambiguous: no acknowledgement', async () => assert.equal(await hooked('<pasted_content id="inner">\nLITERAL\n</pasted_content id="inner">', '<pasted_content id="outer">\n<pasted_content id="inner">\nLITERAL\n</pasted_content id="inner">\n</pasted_content id="outer">'), null));
  it('E5 control: several separate wrappers keep the text between them', async () => assert.equal(await hooked('one\ntwo', '<pasted_content id="a">\none\n</pasted_content id="a">\n<pasted_content id="b">\ntwo\n</pasted_content id="b">'), 'delivered'));
  it('E5 control: the recorded payload of a collapsed paste', async () => {
    const payload = JSON.parse(fx('claude-user-prompt-submit-pasted.json')) as { prompt: string };
    const inner = payload.prompt.replace(/^<pasted_content id="[^"]*">\n/, '').replace(/\n<\/pasted_content id="[^"]*">$/, '');
    assert.equal(await hooked(inner, payload.prompt), 'delivered');
  });
  it('E5 control: tags typed by the user and sent as they are (no wrapper) match as written', async () => {
    const literal = '<pasted_content id="a">\nLITERAL\n</pasted_content id="a">';
    assert.equal(await hooked(literal, literal), 'delivered');
  });
});

describe('E6 / R6: enter_only over MCP (a real Client)', () => {
  async function connect(f: Fixture) {
    const server = buildMcpServer(f.deps, '0.0.0');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'review', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0]?.text ?? '';
    return { client, text, close: () => client.close() };
  }
  const audit = (f: Fixture) => fs.readFileSync(auditPath(f.config), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { tool: string; outcome: string; detail?: string });
  it('E6 a refusal is a tool error with its reason, no key is pressed', async () => {
    const f = fixture('e6-refused', { screen: () => claude(['FOREIGN DRAFT']) });
    await followup(f, 'exact'); await confirming(f);
    const mcp = await connect(f);
    const r = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true } });
    assert.equal(r.isError, true); assert.match(mcp.text(r), /agentctl nie wkleił|różni się|brak śladu/);
    const c = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true, confirm: true, token: '0123456789abcdef' } });
    assert.equal(c.isError, true);
    assert.equal(f.seen.enters, 0);
    assert.equal(audit(f).at(-1)!.outcome, 'error'); assert.match(audit(f).at(-1)!.detail ?? '', /refused/);
    await mcp.close();
  });
  it('E6 an Enter that went in but was swallowed is audited as executed, with a delivery entry and a notice; the answer keeps "key sent" apart from "delivery confirmed"', async () => {
    const { f, show } = await (async () => { const s = await swallowed('e6-swallowed', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']); return { f: s.f, show: s.show }; })();
    void show;
    f.notices.length = 0;
    const mcp = await connect(f);
    const preview = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true } });
    const token = /token: "([0-9a-f]{16})"/.exec(mcp.text(preview))?.[1];
    assert.ok(token, mcp.text(preview)); assert.match(mcp.text(preview), /Tekst w polu \(dokładnie\):\nFIRST LINE\nORIGINAL BODY/);
    assert.equal(f.seen.enters, 3, 'the preview presses nothing');
    const r = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true, confirm: true, token } });
    assert.ok(!r.isError, mcp.text(r)); assert.match(mcp.text(r), /Enter wysłany: tak/); assert.match(mcp.text(r), /potwierdzone: nie/);
    assert.equal(f.seen.enters, 4);
    const last = audit(f).at(-1)!;
    assert.equal(last.outcome, 'done'); assert.match(last.detail ?? '', /enter-sent/);
    assert.ok(readJournal(f.config).some(e => e.kind === 'delivery' && /nie dostarczono/.test(e.text)));
    assert.ok(f.notices.some(m => /send T1/.test(m)), 'the executed Enter is announced');
    await mcp.close();
  });
  it('E6 without send_enter in mcp.allow no key is pressed, even with send allowed', async () => {
    const { f } = await swallowed('e6-allow', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    f.config.mcp.allow = ['send'];
    const mcp = await connect(f);
    const r = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true, confirm: true } });
    assert.equal(r.isError, true); assert.match(mcp.text(r), /not in mcp\.allow/);
    assert.equal(f.seen.enters, 3);
    await mcp.close();
  });
  it('E6 without confirm it only previews: nothing is pressed', async () => {
    const { f } = await swallowed('e6-preview', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    const mcp = await connect(f);
    const r = await mcp.client.callTool({ name: 'send', arguments: { task: 'T1', enter_only: true } });
    assert.ok(!r.isError, mcp.text(r));
    assert.equal(f.seen.enters, 3);
    assert.equal(audit(f).at(-1)!.outcome, 'preview');
    await mcp.close();
  });
});

describe('E7 / R7: every result of a delivery reaches the journal and the events', () => {
  it('E7 a delivery that a later watch tick confirms (delivered) is recorded with its delivery id', async () => {
    const f = fixture('e7-watch', { screen: () => codex([]) }, 'codex');
    await followup(f, 'unique message'); await confirming(f);
    // P15-FIX3: the later tick is confirmed by the notify payload of Codex (an exact source), not by an echo on the screen.
    await handleEvent(f.ctx, new Alerts(f.ctx, { notify: async () => {} }), { task: 'T1', agent: 'codex', payload: { type: 'agent-turn-complete', 'thread-id': 'th-1', 'input-messages': ['unique message'], 'last-assistant-message': 'ok' } });
    await watchTick(f.ctx, new WatchMemory(), { notify: async () => {} });
    const record = f.record();
    assert.equal(record.deliveryResult, 'delivered');
    const entry = readJournal(f.config).find(e => e.kind === 'delivery');
    assert.ok(entry, 'journal entry');
    assert.ok(record.deliveryId && entry!.text.includes(record.deliveryId.slice(0, 8)), entry!.text);
    const events = await collectEvents(f.ctx, { client: 'review', since: '1h', keep: true });
    assert.ok(events.events.some(e => e.kind === 'delivery'), 'events');
  });
  it('E7 send, watch and enter-only write the same kind of entry for queued, not delivered and delivered', async () => {
    const { f } = await swallowed('e7-all', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    await enterOnly(f);
    const texts = readJournal(f.config).filter(e => e.kind === 'delivery').map(e => e.text);
    assert.ok(texts.some(t => /nie dostarczono/.test(t)), texts.join(' | '));
    assert.ok(texts.some(t => /send --enter-only/.test(t) && /\[dostawa [0-9a-f]{8}\]/.test(t)), 'the Enter pressed by hand is written down with the delivery id');
  });
});

describe('E8 / R8: "✳" counts only as the spinner of the status area', () => {
  it('E8 a spinner line quoted in a finished report leaves the screen idle', () => {
    const screen = '● Previous diagnostic report:\n  ✳ Fluttering… (2s · thinking with high effort)\nReport finished.\n❯ \n';
    assert.equal(classifyScreen(screen, DEFAULT_AGENT_SETTINGS.claude), 'idle');
  });
  it('E8 a spinner line quoted higher up above an idle input box stays idle too', () => {
    const screen = '● The log shows:\n  ✳ Fluttering… (2s · thinking with high effort)\n\n● Done, nothing is running.\n\n────────────────\n❯ \n────────────────\n';
    assert.equal(classifyScreen(screen, DEFAULT_AGENT_SETTINGS.claude), 'idle');
  });
  it('E8 control: the recorded "✳" frame without the footer is a working screen', () => {
    const star = fx('screen-claude-spinner-star-no-footer.txt');
    assert.ok(!/esc to interrupt/.test(star));
    assert.equal(classifyScreen(star, DEFAULT_AGENT_SETTINGS.claude), 'working');
  });
});

describe('E9 / R9: the message about an open Codex question names the question', () => {
  it('E9 send says what the question asks', async () => {
    const f = fixture('e9', { screen: () => fx('screen-codex-question-collapsed.txt') }, 'codex');
    const results = await sendPrompts(f.ctx, [{ task: 'T1', window: 't1', prompt: 'QUEUED FOLLOWUP' }]);
    assert.equal(f.seen.pastes, 0); assert.equal(f.seen.enters, 0);
    assert.match(results[0]!.message, /Which colour: red or blue\?/);
    assert.match(results[0]!.message, /zwinięte, 1/);
    assert.equal(f.record().promptDelivery, 'pending');
  });
});

describe('E10 / R10: after the last Enter there is no promise of another one', () => {
  it('E10 (P15-FIX3: there is only the one call that pastes) the note names the manual step, never says watch will press Enter, and no Enter follows', async () => {
    const { f } = await swallowed('e10', 'FIRST LINE\nORIGINAL BODY', ['FIRST LINE', 'ORIGINAL BODY']);
    for (let i = 0; i < 3; i++) { await retryPause(f); await deliverPendingPrompt(f.ctx, 't1'); }
    assert.equal(await deliverPendingPrompt(f.ctx, 't1'), 'needs-attention');
    const note = deliveryNote(f.record())!;
    assert.match(note, /nie dostarczono – tekst w polu wpisywania/);
    assert.doesNotMatch(note, /ponowi/); assert.match(note, /nie naciśnie już Enter sam/);
    assert.match(note, /send --enter-only T1/);
    assert.equal(f.seen.enters, 3);
  });
});
