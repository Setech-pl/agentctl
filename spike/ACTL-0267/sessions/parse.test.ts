import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tailLines, parseClaude, parseCodex, readClaudeRegistry, claudeState } from './parse.ts';

const F = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string) => tailLines(path.join(F, n)).lines;

test('claude: finished turn, deduplicated usage, last message', () => {
  const s = parseClaude(load('claude-turn-done.jsonl'));
  assert.equal(s.phase, 'turn-done');
  assert.equal(s.turnDurationMs, 31000);
  assert.equal(s.lastAssistant, 'Done. Report written to /r/REPORT.md');
  assert.deepEqual(s.turnUsage, { input: 15, output: 80, cacheRead: 2200, cacheWrite: 200, reasoning: 0 });
  assert.equal(s.version, '2.1.326');
});

test('claude: unanswered AskUserQuestion is needs-input with the question', () => {
  const s = parseClaude(load('claude-asking.jsonl'));
  assert.equal(s.phase, 'needs-input');
  assert.deepEqual(s.waiting, { kind: 'question', text: 'Which database?' });
});

test('claude: a torn last line is tolerated and the tail drops the partial first line', () => {
  const lines = load('claude-turn-done.jsonl');
  assert.equal(parseClaude([...lines.slice(0, 3), '{"type":"assis']).phase, 'working');
  const t = tailLines(path.join(F, 'claude-turn-done.jsonl'), 600);
  assert.equal(t.truncated, true);
  assert.ok(t.lines.every(l => l.startsWith('{')));
});

test('codex: finished turn with usage and last agent message', () => {
  const s = parseCodex(load('codex-turn-done.jsonl'));
  assert.equal(s.phase, 'turn-done');
  assert.equal(s.version, '0.167.0');
  assert.equal(s.lastAssistant, 'All green. Report: /r/REPORT.md');
  assert.equal(s.turnUsage.input, 9000);
  assert.equal(s.turnUsage.reasoning, 120);
  assert.equal(s.contextWindow, 272000);
});

test('codex: pending request_user_input is needs-input', () => {
  const s = parseCodex(load('codex-asking.jsonl'));
  assert.equal(s.phase, 'needs-input');
  assert.equal(s.waiting?.text, 'Touch src/ too?');
});

test('claude registry: keyed by tmux pane, live status overrides a stale transcript phase', () => {
  const reg = readClaudeRegistry(path.join(F, 'claude-registry'));
  const live = reg.get('%7');
  assert.equal(live?.status, 'idle');
  const working = parseClaude(load('claude-turn-done.jsonl').slice(0, 3));
  assert.equal(claudeState(working, live, () => true).phase, 'turn-done');
  assert.equal(claudeState(working, live, () => false).live, 'stale');
});
