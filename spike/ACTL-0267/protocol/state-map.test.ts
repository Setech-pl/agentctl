import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initial, codexFrame, acpFrame, answer, type Snapshot } from './state-map.ts';
import { assertNoPrompt } from './jsonrpc-probe.ts';

const F = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const frames = (n: string) => fs.readFileSync(path.join(F, n), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
const serverOnly = (n: string) => frames(n).filter(m => !('method' in m && 'id' in m && typeof m.id === 'number' && 'params' in m && !('result' in m) && String(m.method) === 'initialize'));

test('recorded codex app-server handshake (0.167.0): thread/start without a turn ends ready with the thread id', () => {
  let s: Snapshot = initial();
  for (const m of serverOnly('codex-app-server-handshake.recorded.jsonl')) s = codexFrame(s, m);
  assert.equal(s.state, 'ready');
  assert.equal(s.threadId, '01a221c7-1999-70b1-a40a-06068806a158');
  assert.equal(s.turns, 0);
});

test('codex turn: working → needs-approval → answer → turn-done with per-turn usage; then a usage-limit failure', () => {
  const all = frames('codex-app-server-turn.synthetic.jsonl');
  let s: Snapshot = { ...initial(), state: 'ready' };
  for (const m of all.slice(0, 4)) s = codexFrame(s, m);
  assert.equal(s.state, 'needs-approval');
  assert.equal(s.pending[0]?.text, 'npm run gate -- quick');
  const a = answer(s, 2);
  assert.deepEqual(a.response, { jsonrpc: '2.0', id: 0, result: { decision: 'acceptForSession' } });
  s = a.next;
  for (const m of all.slice(4, 8)) s = codexFrame(s, m);
  assert.equal(s.state, 'turn-done');
  assert.equal(s.lastMessage, 'Werdykt: PASS');
  assert.equal(s.turnUsage?.input, 900);
  assert.equal(s.totalUsage?.contextWindow, 272000);
  for (const m of all.slice(8)) s = codexFrame(s, m);
  assert.equal(s.state, 'limited');
  assert.equal(s.turns, 2);
});

test('acp turn: request_permission is answerable by number, chunks build the message, end_turn is turn-done', () => {
  let s = initial();
  const prompts = new Set<string | number>([3]);
  const all = frames('acp-turn.synthetic.jsonl');
  for (const m of all.slice(0, 3)) s = acpFrame(s, m, prompts);
  assert.equal(s.threadId, 'sess-1');
  assert.equal(s.state, 'needs-approval');
  assert.equal(s.pending[0]?.choices.length, 3);
  const a = answer(s, 1);
  assert.deepEqual(a.response.result, { outcome: { outcome: 'selected', optionId: 'allow' } });
  s = a.next;
  for (const m of all.slice(3)) s = acpFrame(s, m, prompts);
  assert.equal(s.state, 'turn-done');
  assert.equal(s.lastMessage, 'Werdykt: PASS');
  assert.equal(s.totalUsage?.contextWindow, 200000);
});

test('recorded ACP initialize responses advertise resume/close/list for all three agents', () => {
  for (const n of ['claude-agent-acp-init.recorded.jsonl', 'codex-acp-session.recorded.jsonl', 'kimi-acp-init.recorded.jsonl']) {
    const init = frames(n).find(m => m.id === 1 && 'result' in m) as { result: { protocolVersion: number; agentCapabilities: { loadSession: boolean; sessionCapabilities: Record<string, unknown> } } };
    assert.equal(init.result.protocolVersion, 1, n);
    assert.equal(init.result.agentCapabilities.loadSession, true, n);
    for (const k of ['resume', 'close', 'list']) assert.ok(k in init.result.agentCapabilities.sessionCapabilities, `${n} ${k}`);
  }
});

test('the probe refuses any plan that would start a model turn', () => {
  assert.throws(() => assertNoPrompt({ steps: [{ method: 'turn/start' }] }));
  assert.throws(() => assertNoPrompt({ steps: [{ method: 'session/prompt' }] }));
  assert.doesNotThrow(() => assertNoPrompt({ steps: [{ method: 'initialize' }, { method: 'thread/start' }] }));
});
